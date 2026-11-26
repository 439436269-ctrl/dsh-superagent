/** A completion must not restate what the conversation already carries: one outcome, one message. */
import { expect, it } from 'vitest'
import { restatesEarlier } from '../src/core/replies.ts'

const answer = '是——按现在的工具链必须逐家查：export_manager_list 一次只给一家公司的高管名单。实测 1,178 次打点，652 次成功后开始 429，共被拦 526 次。'

it('treats the same words, spaced differently, as the same message', () => {
  expect(restatesEarlier(`${answer}\n\n`, [answer])).toBe(true)
  expect(restatesEarlier(answer.replace(/：/, ': '), [answer])).toBe(false)
})

it('drops a completion whose body repeats an earlier answer inside it', () => {
  const completion = `✅ 执行完成，用时 8 分 38 秒\n\n${answer}`
  expect(restatesEarlier(completion, [answer])).toBe(true)
})

it('keeps a short line that merely appears inside a longer message', () => {
  expect(restatesEarlier('收到', ['收到：把浙大系的取数路径改成批量报表'])).toBe(false)
  expect(restatesEarlier('已完成：改批量报表', ['已完成：改批量报表'])).toBe(true)
})

it('sends the first message even when nothing was delivered yet', () => {
  expect(restatesEarlier(answer, [])).toBe(false)
  expect(restatesEarlier('', [answer])).toBe(false)
})
