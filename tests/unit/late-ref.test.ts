import { describe, expect, it } from 'vitest'
import { LateRef } from '../../src/main/app/late-ref'

describe('LateRef', () => {
  it('returns the bound value', () => {
    const ref = new LateRef<number>('a number')
    ref.bind(3)
    expect(ref.get()).toBe(3)
  })

  it('throws loudly when read before it is bound', () => {
    expect(() => new LateRef<number>('the thing').get()).toThrow('the thing was used before')
  })

  it('refuses to be bound twice', () => {
    const ref = new LateRef<number>('a number')
    ref.bind(1)
    expect(() => ref.bind(2)).toThrow('already bound')
  })
})
