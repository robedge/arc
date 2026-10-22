/** `--smoke` launch: open the database (running migrations), report, and exit without a window. */
export const SMOKE_FLAG = '--smoke'

export function isSmokeRun(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_FLAG)
}

export interface SmokeDeps {
  /** Opens the database and runs migrations; throws on failure. Returns a closer. */
  openDatabase: () => { close: () => void }
  info: (message: string) => void
  error: (message: string, err: unknown) => void
  exit: (code: number) => void
}

/** Runs the smoke check and exits 0 on success, 1 on failure. */
export function runSmoke(deps: SmokeDeps): number {
  let code = 0
  try {
    deps.openDatabase().close()
    deps.info('smoke: database opened and migrations applied')
  } catch (err: unknown) {
    deps.error('smoke: failed to open database', err)
    code = 1
  }
  deps.exit(code)
  return code
}
