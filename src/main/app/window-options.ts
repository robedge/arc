import type { BrowserWindowConstructorOptions, Rectangle } from 'electron'

/** Ground color of the HUD; shown before the renderer paints. */
export const HUD_BACKGROUND = '#03080F'

/** Traffic lights (about 12px tall) sit centered in the 40px renderer title bar (--size-titlebar). */
export const TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const

export function mainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: HUD_BACKGROUND,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  }
}

type Env = Readonly<Record<string, string | undefined>>

/** True only for e2e runs that asked for windows that never appear on screen or take focus. */
export function isE2eOffscreen(env: Env): boolean {
  return env['HARNESS_E2E'] === '1' && env['HARNESS_E2E_OFFSCREEN'] === '1'
}

/** A top-left origin beyond every display (right of and below all of them), with a margin. */
export function offscreenOrigin(displays: readonly Rectangle[]): { x: number; y: number } {
  const margin = 5000
  const right = Math.max(0, ...displays.map((d) => d.x + d.width))
  const bottom = Math.max(0, ...displays.map((d) => d.y + d.height))
  return { x: right + margin, y: bottom + margin }
}

/** Adds the off-screen origin to `options` when both e2e env vars are set; otherwise unchanged. */
export function withE2eOffscreen(
  options: BrowserWindowConstructorOptions,
  env: Env,
  getDisplayBounds: () => readonly Rectangle[]
): BrowserWindowConstructorOptions {
  if (!isE2eOffscreen(env)) return options
  // enableLargerThanScreen disables macOS's pull-back of windows onto a display.
  return { ...options, ...offscreenOrigin(getDisplayBounds()), enableLargerThanScreen: true }
}

/** `showInactive()` (no focus steal) under both e2e env vars, else `show()`. */
export function showWindow(win: { show(): void; showInactive(): void }, env: Env): void {
  if (isE2eOffscreen(env)) win.showInactive()
  else win.show()
}
