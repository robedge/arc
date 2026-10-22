// Runs SQL against an Arc database for e2e seeding. Usage (under Electron's Node, for better-sqlite3's ABI):
//   ELECTRON_RUN_AS_NODE=1 electron sqlite-exec.mjs <db file> <jobs.json>
// jobs.json is [{ "sql": "...", "params": [...] }]. Prints one JSON array of result rows per job.
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

const [dbPath, jobsPath] = process.argv.slice(2)
const jobs = JSON.parse(readFileSync(jobsPath, 'utf8'))
const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')
db.pragma('foreign_keys = ON')
const out = []
for (const job of jobs) {
  const stmt = db.prepare(job.sql)
  if (stmt.reader) out.push(stmt.all(...(job.params ?? [])))
  else {
    stmt.run(...(job.params ?? []))
    out.push([])
  }
}
db.close()
process.stdout.write(JSON.stringify(out))
