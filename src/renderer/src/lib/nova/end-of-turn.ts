/** Words that rarely end a sentence: after one of these the user is probably still thinking. */
const HANGING_WORDS: ReadonlySet<string> = new Set([
  // conjunctions
  'and',
  'but',
  'or',
  'so',
  'because',
  'if',
  'that',
  'which',
  'then',
  'also',
  'maybe',
  'while',
  'when',
  'although',
  'since',
  'than',
  // fillers
  'um',
  'uh',
  'er',
  'erm',
  'uhm',
  'hmm',
  'like',
  'well',
  'okay',
  // articles and determiners
  'the',
  'a',
  'an',
  'this',
  'these',
  'those',
  // prepositions
  'to',
  'of',
  'for',
  'with',
  'in',
  'on',
  'about',
  'at',
  'from',
  'into',
  'by',
  'as',
  // possessives and pronoun subjects
  'my',
  'your',
  'our',
  'their',
  'i',
  'we',
  'they',
  'he',
  'she',
  // auxiliary verbs
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'am',
  'does',
  'did',
  'have',
  'has',
  'had',
  'will',
  'would',
  'can',
  'could',
  'should',
  'might',
  'must',
  'gonna',
  'wanna'
])

/** A last word that gives the sentence away even though it is not hanging by itself ("i want to ..."). */
const HANGING_TAILS: readonly string[] = [
  'i want',
  'i need',
  'can you',
  'could you',
  'would you',
  'let me',
  'i would like',
  'what about',
  'how about'
]

/** Short hold: the user probably finished. Long hold: probably still thinking. */
export type EndVerdict = 'finished' | 'unfinished'

/** The multiple of the short hold that an unfinished-sounding pause waits. */
export const LONG_HOLD_FACTOR = 3

/** Reads the live words of the utterance: does the user sound finished? Empty text counts as unfinished. */
export function judgeEnd(partial: string): EndVerdict {
  const words = partial
    .toLowerCase()
    .replace(/[^a-z'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
  const last = words[words.length - 1]
  if (last === undefined) return 'unfinished'
  if (HANGING_WORDS.has(last)) return 'unfinished'
  const tail = words.slice(-3).join(' ')
  return HANGING_TAILS.some((t) => tail === t || tail.endsWith(` ${t}`)) ? 'unfinished' : 'finished'
}

/** How long a pause lasts before the turn ends, from the setting (the short hold). */
export function holdMs(partial: string, shortHoldMs: number): number {
  return judgeEnd(partial) === 'unfinished' ? shortHoldMs * LONG_HOLD_FACTOR : shortHoldMs
}
