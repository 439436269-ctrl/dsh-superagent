# 011 Extensions

How dsh-superagent grows without changing its core: what is already pluggable, what is not, and what to build so a
third party can ship a Source, an Executor or a Channel the way dsh-market ships plugins.

This document builds on [001 Domain model](001-domain.md) and [009 IM bridge](009-im-bridge.md).

## 1 Today: the seams that already exist

The core is built around a contract, not around GitHub and Feishu. Evidence:

| Seam | Where | How a kind plugs in |
| --- | --- | --- |
| **Source kind** | `src/sources/kind.ts` — `SourceKind` covers config schema, panel fields, policy part, channel, thread reader | `SourceRegistry.register(kind)` (`src/sources/registry.ts`), which rejects a duplicate kind and returns a disposer |
| **One entry per kind** | `tsdown.config.ts`: `github-watch` ← `src/sources/github.ts`, `feishu-watch` ← `src/sources/feishu.ts`, `im-watch` ← `src/sources/im.ts` | Each becomes its own bundle entry in `cordis.patch.yml`, enabled or disabled on its own |
| **Any chat tool** | `docs/009-im-bridge.md` | An external process: a "bridge" speaks JSON lines on stdout and takes one JSON argument to send |
| **Agent presets** | `cordis.patch.yml`: `dsh-superagent-worker-preset`, `dsh-superagent-router-preset` | A preset entry, replaceable without touching the plugin |
| **Other agents as workers** | `orchestrator_agent_*` tools (`src/sessions/bus.ts`) | Any CLI whose non-interactive command is installed — codex, claude, gemini, opencode |
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
4. **No catalog.** Nothing lists what may be installed, what is installed, or what is incompatible — the surface
   dsh-market provides for plugins.

## 3 The model

Three layers, each useful on its own:

```
contract package  →  discovery & loading  →  catalog & install
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

**ExecutorKind** — today one Ticket runs as a DSH Session. The same shape, generalised:

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

**ChannelKind** — the reply side. Today a kind answers through its own channel member; splitting it lets one Source
answer through another (a GitHub issue whose replies land in a chat), which is the shape most teams actually want.

### 3.3 Discovery and loading

One new plugin setting, `extensions`:

```yaml
- id: dsh-superagent
  config:
    stateDir: C:/Users/Lenovo/.dsh/state/superagent
    extensions:
      - module: '@acme/superagent-wecom'   # a package that exports `manifest` and `kind`
```

The runtime imports each module, checks `manifest.contract` and `engines.superagent`, calls
`registry.register(kind)`, and reports the result in a new **Extensions** section of the panel: installed, enabled,
version, and *why* it did not load. A failed extension never takes the plugin down — it is listed with its error, the
same way a Source that is `error` stays visible in Sources.

This mirrors the bundle patch's insert list, so the built-in kinds keep working with no configuration at all: they are
simply pre-registered by the bundle, and the `extensions` list adds to them.

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
      "name": { "zh": "企业微信", "en": "WeCom" }, "engines": { "superagent": "^0.1" } } ] }
```

Installing is deliberately **not** a hot load of arbitrary code: the same trust boundary as `dsh plugin add` applies —
a person installs a package, and the panel only wires it into `extensions`.

## 4 What not to do

- **Do not** make the core event-sourced or generic. Trigger → Ticket → Assignment → Report is the product; extensions
  attach at its edges (Source in, Executor middle, Channel out), not in the middle.
- **Do not** add a sandbox for extensions. They run in-process with the same trust as a DSH plugin; pretending
  otherwise would be worse than saying it.
- **Do not** accept a different contract major. One version check, one error message, no compatibility shims.

## 5 Migration, in three reviewable steps

| Step | Change | Verified by |
| --- | --- | --- |
| **1. Contract** | Move `SourceKind` and friends into `@dsh-superagent/kind` (a workspace package, published as types only); `src/sources/kind.ts` re-exports it. No behaviour change. | `tsc`, the existing 1204-test suite unchanged, build |
| **2. Discovery** | `extensions` config + loader + registry wiring + Extensions panel section. Built-in kinds still come from the bundle. | A test that loads a fixture extension and asserts it appears in `/sources`; a test that a bad manifest is listed as failed and the plugin still serves |
| **3. First outside extension** | Ship the WeCom source as `@acme/superagent-wecom` — the bridge from `examples/im-bridges/wecom.mjs` becomes an in-process kind with the same crypto tests. | The WeCom self-check plus an end-to-end callback against a real app |

Step 3 is the honest test of the design: if the WeCom kind needs an edit to the core, the contract is wrong.

## 6 Acceptance

The plan is done when a person can, without editing this repository:

1. install a package, 2. paste one line into `extensions`, 3. see it in the panel with its settings card,
4. receive a message through it and get a reply, 5. uninstall it and see Sources return to the previous set.
