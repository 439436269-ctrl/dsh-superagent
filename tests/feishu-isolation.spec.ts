import { expect, it } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'

/**
 * Two Feishu instances, each listening to its own group, must not claim each other's chats: that is the "same kind, several instances,
 * no crossed messages" property, checked at the place that decides it (the registry's scope lookup, which the gate asks).
 */
it('gives each Feishu instance only its own chats', () => {
  const settings = SettingsSchema.parse({
    sources: {
      feishu: { enabled: true, config: { chats: [{ chatId: 'oc_first', listen: 'all' }], directMessages: false } },
      'feishu-2': { enabled: true, kind: 'feishu', config: { chats: [{ chatId: 'oc_second', listen: 'all' }], directMessages: false } },
    },
  })
  const board = { claim: () => ({ set: () => {} }), entries: () => [] }
  const registry = new SourceRegistry(() => settings, board as never)
  registry.register(feishuKind)

  const scope = (instance: string, chatId: string) => registry.scope({ source: 'feishu', meta: { instance, chatId, direct: false } })

  expect(scope('feishu', 'oc_first').listened).toBe(true)
  expect(scope('feishu', 'oc_second').listened).toBe(false)
  expect(scope('feishu-2', 'oc_second').listened).toBe(true)
  expect(scope('feishu-2', 'oc_first').listened).toBe(false)
})
