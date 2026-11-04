# 009 IM bridge

The IM Source reaches any chat tool without a change to the core, because the tool-specific part is one small process: a
**bridge**. The bridge owns the tool's credentials, receives its messages, and sends replies. dsh-superagent sees only chat
ids, names and text, exactly as it does for Feishu.

This document builds on [001 Domain model](001-domain.md) through [008 Cookbook](008-cookbook.md). Read
[001](001-domain.md) first if a Source, Trigger or Ticket is unfamiliar.

## What the bridge is

An executable on `PATH` or an absolute path, configured as the Source's **Bridge command**. The core starts it twice:

| Mode | Started as | Speaks |
| --- | --- | --- |
| Receive | `<command> <args> receive` | prints one JSON object per line on stdout; runs until stopped |
| Send | `<command> <args> send <json>` | reads one message from its argument, exits when the message went out |

Running the send path as its own short process means a reply still works while the receiver is restarting, and it needs no
shared state. Both paths are ordinary processes, so any language works.

## The protocol

### Receive → core

One JSON object per line. Unreadable lines are ignored; a bridge that exits is restarted with a bounded backoff.

```json
{"type":"message","id":"8812","chat":"-100223","chatName":"dev","direct":false,
 "from":"42","fromName":"Ada","text":"@superagent fix the typo","at":"2026-11-04T15:02:00Z",
 "mentionsBot":true,"fromBot":false,"replyTo":null,"url":"https://…"}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Message id, unique inside the chat. The Trigger id is derived from `chat`+`id`, so every path for one message must produce the same pair; that is what deduplicates redelivery. |
| `chat` | yes | Conversation id. It is also the Thread, so history of one chat stays together. |
| `text` | no | The message body. Empty text is still a Trigger, but there is nothing to assess. |
| `direct` | no | A one-to-one conversation. Such a message is addressed to the agent with no mention. |
| `from` | yes | Sender id, which the Policy's allowed list names. |
| `mentionsBot` | no | Whether the message addresses the bot. An allowed sender's mention is an explicit request. |
| `fromBot` | no | A bot wrote it. The core drops those unless the Policy lists that bot as a candidate source. |
| `fromName`, `chatName` | no | Display names; `chatName` also labels the Thread and the chat picker. |
| `at` | no | ISO-8601 time; the receive time is used when absent. |
| `replyTo`, `url` | no | The answered message's id, and a deep link to the message. |

Two more line types are accepted: `{"type":"chats","chats":[{"id":"…","name":"…"}]}` to publish chat names, and
`{"type":"log","message":"…"}` to put a line in the Source's health detail.

### Core → send

`<command> <args> send '{"type":"send","id":"…","chat":"…","text":"…","direct":false}'`

`id` is the Outbox message's own id, so an adapter may use it as an idempotency key. `text` is Markdown-ish plain text;
adapters that cannot render Markdown should send it as-is rather than drop it.

| Adapter outcome | The core does |
| --- | --- |
| print `{"type":"sent"}`, or exit 0 | marks the reply sent |
| exit 3 | drops the reply: the conversation can no longer receive messages |
| any other failure | retries with a growing delay, up to three times, then records the failure on the Source |

## Enabling it

1. Enable the entry in the profile's `cordis.patch.yml`:

   ```yaml
   - id: dsh-superagent-im
     disabled: false
   ```

2. In the panel, open the **IM bridge** Source and set **Bridge command** and **Command arguments**, for example
   `node` and `C:\work\telegram.mjs`. Then add the chats it should listen to.
3. Set the bridge's own credentials in the environment of the DSH process that runs dsh-superagent, never in this settings
   form: the panel's configuration is visible to agents, environment variables are not.

Saving starts the bridge. The Source reports `ready` with the running command, or `paused` while no command is set.

## Writing one

`examples/im-bridges/telegram.mjs` is a complete adapter in about 120 lines with no dependencies;
`examples/im-bridges/template.mjs` is the same shape with the four places to fill marked. What each tool needs:

| Tool | Receiving | Sending | Mention test | Gone |
| --- | --- | --- | --- | --- |
| Telegram | `getUpdates` long poll | `sendMessage` | `@botusername` in the text | 403 |
| Slack | Socket Mode, or Events API through a tunnel | `chat.postMessage` | `<@BOTID>` in the text | `channel_not_found` |
| 钉钉 | Stream mode, or the group robot's outgoing webhook | group robot webhook | `@机器人` in the text | webhook error `310000` |
| 企业微信 | 智能机器人回调, or a group robot's outgoing webhook | group robot webhook | `@机器人` | `not in chat` |
| Discord | Gateway `MESSAGE_CREATE` | `POST /channels/{id}/messages` | `<@BOTID>` | 404 |

A bridge is stateless when it can be: keep the read cursor in memory (redelivery is harmless because Trigger ids are
stable) and hold no queue of its own, since the Outbox already retries.

## Security

- **Credentials stay in the bridge.** The adapter reads its token from its own environment; nothing about it enters the
  settings, the database, a Session's instructions, or a Trigger.
- **The bridge is trusted code.** It runs as the operator's OS user and prints whatever it wants into a Trigger, so review
  an adapter before configuring it, exactly as you would review a Feed source.
- **Chat membership is not authorization.** The Policy's allowed list decides who may originate work; a bridge must not
  map a person to another tool's identity.

## Checklist before relying on one

- A message reaches the panel within the poll interval, and the same message redelivered produces one Ticket, not two.
- A reply appears in the same chat, and a reply to a chat the bot was removed from is dropped rather than retried forever.
- Stopping the Source stops the bridge process within a second or two.
- A wrong token surfaces as a Source error with the adapter's own message, not as silence.
