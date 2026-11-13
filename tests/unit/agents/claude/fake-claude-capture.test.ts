import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
let tmp: string | undefined

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

/** Runs the fake on `steps`, feeds it `userText` as one stream-json user message, returns the assistant texts. */
async function says(steps: object[], userText: string): Promise<string[]> {
  tmp = mkdtempSync(join(tmpdir(), 'arc-fake-capture-'))
  const script = join(tmp, 's.jsonl')
  writeFileSync(script, steps.map((s) => JSON.stringify(s)).join('\n'))
  const child = spawn(process.execPath, [fake, '-p'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FAKE_CLAUDE_SCRIPT: script },
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stdin.write(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: userText }] }
    }) + '\n'
  )
  child.stdin.end()
  await new Promise((r) => child.on('close', r))
  return out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type?: string; message?: { content?: { text?: string }[] } })
    .filter((e) => e.type === 'assistant')
    .map((e) => e.message?.content?.[0]?.text ?? '')
    .filter((t) => t !== '')
}

describe('fake-claude capture step', () => {
  it('keeps the first group of a regex over the last user text and fills {{VAR:k}} later', async () => {
    const out = await says(
      [
        { waitForStdin: '*' },
        { capture: { as: 'att', regex: '- (\\w{6}) · Pasted image 1' } },
        { say: 'id={{VAR:att}} again={{VAR:att}}' }
      ],
      'Look\n\n[Attachments for this message]\n- 01HABC · Pasted image 1 · image · 70 bytes · /x/y.png'
    )
    expect(out).toEqual(['id=01HABC again=01HABC'])
  })

  it('uses the whole match when there is no group and leaves the placeholder when nothing matches', async () => {
    const out = await says(
      [
        { waitForStdin: '*' },
        { capture: { as: 'whole', regex: 'ab\\d' } },
        { capture: { as: 'none', regex: 'zzz' } },
        { say: '{{VAR:whole}} {{VAR:none}}' }
      ],
      'xx ab7 yy'
    )
    expect(out).toEqual(['ab7 {{VAR:none}}'])
  })
})
