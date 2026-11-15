/** Worker profiles: a plugin registers one, a Policy rule names it, and its Tickets run that preset, tools and instructions. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { WorkerRegistry } from '../src/workers.ts'
import { WORKER_PRESET, workToolNames } from '../src/app/sessions.ts'
import { ticketExecution } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const textile = { id: 'textile', name: { zh: '超盛纺织', en: 'Chaosheng textile' }, preset: 'chaosheng-textile-preset' }

it('registers a profile once, refuses an id another plugin holds, and removes it through its disposer', () => {
  const workers = new WorkerRegistry()
  const dispose = workers.register({ ...textile, tools: ['chaosheng_lookup'], instructions: 'Answer in one line.' })
  expect(workers.list()).toEqual([{ ...textile, tools: ['chaosheng_lookup'], instructions: 'Answer in one line.' }])
  expect(workers.get('textile')).toMatchObject({ preset: 'chaosheng-textile-preset' })
  expect(() => workers.register(textile)).toThrow('already registered')
  dispose()
  expect(workers.get('textile')).toBeUndefined()
  // A second registration after the first was disposed is allowed, as a reloading plugin needs.
  const again = workers.register(textile)
  expect(workers.list().map(profile => profile.id)).toEqual(['textile'])
  again()
})

it('refuses a profile a Session could not use', () => {
  const workers = new WorkerRegistry()
  expect(() => workers.register({ ...textile, id: 'not allowed' })).toThrow('Invalid worker profile id')
  expect(() => workers.register({ ...textile, preset: ' ' })).toThrow('names no agent preset')
  expect(() => workers.register({ ...textile, name: { zh: '', en: 'Textile' } })).toThrow('names no display name')
  expect(() => workers.register({ ...textile, sources: [''] } as never)).toThrow('names an invalid Source')
  expect(() => workers.register({ ...textile, tools: [' '] } as never)).toThrow('names an invalid tool')
})

it('matches a profile to the Sources it claims, lowest id first, and removes it through its disposer', () => {
  const workers = new WorkerRegistry()
  const dispose = workers.register({ ...textile, id: 'zz-textile', sources: ['feishu'] })
  workers.register({ ...textile, id: 'aa-textile', sources: ['feishu', 'github'] })
  expect(workers.match('feishu')).toMatchObject({ id: 'aa-textile' })
  expect(workers.match('github')).toMatchObject({ id: 'aa-textile' })
  expect(workers.match('session')).toBeUndefined()
  dispose()
  expect(workers.match('feishu')).toMatchObject({ id: 'aa-textile' })
})

it('lets a rule name a worker profile, with the id shape a rule id uses', () => {
  const parsed = SettingsSchema.parse({ policy: { rules: [{ id: 'lookup', name: 'Part lookup', enabled: true,
    instruction: 'Answer part questions.', worker: 'chaosheng-textile' }] } })
  expect(parsed.policy.rules[0]).toMatchObject({ worker: 'chaosheng-textile', workspace: true })
  expect(() => SettingsSchema.parse({ policy: { rules: [{ id: 'lookup', name: 'Part lookup', enabled: true,
    instruction: 'x', worker: 'has space' }] } })).toThrow()
})

it('records the worker a matched rule names when the Ticket is accepted', () => {
  const settings = SettingsSchema.parse({ policy: { rules: [
    { id: 'lookup', name: 'Part lookup', enabled: true, instruction: 'Answer part questions.', worker: 'chaosheng-textile' },
    { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix typos.' }] } })
  const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
    mandate: { strength: 'inferred', policyVersion: 'v1', basis: { rules: ['copy', 'lookup'] }, actor: { source: 'github', id: 'alice' },
      scope: '' } } as unknown as Ticket
  const execution = ticketExecution(ticket, { kind: 'accept', title: 'Look up a part', scope: 'the price', reason: 'r', name: 'lookup-part' } as never,
    settings, '/state')
  expect(execution.worker).toBe('chaosheng-textile')
  // A rule without a profile keeps the Ticket on the bundled worker.
  const plain = ticketExecution({ ...ticket, mandate: { ...ticket.mandate, basis: { rules: ['copy'] } } } as Ticket,
    { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo' } as never, settings, '/state')
  expect(plain).not.toHaveProperty('worker')
})

it('adds a profile\'s known domain tools to the bundled work tools, and nothing a profile does not know', () => {
  const profile = { ...textile, tools: ['chaosheng_lookup', 'not-installed'] }
  const names = workToolNames(profile, name => name !== 'not-installed')
  expect(names).toContain('chaosheng_lookup')
  expect(names).not.toContain('not-installed')
  for (const base of ['read', 'write', 'edit', 'pwsh', 'skill']) expect(names).toContain(base)
  expect(names).not.toContain('orchestrator_report')
  // A profile may add a tool, never remove one.
  expect(workToolNames({ ...profile, tools: [] }, () => true)).toContain('read')
})

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Accepts `trigger` under a rule that names `worker`, and returns the stored Ticket. */
async function acceptUnderWorker(rule: string, worker: string): Promise<Ticket> {
  h.runtime.workers.register({ ...textile, id: worker, tools: ['chaosheng_lookup'], instructions: 'Answer a part question in one line, with its price band.' })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, rules: [{ id: rule, name: 'Part lookup', enabled: true,
    instruction: 'Answer part questions.', workspace: false, worker }] } })
  const trigger = feishu('1', '@bot cs1701 price')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const decision = h.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Look up cs1701', scope: 'the price', reason: 'asked',
    rules: [rule], name: 'lookup-cs1701' } as never)
  expect(decision.kind).toBe('accept')
  await h.runtime.idle()
  return h.runtime.store.tickets.get(decision.ticketId!)!
}

