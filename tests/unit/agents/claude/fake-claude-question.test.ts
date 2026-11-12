import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
let tmp: string | undefined
let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

const questions = [
  {
    question: 'Which library?',
    header: 'Library',
    options: [{ label: 'axios', description: 'a' }],
    multiSelect: false
  }
]

/** Runs the fake with one AskUserQuestion step against a stub bridge answering `decision`. */
async function play(
  decision: unknown
): Promise<{ called: Record<string, unknown>; texts: string[]; results: string[] }> {
  tmp = mkdtempSync(join(tmpdir(), 'arc-fake-question-'))
  let called: Record<string, unknown> = {}
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d: Buffer) => (body += d.toString()))
    req.on('end', () => {
      const msg = JSON.parse(body) as { id?: number; method: string; params?: unknown }
      res.setHeader('content-type', 'application/json')
      if (msg.method === 'tools/call') {
        called = (msg.params as { arguments: Record<string, unknown> }).arguments
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: JSON.stringify(decision) }] }
          })
        )
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
      }
    })
  })
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const config = join(tmp, 'mcp.json')
  writeFileSync(
    config,
    JSON.stringify({ mcpServers: { arc: { url: `http://127.0.0.1:${port}/` } } })
  )
  const script = join(tmp, 's.jsonl')
  writeFileSync(
    script,
    [{ init: true }, { tool: { name: 'AskUserQuestion', input: { questions } } }, { result: true }]
      .map((s) => JSON.stringify(s))
      .join('\n')
  )
  const child = spawn(
    process.execPath,
    [fake, '-p', '--mcp-config', config, '--strict-mcp-config'],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FAKE_CLAUDE_SCRIPT: script },
      stdio: ['pipe', 'pipe', 'ignore']
    }
  )
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stdin.end()
  await new Promise((r) => child.on('close', r))
  const lines = out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(
      (l) =>
        JSON.parse(l) as {
          type: string
          message?: { content?: { type: string; text?: string; content?: { text: string }[] }[] }
        }
    )
  const blocks = lines.flatMap((l) => l.message?.content ?? [])
  return {
    called,
    texts: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? ''),
    results: blocks.filter((b) => b.type === 'tool_result').map((b) => b.content?.[0]?.text ?? '')
  }
}

describe('fake-claude AskUserQuestion step', () => {
  it('sends tool_name and input.questions, then echoes the answers it received', async () => {
    const out = await play({
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Which library?': 'axios' } }
    })
    expect(out.called).toMatchObject({
      tool_name: 'AskUserQuestion',
      input: { questions },
      tool_use_id: expect.stringContaining('toolu_fake_')
    })
    expect(out.results).toEqual(['Your questions have been answered: "Which library?"="axios"'])
    expect(out.texts).toEqual(['AskUserQuestion answers: {"Which library?":"axios"}'])
  })

  it('echoes the deny message when the user declined', async () => {
    const out = await play({ behavior: 'deny', message: 'The user declined to answer.' })
    expect(out.results).toEqual(['The user declined to answer.'])
    expect(out.texts).toEqual(['AskUserQuestion declined: The user declined to answer.'])
  })
})
