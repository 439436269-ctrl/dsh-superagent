/**
 * Session source kind: another DSH Session hands work over, and replies go back into that Session.
 *
 * Built but not yet registered (see docs/012-dispatcher.md): registering it makes delegations enter the normal pipeline
 * (Trigger → admission → assessment → Ticket) instead of only messaging the dispatcher. The builders here are pure so
 * they can be tested without a Host.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Localized, SourceKind } from './kind.ts'

export const SESSION_SOURCE = 'session'

/** The Host service this plugin registers the kind on. */
export const inject = ['orchestrator']

const zh = (text: string): Localized => ({ zh: text, en: text })

/** `session:<id>`: one Session is one Thread, so every message from it continues the same line of work. */
export const sessionThreadId = (session: string): string => `${SESSION_SOURCE}:${session}`

/** The channel a reply goes to: the Session that sent the message. */
export const sessionChannel = (session: string) => ({ source: SESSION_SOURCE, thread: sessionThreadId(session), address: { session } })

/**
 * Builds the Trigger for one delegation. `human` is true because a person drives that Session, and `addressed` is
 * `direct` because the message was sent to this agent rather than mentioned in a shared chat.
 */
export function sessionTrigger(input: { session: string; id: string; text: string; at?: string; intent?: string }) {
  return {
    id: `${SESSION_SOURCE}:${input.session}:${input.id}`,
    source: SESSION_SOURCE,
    threads: [{ source: SESSION_SOURCE, id: sessionThreadId(input.session) }],
    actor: { source: SESSION_SOURCE, id: input.session },
    human: true,
    addressed: 'direct' as const,
    at: input.at ?? new Date().toISOString(),
    text: input.text,
    channel: sessionChannel(input.session),
    meta: { sessionId: input.session, ...(input.intent ? { intent: input.intent } : {}) },
  }
}

/** How a reply reaches a Session; set by the Runtime, which owns the Session service. */
let deliver: ((session: string, text: string) => Promise<'sent' | 'gone'>) | undefined

/** Wires the reply channel to the Session service; called once by the Runtime at start-up. */
export const setSessionDeliver = (fn: typeof deliver): void => { deliver = fn }

export const SessionConfigSchema = z.object({}).strict()

export const sessionKind: SourceKind<Record<string, never>> = {
  kind: SESSION_SOURCE,
  title: { zh: '会话', en: 'Sessions' },
  description: {
    zh: '其他 DSH 会话发来的请求与委派；回复回到那个会话。',
    en: 'Requests and delegations from other DSH Sessions; replies go back to that Session.',
  },
  schema: SessionConfigSchema,
  fields: [],
  health: [],
  // Replies go back into the Session that delegated the work. Without a delivery hook the kind reports `gone`, so a
  // missing wiring shows up instead of silently dropping the answer.
  channel: {
    send: async (_host, message) => {
      const session = String((message.channel as { address?: { session?: string } }).address?.session ?? '')
      if (!session || !deliver) return 'gone' as const
      return deliver(session, message.text)
    },
    link: () => ({ url: '', label: { zh: '会话', en: 'Session' } }),
  },
}

/** Registers the kind; delegation traffic itself arrives through `Runtime.inbound`. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(sessionKind), 'session: source kind')
}