it('runs a Ticket accepted under a worker rule with that profile\'s preset and instructions', async () => {
  const ticket = await acceptUnderWorker('lookup', 'textile')
  expect(ticket.execution).toMatchObject({ worker: 'textile', workless: true })
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `worker-${ticket.id}`, agentPreset: textile.preset }))
  const prompt = h.promptSections.get(`worker-${ticket.id}`)!.text({})
  expect(prompt).toContain('## Worker profile')
  expect(prompt).toContain('Answer a part question in one line, with its price band.')
  expect(prompt).toContain('You are a worker.')
})

it('runs a Ticket from a Source its profile claims, even when no rule names one', async () => {
  // The business bot's Feishu chat is the explicit-request path: the main Session accepts it, so no rule is recorded.
  h.runtime.workers.register({ ...textile, id: 'feishu-textile', sources: ['feishu'], instructions: 'Answer a part question in one line.' })
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot cs1701 price'))
  expect(ticket.execution?.worker).toBe('feishu-textile')
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `worker-${ticket.id}`, agentPreset: textile.preset }))
  expect(h.promptSections.get(`worker-${ticket.id}`)!.text({})).toContain('Answer a part question in one line.')
})

it('falls back to the bundled worker when the named profile is not registered', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, rules: [{ id: 'lookup', name: 'Part lookup', enabled: true,
    instruction: 'Answer part questions.', workspace: false, worker: 'removed' }] } })
  const trigger = feishu('1', '@bot cs1701 price')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const decision = h.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Look up cs1701', scope: 'the price', reason: 'asked',
    rules: ['lookup'], name: 'lookup-cs1701' } as never)
  const ticket = h.runtime.store.tickets.get(decision.ticketId!)!
  await h.runtime.idle()
  expect(ticket.execution?.worker).toBe('removed')
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `worker-${ticket.id}`, agentPreset: WORKER_PRESET }))
  expect(h.promptSections.get(`worker-${ticket.id}`)!.text({})).not.toContain('## Worker profile')
})
