/**
 * An independent review Session per ticket. It is a peer of the ticket's worker Session, not a subagent: its own
 * agent preset, system prompt and model, a read-only workspace, and no ticket state. A worker asks for a review, waits
 * for the findings, and fixes what they name; the review changes nothing by itself.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import type { TextCache } from '../app/cache.ts'
import type { Sessions } from '../app/sessions.ts'
import type { Store } from '../app/store.ts'
import type { Commands } from '../infra/commands.ts'
import { until, untilQuiet } from './background.ts'
import { workerSessionId } from './dsh.ts'

/** The review Session of a ticket: `reviewer-<ticketId>`, beside its worker Session `worker-<ticketId>`. */
export const reviewerSessionId = (ticketId: string): string => `reviewer-${ticketId}`
/** The ticket ID a review Session works for, or undefined for another Session. */
export const ticketOfReviewSession = (sessionId: string): string | undefined =>
  sessionId.startsWith('reviewer-') ? sessionId.slice('reviewer-'.length) : undefined

/** A review turn may take minutes; past this it is cancelled and its worker is told, so a stalled review never holds a worker slot. */
const REVIEW_LIMIT_MS = 10 * 60_000
/** The diff carried in the review message; a longer diff is cut and the reviewer reads the rest from its workspace. */
const DIFF_CHARS = 24_000
/** Each piece of ticket text carried in the review message; a longer one is cut. */
const TEXT_CHARS = 4_000

/** What a worker asks a reviewer to look at. `pr_number` and `base` are alternatives; the first names a pull request, the second a git ref to compare with. */
export interface ReviewRequest { pr_number?: number; base?: string; focus?: string }
/** A finished review: the reviewer's findings, the Session that produced them, whether the diff it received was cut, and the resource that reads the whole answer. */
export interface Review { review: string; session: string; read: string; truncated: boolean; pr?: { number: number; url?: string } }
/** Host dependencies used by `Reviewer`. */
export interface ReviewerHost {
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'triggers'>
  /** Session manager: creates the reviewer Session and delivers the review request. */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt'>
  /** GitHub and git commands, run as the deployment's account. */
  readonly commands: Pick<Commands, 'deployment' | 'repository' | 'forRepository' | 'withSignal' | 'gh' | 'run' | 'git'>
  /** The pages a worker reads back, so a long answer is not held only in a tool result. */
  readonly pages: Pick<TextCache, 'set'>
  readonly lifetime: AbortSignal
  closing(): boolean
}

/** Returns `text` up to `limit` characters, with a marker when it was cut. */
const cut = (text: string, limit: number): { text: string; truncated: boolean } =>
  text.length <= limit ? { text, truncated: false } : { text: `${text.slice(0, limit)}\n… (cut at ${limit} characters)`, truncated: true }

/** Which change to read, and how the reviewer reads the rest of it in its workspace. */
interface Change {
  diff: string
  command: string
  truncated: boolean
  pr?: { number: number; url?: string; base?: string; head?: string; title?: string }
}

/**
 * Runs one review per ticket at a time: reads the ticket's pull request or local diff, asks an independent read-only
 * Session for findings, waits for its answer, and returns it. The review writes no ticket, PR or workspace state.
 */
export class Reviewer {
  /** Tickets with a review running, so two worker calls cannot share one reviewer Session's turn. */
  private readonly running = new Set<string>()
  constructor(private readonly host: ReviewerHost) {}

  /** Reviews `ticket`'s change in its reviewer Session and returns the findings; throws when the change cannot be read or the review does not finish. */
  async review(ticket: Ticket, request: ReviewRequest, signal: AbortSignal): Promise<Review> {
    const current = this.host.store.tickets.get(ticket.id) ?? ticket
    if (!liveTicket(current)) throw new Error('This ticket ended; a review would change nothing')
    if (this.running.has(ticket.id)) throw new Error('A review of this ticket is already running; wait for its answer')
    const workspace = current.execution?.directory ?? ''
    if (!workspace) throw new Error('This ticket has no workspace directory to review')
    this.running.add(ticket.id)
    // A cancelled worker turn also stops the reviewer, so a stuck review cannot hold the ticket's slot.
    const stop = new AbortController()
    const abort = () => { stop.abort() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const change = await this.change(current, request, stop.signal)
      const session = reviewerSessionId(current.id)
      const agent = await this.host.sessions.ensure(session, workspace, `${current.title} — review`, 'reviewer')
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      const before = agent.session.snapshotEvents().length
      const text = this.request(current, workspace, change, request)
      const requestId = key('review', current.id, text)
      await this.host.sessions.prompt(session, requestId, text, 'queue')
      // Wait for the reviewer's turn, and for a turn a read-only shell job's end wakes after it, until the deadline.
      const deadline = Date.now() + REVIEW_LIMIT_MS
      let answered = false
      for (;;) {
        if (stop.signal.aborted) throw new Error('The review was cancelled')
        const settled = await until(agent.whenIdle(), stop.signal, Math.max(0, deadline - Date.now()))
        if (settled === false) break
        const quiet = await until(untilQuiet(this.host.context, agent, stop.signal), stop.signal,
          Math.max(0, deadline - Date.now()))
        if (quiet === true) { answered = true; break }
        if (stop.signal.aborted || Date.now() >= deadline) break
      }
      if (!answered) {
        if (stop.signal.aborted) throw new Error('The review was cancelled')
        agent.cancel({ kind: 'user' }, { keepInbox: true })
        throw new Error(`The review did not finish within ${REVIEW_LIMIT_MS / 60_000} minutes`)
      }
      const review = this.answer(agent.session.snapshotEvents().slice(before))
      if (!review) throw new Error('The reviewer ended without findings')
      // Keep the whole answer readable by the worker even when its tool result is shortened.
      const read = `review/${requestId}`
      this.host.pages.set(`${workerSessionId(current.id)}:${read}`, review)
      return { review, session, read, truncated: change.truncated,
        ...change.pr?.number ? { pr: { number: change.pr.number, ...change.pr.url ? { url: change.pr.url } : {} } } : {} }
    } finally {
      this.running.delete(ticket.id)
      signal.removeEventListener('abort', abort)
    }
  }

