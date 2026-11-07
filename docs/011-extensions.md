# 011 Extensions

How dsh-superagent grows without changing its core: what is already pluggable, what is not, and what to build so a
third party can ship a Source, an Executor or a Channel the way dsh-market ships plugins.

This document builds on [001 Domain model](001-domain.md) and [009 IM bridge](009-im-bridge.md).

## 1 Today: the seams that already exist

The core is built around a contract, not around GitHub and Feishu. Evidence:

| Seam | Where | How a kind plugs in |
| --- | --- | --- |
| **Source kind** | `src/sources/kind.ts` 鈥?`SourceKind` covers config schema, panel fields, policy part, channel, thread reader | `SourceRegistry.register(kind)` (`src/sources/registry.ts`), which rejects a duplicate kind and returns a disposer |
| **One entry per kind** | `tsdown.config.ts`: `github-watch` 鈫?`src/sources/github.ts`, `feishu-watch` 鈫?`src/sources/feishu.ts`, `im-watch` 鈫?`src/sources/im.ts` | Each becomes its own bundle entry in `cordis.patch.yml`, enabled or disabled on its own |
| **Any chat tool** | `docs/009-im-bridge.md` | An external process: a "bridge" speaks JSON lines on stdout and takes one JSON argument to send |
| **Agent presets** | `cordis.patch.yml`: `dsh-superagent-worker-preset`, `dsh-superagent-router-preset` | A preset entry, replaceable without touching the plugin |
| **Other agents as workers** | `orchestrator_agent_*` tools (`src/sessions/bus.ts`) | Any CLI whose non-interactive command is installed 鈥?codex, claude, gemini, opencode |
| **Settings surfaces** | `src/app/views/settings.ts` builds `blocks` (policy/eval/executor) and `sources[]` from the registry | A kind supplies its own card, fields and policy rows |

So "extend" today means: **write a module that exports a `SourceKind` and add a bundle entry**. That is real
decoupling inside this repository. It is not yet decoupling *outside* it.

## 2 The gaps

1. **No published contract.** `SourceKind` is exported from the package internals; a third party can only import it by
   depending on `dsh-superagent` itself, whose version moves with every internal change.
2. **No discovery.** A kind loads only if `cordis.patch.yml` names it. Adding one means editing a bundle: fine inside
   this repo, wrong for anyone else.
3. **The Executor is hard-coded.** A Ticket always runs as a DSH Session in a git worktree (`src/executor`). There is no
   contract for "run this ticket somewhere else" (a container, a CI job, a remote machine).
4. **No catalog.** Nothing lists what may be installed, what is installed, or what is incompatible 鈥?the surface
   dsh-market provides for plugins.

## 3 The model

Three layers, each useful on its own:

```
contract package  鈫? discovery & loading  鈫? catalog & install
(@dsh-superagent/kind)   (config + runtime)      (panel + JSON catalog)
```

### 3.1 Contract package

A types-only package, versioned independently, that a third party depends on instead of this repository:

```ts
// @dsh-superagent/kind
export interface ExtensionManifest {
  /** Contract major this extension implements; the runtime refuses a different major. */
  contract: 1
  kind: 'source' | 'executor' | 'channel'
  /** Unique id inside its kind, such as 'github' or 'wecom'. */
  id: string
  name: Localized
  description?: Localized
  /** Minimum dsh-superagent version, in the shape package.json uses. */
  engines?: { superagent: string }
}

export interface SourceKind<C = Record<string, unknown>> { /* moved from src/sources/kind.ts unchanged */ }
export interface ExecutorKind { /* new, see 3.2 */ }
export interface ChannelKind { /* extracted from SourceKind's channel member */ }
```

The point is not new capabilities: it is that the existing contract gets a **name, a version and a stable import path**,
so an extension can be written, tested and released on its own cadence.

### 3.2 Two new contracts

**ExecutorKind** 鈥?today one Ticket runs as a DSH Session. The same shape, generalised:

```ts
export interface ExecutorKind {
  id: string
  /** Fields the Execution settings card shows, reusing FieldSpec. */
  fields: FieldSpec[]
  /** Refuse an assignment before it starts, e.g. a missing image. */
  check(host: ExecutorHost, config: unknown, signal: AbortSignal): Promise<void>
  /** Start work; resolve when the run ends, however it ends. */
  run(input: ExecutorInput, host: ExecutorHost, signal: AbortSignal): Promise<void>
}
```

`ExecutorInput` carries what the Ticket already knows: id, title, request text, thread context, the git remote, the
branch name. The DSH-session executor becomes `dsh-superagent/executor-dsh`; a container executor is then an
extension rather than a fork.

