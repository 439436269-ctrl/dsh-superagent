# 010 Session bus

A supervision Session works next to other Sessions and other agents. To do that well it needs two things, and this document
separates them because conflating them is what makes such integrations brittle:

- **What another Session already did.** Available only from a tool that keeps a transcript in a public format. DSH does.
- **What another agent could do next.** Available from any tool that runs one non-interactive command. Codex, Claude Code,
  Gemini CLI and opencode all do.

So the bus has two halves, `SessionAdapter` and `AgentRunner`, and a supervisor calls four tools over them. Nothing about a
vendor's private history format is guessed.

This builds on [001 Domain model](001-domain.md) through [009 IM bridge](009-im-bridge.md).

## The model

| Concept | What it is | Bounded by |
| --- | --- | --- |
| `SessionRef` | One Session on disk: agent, id, transcript path, cwd, title, first and last activity, size | a listing returns a digest, never turns |
| `Turn` | One readable step of a transcript: `user`, `assistant` or the name of a `tool` that ran | a read returns a tail, 200 turns at most |
| `SessionAdapter` | `list` and `read` over one tool's transcripts | one adapter per format, `dsh` today |
| `AgentRunner` | `detect` and `args(task, cwd)` for one agent's non-interactive command | dispatch is one process, with a timeout |
| `Run` | One dispatch: task, cwd, state, exit code, captured output | output is capped at 200 000 characters |

## The tools a supervisor gets

| Tool | Answers |
| --- | --- |
| `orchestrator_session_list` | Which Sessions exist, with their cwd, first request and last activity |
| `orchestrator_session_read` | What the latest turns of one Session say |
| `orchestrator_session_search` | Which Sessions mentioned a phrase, such as a file name or an error |
| `orchestrator_agent_list` | Which agents this machine can hand work to, detected rather than assumed |
| `orchestrator_agent_dispatch` | Hand one self-contained task to an agent; returns a run id |
| `orchestrator_agent_status` | The state, exit code and output tail of one run |
| `orchestrator_session_live` | Which Host Sessions exist right now, and whether each is working |
| `orchestrator_session_message` | Send one message into another Session, as its own user would |
| `orchestrator_session_stop` | Stop what another Session is doing, leaving its conversation |

The three `session_*` tools above the last group read transcripts off disk and therefore reach every profile; the three at
the end act on the live Host through its Session service, so they need one (`SessionController` absent means those tools
refuse rather than lie). A message is ordinary input: it joins that Session's conversation and grants no authority. A stop
cancels the turn, not the Session.

A dispatch returns immediately. The supervisor polls, so it can keep routing while another agent works, and a busy agent
never blocks the Session that owns the tickets.

## What makes it cheap

- **One decode per file identity.** A DSH transcript of 1.8 MB decompresses to a few megabytes of JSON, and Zstandard
  frames cannot be seeked. The adapter caches the parsed turns keyed by path plus size plus mtime, so repeated reads of
  one Session are free and a changed Session re-parses once. The cache holds eight Sessions.
- **Digests, not transcripts.** A listing reports a title, a cwd and two timestamps; turns are read only on request.
- **Bounded everything.** 100 Sessions per listing, 200 turns per read, 4 000 characters per turn, 200 000 per run, and a
  timeout on every dispatch. A supervisor's context is never at the mercy of someone else's transcript.
- **Titles that mean something.** A worker Session of dsh-superagent opens with a JSON payload rather than prose, so a
  `title` or `text` field inside it is used as the title; otherwise the payload itself would fill the listing.
- **Detection, not configuration.** `agent_list` resolves each command on `PATH` the way a shell would, so it never offers
  an agent that cannot run.

## Adding a transcript adapter

Implement `SessionAdapter` in `src/sessions/bus.ts` and pass it in `new SessionBus({ stateDir, adapters })`:

```ts
export class CodexSessions implements SessionAdapter {
  readonly agent = 'codex'
  readonly label = 'Codex sessions'
  list(limit: number): Promise<SessionRef[]> { /* newest first */ }
  read(ref: SessionRef, tail: number): Promise<Turn[]> { /* normalized turns */ }
}
```

Return turns for the three roles the model reads, keep `titleOf`'s rule for a JSON first message, and bound what you
return the same way the DSH adapter does.

## Adding a runner

Add one entry to `RUNNERS`, with the agent's own non-interactive form:

```ts
{ agent: 'codex', label: 'OpenAI Codex', detect: () => onPath('codex'), args: (task, cwd) => ['exec', '--cd', cwd, task] }
```

`args` receives the task and the working directory; the runner records stdout, stderr and the exit code. Exit code 0 is
`done`; anything else is `failed`; a timeout or an aborted parent marks it `stopped`.

## Security

- **The bus adds no credential of its own.** A transcript adapter reads files the operator can already read, and a runner
  uses the CLI's own logged-in identity.
- **A dispatch is a shell-level grant.** The agent runs as the operator's OS user in the directory it is given, so a
  supervisor only dispatches work it would be willing to run itself, and the task text must be self-contained: the agent
  cannot ask the supervisor a question.
- **Reading is not authorization.** Another Session's transcript is evidence, never authority: it cannot approve work or
  lift a person's hold.
