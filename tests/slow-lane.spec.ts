import { expect, it } from 'vitest'
import { WorkerSlots } from '../src/executor/dsh.ts'

/** The slow lane runs one ticket at a time, so a second slow ticket waits even when fast slots are free. */
it('lets one slow ticket start while fast tickets keep their slots', () => {
  const running: string[] = []
  const slow = new Set(['a', 'b'])
  const slots = new WorkerSlots(() => running, () => 3, () => [...slow], () => 1)

  slots.reserve('a', 'launch')
  expect(() => slots.reserve('b', 'launch')).toThrow(/slow lane/i)
  // A fast ticket is unaffected by the slow lane being full.
  expect(() => slots.reserve('c', 'launch')).not.toThrow()
  // Once the slow ticket's start ends, the next slow ticket may start.
  slots.free('a')
  expect(() => slots.reserve('b', 'launch')).not.toThrow()
})
