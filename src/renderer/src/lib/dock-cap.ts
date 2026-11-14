/** The dock never takes more than this share of the conversation, not even for its first panel. */
export const DOCK_MAX_SHARE = 0.8
/** Without a reason to grow, the dock is at most this share of the conversation. */
export const DOCK_BASE_SHARE = 0.5

/**
 * The height limit for the dock in pixels, or null when a size is not known yet (then the base share
 * applies). The first panel always fits with its heading, so the limit is half the conversation or
 * the room that heading, panel and paddings take, whichever is larger, and never more than 80%.
 */
export function dockCap(
  conversationHeight: number,
  headingHeight: number,
  firstPanelHeight: number,
  paddings = 0
): number | null {
  if (!(conversationHeight > 0) || !(headingHeight > 0) || !(firstPanelHeight > 0)) return null
  const needed = headingHeight + firstPanelHeight + Math.max(0, paddings)
  return Math.min(
    Math.max(conversationHeight * DOCK_BASE_SHARE, needed),
    conversationHeight * DOCK_MAX_SHARE
  )
}
