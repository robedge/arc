import { cubicOut } from 'svelte/easing'
import type { TransitionConfig } from 'svelte/transition'
import { motion } from './stores/motion.svelte'

/** Entrance duration cap in ms; mirrors --duration-draw. */
export const DRAW_MS = 300

/** Draw-in transition for elements that must stay mounted while they exit (Modal, Toaster). */
export function hudDraw(_node: Element, params: { delay?: number } = {}): TransitionConfig {
  return {
    delay: params.delay ?? 0,
    duration: motion.reduced ? 0 : DRAW_MS,
    easing: cubicOut,
    css: (t) => `opacity: ${t}; transform: scale(${0.98 + 0.02 * t});`
  }
}
