#!/usr/bin/env node
/**
 * Telegram bridge for the generic IM Source (docs/009-im-bridge.md).
 *
 *   TELEGRAM_BOT_TOKEN=123:abc node examples/im-bridges/telegram.mjs receive
 *   node examples/im-bridges/telegram.mjs send '{"type":"send","id":"…","chat":"…","text":"…"}'
 *
 * No dependency: it uses the Bot API over fetch. The token stays in this process's environment, so the agent's Sessions
 * never see it. Restarting re-reads updates from the last offset Telegram still keeps; the core deduplicates by message id.
 */
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('telegram.mjs: TELEGRAM_BOT_TOKEN is not set')
  process.exit(2)
}
const api = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
/** Prints one protocol line; the core reads them one per line. */
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const mode = process.argv[2]
if (mode === 'send') {
  const payload = JSON.parse(process.argv[3] ?? '{}')
  const response = await api('sendMessage', { chat_id: payload.chat, text: payload.text, disable_web_page_preview: true })
  if (response.ok) { emit({ type: 'sent' }); process.exit(0) }
  const body = await response.json().catch(() => ({}))
  // 403 means the bot was removed or blocked: the conversation can never receive another reply.
  if (response.status === 403) process.exit(3)
  emit({ type: 'error', message: `Telegram ${response.status}: ${body.description ?? 'unknown error'}` })
  process.exit(1)
}

if (mode !== 'receive') {
  console.error('telegram.mjs: expected `receive` or `send <json>`')
  process.exit(2)
}

const me = await (await api('getMe')).json()
const username = me.ok ? me.result.username : undefined
emit({ type: 'log', message: `Telegram bridge running as @${username ?? 'unknown'}` })

let offset = 0
let stopped = false
process.on('SIGINT', () => { stopped = true; process.exit(0) })
process.on('SIGTERM', () => { stopped = true; process.exit(0) })

while (!stopped) {
  let response
  try {
    response = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'edited_message'] })
  } catch (error) {
    emit({ type: 'log', message: `poll failed: ${error.message}` })
    await sleep(5000)
    continue
  }
  if (response.status === 401) {
    console.error('telegram.mjs: the bot token was rejected')
    process.exit(1)
  }
  if (response.status === 429) {
    const retry = Number((await response.json().catch(() => ({}))).parameters?.retry_after ?? 5)
    await sleep(Math.min(60, retry) * 1000)
    continue
  }
  if (!response.ok) {
    emit({ type: 'log', message: `Telegram ${response.status}` })
    await sleep(5000)
    continue
  }
  const { result = [] } = await response.json()
  for (const update of result) {
    offset = update.update_id + 1
    const message = update.message ?? update.edited_message
    if (!message) continue
    const text = message.text ?? message.caption ?? ''
    if (!text) continue
    const from = message.from ?? {}
    emit({
      type: 'message',
      id: String(message.message_id),
      chat: String(message.chat.id),
      chatName: message.chat.title ?? [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || message.chat.username || String(message.chat.id),
      direct: message.chat.type === 'private',
      from: String(from.id ?? ''),
      fromName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id ?? ''),
      text,
      at: new Date(message.date * 1000).toISOString(),
      mentionsBot: !!username && new RegExp(`@${username}\\b`, 'i').test(text),
      fromBot: from.is_bot === true,
      replyTo: message.reply_to_message ? String(message.reply_to_message.message_id) : null,
    })
  }
}
