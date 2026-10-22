import { randomFillSync } from 'node:crypto'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Generates a 26-character ULID (48-bit ms timestamp + 80 bits of randomness). */
export function ulid(now: number = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = alphabet.charAt(t % 32) + time
    t = Math.floor(t / 32)
  }
  const bytes = randomFillSync(new Uint8Array(16))
  let random = ''
  for (const b of bytes) random += alphabet.charAt(b % 32)
  return time + random
}
