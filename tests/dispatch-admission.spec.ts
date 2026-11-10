import { describe, expect, it } from 'vitest'
import type { SourceScope } from '../src/policy.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import type { Trigger } from '../src/core/index.ts'

/** A dispatched request says where it came from; the gate must not consult a Source's allow-list for it. */
const dispatched = (dispatched = true): Trigger => ({
  id: 'dispatched:local/2026-11-11T00:00:00.000Z', source: 'dispatched',
  threads: [{ source: 'dispatched', id: 'local' }],
  actor: { source: 'dispatched', id: 'person' }, human: true, addressed: 'direct',
  at: '2026-11-11T00:00:00.000Z', text: 'build a notes app',
  meta: { ...dispatched ? { dispatched: 'true' } : {} },
})

describe('admission of a dispatched request', () => {
  it('admits it as explicit without asking any Source about its allow-list', () => {
    // A Source that would refuse anything: the dispatch must never reach it.
    const sources = { scope: () => { throw new Error('the gate consulted a Source for a dispatch') } } as unknown as SourceScope
    const policy = settingsPolicy(SettingsSchema.parse({}), sources)
    const verdict = policy.gate(dispatched(), undefined, [])
    expect(verdict).toMatchObject({ admissible: true, strength: 'explicit', basis: { addressed: 'direct', via: 'addressed' } })
  })
})
