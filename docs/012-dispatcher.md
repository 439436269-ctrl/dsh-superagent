# 012 Dispatcher

Today the agent that judges requests is one the plugin creates for itself: `orchestrator-<hash>`, with its own preset and
its own workspace. That session is the dispatcher whether or not a person ever looks at it. This document changes that
into something a person chooses, and gives both directions of the conversation real tools.

Builds on [001 Domain model](001-domain.md), [010 Session bus](010-session-bus.md), [011 Extensions](011-extensions.md).

## 1 What is asked

1. **A dispatcher can be designated at any time** — any Session in this DSH process, not only the agent's own. It
   reports back to whoever asked by default.
2. **The dispatcher can message a worker** — not only read it, and not only when a ticket already routes there.
3. **Any Session can send the dispatcher an event** — a worker stuck mid-ticket, or an ordinary conversation, may hand
   the dispatcher work to assign.

## 2 What exists today

| Piece | State |
| --- | --- |
| Dispatcher identity | Fixed at `orchestrator-${key(stateDir, masterDirectory)}`, created by `Runtime.initialize` through `Sessions.ensure` |
| Dispatcher → worker | `orchestrator_session_message` / `_stop` (the session bus), and ticket replies |
| Worker → dispatcher | `orchestrator_trigger_handback` (hands a message back for assessment) and `orchestrator_report` |
| Ordinary Session → dispatcher | Nothing: a conversation that wants work has no tool that reaches the agent |
| Who may be the dispatcher | Only the Session the plugin made |

So (2) is nearly there, (3) exists only for workers and only through a ticket, and (1) is the real change.

## 3 The model

### 3.1 Dispatcher as a setting

`dispatcher` becomes a settings value, not a derived id:

- `auto` (default, today's behaviour): the plugin creates and owns `orchestrator-<hash>`.
- a Session id: that Session becomes the dispatcher. The plugin **does not** create a Session; it adopts the given one,
  installing the router preset's tools into it for as long as it is the dispatcher.

Adopting means three things, and each has a cost worth naming:

| Consequence | Why acceptable |
| --- | --- |
| That Session's own tools stay; the router tools are added | A person's Session keeps working as a Session |
| Its replies become decisions, so a stray message can start a ticket | It is the dispatcher; that is the role |
| Changing it back leaves the tools installed | They are refused when the Session is not the dispatcher, and the panel shows the current one |

`POST /settings/dispatcher` writes it; a change takes effect without restarting the plugin, because the master Session
is resolved on every turn, not cached.

### 3.2 Tools both ways

| Tool | Given to | Does |
| --- | --- | --- |
| `orchestrator_event` | **every** Session in the process: worker sessions, ordinary conversations | Sends one message to the dispatcher: `{ text, kind: 'request' | 'blocked' | 'report', ticket? }`. It becomes a Trigger whose source is `session`, so it is judged like any other message. |
| `orchestrator_dispatch` | the dispatcher | Same as today's route tool: accept into a ticket, attach, or ignore. |
| `orchestrator_session_message` | the dispatcher | Already exists; now keyed by the ticket's Session id, so "message the worker" needs no lookup. |

`orchestrator_event` is the load-bearing piece: it is what makes "any Session can ask the dispatcher" true. Its trust is
the caller's Session, and its admission is a Policy row of its own (`session`), so a project can allow events from its
own Sessions and refuse them from anywhere else.

### 3.3 Reporting back

Every Trigger from `session` remembers the Session that sent it (`trigger.channel` = that Session). Replies to it go
there by default, which is requirement 1's "反馈给提问方": the dispatcher answers the Session that asked, not a thread
in a chat, unless the event names a thread.

## 4 What not to do

- **Do not** let `orchestrator_event` create a ticket directly. It queues a Trigger; the dispatcher decides. Otherwise
  every Session becomes a dispatcher and the queue is meaningless.
- **Do not** move the worker preset to the dispatcher. The two presets differ on purpose (a worker's shell backgrounding
  is tuned for long commands).
- **Do not** support a dispatcher outside this DSH process. Cross-process dispatch is the Session bus's read-only view,
  not control.

## 5 Steps

| Step | Change | Verified by |
| --- | --- | --- |
| 1 | `dispatcher` setting + adoption: resolve the master Session from settings; `auto` keeps today's id | A test: with a Session id set, no Session is created; with `auto`, the id is the derived one |
| 2 | `orchestrator_event` + the `session` Source kind + Policy row | A test: an event from a worker becomes a Trigger with the sender as its channel, and its reply goes back to that Session |
| 3 | Panel: current dispatcher, a picker, and the events it received | The panel lists a dispatcher and one event from a worker |

Step 2 does not depend on step 1: an event tool plus the `session` kind is useful while the dispatcher is still the
agent's own Session. That is the piece to build first.
