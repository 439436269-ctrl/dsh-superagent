/** Registry of worker profiles a plugin adds: which DSH agent preset, extra tools and instructions a Ticket's worker runs with. */
import type { Text } from './core/model.ts'

/**
 * One worker a plugin contributes to the Executor: a policy rule names it in `worker`, and every Ticket accepted under that
 * rule runs its worker Session with this profile instead of the bundled one. A profile adds to the bundled worker; it
 * cannot take away the work tools, the report and reply tools, or the Ticket's permissions.
 */
export interface WorkerProfile {
  /** Stable id a Policy rule names; `[A-Za-z0-9_-]{1,80}`, like a rule id. */
  id: string
  /** Display name for the panel and for people reading a Rule. */
  name: Text
  /** The DSH agent preset these Sessions are created with; it must be installed in the profile. */
  preset: string
  /** Additional tool names the worker may use beside the bundled work tools, such as a plugin's own domain tools. */
  tools?: readonly string[]
  /**
   * The Sources whose Tickets run this profile when no matched rule names another, such as a business bot's Feishu chat.
   * A rule's `worker` wins; when two profiles claim one Source, the profile with the lower id does.
   */
  sources?: readonly string[]
  /** Instructions appended to the worker's system prompt, after the team's sections; the Ticket's Mandate still bounds the work. */
  instructions?: string
}

/** Holds the worker profiles registered by loaded plugins; registration returns the disposer that removes one again. */
export class WorkerRegistry {
  private readonly profiles = new Map<string, WorkerProfile>()
  /** Registers `profile`, refusing an id another loaded plugin already registered and a profile a Session could not use. */
  register(profile: WorkerProfile): () => void {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(profile.id)) throw new Error(`Invalid worker profile id: ${profile.id}`)
    if (!profile.preset.trim()) throw new Error(`Worker profile ${profile.id} names no agent preset`)
    if (!profile.name || (typeof profile.name === 'object' && (!profile.name.zh.trim() || !profile.name.en.trim()))) {
      throw new Error(`Worker profile ${profile.id} names no display name`)
    }
    if (profile.sources && (!Array.isArray(profile.sources) || profile.sources.some(source => typeof source !== 'string' || !source.trim()))) {
      throw new Error(`Worker profile ${profile.id} names an invalid Source`)
    }
    if (profile.tools && (!Array.isArray(profile.tools) || profile.tools.some(tool => typeof tool !== 'string' || !tool.trim()))) {
      throw new Error(`Worker profile ${profile.id} names an invalid tool`)
    }
    if (this.profiles.has(profile.id)) throw new Error(`Worker profile already registered: ${profile.id}`)
    this.profiles.set(profile.id, profile)
    return () => { if (this.profiles.get(profile.id) === profile) this.profiles.delete(profile.id) }
  }
  /** The profile `id` names, when a loaded plugin registered it. */
  get(id: string | undefined): WorkerProfile | undefined { return id === undefined ? undefined : this.profiles.get(id) }
  /** The profile whose `sources` name `source`, ordered by id so two plugins claiming one Source resolve the same way. */
  match(source: string | undefined): WorkerProfile | undefined {
    return source === undefined ? undefined : this.list().find(profile => profile.sources?.includes(source))
  }
  /** Every registered profile, ordered by id. */
  list(): WorkerProfile[] { return [...this.profiles.values()].sort((a, b) => a.id.localeCompare(b.id)) }
}
