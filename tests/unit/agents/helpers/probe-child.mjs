// Stand-in CLI for the command probe tests. Mode is argv[2]; the commands come from PROBE_COMMANDS.
//   hooks    prints hook lines, a stray line, then the control_response; exits when stdin closes
//   hang     reads stdin, never answers
//   linger   answers, then ignores stdin closing and stays until a signal
//   error    answers with an error control_response
//   exit1    exits 1 with stderr text before answering
import { createInterface } from 'node:readline'

const mode = process.argv[2]
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const commands = JSON.parse(process.env.PROBE_COMMANDS ?? '[]')

if (mode === 'exit1') {
  process.stderr.write('probe child failed\n')
  process.exit(1)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (raw) => {
  const msg = JSON.parse(raw)
  if (msg.type !== 'control_request' || msg.request?.subtype !== 'initialize') return
  if (mode === 'hang') return
  if (mode === 'error') {
    out({
      type: 'control_response',
      response: { subtype: 'error', request_id: msg.request_id, error: 'nope' }
    })
    return
  }
  out({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' })
  out({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', exit_code: 0 })
  out({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'someone-else', response: { commands: [] } }
  })
  out({
    type: 'control_response',
    response: { subtype: 'success', request_id: msg.request_id, response: { commands } }
  })
})
if (mode === 'linger') {
  rl.on('close', () => setInterval(() => {}, 1000))
} else {
  rl.on('close', () => process.exit(0))
}
