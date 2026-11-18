// electron-builder afterPack hook: ad hoc sign the .app (codesign -s -), no Developer ID needed.
// electron-builder's own `identity: "-"` is ignored in favour of any keychain certificate, so the
// config sets `identity: null` (skip its signing) and this hook signs deterministically instead.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Unpacked native addons and dylibs (asarUnpack) are signed one by one, inside-out, because
// `codesign --deep` does not reach loose Mach-O files under Resources/app.asar.unpacked.
function findNative(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) findNative(full, found)
    else if (name.endsWith('.node') || name.endsWith('.dylib')) found.push(full)
  }
  return found
}

export default function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const unpacked = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked')
  if (existsSync(unpacked)) {
    for (const file of findNative(unpacked)) {
      execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' })
    }
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
