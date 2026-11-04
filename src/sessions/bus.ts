/**
 * Session bus: lets one supervision Session see other Sessions and hand work to other agents.
 *
 * First principles, because the formats differ per tool: a Session is a conversation with a transcript, and an agent that
 * cannot show its transcript can still accept a task and answer. So the bus has two halves and no more:
 *
 * - **Transcripts** (`SessionAdapter`) for tools whose transcript format is public. DSH writes one, so a supervision
 *   Session can list Sessions across every DSH profile on the machine, read their latest turns, and search them.
 * - **Runners** (`AgentRunner`) for tools that are only usable as a non-interactive command. Nothing about Codex's or
 *   Claude Code's private history is guessed: the task goes in on the command line, the answer comes back on stdout.
 *
 * Everything is bounded on purpose: listings carry a digest, reads take the tail, decodes are cached by file identity,
 * and a dispatch is a recorded run with a timeout, so a supervisor never holds a whole transcript or a hung agent.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

export interface SessionRef {
  agent: string
  id: string
  /** Absolute path of the transcript this Session was read from. */
  path: string
  cwd: string
  title: string
  startedAt: string
  lastAt: string
  bytes: number
}
export type Role = 'user' | 'assistant' | 'tool'
export interface Turn { role: Role; at?: string; text: string }
export interface SessionAdapter {
  readonly agent: string
  readonly label: string
  list(limit: number): Promise<SessionRef[]>
  read(ref: SessionRef, tail: number): Promise<Turn[]>
}
export interface AgentRunner {
  readonly agent: string
  readonly label: string
  /** The resolved executable, or undefined when the tool is not installed. */
  detect(): string | undefined
  args(task: string, cwd: string): string[]
}
export interface Run {
  id: string
  agent: string
  task: string
  cwd: string
  state: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: string
  endedAt?: string
  code?: number
  output: string
}

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/
const MAX_BYTES = 64 * 1024 * 1024

/** Newest transcript of one Session directory: the highest version, never a `.zstd` beside a plain file of the same version. */
function transcriptOf(directory: string): string | undefined {
  let best: { path: string; version: number } | undefined
  let names: string[]
  try { names = readdirSync(directory) } catch { return undefined }
  for (const name of names) {
    const match = SESSION_FILE.exec(name)
    if (!match) continue
    const version = Number(match[1] ?? 0) + (match[2] ? 0.5 : 0)
    if (!best || version > best.version) best = { path: join(directory, name), version }
  }
  return best?.path
}

/** Reads a transcript as text, decompressing Zstandard frames; undefined when it is unreadable or too large to bound the cost. */
function transcriptText(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_BYTES) return undefined
    const buffer = readFileSync(path)
    return path.endsWith('.zstd') ? zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8')
  } catch { return undefined }
}

/** A tiny LRU so repeated reads of one Session decode once; transcripts cannot be seeked while compressed. */
class Lru<T> {
  private readonly map = new Map<string, T>()
  constructor(private readonly size: number) {}
  get(key: string): T | undefined {
    const value = this.map.get(key)
    if (value !== undefined) { this.map.delete(key); this.map.set(key, value) }
    return value
  }
  set(key: string, value: T): T {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value!)
    return value
  }
}

