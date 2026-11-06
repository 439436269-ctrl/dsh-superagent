#!/usr/bin/env node
/**
 * WeCom (企业微信) bridge for dsh-superagent's generic IM Source, as docs/009-im-bridge.md describes.
 *
 *   wecom.mjs receive   serve the callback URL, print one JSON line per message
 *   wecom.mjs send <json>   deliver one reply
 *
 * WeCom differs from the chat tools this bridge normally wraps in one way: it has no way to subscribe to messages, so
 * the receiver *is* an HTTP server that WeCom calls. Point the app's 接收消息 server at `<port>/wecom` through whatever
 * public entry this machine has, and the two modes then look exactly like every other bridge to dsh-superagent.
 *
 * Configuration is the app's own settings, read from the environment:
 *
 *   WECOM_CORP_ID    企业 id (我的企业 → 企业信息)
 *   WECOM_AGENT_ID   应用 id (应用管理 → 自建应用 → AgentId)
 *   WECOM_SECRET     the app's Secret
 *   WECOM_TOKEN      the Token chosen in 接收消息 → 设置 API 接收
 *   WECOM_AES_KEY    the EncodingAESKey chosen there
 *   WECOM_PORT       local port to serve, default 8790
 *   WECOM_PATH       path to serve, default /wecom
 *
 * Only text messages become Triggers; anything else is acknowledged and dropped, because the core has nothing to assess.
 */
import { createHash } from 'node:crypto'
import { createDecipheriv } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`${name} is required`)
  return value
}
const corpId = () => env('WECOM_CORP_ID')
const agentId = () => Number(env('WECOM_AGENT_ID'))
const secret = () => env('WECOM_SECRET')
const token = () => env('WECOM_TOKEN')
const aesKey = () => env('WECOM_AES_KEY')

const API = 'https://qyapi.weixin.qq.com/cgi-bin'

/** The decryption key is the EncodingAESKey with its usual trailing '='; the IV is its first 16 bytes. */
const cipher = () => {
  const key = Buffer.from(`${aesKey()}=`, 'base64')
  if (key.length !== 32) throw new Error('WECOM_AES_KEY must decode to 32 bytes')
  return { key, iv: key.subarray(0, 16) }
}

/** PKCS#7 with a 32-byte block, as WeCom pads it: the last byte is the pad length. */
const unpad = (buffer) => {
  const pad = buffer[buffer.length - 1]
  if (pad < 1 || pad > 32) return buffer
  return buffer.subarray(0, buffer.length - pad)
}

/** Decrypt one WeCom cipher text: 16 random bytes, the length as a big-endian uint32, the message, then the corp id. */
export function decrypt(encryptedBase64) {
  const { key, iv } = cipher()
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  const plain = unpad(Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()]))
  if (plain.length < 20) throw new Error('decrypted message is too short')
  const length = plain.readUInt32BE(16)
  const message = plain.subarray(20, 20 + length).toString('utf8')
  const from = plain.subarray(20 + length).toString('utf8')
  if (from !== corpId()) throw new Error(`message is for corp ${from}, not ${corpId()}`)
  return message
}

/** WeCom signs with SHA-1 over the sorted token, timestamp, nonce and cipher text. */
const signature = (...parts) => createHash('sha1').update(parts.slice().sort().join('')).digest('hex')

const verified = (msgSignature, timestamp, nonce, encrypted) =>
  signature(token(), timestamp, nonce, encrypted) === msgSignature

/** The fields this bridge needs out of WeCom's flat XML; anything nested is left alone. */
const parseXml = (xml) => {
  const fields = {}
  // WeCom wraps values in CDATA; the plain form is accepted too so a hand-written test or a newer field still parses.
  // The plain form refuses a value that contains '<', which keeps the root <xml> wrapper from swallowing everything.
  for (const [, cdataName, cdata, plainName, plain] of xml.matchAll(/<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>|<(\w+)>([^<]*)<\/\3>/g)) fields[cdataName ?? plainName] = cdata ?? plain ?? ''
  return fields
}

