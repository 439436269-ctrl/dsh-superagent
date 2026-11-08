#!/usr/bin/env node
// A bridge that reports exactly one message for its own chat and then stays open, so a test can watch two instances of the same kind
// receive their own messages and nothing else. The delay lets the parent attach its stdout reader before the line is written.
const chat = process.env.PROBE_CHAT ?? 'probe'
const line = { type: 'message', id: `probe-${chat}-1`, chat, chatName: chat, direct: false, from: 'probe-user',
  fromName: 'Probe', text: `hello from ${chat}`, at: new Date().toISOString(), mentionsBot: true, fromBot: false, replyTo: null }
setTimeout(() => process.stdout.write(`${JSON.stringify(line)}\n`), 2000)
setInterval(() => {}, 1 << 30)