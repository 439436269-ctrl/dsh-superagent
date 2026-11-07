/**
 * The public extension contract.
 *
 * A Source plugin is an ordinary DSH plugin: it declares `inject = ['orchestrator']` and registers a kind in `apply`.
 * It imports the types from here rather than reaching into `src/`, so this module is the compatibility surface this
 * repository promises to keep stable.
 *
 * ```ts
 * import type { Context } from '@deepseek-ai/cordis'
 * import type { SourceKind } from 'dsh-superagent/kind'
 * import { myKind } from './kind.ts'
 *
 * export const name = 'my-source'
 * export const inject = ['orchestrator']
 * export function apply(ctx: Context): void {
 *   ctx.effect(() => ctx.orchestrator.sources.register(myKind), 'my-source: kind')
 * }
 * ```
 *
 * Nothing here loads a plugin: DSH installs it (`dsh plugin add`), the plugin manager enables it, and the Cordis
 * context gives it `orchestrator`. This repository adds no second discovery mechanism.
 */
export type {
  /** Everything a Source kind declares: configuration, panel fields, policy, channel and thread reader. */
  SourceKind,
  /** One field of a settings card. */
  FieldSpec,
  /** A string that carries both interface languages. */
  Localized,
  /** An environment variable the prepare command or a prompt may use. */
  VariableSpec,
  /** The Source's part of the Policy: allowed senders and admission rows. */
  SourcePolicyPart,
  /** A row of the admission table for a receiving scope. */
  AdmissionRowView,
  /** UI link back to a thread, used in the panel and in reports. */
  ChannelLink,
  /** Adapter that answers in a kind's threads. */
  SourceChannel,
  /** One stored Source instance of a kind. */
  SourceInstance,
} from './sources/kind.ts'
export type { SourceHost, SourceContext } from './sources/host.ts'

/**
 * What the panel shows about an extension besides its registered kinds. A plugin may export `manifest` with these
 * values; dsh-superagent treats a missing manifest as "built in", which is what every kind shipped here is.
 */
export interface ExtensionManifest {
  /** Contract major this extension was written against; a different major is refused rather than adapted. */
  contract: 1
  /** Where the extension came from, shown in the panel. */
  origin?: 'builtin' | 'community'
  /** Repository or home page, for a person deciding whether to trust it. */
  homepage?: string
  /** Short description of what the extension adds. */
  description?: LocalizedText
}
/** The contract major this build implements. */
export const CONTRACT = 1 as const
/** Minimal shape of a localized string, duplicated so this module imports no runtime code. */
export interface LocalizedText { zh: string; en: string }
