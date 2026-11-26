/** Archives stale worker and reviewer Sessions through the Host's durable archive set, without deleting their files. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { liveTicket } from '../core/index.ts'
import type { Store } from './store.ts'

/** Days a worker or reviewer Session may stay inactive before a pass archives it. */
export const ARCHIVE_AFTER_DAYS = 7
/** How often the automatic pass looks for stale Sessions. */
export const ARCHIVE_INTERVAL_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** The newest transcript of one Session directory, plain or compressed, as the persistence backend names it. */
const TRANSCRIPT = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
/** The Sessions this plugin owns: `worker-<ticket>` and `reviewer-<ticket>`, the ticket id being 32 hex characters. */
const MANAGED = /^(worker|reviewer)-([0-9a-f]{32})$/

/** The role a managed Session plays for its Ticket. */
export type ManagedSessionRole = 'worker' | 'reviewer'

/** One worker or reviewer Session old enough to archive. */
export interface SessionArchiveCandidate {
  /** `worker-<ticket>` or `reviewer-<ticket>`. */
  sessionId: string
  role: ManagedSessionRole
  ticketId: string
  /** The newest transcript write (or the creation time when no transcript exists), as ISO-8601. */
  lastActive: string
  /** Whole days since `lastActive`. */
  ageDays: number
  /** Whether `lastActive` came from the Session's transcript or, when none was readable, from its creation time. */
  basis: 'transcript' | 'created'
}

/** A stored Session as persistence lists it: its header is all this scan reads. */
interface StoredSession { readonly header: { readonly id: string; readonly createdAt: number } }
/** The Session store's list call, narrowed to what an archive pass needs. */
interface SessionLister { list(options?: { signal?: AbortSignal }): Promise<readonly StoredSession[]> }
/** The workspace registry's durable archive set, narrowed to what an archive pass needs. */
interface ArchiveRegistry {
  readonly archivedSessionIds: readonly string[]
  archiveSession(sessionId: SessionId, options?: { stopActivity?: boolean }): Promise<void>
}

/** What an archive pass found, what it archived, and what it left alone. */
export interface SessionArchiveReport {
  /** Whether this Host exposes the durable archive set; a Host without it is left alone rather than guessed at. */
  available: boolean
  days: number
  dryRun: boolean
  /** ISO-8601 time the scan ran. */
  at: string
  /** Stored Sessions persistence listed, all roles and workspaces. */
  scanned: number
  /** Sessions old enough to archive, oldest first. */
  candidates: SessionArchiveCandidate[]
  /** Candidates whose transcript could not be found, so their creation time decided their age. */
  createdFallback: number
  archived: string[]
  skipped: { archived: number; recent: number; liveTicket: number; active: string[] }
  failed: { sessionId: string; error: string }[]
}

/** What an archive pass needs from its Host. */
export interface SessionArchiveHost {
  readonly context: Context
  readonly store: Pick<Store, 'tickets'>
  /** Directory holding one subdirectory per Workspace, each with one per Session (DSH's `$DSH_HOME/sessions`). */
  readonly sessionsRoot: string
  /** Clock in epoch milliseconds; the tests replace it. */
  now?(): number
}

/** The DeepSeek Harness home of the running Host, which keeps stored Sessions under `sessions/`. */
export function dshHome(): string { return process.env.DSH_HOME ?? join(homedir(), '.dsh') }

/** A Session id the plugin manages, split into its role and Ticket, or undefined for any other Session. */
export function managedSession(sessionId: string): { role: ManagedSessionRole; ticketId: string } | undefined {
  const match = MANAGED.exec(sessionId)
  return match ? { role: match[1] as ManagedSessionRole, ticketId: match[2]! } : undefined
}

/**
 * The newest write per Session directory under `root`, so inactivity follows the transcript rather than the Session's
 * creation. A Session directory without a readable transcript is absent, and its creation time is used instead.
 */
export function transcriptActivity(root: string): Map<string, number> {
  const newest = new Map<string, number>()
  let workspaces: string[]
  try { workspaces = readdirSync(root) } catch { return newest }
  for (const workspace of workspaces) {
    const workspaceDirectory = join(root, workspace)
    let sessions: string[]
    try { sessions = readdirSync(workspaceDirectory) } catch { continue }
    for (const session of sessions) {
      const sessionDirectory = join(workspaceDirectory, session)
      let names: string[]
      try { names = readdirSync(sessionDirectory) } catch { continue }
      let last = 0
      for (const name of names) {
        if (!TRANSCRIPT.test(name)) continue
        try {
          const stat = statSync(join(sessionDirectory, name))
          if (stat.mtimeMs > last) last = stat.mtimeMs
        } catch { /* A transcript that vanished between listing and stat tells nothing. */ }
      }
      if (last > 0) {
        const previous = newest.get(session) ?? 0
        if (last > previous) newest.set(session, last)
      }
    }
  }
  return newest
}

