/**
 * Checks the WeCom bridge's decryption against the algorithm WeCom documents, by encrypting a message the way WeCom
 * does and reading it back. Run with: node examples/im-bridges/wecom.test.mjs
 *
 * The bridge itself is not covered here beyond its pure pieces: the API calls and the callback server need a real
 * 企业微信 app, which is what the console steps in docs/009-im-bridge.md set up.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const corpId = 'wwtest0123456789'
const token = 'bridgeToken'
const aesKey = randomBytes(32).toString('base64').slice(0, 43)
process.env.WECOM_CORP_ID = corpId
process.env.WECOM_AGENT_ID = '1000002'
process.env.WECOM_SECRET = 'secret'
process.env.WECOM_TOKEN = token
process.env.WECOM_AES_KEY = aesKey

const { decrypt, signature, parseXml } = await import('./wecom.mjs')

/** PKCS#7 with a 32-byte block, then 16 random bytes, the length, the message and the corp id. */
const encrypt = (message) => {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const body = Buffer.from(message, 'utf8')
  const framed = Buffer.concat([randomBytes(16), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(body.length); return b })(), body, Buffer.from(corpId, 'utf8')])
  const pad = 32 - (framed.length % 32)
  const padded = Buffer.concat([framed, Buffer.alloc(pad, pad)])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}

let failures = 0
const check = (name, run) => {
  try { run(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.log(`  FAIL ${name}: ${error.message}`) }
}

const xml = '<xml><ToUserName><![CDATA[wwtest]]></ToUserName><FromUserName><![CDATA[ada]]></FromUserName>'
  + '<CreateTime>1730732400</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[@superagent 修一下拼写]]></Content>'
  + '<MsgId>8812</MsgId><AgentID>1000002</AgentID></xml>'

check('decrypts a text message WeCom would deliver', () => {
  assert.equal(decrypt(encrypt(xml)), xml)
})

check('rejects a message for another corp', () => {
  const saved = process.env.WECOM_CORP_ID
  process.env.WECOM_CORP_ID = 'wwother9999999'
  assert.throws(() => decrypt(encrypt(xml)), /is for corp/)
  process.env.WECOM_CORP_ID = saved
})

check('signs the console challenge the way WeCom expects', () => {
  const timestamp = '1730732400'
  const nonce = 'abc'
  const encrypted = encrypt('challenge')
  const expected = createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex')
  assert.equal(signature(token, timestamp, nonce, encrypted), expected)
})

check('parses the fields a message needs', () => {
  const fields = parseXml(xml)
  assert.equal(fields.FromUserName, 'ada')
  assert.equal(fields.Content, '@superagent 修一下拼写')
  assert.equal(fields.MsgId, '8812')
  assert.equal(fields.MsgType, 'text')
})

check('keeps a body that contains XML-looking text', () => {
  const nested = '<xml><Content><![CDATA[if (a<b && c>d) {}]]></Content></xml>'
  assert.equal(parseXml(nested).Content, 'if (a<b && c>d) {}')
})

console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
