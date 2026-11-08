#!/usr/bin/env node
/**
 * DingTalk bridge over Stream mode: no public callback, no tunnel. The bridge opens an outbound WebSocket to DingTalk's
 * gateway and receives the robot's messages there; replies go through the robot's own send API.
 *
 * `receive` prints one `message` line per callback; `send <json>` posts `payload.text` to `payload.chat`.
 * Credentials arrive through the environment and never reach the agent's Sessions.
 */
import { message } from './dingtalk-core.mjs'

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const fail = (code, text) => { console.error(text); process.exit(code) }

const clientId = process.env.DINGTALK_CLIENT_ID ?? ''
const clientSecret = process.env.DINGTALK_APP_SECRET ?? ''
const TOPIC = '/v1.0/im/bot/messages/get'

async function token() {
  const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  })
  const body = await response.json()
  if (!body.accessToken) throw new Error(`token: ${JSON.stringify(body).slice(0, 200)}`)
  return body.accessToken
}

if (process.argv[2] === 'send') {
  const payload = JSON.parse(process.argv[3] ?? '{}')
  const at = await token()
  // A robot may only write into a conversation it was added to; the address carries that id.
  const response = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': at },
    body: JSON.stringify({ robotCode: clientId, openConversationId: String(payload.chat ?? ''),
      msgKey: 'sampleText', msgParam: JSON.stringify({ content: String(payload.text ?? '') }) }),
  })
  const body = await response.json().catch(() => ({}))
  if (response.ok && (body.processQueryKey || body.flowControlled === false || body.spaceType)) { emit({ type: 'sent' }); process.exit(0) }
  if (response.status === 400 && String(body.message ?? '').includes('conversation')) fail(3, `dingtalk-stream: conversation gone ${JSON.stringify(body).slice(0, 120)}`)
  fail(1, `dingtalk-stream: send failed ${response.status} ${JSON.stringify(body).slice(0, 200)}`)
}

if (process.argv[2] !== 'receive') fail(2, 'dingtalk-stream.mjs: expected `receive` or `send <json>`')

const opened = await fetch('https://api.dingtalk.com/v1.0/gateway/connections/open', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId, clientSecret, ua: 'dsh-superagent/1.0', localIp: '127.0.0.1',
    subscriptions: [{ type: 'CALLBACK', topic: TOPIC }] }),
}).then(response => response.json())
if (!opened.endpoint || !opened.ticket) fail(1, `dingtalk-stream: open failed ${JSON.stringify(opened).slice(0, 200)}`)

const socket = new WebSocket(`${opened.endpoint}?ticket=${encodeURIComponent(opened.ticket)}`)
socket.addEventListener('open', () => console.error('dingtalk-stream: connected'))
socket.addEventListener('error', () => console.error('dingtalk-stream: socket error'))
socket.addEventListener('close', () => { console.error('dingtalk-stream: closed'); process.exit(0) })

socket.addEventListener('message', event => {
  let frame
  try { frame = JSON.parse(String(event.data)) } catch { return }
  if (frame.type === 'SYSTEM') {
    if (frame.headers?.topic === 'disconnect') socket.close()
    return
  }
  // Every callback must be acknowledged, or DingTalk redelivers it.
  const reply = JSON.stringify({ code: 200, headers: { messageId: frame.headers?.messageId ?? '' }, message: 'OK',
    data: JSON.stringify({ status: 'SUCCESS' }) })
  socket.send(reply)
  if (frame.headers?.topic !== TOPIC) return
  try {
    const line = message(JSON.parse(frame.data))
    if (line.chat && line.from) emit(line)
  } catch { /* a malformed payload is dropped rather than killing the connection */ }
})