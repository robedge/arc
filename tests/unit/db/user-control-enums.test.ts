import { describe, expect, it } from 'vitest'
import { AttentionRoute, UserControl } from '../../../src/main/db/schema'
import { attentionRequests, workers } from '../../../src/main/db/schema'
import { ATTENTION_ROUTE_VALUES, USER_CONTROL_VALUES } from '../../../src/shared/types/session'

describe('user-control enums', () => {
  it('shared UserControl matches the schema', () => {
    expect([...USER_CONTROL_VALUES].sort()).toEqual(Object.values(UserControl).sort())
    expect([...USER_CONTROL_VALUES].sort()).toEqual([...workers.userControl.enumValues!].sort())
  })

  it('shared AttentionRoute matches the schema', () => {
    expect([...ATTENTION_ROUTE_VALUES].sort()).toEqual(Object.values(AttentionRoute).sort())
    expect([...ATTENTION_ROUTE_VALUES].sort()).toEqual(
      [...attentionRequests.route.enumValues].sort()
    )
  })
})
