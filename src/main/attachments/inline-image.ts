/**
 * The largest image an adapter inlines as base64 (tech spec 2.8): an image of this many bytes or fewer, by its size
 * on disk at send time, is inlined; a larger one goes by path only. The Claude and Cursor adapters share it.
 */
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
