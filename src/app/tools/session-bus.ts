/**
 * Main-Session tools for supervising other Sessions and agents: reading another Session's transcript, searching across
 * them, and handing work to an agent that only takes a non-interactive command.
 *
 * These tools are deliberately narrow. `orchestrator_session_read` returns a tail, never a whole transcript, and a
 * dispatch returns a run id instead of blocking until the agent finishes, so a supervisor stays responsive.
 */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { SessionBus } from '../../sessions/bus.ts'
import { tool, type Tool } from './tool.ts'

const AgentName = z.string().min(1).max(40)
/** A working directory a dispatched agent may run in; a relative path would silently land in the Service's own directory. */
const Directory = z.string().min(1).max(400).refine(path => {
  if (!isAbsolute(path)) return false
  try { return statSync(path).isDirectory() } catch { return false }
}, 'An absolute path of an existing directory')

export function sessionBusTools(bus: SessionBus): Tool[] {
  return [
    tool({
      name: 'orchestrator_session_list',
      description: 'List recent Sessions on this machine with a short digest each: which agent, its cwd, its first request, and when it last changed. Use it before reading one, and to find the Session that is working on something.',
      schema: z.object({
        agent: AgentName.optional().describe('Limit to one agent, such as `dsh`. Omit for every agent that keeps a readable transcript.'),
        limit: z.number().int().min(1).max(100).default(20),
      }).strict(),
      execute: async args => ({ sessions: await bus.listSessions(args) }),
    }),
    tool({
      name: 'orchestrator_session_read',
      description: 'Read the latest turns of one Session: what was asked, what the agent answered, and which tools it ran. Use it to learn what another Session already did or decided, instead of asking a person. Reads the tail only.',
      schema: z.object({
        agent: AgentName.describe('The agent from orchestrator_session_list, such as `dsh`.'),
        id: z.string().min(1).describe('The Session id from orchestrator_session_list.'),
        tail: z.number().int().min(1).max(200).default(20).describe('How many of the latest turns to return.'),
      }).strict(),
      execute: async args => bus.readSession(args),
    }),
    tool({
      name: 'orchestrator_session_search',
      description: 'Search the transcripts this machine keeps for a phrase, such as a file name, an error or a decision; returns the matching turn and its Session. Use it to find prior work without knowing which Session did it.',
      schema: z.object({ query: z.string().trim().min(2).max(200), limit: z.number().int().min(1).max(50).default(10) }).strict(),
      execute: async args => ({ hits: (await bus.searchSessions(args)).map(hit => ({ agent: hit.ref.agent, id: hit.ref.id, title: hit.ref.title, lastAt: hit.ref.lastAt, role: hit.turn.role, text: hit.turn.text })) }),
    }),
    tool({
      name: 'orchestrator_agent_list',
      description: 'List the agents this machine can hand work to, which are the ones whose non-interactive command is installed. An agent that is not listed cannot be dispatched to.',
      schema: z.object({}).strict(),
      execute: async () => ({ agents: bus.runners.list() }),
    }),
    tool({
      name: 'orchestrator_agent_dispatch',
      description: 'Hand one task to another agent, such as Codex or Claude Code, in a directory it may work in. Returns a run id immediately; poll it with orchestrator_agent_status. Use it for work the tool is good at, and keep the task self-contained: the agent does not see this conversation.',
      schema: z.object({
        agent: AgentName.describe('The agent from orchestrator_agent_list.'),
        task: z.string().trim().min(1).max(8000).describe('The whole task, with the context the agent needs. It cannot ask this Session questions.'),
        cwd: Directory.describe('Absolute path of the directory the agent works in.'),
        timeout_ms: z.number().int().min(10000).max(3600000).default(600000),
      }).strict(),
      execute: async (args, signal) => {
        const run = await bus.runners.dispatch({ agent: args.agent, task: args.task, cwd: args.cwd, timeoutMs: args.timeout_ms, signal })
        return { run_id: run.id, agent: run.agent, state: run.state, started_at: run.startedAt, note: 'Poll orchestrator_agent_status with run_id.' }
      },
    }),
    tool({
      name: 'orchestrator_agent_status',
      description: 'Read one dispatched run: its state, exit code, and the tail of the output the agent printed. Call it until the state is no longer `running`.',
      schema: z.object({ run_id: z.string().min(1), tail_chars: z.number().int().min(200).max(20000).default(4000) }).strict(),
      execute: async args => {
        const run = bus.runners.status(args.run_id)
        if (!run) throw new Error(`Unknown run ${args.run_id}`)
        return { ...run, output: run.output.slice(-args.tail_chars) }
      },
    }),
  ]
}
