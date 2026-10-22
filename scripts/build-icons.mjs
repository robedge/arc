// Renders the Arc app icon (.icns, .png) and the DMG background (.tiff) from the SVG sources in
// resources/. macOS only: needs `iconutil` and `tiffutil`. Outputs are committed, so
// `pnpm package` never runs this. Usage: pnpm icons
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = (...p) => join(root, 'resources', ...p)

function requireTool(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
  } catch {
    console.error(`pnpm icons needs "${name}", which ships with macOS. Run it on a Mac.`)
    process.exit(1)
  }
}

function render(svgPath, width) {
  const svg = readFileSync(svgPath)
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'rgba(0,0,0,0)' })
    .render()
    .asPng()
}

if (process.platform !== 'darwin') {
  console.error('pnpm icons only runs on macOS (iconutil, tiffutil).')
  process.exit(1)
}
requireTool('iconutil')
requireTool('tiffutil')

const work = mkdtempSync(join(tmpdir(), 'arc-icons-'))
try {
  // App icon: the small variant covers pixel sizes up to 64, the full icon everything above.
  const iconset = join(work, 'Arc.iconset')
  mkdirSync(iconset)
  const sizes = [16, 32, 128, 256, 512]
  for (const s of sizes) {
    for (const scale of [1, 2]) {
      const px = s * scale
      const src = px <= 64 ? res('icon', 'arc-icon-small.svg') : res('icon', 'arc-icon.svg')
      const name = scale === 1 ? `icon_${s}x${s}.png` : `icon_${s}x${s}@2x.png`
      writeFileSync(join(iconset, name), render(src, px))
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', res('icon.icns')])
  writeFileSync(res('icon.png'), render(res('icon', 'arc-icon.svg'), 1024))

  // DMG background: 1x and 2x combined into one multi-resolution TIFF.
  const bg = res('dmg', 'background.svg')
  const bg1 = join(work, 'background.png')
  const bg2 = join(work, 'background@2x.png')
  writeFileSync(bg1, render(bg, 540))
  writeFileSync(bg2, render(bg, 1080))
  // tiffutil reads TIFF only; convert the PNGs, tagging 2x at 144 dpi.
  const t1 = join(work, 'background.tiff')
  const t2 = join(work, 'background@2x.tiff')
  execFileSync(
    'sips',
    ['-s', 'format', 'tiff', '-s', 'dpiWidth', '72', '-s', 'dpiHeight', '72', bg1, '--out', t1],
    { stdio: 'ignore' }
  )
  execFileSync(
    'sips',
    ['-s', 'format', 'tiff', '-s', 'dpiWidth', '144', '-s', 'dpiHeight', '144', bg2, '--out', t2],
    { stdio: 'ignore' }
  )
  execFileSync('tiffutil', ['-cathidpicheck', t1, t2, '-out', res('dmg', 'background.tiff')])
  console.log('wrote resources/icon.icns, resources/icon.png, resources/dmg/background.tiff')
} finally {
  rmSync(work, { recursive: true, force: true })
}
