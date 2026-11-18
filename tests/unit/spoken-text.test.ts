import { describe, expect, it } from 'vitest'
import { shapeSpoken } from '../../src/shared/spoken-text'

interface Case {
  name: string
  input: string
  text: string
  dropped: boolean
}

const cases: Case[] = [
  { name: 'empty', input: '', text: '', dropped: false },
  { name: 'whitespace only', input: '  \n\t ', text: '', dropped: false },
  { name: 'plain sentence', input: 'All done.', text: 'All done.', dropped: false },
  {
    name: 'fenced code only',
    input: '```ts\nconst a = 1\n```',
    text: '',
    dropped: true
  },
  {
    name: 'fenced code between sentences',
    input: 'I fixed it.\n\n```ts\nconst a = 1\n```\n\nTests pass.',
    text: 'I fixed it. Tests pass.',
    dropped: true
  },
  {
    name: 'inline code token is dropped',
    input: 'I renamed `foo` to something clearer.',
    text: 'I renamed to something clearer.',
    dropped: true
  },
  {
    name: 'sentence that is only inline code is dropped',
    input: 'Done. `npm run build`. It works.',
    text: 'Done. It works.',
    dropped: true
  },
  {
    name: 'table',
    input: 'Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAll good.',
    text: 'Results: All good.',
    dropped: true
  },
  {
    name: 'diff lines outside fences',
    input: 'Changed it.\n@@ -1,2 +1,2 @@\n-old line\n+new line\nDone.',
    text: 'Changed it. Done.',
    dropped: true
  },
  {
    name: 'diff fence',
    input: 'Here is the patch.\n```diff\n-a\n+b\n```',
    text: 'Here is the patch.',
    dropped: true
  },
  {
    name: 'bare URL',
    input: 'See https://example.com/docs for more.',
    text: 'See for more.',
    dropped: true
  },
  {
    name: 'markdown link keeps its text',
    input: 'Read [the guide](https://example.com/guide) first.',
    text: 'Read the guide first.',
    dropped: true
  },
  {
    name: 'path with slash and extension',
    input: 'I edited src/main/app.ts today.',
    text: 'I edited today.',
    dropped: true
  },
  {
    name: 'relative and home paths',
    input: 'Look in ./build and ~/notes and ../up and /etc.',
    text: 'Look in and and and.',
    dropped: true
  },
  {
    name: 'a slash between words is not a path',
    input: 'Use either/or here.',
    text: 'Use either/or here.',
    dropped: false
  },
  {
    name: 'heading, list, emphasis and blockquote markers are formatting only',
    input: '# Title\n\n- **first** item\n1. *second* item\n> quoted words',
    text: 'Title first item second item quoted words',
    dropped: false
  },
  {
    name: 'html tags',
    input: 'Hello <b>there</b> friend.',
    text: 'Hello there friend.',
    dropped: false
  },
  {
    name: 'caps at three sentences',
    input: 'One. Two. Three. Four. Five.',
    text: 'One. Two. Three.',
    dropped: true
  },
  {
    name: 'abbreviation guard',
    input: 'Use tools e.g. grep, i.e. fast ones, etc. Dr. Smith agrees. Done.',
    text: 'Use tools e.g. grep, i.e. fast ones, etc. Dr. Smith agrees. Done.',
    dropped: false
  },
  {
    name: 'decimals are not sentence ends',
    input: 'It took 1.5 seconds. Fast.',
    text: 'It took 1.5 seconds. Fast.',
    dropped: false
  },
  {
    name: 'question and exclamation split',
    input: 'Really? Yes! Done. Extra.',
    text: 'Really? Yes! Done.',
    dropped: true
  }
]

describe('shapeSpoken', () => {
  it.each(cases)('$name', ({ input, text, dropped }) => {
    expect(shapeSpoken(input)).toEqual({ text, droppedContent: dropped })
  })

  it('stops before a sentence that would pass about 350 characters', () => {
    const sentence = `${'Word '.repeat(30).trim()}.`
    const result = shapeSpoken(`${sentence} ${sentence} ${sentence}`)
    expect(result.text).toBe(`${sentence} ${sentence}`)
    expect(result.text.length).toBeLessThanOrEqual(350)
    expect(result.droppedContent).toBe(true)
  })

  it('cuts one very long sentence at a word boundary and ends with a period', () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') + '.'
    const result = shapeSpoken(long)
    expect(result.text.length).toBeLessThanOrEqual(350)
    expect(result.text.endsWith('.')).toBe(true)
    expect(
      result.text
        .slice(0, -1)
        .split(' ')
        .every((w) => /^word\d+$/.test(w))
    ).toBe(true)
    expect(result.droppedContent).toBe(true)
  })
})
