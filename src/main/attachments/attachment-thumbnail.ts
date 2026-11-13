import { writeFile } from 'node:fs/promises'
import { nativeImage } from 'electron'
import type { MakeThumbnail } from './attachment-service'

export const THUMB_HEIGHT = 96

/** The real thumbnail maker. An image Electron cannot decode gives no thumbnail (false). */
export const makeNativeThumbnail: MakeThumbnail = async (src, dest) => {
  const image = nativeImage.createFromPath(src)
  if (image.isEmpty()) return false
  // Giving only a height keeps the aspect ratio; a small image is not enlarged.
  const thumb =
    image.getSize().height > THUMB_HEIGHT ? image.resize({ height: THUMB_HEIGHT }) : image
  await writeFile(dest, thumb.toPNG())
  return true
}
