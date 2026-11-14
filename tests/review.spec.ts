/** The independent reviewer Session: a peer of the ticket's worker Session that reads a change and answers with findings. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { REVIEWER_PRESET } from '../src/app/sessions.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })

/** What the fixture's Session exposes to a test that plays its reviewer. */
interface ReviewAgent {
  status: string
  inbox: { nextTurn: { content: { type: string; text?: string }[] }[] }
  session: { snapshotEvents: () => unknown[] }
}
/** The reviewer Session of a ticket, once it exists and the review request reached it. */
async function reviewerOf(id: string) {
  await vi.waitFor(() => { expect(h.agents.has(id)).toBe(true) }, { timeout: 3000 })
  const reviewer = h.agents.get(id) as unknown as ReviewAgent
  await vi.waitFor(() => { expect(reviewer.inbox.nextTurn.length).toBeGreaterThan(0) }, { timeout: 3000 })
  return reviewer
}
/** The text of a delivered message, as the Session reads it. */
const textOf = (reviewer: ReviewAgent) =>
  reviewer.inbox.nextTurn.map(message => message.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')).join('\n')
/** Ends the reviewer's turn with `answer`, which the waiting worker tool reads. */
const answer = (reviewer: ReviewAgent, text: string) => {
  reviewer.session.snapshotEvents = (() => [{ type: 'assistant/message', data: { message: { role: 'assistant',
    content: [{ type: 'text', text }] } } }]) as never
  reviewer.status = 'idle'
}

it('reviews a pull request in a separate read-only Session and hands its findings to the worker', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot set the value'))
  const reviewerId = `reviewer-${ticket.id}`
  const findings = 'blocker: src/app.ts:1 — the value is unguarded. VERDICT: request changes'
  vi.mocked(Commands.prototype.run).mockResolvedValueOnce('diff --git a/src/app.ts b/src/app.ts\n+export const value = 1\n')
  const pending = h.runTool(sessionId, 'orchestrator_review', { pr_number: 7, focus: 'the guard' })
  const reviewer = await reviewerOf(reviewerId)
  answer(reviewer, findings)
  const result = await pending as { review: string; read: string; session: string; chars: number }
  expect(result).toMatchObject({ session: reviewerId, review: findings, chars: findings.length })
  // It is a reviewer Session, not the worker's preset, and it cannot write, report or ask for another review.
  expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: reviewerId, agentPreset: REVIEWER_PRESET }))
  const tools = h.tools.get(reviewerId)!
  expect(tools.has('orchestrator_read')).toBe(true)
  for (const name of ['orchestrator_report', 'orchestrator_ack', 'orchestrator_review', 'write', 'edit']) expect(tools.has(name), name).toBe(false)
  // The request named the pull request, the workspace, the requirements and the answer's shape.
  const asked = textOf(reviewer)
  expect(asked).toContain('Pull request #7')
  expect(asked).toContain(`Workspace: ${ticket.execution?.directory}`)
  expect(asked).toContain('Requirements')
  expect(asked).toContain('one verdict line')
  // The whole answer stays readable through the resource the tool result names.
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: result.read })).toMatchObject({ text: findings })
})

it('returns a long answer shortened, keeping the whole review readable as a resource', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot set the value'))
  const findings = Array.from({ length: 400 }, (_, index) => `minor: src/app.ts:${index + 1} — finding ${index}.`).join('\n')
  const pending = h.runTool(sessionId, 'orchestrator_review', { pr_number: 7 })
  const reviewer = await reviewerOf(`reviewer-${ticket.id}`)
  answer(reviewer, findings)
  const result = await pending as { review: string; read: string; chars: number }
  expect(result.chars).toBe(findings.length)
  expect(result.review.length).toBeLessThan(findings.length)
  expect(result.review).toContain('read the rest with orchestrator_read')
  // The resource pages through the whole answer, starting at its first finding.
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: result.read, limit: 8000 }))
    .toMatchObject({ text: findings.slice(0, 8000), total_chars: findings.length, next_offset: 8000 })
})

it('refuses a second review of the same ticket while the first waits for its answer', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot set the value'))
  const pending = h.runTool(sessionId, 'orchestrator_review', { pr_number: 7 })
  const reviewer = await reviewerOf(`reviewer-${ticket.id}`)
  await expect(h.runTool(sessionId, 'orchestrator_review', { pr_number: 7 })).rejects.toThrow('already running')
  answer(reviewer, 'no findings. VERDICT: approve')
  await expect(pending).resolves.toMatchObject({ review: 'no findings. VERDICT: approve' })
})

it('refuses to review a ticket that ended', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot set the value'))
  h.runtime.engine.stopTicket(ticket.id, 'no longer needed')
  await expect(h.runTool(sessionId, 'orchestrator_review', { pr_number: 7 })).rejects.toThrow('ended')
  expect(h.agents.has(`reviewer-${ticket.id}`)).toBe(false)
})
