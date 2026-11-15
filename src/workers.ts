/** Registry of worker profiles a plugin adds: which DSH agent preset, extra tools and instructions a Ticket's worker runs with. */
import type { Trigger } from './core/model.ts'

/**
 * Tools a worker profile may not add: they ask or show a person something, change the profile, or schedule work outside the
 * worker slots, which an Executor Session must never do.
 */
const FORBIDDEN_TOOL = /^(ask_user_question|present|plugin_|market|schedule|goal|workflow)/

/**
 * One worker a plugin contributes to the Executor: a Policy rule names it in `worker`, or its `match` accepts the Ticket's
 * Source Trigger, and every Ticket accepted that way runs its worker Session with this profile.
 *
 * The preset **replaces** the bundled worker preset, so it must be based on `dsh-superagent-worker` to keep the work tools;
 * `tools` adds the profile's own tools to that preset's tool set. A profile cannot add person-facing or management tools.
 */
export interface WorkerProfile {
  /** Stable id a Policy rule names; `[A-Za-z0-9_-]{1,80}`, like a rule id. */
  id: string
  /** The DSH agent preset these Sessions are created with; it must be installed, and include the work tools the Tickets need. */
  preset: string
  /** Additional tool names the worker may use beside the preset's tools, such as a plugin's own domain tools. */
  tools?: readonly string[]
  /**
   * Whether a Ticket whose accepted Trigger this accepts runs the profile when no matched rule names another. It may read
   * the Trigger's Source, channel address and meta, such as a Feishu `chatId`; the plugin supplies trusted code.
   */
  match?: (trigger: Trigger) => boolean
  /** Its Tickets need no code directory: an empty folder and no prepare command, as a rule's `workspace: false` does. */
  workless?: boolean
  /** Instructions appended to the worker's system prompt, after the team's sections; the Ticket's Mandate still bounds the work. */
  instructions?: string
}

/** Holds the worker profiles registered by loaded plugins; registration returns the disposer that removes one again. */
export class WorkerRegistry {
  private readonly profiles = new Map<string, WorkerProfile>()
  /** Registers `profile`, refusing an id another loaded plugin already registered and a profile a Session could not use. */
  register(profile: WorkerProfile): () => void {
    if (!profile || typeof profile !== 'object') throw new Error('A worker profile must be an object')
    if (typeof profile.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(profile.id)) {
      throw new Error(`Invalid worker profile id: ${String(profile.id)}`)
    }
    if (typeof profile.preset !== 'string' || !profile.preset.trim()) throw new Error(`Worker profile ${profile.id} names no agent preset`)
    if (profile.match !== undefined && typeof profile.match !== 'function') throw new Error(`Worker profile ${profile.id} has a non-function match`)
    if (profile.tools !== undefined && !Array.isArray(profile.tools)) throw new Error(`Worker profile ${profile.id} has a non-array tools list`)
    for (const tool of profile.tools ?? []) {
      if (typeof tool !== 'string' || !tool.trim()) throw new Error(`Worker profile ${profile.id} names an invalid tool`)
      if (FORBIDDEN_TOOL.test(tool)) throw new Error(`Worker profile ${profile.id} may not add ${tool}: it is not a work tool`)
    }
    if (this.profiles.has(profile.id)) throw new Error(`Worker profile already registered: ${profile.id}`)
    this.profiles.set(profile.id, profile)
    return () => { if (this.profiles.get(profile.id) === profile) this.profiles.delete(profile.id) }
  }
  /** The profile `id` names, when a loaded plugin registered it. */
  get(id: string | undefined): WorkerProfile | undefined { return id === undefined ? undefined : this.profiles.get(id) }
  /** The first profile, by id, whose `match` accepts `trigger`; a throwing match names the profile and stops the acceptance. */
  match(trigger: Trigger | undefined): WorkerProfile | undefined {
    if (!trigger) return undefined
    for (const profile of this.list()) {
      if (!profile.match) continue
      try {
        if (profile.match(trigger)) return profile
      } catch (error) {
        throw new Error(`Worker profile ${profile.id} failed to match the Trigger: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return undefined
  }
  /** Every registered profile, ordered by id. */
  list(): WorkerProfile[] { return [...this.profiles.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}
