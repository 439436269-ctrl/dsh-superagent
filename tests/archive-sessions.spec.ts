/** Archiving stale worker and reviewer Sessions through the durable archive set, and restoring a Session a Ticket resumes. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionArchiver, transcriptActivity, type SessionArchiveHost } from '../src/app/archive-sessions.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 25, 12)
const OLD = 'a'.repeat(32)
const RECENT = 'b'.repeat(32)
const LIVE = 'c'.repeat(32)
const ARCHIVED = 'd'.repeat(32)
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

/** A session directory under `root`, with a transcript last written `ageDays` ago; no transcript when omitted. */
function stored(root: string, workspace: string, id: string, ageDays?: number): void {
  const directory = join(root, workspace, id)
  mkdirSync(directory, { recursive: true })
  if (ageDays === undefined) return
  const transcript = join(directory, 'session.v1.jsonl')
  writeFileSync(transcript, '{}\n')
  const time = new Date(NOW - ageDays * DAY)
  utimesSync(transcript, time, time)
}
/** A host whose persistence lists `snapshots` and whose registry records archive calls. */
function host(root: string, snapshots: { id: string; createdAt: number }[], tickets: Map<string, { ended?: { by: string } }> = new Map()) {
  const registry = { archivedSessionIds: [] as string[], archiveSession: vi.fn(async () => {}) }
  const context = { get: (name: string) => name === 'sessionPersistence'
    ? { list: async () => snapshots.map(snapshot => ({ header: { id: snapshot.id, createdAt: snapshot.createdAt } })) }
    : name === 'workspaceRegistry' ? registry : undefined }
  const archive = new SessionArchiver({ context, store: { tickets: { get: (id: string) => tickets.get(id) } },
    sessionsRoot: root, now: () => NOW } as unknown as SessionArchiveHost)
  return { archive, registry }
}
function home(): string { const root = mkdtempSync(join(tmpdir(), 'session-archive-')); homes.push(root); return root }

describe('session archiving', () => {
  it('lists stale worker and reviewer Sessions, following the transcript rather than the creation time', async () => {
    const root = home()
    stored(root, 'work', `worker-${OLD}`, 10)
    stored(root, 'work', `reviewer-${OLD}`)
    stored(root, 'work', `worker-${RECENT}`, 1)
    stored(root, 'work', `orchestrator-${OLD}`, 30)
    const { archive, registry } = host(root, [
      { id: `worker-${OLD}`, createdAt: NOW - 20 * DAY },
      { id: `reviewer-${OLD}`, createdAt: NOW - 8 * DAY },
      { id: `worker-${RECENT}`, createdAt: NOW - 50 * DAY },
      { id: `orchestrator-${OLD}`, createdAt: NOW - 30 * DAY },
    ])
    registry.archivedSessionIds.push(`worker-${ARCHIVED}`)
    const report = await archive.run()
    expect(report.available).toBe(true)
    expect(report.dryRun).toBe(true)
    expect(report.scanned).toBe(4)
    expect(report.candidates.map(item => item.sessionId)).toEqual([`worker-${OLD}`, `reviewer-${OLD}`])
    expect(report.candidates[0]).toMatchObject({ role: 'worker', ticketId: OLD, ageDays: 10, basis: 'transcript' })
    expect(report.candidates[1]).toMatchObject({ basis: 'created' })
    expect(report.createdFallback).toBe(1)
    // A dry run writes nothing.
    expect(registry.archiveSession).not.toHaveBeenCalled()
  })

  it('leaves a live Ticket, a recent Session and an already archived Session alone', async () => {
    const root = home()
    stored(root, 'work', `worker-${LIVE}`, 12)
    stored(root, 'work', `reviewer-${LIVE}`, 12)
    stored(root, 'work', `worker-${ARCHIVED}`, 12)
    const tickets = new Map([[LIVE, {}], [ARCHIVED, {}]])
    const { archive, registry } = host(root, [
      { id: `worker-${LIVE}`, createdAt: NOW - 12 * DAY }, { id: `reviewer-${LIVE}`, createdAt: NOW - 12 * DAY },
      { id: `worker-${ARCHIVED}`, createdAt: NOW - 12 * DAY },
    ], tickets)
    registry.archivedSessionIds.push(`worker-${ARCHIVED}`)
    const report = await archive.run({ days: 7 })
    expect(report.candidates).toEqual([])
    expect(report.skipped).toMatchObject({ liveTicket: 2, archived: 1 })
  })

  it('archives on apply and keeps an active Session for a later pass instead of stopping it', async () => {
    const root = home()
    stored(root, 'work', `worker-${OLD}`, 10)
    stored(root, 'work', `reviewer-${OLD}`, 10)
    const { archive, registry } = host(root, [
      { id: `worker-${OLD}`, createdAt: NOW - 10 * DAY }, { id: `reviewer-${OLD}`, createdAt: NOW - 10 * DAY },
    ])
    const active = new Error('active'); active.name = 'WorkspaceActiveSessionError'
    registry.archiveSession.mockRejectedValueOnce(active)
    const report = await archive.run({ days: 7, dryRun: false })
    expect(report.archived).toEqual([`reviewer-${OLD}`])
    expect(report.skipped.active).toEqual([`worker-${OLD}`])
    expect(registry.archiveSession).toHaveBeenCalledTimes(2)
    expect(registry.archiveSession).toHaveBeenCalledWith(`worker-${OLD}`)
  })

  it('reports an unavailable Host instead of guessing at its storage', async () => {
    const root = home()
    const archive = new SessionArchiver({ context: { get: () => undefined }, store: { tickets: { get: () => undefined } },
      sessionsRoot: root, now: () => NOW } as unknown as SessionArchiveHost)
    const report = await archive.run()
    expect(report).toMatchObject({ available: false, candidates: [], scanned: 0 })
  })

  it('reads the newest transcript write when a Session directory holds more than one, and across workspaces', () => {
    const root = home()
    const directory = join(root, 'work', 'worker-1')
    mkdirSync(directory, { recursive: true })
    for (const [name, age] of [['session.v1.jsonl', 10], ['session.v2.jsonl.zstd', 3], ['notes.txt', 1]] as const) {
      const file = join(directory, name)
      writeFileSync(file, '{}')
      const time = new Date(NOW - age * DAY)
      utimesSync(file, time, time)
    }
    // The same id under a second workspace, with a newer write, must not be shadowed by read order.
    const duplicate = join(root, 'other', 'worker-1')
    mkdirSync(duplicate, { recursive: true })
    const newer = join(duplicate, 'session.v1.jsonl')
    writeFileSync(newer, '{}')
    const time = new Date(NOW - 1 * DAY)
    utimesSync(newer, time, time)
    expect(transcriptActivity(root).get('worker-1')).toBe(NOW - 1 * DAY)
  })

  it('stops before writing when the pass is cancelled', async () => {
    const root = home()
    stored(root, 'work', `worker-${OLD}`, 10)
    const { archive, registry } = host(root, [{ id: `worker-${OLD}`, createdAt: NOW - 10 * DAY }])
    const controller = new AbortController()
    controller.abort()
    await expect(archive.run({ dryRun: false }, controller.signal)).rejects.toThrow()
    expect(registry.archiveSession).not.toHaveBeenCalled()
  })
})

