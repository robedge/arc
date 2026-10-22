import { expect, it } from 'vitest'
import { exactTokens, formatTokens } from '../../src/renderer/src/lib/format/tokens'

it.each([
  [0, '0'],
  [999, '999'],
  [1000, '1k'],
  [12_400, '12.4k'],
  [84_000, '84k'],
  [999_949, '999.9k'],
  [999_950, '1M'],
  [1_200_000, '1.2M'],
  [-5, '0'],
  [NaN, '0']
])('formatTokens(%s) is %s', (n, text) => {
  expect(formatTokens(n)).toBe(text)
})

it('groups the exact count', () => {
  expect(exactTokens(12_412)).toBe('12,412')
  expect(exactTokens(0)).toBe('0')
  expect(exactTokens(NaN)).toBe('0')
})