**ChannelKind** 鈥?the reply side. Today a kind answers through its own channel member; splitting it lets one Source
answer through another (a GitHub issue whose replies land in a chat), which is the shape most teams actually want.

### 3.3 Discovery and loading: DSH's own plugin system

**There is no second loader, and none is needed.** `src/app/runtime.ts` declares
`interface Context { orchestrator: SourceHost }` and mounts itself with `super(ctx, 'orchestrator')`, and its own
comment says source plugins interact with dsh-superagent *exclusively* through that interface. So an extension is an
ordinary DSH plugin:

```ts
// @acme/superagent-notes — an installable DSH plugin, no fork of this repository
import type { Context } from '@deepseek-ai/cordis'
import type { SourceKind } from 'dsh-superagent/kind'
import { notesKind } from './kind.ts'

export const name = 'superagent-notes'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(notesKind), 'notes: source kind')
}
```

Discovery, enable/disable, versions and supply-chain checks are then DSH's, already built: `dsh plugin add`, the plugin
manager, and the market. What this repository owes an extension writer is the **contract import path** —
`dsh-superagent/kind` (a types entry plus the `CONTRACT` version) — so nobody reaches into `src/`.

```json
"exports": { "./kind": { "types": "./lib/kind.d.ts" } }
```

The built-in kinds are registered by their own bundle entries exactly as above, which is why they keep working with no
configuration: `dsh-superagent-github` and `dsh-superagent-feishu` are, in every respect, extensions that happen to ship
in this package.

### 3.3.1 What the panel still needs

Registration answers "does it work"; the panel must answer "what is installed, and why did one not load". `/sources`
already lists every registered kind with its health; the Extensions section adds the manifest — origin (built-in or
community), homepage, contract version — and a row for a kind whose `apply` threw.

### 3.4 Catalog and install

A static JSON catalog (one file, one repository, like dsh-market's), plus four routes:

| Route | Purpose |
| --- | --- |
| `GET /extensions` | installed (loaded, disabled, failed with reason) |
| `GET /extensions/catalog` | fetched from the catalog URL in settings, with the same filters the panel shows |
| `POST /extensions/install` | adds one entry to `extensions` and installs the package through DSH's plugin manager |
| `POST /extensions/remove` | disables and removes the entry; the package stays until the person removes it |

```json
{ "version": 1,
  "extensions": [
    { "module": "@acme/superagent-wecom", "kind": "source", "id": "wecom",
      "name": { "zh": "浼佷笟寰俊", "en": "WeCom" }, "engines": { "superagent": "^0.1" } } ] }
```

Installing is deliberately **not** a hot load of arbitrary code: the same trust boundary as `dsh plugin add` applies 鈥?a person installs a package, and the panel only wires it into `extensions`.

## 4 What not to do

- **Do not** make the core event-sourced or generic. Trigger 鈫?Ticket 鈫?Assignment 鈫?Report is the product; extensions
  attach at its edges (Source in, Executor middle, Channel out), not in the middle.
- **Do not** add a sandbox for extensions. They run in-process with the same trust as a DSH plugin; pretending
  otherwise would be worse than saying it.
- **Do not** accept a different contract major. One version check, one error message, no compatibility shims.

## 5 Migration, in three reviewable steps

| Step | Change | Verified by |
| --- | --- | --- |
| **1. Contract entry** (done) | `src/kind.ts` re-exports the contract as `dsh-superagent/kind` and exports `CONTRACT = 1`; no behaviour change, built as its own entry (`lib/kind.d.ts`). | `tsc`, `pnpm build`, `node -e "import(.../lib/kind.js)"` printing `CONTRACT = 1` |
| **2. First outside extension** | Ship WeCom as a separate DSH plugin package (reusing the bridge's crypto): `inject: ['orchestrator']` + `ctx.orchestrator.sources.register(kind)`. Built-ins keep working unchanged. | The WeCom self-check, plus a real callback against a 企业微信 app; the plugin must load with **no** edit to this repository |
| **3. Panel and catalog** | Extensions section (manifest, origin, failed rows) and the catalog routes. | A person installs the WeCom plugin, sees it listed with its manifest, and uninstalls it without losing the rest |

Step 3 is the honest test of the design: if the WeCom kind needs an edit to the core, the contract is wrong.

## 6 Acceptance

The plan is done when a person can, without editing this repository:

1. install a package, 2. paste one line into `extensions`, 3. see it in the panel with its settings card,
4. receive a message through it and get a reply, 5. uninstall it and see Sources return to the previous set.