const escapeXml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One message the core can assess, in the shape docs/009-im-bridge.md defines. */
function message(fields) {
  const at = fields.CreateTime ? new Date(Number(fields.CreateTime) * 1000).toISOString() : new Date().toISOString()
  const from = fields.FromUserName ?? ''
  return {
    type: 'message',
    // WeCom repeats a delivery; MsgId is stable for one message and absent on some event types.
    id: fields.MsgId ?? `${fields.CreateTime}-${from}`,
    chat: from,
    chatName: from,
    from,
    fromName: from,
    text: fields.Content ?? '',
    direct: true,
    mentionsBot: true,
    fromBot: false,
    at,
  }
}

/** Reads the callback server's requests and prints what the core consumes. */
function receive() {
  const port = Number(process.env.WECOM_PORT ?? 8790)
  const path = process.env.WECOM_PATH ?? '/wecom'
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== path) { response.writeHead(404).end(); return }
    if (request.method === 'GET') {
      // The console checks the URL once: echo the decrypted challenge when the signature holds.
      const echo = url.searchParams.get('echostr') ?? ''
      const ok = verified(url.searchParams.get('msg_signature') ?? '', url.searchParams.get('timestamp') ?? '', url.searchParams.get('nonce') ?? '', echo)
      let answer = ''
      try { answer = ok ? decrypt(echo) : '' } catch { answer = '' }
      response.writeHead(answer ? 200 : 403, { 'content-type': 'text/plain' }).end(answer)
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      // Acknowledge first: WeCom retries a slow answer, and the reply travels back over the send path anyway.
      response.writeHead(200, { 'content-type': 'text/plain' }).end('success')
      try {
        const outer = parseXml(body)
        const plain = decrypt(outer.Encrypt ?? '')
        const fields = parseXml(plain)
        process.stdout.write(`${JSON.stringify({ type: 'log', message: `WeCom ${fields.MsgType ?? '?'} from ${fields.FromUserName ?? '?'}` })}\n`)
        if ((fields.MsgType ?? 'text') !== 'text') return
        process.stdout.write(`${JSON.stringify(message(fields))}\n`)
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ type: 'log', message: `WeCom callback failed: ${error.message}` })}\n`)
      }
    })
  })
  server.listen(port, () => process.stdout.write(`${JSON.stringify({ type: 'log', message: `WeCom bridge listening on ${port}${path}` })}\n`))
}

/** The access token lives an hour and a half; a file keeps the send path from fetching one per reply. */
async function accessToken() {
  const cache = join(tmpdir(), `dsh-superagent-wecom-${corpId()}.json`)
  try {
    const held = JSON.parse(readFileSync(cache, 'utf8'))
    if (held.expires > Date.now() + 60_000) return held.token
  } catch { /* No usable cache. */ }
  const response = await fetch(`${API}/gettoken?corpid=${encodeURIComponent(corpId())}&corpsecret=${encodeURIComponent(secret())}`)
  const body = await response.json()
  if (!body.access_token) throw new Error(`WeCom gettoken failed: ${body.errcode} ${body.errmsg}`)
  writeFileSync(cache, JSON.stringify({ token: body.access_token, expires: Date.now() + (body.expires_in ?? 7200) * 1000 }))
  return body.access_token
}

async function send(payload) {
  const to = String(payload.chat ?? '')
  if (!to) throw new Error('a WeCom reply needs a chat, which is the recipient userid')
  const token = await accessToken()
  const response = await fetch(`${API}/message/send?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ touser: to, msgtype: 'text', agentid: agentId(), text: { content: String(payload.text ?? '') } }),
  })
  const body = await response.json()
  if (body.errcode !== 0) throw new Error(`WeCom send failed: ${body.errcode} ${body.errmsg}`)
  process.stdout.write(`${JSON.stringify({ type: 'sent', id: payload.id })}\n`)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
const [mode, argument] = process.argv.slice(2)
if (!invokedDirectly) {
  // Imported by a test, which calls the exported pieces itself.
} else if (mode === 'receive') receive()
else if (mode === 'send') {
  // The core passes the whole send payload as one argument; a shell that splits it would be caught here.
  let payload
  try { payload = JSON.parse(argument ?? '') } catch { process.stderr.write('send needs one JSON argument\n'); process.exit(2) }
  send(payload).catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1) })
} else {
  process.stderr.write('usage: wecom.mjs receive | send <json>\n')
  process.exit(2)
}

export { signature, parseXml }