/**
 * Finds worker and reviewer Sessions whose newest transcript is older than the retention window and archives them with
 * `workspaceRegistry.archiveSession`, which hides a Session and blocks its next step while keeping every file on disk.
 * A Session is left alone when its Ticket is still live, when it is already archived, or when it reports activity: an
 * active Session is never stopped to archive it. Dry runs report the same candidates and write nothing.
 */
export class SessionArchiver {
  constructor(private readonly host: SessionArchiveHost) {}

  /** Scan and, unless `dryRun` (the default), archive; an unavailable Host returns an empty report. */
  async run(request: { days?: number; dryRun?: boolean } = {}, signal?: AbortSignal): Promise<SessionArchiveReport> {
    const days = request.days ?? ARCHIVE_AFTER_DAYS
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new RangeError('days must be an integer from 1 to 3650')
    const now = this.now()
    const report: SessionArchiveReport = {
      available: false, days, dryRun: request.dryRun ?? true, at: new Date(now).toISOString(), scanned: 0,
      candidates: [], createdFallback: 0, archived: [], skipped: { archived: 0, recent: 0, liveTicket: 0, active: [] }, failed: [],
    }
    const lister = this.sessionLister(), registry = this.archiveRegistry()
    if (!lister || !registry) return report
    report.available = true
    signal?.throwIfAborted()
    const snapshots = await lister.list(signal ? { signal } : undefined)
    signal?.throwIfAborted()
    report.scanned = snapshots.length
    const archived = new Set(registry.archivedSessionIds.map(String))
    // The filesystem is read only when persistence returned Sessions, so a Host with none costs no scan.
    const activity = snapshots.length > 0 ? transcriptActivity(this.host.sessionsRoot) : new Map<string, number>()
    for (const snapshot of snapshots) {
      signal?.throwIfAborted()
      const sessionId = String(snapshot.header.id)
      const managed = managedSession(sessionId)
      if (!managed) continue
      if (archived.has(sessionId)) { report.skipped.archived++; continue }
      const ticket = this.host.store.tickets.get(managed.ticketId)
      if (ticket && liveTicket(ticket)) { report.skipped.liveTicket++; continue }
      const transcript = activity.get(sessionId)
      const lastActive = transcript ?? snapshot.header.createdAt
      // A header without a usable creation time cannot say how old the Session is; leave it for a person.
      if (!Number.isFinite(lastActive)) continue
      const age = Math.max(0, now - lastActive)
      if (age < days * DAY_MS) { report.skipped.recent++; continue }
      if (transcript === undefined) report.createdFallback++
      report.candidates.push({ sessionId, role: managed.role, ticketId: managed.ticketId,
        lastActive: new Date(lastActive).toISOString(), ageDays: Math.floor(age / DAY_MS),
        basis: transcript === undefined ? 'created' : 'transcript' })
    }
    report.candidates.sort((left, right) => left.lastActive.localeCompare(right.lastActive))
    if (report.dryRun) return report
    for (const candidate of report.candidates) {
      signal?.throwIfAborted()
      // The Ticket may have resumed since the scan; never archive a Session that just became live.
      const ticket = this.host.store.tickets.get(candidate.ticketId)
      if (ticket && liveTicket(ticket)) { report.skipped.liveTicket++; continue }
      try {
        await registry.archiveSession(candidate.sessionId as SessionId)
        report.archived.push(candidate.sessionId)
      } catch (error) {
        if (activeSession(error)) report.skipped.active.push(candidate.sessionId)
        else report.failed.push({ sessionId: candidate.sessionId, error: reason(error) })
      }
    }
    return report
  }

  private now(): number { return this.host.now?.() ?? Date.now() }

  private sessionLister(): SessionLister | undefined {
    const service = this.service('sessionPersistence')
    return service && typeof service.list === 'function' ? service as unknown as SessionLister : undefined
  }

  private archiveRegistry(): ArchiveRegistry | undefined {
    const service = this.service('workspaceRegistry')
    if (!service || typeof service.archiveSession !== 'function' || !Array.isArray(service.archivedSessionIds)) return undefined
    return service as unknown as ArchiveRegistry
  }

  /** One optional Host service, or undefined when this DeepSeek Harness version does not provide it. */
  private service(name: 'sessionPersistence' | 'workspaceRegistry'): Record<string, unknown> | undefined {
    return this.host.context.get(name) as Record<string, unknown> | undefined
  }
}

/** Whether archiving was refused because the Session reported activity; it is retried, never stopped. */
function activeSession(error: unknown): boolean {
  return error instanceof Error && error.name === 'WorkspaceActiveSessionError'
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
