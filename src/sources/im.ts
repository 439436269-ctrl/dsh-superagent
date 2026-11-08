/** Generic IM source kind: any chat tool reaches dsh-superagent through a bridge adapter (docs/009-im-bridge.md). */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key } from '../core/index.ts'
import { imTrigger, runIm, sendIm, SOURCE, splitArgs } from './im-bridge.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export { SOURCE } from './im-bridge.ts'
// Bridge ids are opaque: DingTalk pads its conversation ids with =, so the alphabet covers base64 as well.
const ChatIdSchema = z.string().trim().regex(/^[A-Za-z0-9_:@.@+=\/=-]{1,200}$/, 'A chat id from your bridge')
export const ImConfigSchema = z.object({
  /** The adapter executable, a command name or an absolute path. */
  command: z.string().trim().max(1000).default(''),
  /** Arguments before the mode word, split on whitespace. */
  args: z.string().trim().max(2000).default(''),
  chats: z.array(z.object({ chatId: ChatIdSchema, name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  /**
   * Environment for this instance's bridge, on top of the process environment: how two instances of the same kind carry
   * their own credentials instead of sharing the service's.
   */
  env: z.record(z.string(), z.string()).default({}),
}).strict()
export type ImConfig = z.infer<typeof ImConfigSchema>

const zh = (text: string): Localized => ({ zh: text, en: text })

export const imKind: SourceKind<ImConfig> = {
  kind: SOURCE,
  title: { zh: 'IM 桥接', en: 'IM bridge' },
  description: {
    zh: '通过一个桥接进程接入任意 IM：桥接负责收发，智能体只看到会话 id、名称和文本。',
    en: 'Reaches any chat tool through a bridge process: the bridge sends and receives, the agent sees chat ids, names and text.',
  },
  schema: ImConfigSchema,
  fields: [
    { key: 'command', type: 'text', label: { zh: '桥接命令', en: 'Bridge command' },
      hint: { zh: '命令名或绝对路径，例如 node。缺少它时这个来源只显示配置提示，不接收消息。', en: 'A command name or absolute path, such as node. Without it the Source only shows a setup hint and receives nothing.' } },
    { key: 'args', type: 'text', label: { zh: '命令参数', en: 'Command arguments' },
      hint: { zh: '空格分隔，放在模式词之前，例如桥接脚本的路径。', en: 'Space separated, placed before the mode word, such as the path of a bridge script.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的会话', en: 'Chats' },
      hint: { zh: '“仅 @”接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可按规则从中推断工作。', en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '会话', en: 'Chat' }, pattern: '[A-Za-z0-9_:@.+=\/-]{1,200}' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他会话', en: 'Other chats' },
      options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }] },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
  ],
  health: ['im'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) => imKind.scope!({ meta: { chatId: address.chat ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendIm,
    link: address => ({
      url: address.url ?? '', label: { zh: 'IM 消息', en: 'IM message' },
      ...address.chat && address.messageId ? { triggerId: key(SOURCE, `${address.chat}/${address.messageId}`) } : {},
    }),
  },
  find: query => ({ threads: [], terms: [] }),
  policy: {
    unnamed: { person: { zh: 'IM 用户', en: 'IM user' }, bot: { zh: 'IM 机器人', en: 'IM bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_:@.+-]{1,200}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user ids').default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_:@.+-]{1,200}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 IM 用户', en: 'IM users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 id', en: 'User id' }, pattern: '[A-Za-z0-9_:@.+=\/-]{1,200}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人在接收的会话里发的消息成为推断的候选；它们不能发起明确请求，也不能停止工单。', en: 'Messages of a bot on this list, in chats the Source receives, become inferred candidates; they never make an explicit request or stop a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '机器人 id', en: 'Bot id' }, pattern: '[A-Za-z0-9_:@.+=\/-]{1,200}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = ImConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? zh('全部消息') : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他会话', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : zh('不接收'),
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? zh('接收') : zh('不接收'),
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_IM_CHAT', description: { zh: '接这个工单的 IM 会话 id；工单不是从 IM 来的时为空', en: 'Chat id of the IM chat that started the ticket; empty when the ticket did not start on IM' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_IM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
  facts: () => ({}),
}

/** Returns the IM Source's settings, falling back to schema defaults while the IM plugin is disabled. */
export const imSettings = (sources: SourceRegistry): ImConfig => sources.instance<ImConfig>(SOURCE)?.config ?? ImConfigSchema.parse({})

export const name = 'dsh-superagent-im'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(imKind), 'im: source kind')
  ctx.effect(() => {
    // One loop per instance of this kind: each bridge reads its own configuration, so two chat tools never share a
    // process, a cursor, or credentials.
    const instances = ctx.orchestrator.sources.instances().filter(instance => instance.kind === imKind.kind)
    const controllers: AbortController[] = []
    const running = instances.map(instance => {
      const controller = new AbortController()
      controllers.push(controller)
      return runIm(sourceContext(ctx.orchestrator, imKind, instance.id), controller.signal)
    })
    return async () => {
      for (const controller of controllers) controller.abort()
      await Promise.allSettled(running)
    }
  })
}