const identity = (path: string): string => { const stat = statSync(path); return `${path}:${stat.size}:${stat.mtimeMs}` }
const truncated = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 1)}…`

/**
 * A Session's display title from its first request. A supervisor's own worker Sessions open with a JSON payload rather
 * than prose, so a `title` or `text` field inside it is used instead of showing the payload.
 */
function titleOf(turn: Turn | undefined, fallback: string): string {
  const text = turn?.text.replace(/\s+/g, ' ').trim() ?? ''
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text) as { title?: unknown; text?: unknown }
      const inner = typeof value.title === 'string' ? value.title : typeof value.text === 'string' ? value.text : undefined
      if (inner?.trim()) return truncated(inner.replace(/\s+/g, ' ').trim(), 120)
    } catch { /* Not JSON after all; fall through to the raw text. */ }
  }
  return truncated(text || fallback, 120)
}

/** Events of a DSH transcript, reduced to the three kinds a supervisor reads: what was asked, what was answered, what ran. */
function dshTurns(text: string): Turn[] {
  const turns: Turn[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let event: { type?: string; time?: number; data?: Record<string, unknown> }
    try { event = JSON.parse(line) } catch { continue }
    const at = typeof event.time === 'number' ? new Date(event.time).toISOString() : undefined
    if (event.type === 'user/message') {
      const content = event.data?.content
      const body = Array.isArray(content) ? content.flatMap(part => typeof part === 'object' && part && 'text' in part ? [String((part as { text: unknown }).text)] : []).join('\n') : ''
      if (body.trim()) turns.push({ role: 'user', at, text: truncated(body, 4000) })
    } else if (event.type === 'assistant/message') {
      const message = event.data?.message as { content?: unknown } | undefined
      const content = message?.content
      const body = Array.isArray(content) ? content.flatMap(part => typeof part === 'object' && part && (part as { type?: string }).type === 'text' ? [String((part as { text: unknown }).text)] : []).join('\n') : ''
      if (body.trim()) turns.push({ role: 'assistant', at, text: truncated(body, 4000) })
    } else if (event.type === 'tool/call') {
      const name = String(event.data?.name ?? 'tool')
      const args = String(event.data?.arguments ?? '')
      turns.push({ role: 'tool', at, text: `${name} ${truncated(args, 300)}` })
    }
  }
  return turns
}

/** DSH Sessions on this machine, across every profile and workspace. */
export class DshAdapter implements SessionAdapter {
  readonly agent = 'dsh'
  readonly label = 'DeepSeek Harness'
  private readonly cache = new Lru<{ ref: SessionRef; turns: Turn[] }>(8)
  constructor(private readonly home = DSH_HOME) {}

  list(limit: number): Promise<SessionRef[]> {
    const found: SessionRef[] = []
    const root = join(this.home, 'sessions')
    let workspaces: string[]
    try { workspaces = readdirSync(root) } catch { return Promise.resolve([]) }
    for (const workspace of workspaces) {
      const workspaceDirectory = join(root, workspace)
      let sessions: string[]
      try { sessions = readdirSync(workspaceDirectory) } catch { continue }
      for (const session of sessions) {
        const path = transcriptOf(join(workspaceDirectory, session))
        if (!path) continue
        let stat
        try { stat = statSync(path) } catch { continue }
        const parsed = this.cache.get(identity(path)) ?? this.parse(path, session, workspace)
        if (parsed) found.push({ ...parsed.ref, bytes: stat.size, lastAt: stat.mtime.toISOString() })
      }
    }
    return Promise.resolve(found.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit))
  }

  /** Parses a transcript once per file identity; both the digest for listings and the turns for reads come from it. */
  private parse(path: string, session: string, workspace: string): { ref: SessionRef; turns: Turn[] } | undefined {
    const text = transcriptText(path)
    if (!text) return undefined
    const turns = dshTurns(text)
    const header = text.split('\n', 1)[0] ?? ''
    let cwd = workspace.replace(/^--/, '').replace(/--$/, '').replace(/-/g, '/')
    let startedAt = new Date().toISOString()
    try {
      const first = JSON.parse(header) as { type?: string; cwd?: string; createdAt?: number }
      if (first.type === 'session') {
        if (first.cwd) cwd = first.cwd
        if (typeof first.createdAt === 'number') startedAt = new Date(first.createdAt).toISOString()
      }
    } catch { /* A transcript without a readable header still lists, with the directory's own facts. */ }
    const title = titleOf(turns.find(turn => turn.role === 'user'), session)
    return this.cache.set(identity(path), { ref: { agent: this.agent, id: session, path, cwd, title, startedAt, lastAt: startedAt, bytes: 0 }, turns })
  }

  async read(ref: SessionRef, tail: number): Promise<Turn[]> {
    const cached = this.cache.get(identity(ref.path))?.turns ?? this.parse(ref.path, ref.id, '')?.turns
    if (!cached) return []
    return cached.slice(-Math.max(1, tail))
  }

  /** Turns containing `query`, newest Session first, bounded by `limit`; decodes only what it must. */
  async search(query: string, limit: number): Promise<{ ref: SessionRef; turn: Turn }[]> {
    const needle = query.toLowerCase()
    const hits: { ref: SessionRef; turn: Turn }[] = []
    for (const ref of await this.list(200)) {
      if (hits.length >= limit) break
      const cached = this.cache.get(identity(ref.path)) ?? this.parse(ref.path, ref.id, '')
      for (const turn of cached?.turns ?? []) {
        if (!turn.text.toLowerCase().includes(needle)) continue
        hits.push({ ref, turn })
        if (hits.length >= limit) break
      }
    }
    return hits
  }
}

/** Runners for agents usable as one non-interactive command; each is detected rather than assumed. */
export class CliRunners {
  private readonly runs = new Map<string, { run: Run; child?: ReturnType<typeof spawn> }>()
  /** `runners` is injectable so a test can drive the dispatch machinery without installing an agent. */
  constructor(private readonly directory: string, private readonly definitions: readonly AgentRunner[] = RUNNERS) { mkdirSync(directory, { recursive: true }) }

  list(): { agent: string; label: string; command: string }[] {
    return this.definitions.flatMap(definition => { const path = definition.detect(); return path ? [{ agent: definition.agent, label: definition.label, command: path }] : [] })
  }

  async dispatch(input: { agent: string; task: string; cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<Run> {
    const definition = this.definitions.find(item => item.agent === input.agent)
    if (!definition) throw new Error(`Unknown agent ${input.agent}; known: ${this.definitions.map(item => item.agent).join(', ')}`)
    const command = definition.detect()
    if (!command) throw new Error(`${definition.label} is not installed`)
    const id = randomUUID()
    const run: Run = { id, agent: input.agent, task: input.task, cwd: input.cwd, state: 'running', startedAt: new Date().toISOString(), output: '' }
    this.runs.set(id, { run })
    const child = spawn(command, definition.args(input.task, input.cwd), { cwd: input.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.runs.set(id, { run, child })
    const append = (chunk: Buffer): void => { run.output = truncated(run.output + chunk.toString(), 200_000) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timeout = input.timeoutMs ?? 600_000
    const timer = setTimeout(() => { run.state = 'stopped'; child.kill() }, timeout)
    const abort = (): void => { run.state = 'stopped'; child.kill() }
    input.signal?.addEventListener('abort', abort, { once: true })
    child.on('exit', code => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      if (run.state !== 'stopped') run.state = code === 0 ? 'done' : 'failed'
      run.code = code ?? undefined
      run.endedAt = new Date().toISOString()
      this.persist(run)
    })
    return run
  }

  status(id: string): Run | undefined {
    const entry = this.runs.get(id)
    if (entry) return entry.run
    try { return JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8')) as Run } catch { return undefined }
  }

  /** Writes the finished run beside the state directory so it survives a restart and a supervisor can look it up later. */
  private persist(run: Run): void {
    try { writeFileSync(join(this.directory, `${run.id}.json`), JSON.stringify(run)) } catch { /* A lost record never breaks a run. */ }
  }
}

/** Resolves a command on PATH the way a shell would, so detection never claims a tool that cannot run. */
function onPath(name: string): string | undefined {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD').split(';') : ['']
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** One entry per agent a supervisor may hand work to; the argument shapes are the CLIs' own non-interactive forms. */
const RUNNERS: AgentRunner[] = [
  { agent: 'codex', label: 'OpenAI Codex', detect: () => onPath('codex'), args: (task, cwd) => ['exec', '--cd', cwd, task] },
  { agent: 'claude', label: 'Claude Code', detect: () => onPath('claude'), args: task => ['-p', task, '--output-format', 'text'] },
  { agent: 'gemini', label: 'Gemini CLI', detect: () => onPath('gemini'), args: task => ['-p', task] },
  { agent: 'opencode', label: 'opencode', detect: () => onPath('opencode'), args: task => ['run', task] },
]

/** The bus a supervision Session sees: every transcript adapter, plus the runners that are actually installed. */
export class SessionBus {
  readonly adapters: SessionAdapter[]
  readonly runners: CliRunners
  constructor(options: { stateDir: string; adapters?: SessionAdapter[] }) {
    this.adapters = options.adapters ?? [new DshAdapter()]
    this.runners = new CliRunners(join(options.stateDir, 'session-bus', 'runs'))
  }

  async listSessions(input: { agent?: string; limit?: number }): Promise<SessionRef[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const adapters = input.agent ? this.adapters.filter(item => item.agent === input.agent) : this.adapters
    const lists = await Promise.all(adapters.map(adapter => adapter.list(limit).catch(() => [] as SessionRef[])))
    return lists.flat().sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit)
  }

  async readSession(input: { agent: string; id: string; tail?: number }): Promise<{ ref: SessionRef; turns: Turn[] }> {
    const adapter = this.adapters.find(item => item.agent === input.agent)
    if (!adapter) throw new Error(`No transcript adapter for ${input.agent}; known: ${this.adapters.map(item => item.agent).join(', ')}`)
    const ref = (await adapter.list(500)).find(item => item.id === input.id)
    if (!ref) throw new Error(`Unknown Session ${input.agent}/${input.id}`)
    return { ref, turns: await adapter.read(ref, Math.min(Math.max(input.tail ?? 20, 1), 200)) }
  }

  async searchSessions(input: { query: string; limit?: number }): Promise<{ ref: SessionRef; turn: Turn }[]> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
    const dsh = this.adapters.find(item => item instanceof DshAdapter)
    if (!dsh) return []
    return (dsh as DshAdapter).search(input.query, limit)
  }
}
