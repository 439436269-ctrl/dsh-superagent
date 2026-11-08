import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/claim.ts'

/** A Cordis context stub carrying only what the claim plugin touches: the tool registry and the orchestrator. */
function context(setDispatcher: (id: string | null) => unknown, inbound = async (_f: string, _t: string, _i: string, _s: AbortSignal) => ({ delivered: '' })) {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
  const ctx = { tools: { register: (definition: never) => { registered.push(definition); return () => {} } },
    orchestrator: { setDispatcher, inbound, dispatcher: async () => ({ id: '', available: true, running: false }) } }
  return { ctx, registered }
}

describe('orchestrator_claim', () => {
  it('registers one tool that names the calling Session, not an argument', async () => {
    const setDispatcher = vi.fn(() => ({ dispatcher: 'session-caller' }))
    const { ctx, registered } = context(setDispatcher)
    // The registry is the plugin's only contract with the Host: one tool, no parameters.
    apply(ctx as never)
    // Two tools: claiming the role, and messaging the dispatcher from any Session.
    expect(registered.map(tool => tool.name)).toEqual(['orchestrator_claim', 'orchestrator_notify'])
    const claim = registered[0]!
    const result = await claim.execute({}, { agent: { id: 'session-caller' } })
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
  it('registers a second tool that labels the message with the calling Session', async () => {
    const setDispatcher = vi.fn(() => ({ dispatcher: 'session-caller' }))
    const inbound = vi.fn(async () => ({ delivered: 'orchestrator-default' }))
    const { ctx, registered } = context(setDispatcher, inbound)
    apply(ctx as never)
    const notify = registered.find(tool => tool.name === 'orchestrator_notify')!
    const result = await notify.execute({ text: 'please assign', intent: 'request' }, { agent: { id: 'session-caller' }, signal: AbortSignal.timeout(1000) })
    expect(inbound).toHaveBeenCalledWith('session-caller', 'please assign', 'request', expect.anything())
    expect(result).toEqual({ delivered: 'orchestrator-default' })
  })

  it('refuses a notify call without a Session or without text', async () => {
    const inbound = vi.fn(async () => ({ delivered: 'x' }))
    const { ctx, registered } = context(vi.fn(), inbound)
    apply(ctx as never)
    const notify = registered.find(tool => tool.name === 'orchestrator_notify')!
    await expect(notify.execute({ text: 'hi', intent: 'request' }, {})).rejects.toThrow(/no sender/)
    await expect(notify.execute({ text: '  ', intent: 'delegate' }, { agent: { id: 's' } })).rejects.toThrow(/empty/)
    expect(inbound).not.toHaveBeenCalled()
  })