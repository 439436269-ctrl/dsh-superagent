#!/usr/bin/env node
/**
 * Skeleton for an IM bridge (docs/009-im-bridge.md). Copy it, rename it, and fill the four marked places: your IM's
 * "read new messages" API, its "send message" API, its mention test, and its "conversation is gone" signal.
 *
 * Keep every credential in this process's environment. Nothing here reaches the agent's Sessions.
 */
const mode = process.argv[2]
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)

if (mode === 'send') {
  const payload = JSON.parse(process.argv[3] ?? '{}')
  // 1. Send `payload.text` to `payload.chat`.
  // 2. Exit 0 (or print {"type":"sent"}) on success, exit 3 when the conversation can no longer receive messages,
  //    and exit 1 with a message on stderr for a failure worth retrying.
  emit({ type: 'sent' })
  process.exit(0)
}

if (mode !== 'receive') {
  console.error('bridge.mjs: expected `receive` or `send <json>`')
  process.exit(2)
}

// 3. Read new messages until the process is stopped, printing one line each. Long-polling, a webhook, or a socket are
//    all fine; only the shape of the line matters.
async function nextBatch() {
  return []
}

while (true) {
  for (const raw of await nextBatch()) {
    emit({
      type: 'message',
      id: String(raw.id),                       // unique inside the chat; the core deduplicates by it
      chat: String(raw.chat),
      chatName: raw.chatName,                   // optional, shown in the panel
      direct: !!raw.direct,                     // a one-to-one conversation: no mention needed
      from: String(raw.from),
      fromName: raw.fromName,                   // optional
      text: raw.text,
      at: new Date().toISOString(),
      mentionsBot: false,                       // 4. true when the message addresses the bot
      fromBot: false,                           // true when a bot wrote it; the core ignores those
      replyTo: raw.replyTo ?? null,             // optional; the thread is the chat itself
    })
  }
  await new Promise(resolve => setTimeout(resolve, 3000))
}
