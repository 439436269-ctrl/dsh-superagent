/**
 * Generic IM bridge: a child process speaks newline-delimited JSON, so supporting a chat tool needs only a small adapter,
 * never a change to the core. The bridge owns every credential; the agent sees chat ids, names and text.
 *
 * The bridge is started as `<command> <args...> receive` and prints one JSON object per line:
 *   {"type":"message","id":"…","chat":"…","chatName":"…","direct":false,"from":"…","fromName":"…",
 *    "text":"…","at":"2026-01-01T00:00:00Z","mentionsBot":true,"fromBot":false,"replyTo":"…","url":"…"}
 *   {"type":"chats","chats":[{"id":"…","name":"…"}]}
 *   {"type":"log","message":"…"}
 * A message is sent by running `<command> <args...> send <json>`, where <json> is
 *   {"type":"send","id":"…","chat":"…","text":"…","direct":false}
 * and the adapter prints {"type":"sent"} (or exits 0), {"type":"error","message":"…"} (or exits non-zero), or exits 3 when
 * the chat can no longer receive messages. See docs/009-im-bridge.md.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'
import type { ImConfig } from './im.ts'

export const SOURCE = 'im'
/** Exit code an adapter uses to say the target conversation is gone, so the Outbox drops the message instead of retrying. */
export const GONE = 3
/** Splits the configured argument text, honouring single and double quotes so a path with spaces survives. */
export const splitArgs = (text: string): string[] => [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
  .map(match => match[1] ?? match[2] ?? match[3] ?? '').filter(Boolean)

/** Constructs an IM reply channel address; it carries the bridge entry point so a send needs no shared state. */
export const imChannel = (chat: string, messageId: string, direct: boolean, bridge: string, args: string[], url?: string): ChannelRef => ({
  source: SOURCE, thread: `${SOURCE}:${chat}`,
  address: { chat, messageId, bridge, ...direct ? { direct: 'true' } : {}, ...args.length ? { args: JSON.stringify(args) } : {}, ...url ? { url } : {} },
})

const MessageSchema = z.object({
  type: z.literal('message'),
  id: z.string().min(1).max(200),
  chat: z.string().min(1).max(200),
  chatName: z.string().max(200).optional(),
  direct: z.boolean().default(false),
  from: z.string().min(1).max(200),
  fromName: z.string().max(200).optional(),
  text: z.string().default(''),
  at: z.string().optional(),
  mentionsBot: z.boolean().default(false),
  fromBot: z.boolean().default(false),
  replyTo: z.string().nullish(),
  url: z.string().nullish(),
}).loose()
const ChatsSchema = z.object({ type: z.literal('chats'), chats: z.array(z.object({ id: z.string(), name: z.string().optional() }).loose()) })
const LogSchema = z.object({ type: z.literal('log'), message: z.string(), level: z.string().optional() })
export type ImMessage = z.infer<typeof MessageSchema>

/** Converts one bridge message into a domain Trigger; a bot's own message never becomes one. */
export function imTrigger(message: ImMessage, bridge: string, args: string[]): Trigger | undefined {
  if (message.fromBot) return undefined
  const at = message.at ? new Date(message.at) : new Date()
  return {
    id: key(SOURCE, `${message.chat}/${message.id}`), source: SOURCE,
    threads: [{ source: SOURCE, id: message.chat }],
    actor: { source: SOURCE, id: message.from }, human: true,
    ...message.direct ? { addressed: 'direct' as const } : message.mentionsBot ? { addressed: 'mention' as const } : {},
    at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    text: message.text,
    channel: imChannel(message.chat, message.id, message.direct, bridge, args, message.url ?? undefined),
    ...message.url ? { url: message.url } : {},
    meta: { chatId: message.chat, messageId: message.id, direct: message.direct, mentioned: message.mentionsBot,
      ...message.fromName ? { fromName: message.fromName } : {}, ...message.replyTo ? { replyTo: message.replyTo } : {} },
  }
}

const rest = async (ms: number, signal: AbortSignal): Promise<void> => { await delay(ms, undefined, { signal }).catch(() => { /* aborted */ }) }

/** Names the instance on a Trigger's Channel when it is not the kind's default one, so admission resolves that instance's chats. */
const stampInstance = <T extends { channel?: { address: Record<string, string> } }>(trigger: T, instance: string): T =>
  instance === 'im' || !trigger.channel ? trigger
    : { ...trigger, channel: { ...trigger.channel, address: { ...trigger.channel.address, instance } } }

/** Runs the bridge for as long as the Source is on, restarting it with a bounded backoff when it exits. */
export async function runIm(ctx: SourceContext, signal: AbortSignal, instance = 'im'): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    // The context is bound to one instance, so this reads that instance's configuration rather than the kind's first.
  const config = ctx.config<ImConfig>()
    if (!config?.command) {
      ctx.report('im', { state: 'paused', detail: 'The IM Source has no bridge command' })
      await rest(5000, signal)
      continue
    }
    const started = Date.now()
    try {
      await listen(ctx, config, signal, instance)
      if (signal.aborted) return
      failures = Date.now() - started < 5000 ? failures + 1 : 0
      ctx.report('im', { state: failures ? 'error' : 'starting', detail: `The bridge exited; restarting (attempt ${failures + 1})` })
    } catch (error) {
      if (signal.aborted) return
      failures += 1
      ctx.report('im', { state: 'error', detail: `The bridge failed: ${error instanceof Error ? error.message : String(error)}` })
    }
    await rest(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), signal)
  }
}

