import { describe, expect, it } from 'vitest'
import { SESSION_SOURCE, sessionChannel, sessionThreadId, sessionTrigger } from '../src/sources/session.ts'

describe('session source kind', () => {
  it('puts every message from one Session on the same Thread', () => {
    expect(sessionThreadId('s1')).toBe('session:s1')
    const first = sessionTrigger({ session: 's1', id: 'm1', text: 'a' })
    const second = sessionTrigger({ session: 's1', id: 'm2', text: 'b' })
    expect(first.threads).toEqual(second.threads)
    expect(first.id).not.toBe(second.id)
  })

  it('builds a trigger a person drives and that addresses this agent directly', () => {
    const trigger = sessionTrigger({ session: 's1', id: 'm1', text: '修一下 README', at: '2026-11-08T00:00:00.000Z', intent: 'delegate' })
    expect(trigger).toMatchObject({
      source: SESSION_SOURCE, human: true, addressed: 'direct', text: '修一下 README', at: '2026-11-08T00:00:00.000Z',
      actor: { source: SESSION_SOURCE, id: 's1' }, meta: { sessionId: 's1', intent: 'delegate' },
    })
  })

  it('sends replies back to the Session that sent the message', () => {
    expect(sessionChannel('s1')).toEqual({ source: SESSION_SOURCE, thread: 'session:s1', address: { session: 's1' } })
  })
})