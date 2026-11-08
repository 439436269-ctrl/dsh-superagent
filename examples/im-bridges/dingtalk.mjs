/**
 * DingTalk bridge for the generic IM Source (docs/009-im-bridge.md). Signing and mapping live in `dingtalk-core.mjs`.
 *
 * Environment: DINGTALK_PORT (default 8877), DINGTALK_APP_SECRET, DINGTALK_ROBOT_TOKEN, DINGTALK_ROBOT_SECRET.
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { message, sign, same } from './dingtalk-core.mjs'

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const fail = (code, text) => { console.error(text); process.exit(code) }
async function main() {
const mode = process.argv[2]

if (mode === 'send') {
  const payload = JSON.parse(process.argv[3] ?? '{}')
  const token = process.env.DINGTALK_ROBOT_TOKEN
  if (!token) fail(1, 'dingtalk.mjs: DINGTALK_ROBOT_TOKEN is not set')
  const url = new URL('https://oapi.dingtalk.com/robot/send')
  url.searchParams.set('access_token', token)
  const secret = process.env.DINGTALK_ROBOT_SECRET
  if (secret) {
    const timestamp = Date.now()
    url.searchParams.set('timestamp', String(timestamp))
    url.searchParams.set('sign', sign(secret, timestamp))
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: String(payload.text ?? '') } }),
  })
  const result = await response.json().catch(() => ({}))
  if (result?.errcode === 0) { emit({ type: 'sent' }); process.exit(0) }
  fail(1, `dingtalk.mjs: send failed ${result?.errcode ?? response.status} ${result?.errmsg ?? ''}`.trim())
}

if (mode !== 'receive') fail(2, 'dingtalk.mjs: expected `receive` or `send <json>`')

const port = Number(process.env.DINGTALK_PORT ?? 8877)
const secret = process.env.DINGTALK_APP_SECRET

createServer((request, response) => {
  if (request.method !== 'POST') { response.writeHead(405).end(); return }
  let raw = ''
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    const timestamp = request.headers.timestamp
    const signature = request.headers.sign
    // The version header guards against a malformed callback being mistaken for a message.
    if (secret && !same(signature, sign(secret, timestamp))) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ errcode: 401, errmsg: 'bad signature' }))
      return
    }
    let body
    try { body = JSON.parse(raw) } catch { response.writeHead(400).end(); return }
    const line = message(body)
    if (line.chat && line.from) emit(line)
    // An empty reply keeps the robot from posting a second message into the chat.
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
  })
}).listen(port, () => console.error(`dingtalk.mjs: callback listening on ${port}`))

}

// Only run as a script: importing this file must not start a server or exit the importing process.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
