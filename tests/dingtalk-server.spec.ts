import { spawn } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { sign } from '../examples/im-bridges/dingtalk-core.mjs'

/** Starts the bridge and resolves once it reports the port it listens on. */
function start(port: number, secret: string | undefined) {
  const child = spawn(process.execPath, ['examples/im-bridges/dingtalk.mjs', 'receive'], {
    env: { ...process.env, DINGTALK_PORT: String(port), ...(secret ? { DINGTALK_APP_SECRET: secret } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge did not start')), 15_000)
    child.stderr.on('data', chunk => {
      if (String(chunk).includes('listening')) { clearTimeout(timer); resolve() }
    })
  })
  return { child, ready, lines: () => out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

const callback = (text: string) => JSON.stringify({
  msgId: 'm1', conversationId: 'cid', conversationType: '2', senderStaffId: 'staff-1', senderNick: 'He',
  createAt: 1700000000000, text: { content: text },
})

const children: ReturnType<typeof start>[] = []
afterAll(() => { for (const item of children) item.child.kill() })

describe('dingtalk bridge callback', () => {
  it('rejects a forged signature and emits nothing', async () => {
    const port = 8971
    const bridge = start(port, 'sec'); children.push(bridge)
    await bridge.ready
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST', headers: { timestamp: '1', sign: 'forged' }, body: callback('hello'),
    })
    expect(response.status).toBe(401)
    expect(bridge.lines()).toHaveLength(0)
  })

  it('accepts a signed callback and prints one message line for it', async () => {
    const port = 8972
    const bridge = start(port, 'sec'); children.push(bridge)
    await bridge.ready
    const timestamp = String(Date.now())
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST', headers: { timestamp, sign: sign('sec', timestamp) }, body: callback('帮我改 README'),
    })
    expect(response.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 300))
    const lines = bridge.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ type: 'message', id: 'm1', chat: 'cid', from: 'staff-1', text: '帮我改 README', mentionsBot: true })
  })
})