/** Spawns the bridge, ingests its lines until it exits, and resolves when it ends. */
function listen(ctx: SourceContext, config: ImConfig, signal: AbortSignal, instance = 'im'): Promise<void> {
  const args = [...splitArgs(config.args), 'receive']
  return new Promise((resolve, reject) => {
    // This instance's own environment comes last, so it can override a shared credential without touching the service.
  const child = spawn(config.command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...config.env } })
    let settled = false
    let stderr = ''
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', kill)
      error ? reject(error) : resolve()
    }
    const kill = (): void => { child.kill() }
    signal.addEventListener('abort', kill, { once: true })
    child.on('error', (error: Error) => finish(error))
    child.on('exit', (code, signalName) => finish(code === 0 || signal.aborted ? undefined : new Error(`the bridge exited with ${code ?? signalName}${stderr ? `: ${stderr.trim()}` : ''}`)))
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000) })
    ctx.report('im', { state: 'ready', detail: `The bridge runs ${config.command}`, at: new Date().toISOString() })
    let queue = Promise.resolve()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line: string) => { queue = queue.then(() => ingest(ctx, config, line, instance)).catch(() => { /* a bad line never stops the bridge */ }) })
  })
}

/** Applies one bridge line: a message becomes a Trigger, names refresh the chat labels, logs are ignored. */
async function ingest(ctx: SourceContext, config: ImConfig, line: string, instance = 'im'): Promise<void> {
  if (!line.trim()) return
  let value: unknown
  try { value = JSON.parse(line) } catch { return }
  const message = MessageSchema.safeParse(value)
  if (message.success) {
    const trigger = imTrigger(message.data, config.command, splitArgs(config.args))
    if (!trigger) return
    await ctx.receive(stampInstance(trigger, instance))
    if (message.data.chatName) labels(ctx, { [message.data.chat]: message.data.chatName })
    ctx.threads.describe(`${SOURCE}:${message.data.chat}`, { label: message.data.chatName ?? message.data.chat })
    return
  }
  const chats = ChatsSchema.safeParse(value)
  if (chats.success) { labels(ctx, Object.fromEntries(chats.data.chats.map(chat => [chat.id, chat.name ?? chat.id]))); return }
  if (LogSchema.safeParse(value).success) ctx.report('im', { state: 'ready', detail: (value as { message: string }).message })
}

/** Merges chat names into the Source's label record, which the panel and Threads read. */
function labels(ctx: SourceContext, names: Record<string, string>): void {
  ctx.state.set(KV.sources.labels(SOURCE), { ...ctx.state.get(KV.sources.labels(SOURCE)) ?? {}, ...names })
}

/** Sends one message through the bridge; exit code {@link GONE} means the conversation can no longer receive replies. */
export async function sendIm(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { chat, bridge, args, direct, url: _url } = message.channel.address
  if (!chat || !bridge) throw new Error('Missing IM reply target')
  const payload = JSON.stringify({ type: 'send', id: message.id, chat, text: checkedImText(message.text), direct: direct === 'true' })
  try { await host.commands.run(bridge, [...args ? JSON.parse(args) as string[] : [], 'send', payload]) }
  catch (error) {
    if (error instanceof CliError && error.exitCode === GONE) return 'gone'
    throw error
  }
  return 'sent'
}
