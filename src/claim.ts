/**
 * `orchestrator_claim`: lets the Session that runs this tool take over as the dispatcher.
 *
 * It is registered only in the router preset, so the capability exists exactly where a person expects it: a Session
 * started with `dsh-superagent-router` can say "我要接手调度者" and the model calls this. The Session id comes from the
 * tool execution, not from an argument, so it can only ever name the caller.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis'

export const name = 'dsh-superagent-claim'
export const inject = ['tools', 'orchestrator']

/** The Host service this tool needs: setting the dispatcher is the whole operation. */
interface DispatcherHost {
  setDispatcher(id: string | null): { dispatcher: string }
  dispatcher(): Promise<{ id: string; available: boolean; running: boolean }>
}

export function apply(ctx: Context): void {
  const host = ctx.orchestrator as unknown as DispatcherHost
  ctx.tools.register({
    name: 'orchestrator_claim',
    description: 'Take over as the dispatcher of dsh-superagent from this Session, so every later request is judged here. Use it only when the person asks for it, such as "我要接手调度者". The dispatcher is remembered across restarts; a person can hand it back from the panel.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    execute: async (_args: unknown, exec: { agent?: { id?: string } }) => {
      const id = exec?.agent?.id
      if (!id) throw new Error('This call carries no Session, so there is nothing to claim')
      host.setDispatcher(id)
      return { dispatcher: id, claimed: true }
    },
  })
}