describe('session archiving on a running Runtime', () => {
  it('lists a dry run by default and archives only when asked, through the management API', async () => {
    const h = await startRuntime()
    try {
      const id = `worker-${'e'.repeat(32)}`
      const persistence = h.ctx.get('sessionPersistence') as unknown as { list: ReturnType<typeof vi.fn> }
      persistence.list.mockResolvedValue([{ header: { id, createdAt: Date.now() - 10 * DAY } }])
      const dry = await h.api('POST', 'sessions/archive', {})
      expect(dry.status).toBe(200)
      expect(dry.body).toMatchObject({ available: true, dryRun: true })
      expect(dry.body.candidates).toEqual([expect.objectContaining({ sessionId: id, role: 'worker' })])
      const registry = h.ctx.get('workspaceRegistry') as unknown as { archiveSession: ReturnType<typeof vi.fn> }
      expect(registry.archiveSession).not.toHaveBeenCalled()
      const applied = await h.api('POST', 'sessions/archive', { dryRun: false })
      expect(applied.body).toMatchObject({ dryRun: false, archived: [id] })
      expect(registry.archiveSession).toHaveBeenCalledWith(id)
      // The route refuses an out-of-range retention window instead of silently clamping it.
      expect((await h.api('POST', 'sessions/archive', { days: 0 })).status).toBe(400)
      expect((await h.api('POST', 'sessions/archive', { days: 4000 })).status).toBe(400)
    } finally { await h.stop() }
  })

  it('restores an archived Ticket Session when its Ticket runs again', async () => {
    const h = await startRuntime()
    try {
      const { ticket } = await h.acceptedTicket(feishu('1', '@bot set the value'))
      const id = `worker-${ticket.id}`
      const registry = h.ctx.get('workspaceRegistry') as unknown as { archivedSessionIds: string[]; unarchiveSession: ReturnType<typeof vi.fn> }
      registry.archivedSessionIds.push(id)
      registry.unarchiveSession = vi.fn(async () => {
        registry.archivedSessionIds = registry.archivedSessionIds.filter(item => item !== id)
      })
      await h.runtime.sessions.ensure(id, h.directory, 'Fix the value', 'worker')
      expect(registry.unarchiveSession).toHaveBeenCalledWith(id)
    } finally { await h.stop() }
  })
})
