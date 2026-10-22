import { spawnSync } from 'node:child_process'

// First migration must be named 0000_init; later ones are named via `pnpm db:generate --name <name>`.
const args = process.argv.slice(2)
const r = spawnSync('drizzle-kit', ['generate', ...args], { stdio: 'inherit' })
process.exit(r.status ?? 1)
