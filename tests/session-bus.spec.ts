/** The Session bus against a synthetic DSH transcript and an injected runner, so nothing here depends on the host. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CliRunners, DshAdapter, SessionBus, type AgentRunner } from '../src/sessions/bus.ts'

/** Builds a DSH home with one session whose transcript is Zstandard-compressed, as the real one is. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'session-bus-'))
  const directory = join(home, 'sessions', '--D-work-demo--', 'session-abc')
  mkdirSync(directory, { recursive: true })
  const events = [
    { type: 'session', version: 4, id: 'session-abc', createdAt: Date.parse('2026-01-02T03:00:00Z'), cwd: 'D:\\work\\demo', agentPreset: 'standard' },
    { type: 'user/message', seq: 1, time: Date.parse('2026-01-02T03:00:01Z'), data: { role: 'user', content: [{ type: 'text', text: 'Add a retry to the uploader' }] } },
    { type: 'assistant/message', seq: 2, time: Date.parse('2026-01-02T03:00:05Z'), data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'I will read the uploader first.' }] } } },
    { type: 'tool/call', seq: 3, time: Date.parse('2026-01-02T03:00:06Z'), data: { name: 'read', arguments: '{"path":"uploader.ts"}' } },
    { type: 'user/message', seq: 4, time: Date.parse('2026-01-02T03:01:00Z'), data: { role: 'user', content: [{ type: 'text', text: 'Also keep the timeout at 30 seconds' }] } },
    { type: 'assistant/message', seq: 5, time: Date.parse('2026-01-02T03:01:10Z'), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Done: retry added, timeout unchanged.' }] } } },
  ]
  writeFileSync(join(directory, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')))
  return home
}

const echoRunner = (): AgentRunner => ({
  agent: 'echo',
  label: 'Echo',
  detect: () => process.execPath,
  // node -e <script> <task> prints the task, which is enough to prove capturing and exit codes.
  args: task => ['-e', 'process.stdout.write(process.argv[1] ?? "")', task],
})
const sleepRunner = (): AgentRunner => ({ agent: 'sleep', label: 'Sleep', detect: () => process.execPath, args: () => ['-e', 'setTimeout(() => {}, 30000)'] })

describe('DshAdapter', () => {
  it('lists a session with its digest, reading the header rather than the directory name', async () => {
    const adapter = new DshAdapter(fakeHome())
    const ref = (await adapter.list(10))[0]!
    expect(ref.id).toBe('session-abc')
    expect(ref.cwd).toBe('D:\\work\\demo')
    expect(ref.title).toBe('Add a retry to the uploader')
    expect(ref.bytes).toBeGreaterThan(0)
  })

  it('reads only the requested tail, and skips reasoning', async () => {
    const adapter = new DshAdapter(fakeHome())
    const ref = (await adapter.list(10))[0]!
    const turns = await adapter.read(ref, 2)
    expect(turns.map(turn => turn.role)).toEqual(['user', 'assistant'])
    expect(turns[1]!.text).toBe('Done: retry added, timeout unchanged.')
    const all = await adapter.read(ref, 50)
    expect(all.map(turn => turn.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
    expect(all[2]!.text).toContain('read')
  })

  it('searches across transcripts', async () => {
    const adapter = new DshAdapter(fakeHome())
    const hits = await adapter.search('timeout', 5)
    // Both the request and the answer mention it, and both are hits in order.
    expect(hits).toHaveLength(2)
    expect(hits.map(hit => hit.turn.role)).toEqual(['user', 'assistant'])
    expect(await adapter.search('nothing matches this', 5)).toHaveLength(0)
  })
})

describe('SessionBus', () => {
  it('merges adapters and caps the listing', async () => {
    const bus = new SessionBus({ stateDir: mkdtempSync(join(tmpdir(), 'session-bus-state-')), adapters: [new DshAdapter(fakeHome())] })
    expect(await bus.listSessions({ limit: 5 })).toHaveLength(1)
    await expect(bus.readSession({ agent: 'nope', id: 'x' })).rejects.toThrow(/No transcript adapter/)
  })
})

describe('CliRunners', () => {
  it('captures output and the exit code of a dispatched agent', async () => {
    const runners = new CliRunners(mkdtempSync(join(tmpdir(), 'session-bus-runs-')), [echoRunner()])
    const run = await runners.dispatch({ agent: 'echo', task: 'hello from a supervisor', cwd: tmpdir() })
    await new Promise(resolve => setTimeout(resolve, 2000))
    const done = runners.status(run.id)!
    expect(done.state).toBe('done')
    expect(done.code).toBe(0)
    expect(done.output).toContain('hello from a supervisor')
  })

  it('stops a run that outlives its timeout instead of holding it forever', async () => {
    const runners = new CliRunners(mkdtempSync(join(tmpdir(), 'session-bus-runs-')), [sleepRunner()])
    const run = await runners.dispatch({ agent: 'sleep', task: 'wait', cwd: tmpdir(), timeoutMs: 300 })
    await new Promise(resolve => setTimeout(resolve, 2000))
    expect(runners.status(run.id)!.state).toBe('stopped')
  })
})
