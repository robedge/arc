// Tiny child process for the supervisor and adapter tests. Mode is argv[2].
//   env           prints process.env as one JSON line, then waits for stdin to close
//   exit1         prints to stderr, exits 1
//   ignore-all    ignores stdin, SIGINT and SIGTERM; only SIGKILL stops it
//   sigint-dies   ignores stdin; the default SIGINT action stops it
//   grandchild    spawns a long-lived child, prints {"gpid":N}, then hangs
//   big-line      prints a 5 MB line, then a small valid line
import { spawn } from 'node:child_process'

const mode = process.argv[2]
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

if (mode === 'env') {
  out({ env: process.env })
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
} else if (mode === 'exit1') {
  process.stderr.write('boom from stub\n')
  process.exit(1)
} else if (mode === 'ignore-all') {
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => {})
  out({ ready: true })
  setInterval(() => {}, 1000)
} else if (mode === 'sigint-dies') {
  out({ ready: true })
  setInterval(() => {}, 1000)
} else if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    env: { ...process.env }
  })
  out({ gpid: child.pid })
  setInterval(() => {}, 1000)
} else if (mode === 'big-line') {
  process.stdout.write('x'.repeat(5 * 1024 * 1024) + '\n')
  out({ after: true })
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
}
