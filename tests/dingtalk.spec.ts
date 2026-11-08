import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
// @ts-expect-error -- the bridge is plain ESM, shipped without type declarations
import { message, same, sign } from '../examples/im-bridges/dingtalk-core.mjs'

describe('dingtalk bridge', () => {
  it('signs the way DingTalk asks: base64 of HMAC-SHA256 over timestamp + newline + secret', () => {
    const secret = 'sec'
    const timestamp = 1700000000000
    expect(sign(secret, timestamp)).toBe(createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'))
  })

  it('compares signatures without short-circuiting on the first differing character', () => {
    expect(same('abc', 'abc')).toBe(true)
    expect(same('abc', 'abd')).toBe(false)
    expect(same('abc', 'ab')).toBe(false)
    expect(same(undefined, 'ab')).toBe(false)
  })

  it('maps a robot callback onto the line shape the core reads', () => {
    const line = message({
      msgId: 'm1', conversationId: 'cid', conversationType: '2', conversationTitle: 'dev',
      senderStaffId: 'staff-1', senderNick: 'He', createAt: 1700000000000,
      text: { content: '帮我改 README' },
    })
    expect(line).toMatchObject({ type: 'message', id: 'm1', chat: 'cid', direct: false, from: 'staff-1', text: '帮我改 README', mentionsBot: true, fromBot: false })
    expect(line.at).toBe(new Date(1700000000000).toISOString())
  })

  it('treats a one-to-one conversation as direct and falls back when the id is missing', () => {
    const line = message({ conversationId: 'cid', conversationType: '1', senderNick: 'He', text: { content: 'hi' } })
    expect(line.direct).toBe(true)
    expect(line.id.startsWith('cid:')).toBe(true)
    expect(line.from).toBe('')
  })
})