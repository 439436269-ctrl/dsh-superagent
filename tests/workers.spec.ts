/** Worker profiles: a plugin registers one, a Policy rule names it or its match accepts a Trigger, and its Tickets run it. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { WorkerRegistry } from '../src/workers.ts'
import { WORKER_PRESET, workToolNames } from '../src/app/sessions.ts'
import { ticketExecution, workerSelection } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'
import { join } from 'node:path'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

const textile = { id: 'textile', preset: 'chaosheng-textile-preset' }
/** A ticket whose Mandate matched `rules`, as the Engine stores it before `prepare`. */
const ticketOf = (rules: string[]) => ({ id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
  mandate: { strength: 'inferred', policyVersion: 'v1', basis: { rules }, actor: { source: 'feishu', id: 'ou_alice' },
    scope: '' } }) as unknown as Ticket
const settingsOf = (rules: { id: string; worker?: string; workspace?: boolean }[]) => SettingsSchema.parse({ policy: { rules:
  rules.map(rule => ({ name: rule.id, enabled: true, instruction: `Rule ${rule.id}.`, ...rule })) } })

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

it('refuses a profile a Session could not use, and tools a worker must never get', () => {
  const workers = new WorkerRegistry()
  expect(() => workers.register({ ...textile, id: 'not allowed' })).toThrow('Invalid worker profile id')
  expect(() => workers.register({ ...textile, preset: ' ' })).toThrow('names no agent preset')
  expect(() => workers.register({ ...textile, preset: 42 } as never)).toThrow('names no agent preset')
  expect(() => workers.register({ ...textile, match: 'feishu' } as never)).toThrow('non-function match')
  expect(() => workers.register({ ...textile, tools: 'chaosheng_lookup' } as never)).toThrow('non-array tools')
  expect(() => workers.register({ ...textile, tools: [' '] } as never)).toThrow('names an invalid tool')
  for (const tool of ['ask_user_question', 'present', 'plugin_manager', 'plugin_market', 'schedule_task', 'goal_write', 'workflow_run']) {
    expect(() => workers.register({ ...textile, tools: [tool] })).toThrow('not a work tool')
  }
  // A profile may add a work tool it knows; the domain tools are not special to the registry.
  expect(() => workers.register({ ...textile, tools: ['chaosheng_lookup'] })).not.toThrow()
})

it('matches the first profile, by id, whose predicate accepts the Trigger', () => {
  const workers = new WorkerRegistry()
  const team = (trigger: { meta: Record<string, unknown> }) => trigger.meta.chatId === CHAT
  const dispose = workers.register({ ...textile, id: 'zz-textile', match: team })
  workers.register({ ...textile, id: 'aa-textile', match: team })
  workers.register({ ...textile, id: 'unclaimed' })
  expect(workers.match(feishu('1', '@bot hi'))).toMatchObject({ id: 'aa-textile' })
  dispose()
  expect(workers.match(feishu('1', '@bot hi'))).toMatchObject({ id: 'aa-textile' })
  expect(workers.match(feishu('1', '@bot hi', { chat_id: 'oc_other' }))).toBeUndefined()
  expect(workers.match(undefined)).toBeUndefined()
})

it('lets a rule name a worker profile, with the id shape a rule id uses', () => {
  const parsed = SettingsSchema.parse({ policy: { rules: [{ id: 'lookup', name: 'Part lookup', enabled: true,
    instruction: 'Answer part questions.', worker: 'chaosheng-textile' }] } })
  expect(parsed.policy.rules[0]).toMatchObject({ worker: 'chaosheng-textile', workspace: true })
  expect(() => SettingsSchema.parse({ policy: { rules: [{ id: 'lookup', name: 'Part lookup', enabled: true,
    instruction: 'x', worker: 'has space' }] } })).toThrow()
})

it('selects the profile a rule names, taking its workless setting, before any Trigger match', () => {
  const workers = new WorkerRegistry()
  workers.register({ ...textile, id: 'rule-worker', workless: false })
  workers.register({ ...textile, id: 'chat-worker', match: () => true, workless: true })
  const trigger = feishu('1', '@bot hi')
  expect(workerSelection(ticketOf(['lookup']), settingsOf([{ id: 'lookup', worker: 'rule-worker' }]), workers, trigger))
    .toEqual({ id: 'rule-worker' })
  // No rule names one: the Trigger match applies, with its workless setting.
  expect(workerSelection(ticketOf(['lookup']), settingsOf([{ id: 'lookup' }]), workers, trigger))
    .toEqual({ id: 'chat-worker', workless: true })
  // A rule that names an unregistered profile selects nothing; a Trigger match must not silently replace it.
  expect(workerSelection(ticketOf(['lookup']), settingsOf([{ id: 'lookup', worker: 'later' }]), workers, trigger))
    .toBeUndefined()
  // Several matched rules: the first in Policy order that names a worker wins.
  workers.register({ ...textile, id: 'second-worker' })
  expect(workerSelection(ticketOf(['a', 'b']), settingsOf([{ id: 'a' }, { id: 'b', worker: 'second-worker' }]), workers, trigger))
    .toEqual({ id: 'second-worker' })
})

