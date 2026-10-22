// electron-builder afterPack hook: ad hoc sign the .app (codesign -s -), no Developer ID needed.
// electron-builder's own `identity: "-"` is ignored in favour of any keychain certificate, so the
// config sets `identity: null` (skip its signing) and this hook signs deterministically instead.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export default function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