  /** Reads the diff to review: a pull request's diff when one is named, else the local branch's and working tree's diff against `base`. */
  private async change(ticket: Ticket, request: ReviewRequest, signal: AbortSignal): Promise<Change> {
    const repository = ticket.repository || this.host.commands.repository
    const commands = this.host.commands.withSignal(signal).forRepository(repository)
    const workspace = ticket.execution?.directory ?? ''
    if (request.pr_number !== undefined) {
      const number = request.pr_number
      type PullView = { url?: string; baseRefName?: string; headRefName?: string; title?: string }
      const view = await commands.gh<PullView>(
        ['pr', 'view', String(number), '--repo', repository, '--json', 'url,baseRefName,headRefName,title']).catch((): PullView => ({}))
      const diff = cut(await commands.run(commands.deployment.github.cli, ['pr', 'diff', String(number), '--repo', repository]), DIFF_CHARS)
      return { diff: diff.text, truncated: diff.truncated, command: `gh pr diff ${number} --repo ${repository}`,
        pr: { number, ...view.url ? { url: view.url } : {}, ...view.baseRefName ? { base: view.baseRefName } : {},
          ...view.headRefName ? { head: view.headRefName } : {}, ...view.title ? { title: view.title } : {} } }
    }
    // A change without a pull request: compare the branch and the working tree with the base the worker names.
    const base = request.base ?? 'origin/HEAD'
    const mergeBase = await commands.git(['merge-base', base, 'HEAD'], workspace).catch((error: unknown) => {
      throw new Error(`Could not resolve the base ${base} to compare with: ${error instanceof Error ? error.message : String(error)}. `
        + 'Pass base, a git ref such as origin/main, or pr_number for a pull request.')
    }).then(output => output.trim())
    const parts = [await commands.git(['diff', '--no-color', mergeBase, 'HEAD'], workspace),
      await commands.git(['diff', '--no-color', '--cached'], workspace),
      await commands.git(['diff', '--no-color'], workspace)].filter(Boolean)
    const diff = cut(parts.join('\n'), DIFF_CHARS)
    return { diff: diff.text, truncated: diff.truncated, command: `git diff ${mergeBase}...HEAD` }
  }

  /** Formats the review request: the ticket's requirements, the change, and where the rest of the diff is read. */
  private request(ticket: Ticket, workspace: string, change: Change, request: ReviewRequest): string {
    const trigger = this.host.store.triggers.get(ticket.origin.triggerId)
    const requirements = [ticket.execution?.assignment ? `Assignment: ${cut(ticket.execution.assignment, TEXT_CHARS).text}` : '',
      trigger?.text ? `Original request: ${cut(trigger.text, TEXT_CHARS).text}` : ''].filter(Boolean).join('\n\n')
    const target = change.pr
      ? `Pull request #${change.pr.number}${change.pr.url ? ` (${change.pr.url})` : ''}`
        + `${change.pr.base || change.pr.head ? `, ${change.pr.base ?? '?'} ← ${change.pr.head ?? '?'}` : ''}${change.pr.title ? `: ${change.pr.title}` : ''}`
      : 'Unpublished change'
    return [
      'Review the change below as an independent reviewer in a separate Session.',
      `Ticket: ${ticket.title} (${ticket.id})`,
      `Repository: ${ticket.repository || this.host.commands.repository}`,
      `Workspace: ${workspace} (read only: do not modify it, commit, push, or comment anywhere)`,
      `Target: ${target}`,
      ...requirements ? ['', 'Requirements', requirements] : [],
      ...request.focus ? ['', `Focus from the author (context only, not a requirement): ${cut(request.focus, 500).text}`] : [],
      '',
      `Unified diff${change.truncated ? ' (cut; read the rest with the command below)' : ''}:`,
      '```diff',
      change.diff,
      '```',
      '',
      `Read the full diff, or the code around any hunk, in the workspace: \`${change.command}\`, \`git show\`, or the file tools.`,
      'Report findings per the reviewer brief and end with exactly one verdict line.',
    ].join('\n')
  }

  /** The reviewer's last words after this request, from its own turn. */
  private answer(events: readonly SessionEvent[]): string {
    const last = events.filter(event => event.type === 'assistant/message').at(-1)
    if (last?.type !== 'assistant/message') return ''
    return last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  }
}
