import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/claim.ts'

/** A Cordis context stub carrying only what the claim plugin touches: the tool registry and the orchestrator. */
function context(setDispatcher: (id: string | null) => unknown) {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
  const ctx = { tools: { register: (definition: never) => { registered.push(definition); return () => {} } },
    orchestrator: { setDispatcher, dispatcher: async () => ({ id: '', available: true, running: false }) } }
  return { ctx, registered }
}

describe('orchestrator_claim', () => {
  it('registers one tool that names the calling Session, not an argument', async () => {
    const setDispatcher = vi.fn(() => ({ dispatcher: 'session-caller' }))
    const { ctx, registered } = context(setDispatcher)
    // The registry is the plugin's only contract with the Host: one tool, no parameters.
    apply(ctx as never)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.name).toBe('orchestrator_claim')
    const result = await registered[0]!.execute({}, { agent: { id: 'session-caller' } })
    expect(setDispatcher).toHaveBeenCalledWith('session-caller')
    expect(result).toEqual({ dispatcher: 'session-caller', claimed: true })
  })

  it('refuses a call that carries no Session instead of guessing one', async () => {
    const setDispatcher = vi.fn(() => ({ dispatcher: '' }))
    const { ctx, registered } = context(setDispatcher)
    apply(ctx as never)
    // A nested dispatch may arrive without an agent; claiming on its behalf would move the role to the wrong place.
    await expect(registered[0]!.execute({}, {})).rejects.toThrow(/carries no Session/)
    expect(setDispatcher).not.toHaveBeenCalled()
  })
})