it('records the selected profile and its workless setting on the Execution it builds', () => {
  const settings = settingsOf([{ id: 'copy' }])
  const outcome = { kind: 'accept', title: 'Look up a part', scope: 'the price', reason: 'r', name: 'lookup-part' } as never
  const withProfile = ticketExecution(ticketOf(['copy']), outcome, settings, '/state', undefined,
    { id: 'textile', workless: true })
  expect(withProfile).toMatchObject({ worker: 'textile', workless: true })
  expect(withProfile.directory.endsWith(join('answers', withProfile.name))).toBe(true)
  // No profile selected: the bundled worker and the rule's own workspace setting.
  const plain = ticketExecution(ticketOf(['copy']), outcome, settings, '/state')
  expect(plain).not.toHaveProperty('worker')
  expect(plain).not.toHaveProperty('workless')
  // A rule's workspace: false still means an empty folder even with no profile.
  const answers = ticketExecution(ticketOf(['help']), outcome, settingsOf([{ id: 'help', workspace: false }]), '/state')
  expect(answers).toMatchObject({ workless: true })
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
  // A profile whose preset lacks a work tool only gets what the preset actually registers: the allow list cannot invent it.
  expect(workToolNames(undefined, name => name === 'read')).toEqual(['read'])
  expect(workToolNames({ ...textile, tools: ['chaosheng_lookup'] }, name => name === 'chaosheng_lookup')).toEqual(['chaosheng_lookup'])
})

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** Accepts `trigger` under `rule`, which must be registered with the profile the test wants, and returns the Ticket. */
async function acceptUnderRule(rule: string, workspace = true): Promise<Ticket> {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, rules: [{ id: rule, name: 'Part lookup', enabled: true,
    instruction: 'Answer part questions.', workspace, worker: 'textile' }] } })
  const trigger = feishu('1', '@bot cs1701 price')
  h.runtime.receive(trigger)
  await h.runtime.idle()
  const decision = h.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Look up cs1701', scope: 'the price', reason: 'asked',
    rules: [rule], name: 'lookup-cs1701' } as never)
  expect(decision.kind).toBe('accept')
  await h.runtime.idle()
  return h.runtime.store.tickets.get(decision.ticketId!)!
}

it('runs a Ticket accepted under a worker rule with that profile\'s preset, workless folder and instructions', async () => {
  h.runtime.workers.register({ ...textile, tools: ['chaosheng_lookup'], workless: true,
    instructions: 'Answer a part question in one line, with its price band.' })
  const ticket = await acceptUnderRule('lookup', true)
  expect(ticket.execution).toMatchObject({ worker: 'textile', workless: true })
  expect(ticket.execution?.directory.endsWith(join('answers', ticket.execution.name))).toBe(true)
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `worker-${ticket.id}`, agentPreset: textile.preset }))
  const prompt = h.promptSections.get(`worker-${ticket.id}`)!.text({})
  expect(prompt).toContain('## Worker profile')
  expect(prompt).toContain('Answer a part question in one line, with its price band.')
  expect(prompt).toContain('You are a worker.')
})

it('lets a profile claim one Feishu chat, not the whole Source kind or another chat', async () => {
  // The fixture listens to oc_team only; let it also receive mentions in other chats so the second ticket exists.
  const settings = h.runtime.store.settings()
  const feishuSource = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    feishu: { ...feishuSource, config: { ...feishuSource.config, otherChats: 'mentions' } } } })
  h.runtime.workers.register({ ...textile, id: 'chat-textile', workless: true,
    match: trigger => trigger.meta.chatId === CHAT, instructions: 'Answer a part question in one line.' })
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot cs1701 price'))
  expect(ticket.execution).toMatchObject({ worker: 'chat-textile', workless: true })
  expect(h.promptSections.get(`worker-${ticket.id}`)!.text({})).toContain('Answer a part question in one line.')
  // The same kind in another chat is not claimed: the explicit accept records no profile.
  const other = await h.acceptedTicket(feishu('5', '@bot other chat', { chat_id: 'oc_other' }))
  expect(other.ticket.execution).not.toHaveProperty('worker')
})

it('falls back to the bundled worker for a rule that names a profile no plugin registered', async () => {
  const ticket = await acceptUnderRule('lookup', true)
  expect(ticket.execution).not.toHaveProperty('worker')
  expect(ticket.execution).not.toHaveProperty('workless')
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `worker-${ticket.id}`, agentPreset: WORKER_PRESET }))
  expect(h.promptSections.get(`worker-${ticket.id}`)!.text({})).not.toContain('## Worker profile')
})

it('does not half-apply a profile registered after the Ticket was accepted', async () => {
  const ticket = await acceptUnderRule('lookup', true)
  expect(ticket.execution).not.toHaveProperty('worker')
  // The profile appears later; the Session already runs the bundled preset, so its instructions must not appear either.
  h.runtime.workers.register({ ...textile, instructions: 'A late instruction.' })
  await h.runtime.idle()
  expect(h.promptSections.get(`worker-${ticket.id}`)!.text({})).not.toContain('A late instruction.')
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `worker-${ticket.id}`, agentPreset: WORKER_PRESET }))
})

