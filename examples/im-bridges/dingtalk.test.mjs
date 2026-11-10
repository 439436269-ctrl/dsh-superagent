/** Self-check for the DingTalk bridge's pure parts: signing, constant-time comparison, and callback-to-line mapping. */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { message, same, sign } from './dingtalk-core.mjs'

const check = (name, run) => { run(); console.log(`  ok  ${name}`) }

check('signs timestamp+newline+secret, base64', () => {
  const expected = createHmac('sha256', 's3cret').update('1700000000000\ns3cret').digest('base64')
  assert.equal(sign('s3cret', '1700000000000'), expected)
})

check('compares signatures of equal length and rejects differences', () => {
  assert.equal(same('abc123', 'abc123'), true)
  assert.equal(same('abc123', 'abc124'), false)
  assert.equal(same('abc', 'abcd'), false)
})

const group = overrides => ({
  msgId: 'msg-1', senderStaffId: 'staff-1', senderNick: '何乐乐', conversationType: '2', conversationId: 'cid-group',
  createAt: 1700000000000, text: { content: ' 帮我改 README ' }, atUsers: [], ...overrides,
})

check('maps a group message to the line the core expects', () => {
  const line = message(group({ isInAtList: true }))
  assert.equal(line.type, 'message')
  assert.equal(line.id, 'msg-1')
  assert.equal(line.chat, 'cid-group')
  assert.equal(line.from, 'staff-1')
  assert.equal(line.fromName, '何乐乐')
  assert.equal(line.direct, false)
  assert.equal(line.mentionsBot, true)
  assert.equal(line.text, ' 帮我改 README ')
  assert.equal(line.at, '2023-11-14T22:13:20.000Z')
})

check('only claims a mention when DingTalk says this robot was addressed', () => {
  // Two robots in one group: DingTalk sets isInAtList per robot, so an @ for the other one must not become our mention.
  assert.equal(message(group({ isInAtList: false })).mentionsBot, false)
})

check('treats a payload without isInAtList as addressed, such as a direct message', () => {
  const direct = message(group({ isInAtList: undefined, conversationType: '1', conversationId: 'cid-dm', text: { content: '你好' } }))
  assert.equal(direct.direct, true)
  assert.equal(direct.mentionsBot, true)
})

check('falls back to conversation and time when a callback carries no message id', () => {
  const line = message(group({ msgId: undefined, createAt: 1700000001000 }))
  assert.equal(line.id, 'cid-group:1700000001000')
})

console.log('all checks passed')
