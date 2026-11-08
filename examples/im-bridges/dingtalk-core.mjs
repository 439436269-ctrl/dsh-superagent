/**
 * Pure parts of the DingTalk bridge: signing, constant-time comparison and the callback-to-line mapping. The executable
 * wrapper is `dingtalk.mjs`, which keeps a shebang; keeping the logic here lets tests import it without a shebang.
 */
import { createHmac } from 'node:crypto'

/** DingTalk signs `timestamp + "\n" + secret` with HMAC-SHA256 and sends it base64 encoded. */
export function sign(secret, timestamp) {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
}

/** Compares two signatures without stopping at the first differing character. */
export function same(left, right) {
  const a = String(left ?? ''), b = String(right ?? '')
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Turns one DingTalk robot callback body into the line shape the core expects. */
export function message(body) {
  const text = body?.text?.content ?? ''
  return {
    type: 'message',
    id: String(body?.msgId ?? `${body?.conversationId}:${body?.createAt ?? Date.now()}`),
    chat: String(body?.conversationId ?? ''),
    chatName: body?.conversationTitle ?? undefined,
    direct: body?.conversationType === '1',
    from: String(body?.senderStaffId ?? body?.senderId ?? ''),
    fromName: body?.senderNick ?? undefined,
    text,
    at: new Date(Number(body?.createAt ?? Date.now())).toISOString(),
    // DingTalk says whether this robot is in the message's @ list. A group can hold several robots, and each one's stream sees
    // the same conversation, so this flag is what keeps a message from being treated as addressed to every robot in it.
    // A payload without the field (a direct message, or an older shape) counts as addressed to this robot.
    mentionsBot: body?.isInAtList === undefined ? true : body.isInAtList === true,
    fromBot: false,
    replyTo: null,
  }
}