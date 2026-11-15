/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/** The host's own wording when a Session's is missing: the reply still arrives, in the deployment's operating language. */
const RECEIPT = '收到'
const COMPLETE = '已完成'
const ENDED = '已结束'
/** How much of a title a host-written reply keeps, so the IM word limit has room beside it. */
const TITLE_CHARS = 80
export const shortTitle = (title: string): string => title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS).trimEnd()}…` : title

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, Assignments asks it for the result a ready report earns, and both ask it to withdraw a question a
 * report replaced.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement a person's request receives when the host sends receipts itself: `text` (an assessment's own
   * sentence, in the source language) when there is one, else a short default built from the ticket's title. Messages not
   * addressed to the agent get no default, so proactive work does not acknowledge unrelated chatter.
   */
  receipt(ticket: Ticket, trigger: Trigger, text?: string): void {
    if (!this.policy().replies.receipt || !trigger.human || !trigger.channel) return
    const message = text?.trim() || (trigger.addressed ? `${RECEIPT}：${shortTitle(ticket.title)}` : '')
    if (!message) return
    this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text: message, kind: 'acknowledgement', ticketId: ticket.id })
  }
  /**
   * Queue the host's completion reply for a ready or dropped report when the host sends completion replies itself: the
   * worker's own `message` when it wrote one, else a short default. One message per report, keyed by its time, so a resumed
   * ticket's later result is its own message. A ticket with no conversation the agent reached gets none.
   */
  complete(ticket: Ticket, state: 'ready' | 'dropped', message: string | undefined, at: string): void {
    if (!this.policy().replies.completion) return
    const channel = this.sourceChannel(ticket)
    if (!channel) return
    const text = message?.trim() || `${state === 'dropped' ? ENDED : COMPLETE}：${shortTitle(ticket.title)}`
    this.options.outbox.send({ id: key('result', ticket.id, at), channel, text, kind: 'reply', ticketId: ticket.id })
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
      // The host's completion reply for the latest report is this ticket's result; a Session's later text is not a second message.
      const automatic = this.completed(ticket)
      if (automatic) return { id: automatic, status: this.options.outbox.status(automatic) ?? 'pending', reused: true }
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The host's completion reply for a ticket's latest ready or dropped report, while it is the one that went out. */
  private completed(ticket: Ticket): string | undefined {
    if (!this.policy().replies.completion) return undefined
    const report = latestReport(ticket)
    if (report?.state !== 'ready' && report?.state !== 'dropped') return undefined
    const id = key('result', ticket.id, report.at)
    return this.options.outbox.status(id) ? id : undefined
  }
  /**
   * The conversation a ticket answers in: its origin Trigger's Channel, else the Channel of the latest person's message
   * attached to it (a ticket started from the dispatcher has no Channel of its own), else its first Channel.
   */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined {
    const source = this.source(ticket)?.channel
    if (source) return source
    const human = [...ticket.inputs].reverse().find(input => input.kind === 'trigger' && input.human && !input.context
      && this.repo.triggers.get(input.triggerId)?.channel)
    const attached = human?.kind === 'trigger' ? this.repo.triggers.get(human.triggerId)?.channel : undefined
    return attached ?? ticket.channels[0]
  }
}
