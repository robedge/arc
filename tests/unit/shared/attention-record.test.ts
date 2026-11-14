import { describe, expect, it } from 'vitest'
import { BRANCH_CHOICE_LABELS, recordText } from '../../../src/shared/attention-record'

describe('recordText', () => {
  it.each([
    [
      { decision: 'approved', subject: 'git push origin arc/fix-order-sync', from: 'W2 api-retry' },
      'Approved: git push origin arc/fix-order-sync (W2 api-retry)'
    ],
    [
      { decision: 'denied', subject: 'rm -rf build', from: 'W1 cleanup' },
      'Denied: rm -rf build (W1 cleanup)'
    ],
    [
      { decision: 'always', subject: 'npm install -g typescript', from: 'W3 web-fix' },
      'Always allowed in this session: npm install -g typescript (W3 web-fix)'
    ],
    [
      { decision: 'answered', subject: 'Which repository?', answer: 'web', from: 'Brain' },
      'Answered: Which repository? → web (Brain)'
    ],
    [
      { decision: 'declined', subject: 'Which repository?', from: 'Brain' },
      'Declined: Which repository? (Brain)'
    ],
    [
      { decision: 'branch', subject: 'api', answer: 'Set aside', from: 'Arc' },
      'Unsaved changes in api: Set aside (Arc)'
    ]
  ] as const)('says %j as one line', (fields, text) => {
    expect(recordText({ kind: 'attention-record', ...fields })).toBe(text)
  })

  it('says a failed unsaved-changes choice did not work', () => {
    expect(
      recordText({
        kind: 'attention-record',
        decision: 'branch',
        subject: 'api',
        answer: 'Bring them along',
        from: 'Arc',
        failed: true
      })
    ).toBe('Unsaved changes in api: Bring them along did not work (Arc)')
  })

  it('keeps the full text of a long subject', () => {
    const command = `echo ${'x'.repeat(300)}`
    expect(
      recordText({ kind: 'attention-record', decision: 'approved', subject: command, from: 'W1 a' })
    ).toBe(`Approved: ${command} (W1 a)`)
  })

  it('names the four unsaved-changes choices as their panel does', () => {
    expect(BRANCH_CHOICE_LABELS).toEqual({
      stash: 'Set aside',
      commit: 'Commit them first',
      carry: 'Bring them along',
      skip: "Don't start"
    })
  })
})
