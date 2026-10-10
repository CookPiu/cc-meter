import { describe, expect, test } from 'claude-code/testing'

import { costOf, globalView, priceOf } from '../hooks/register'
import type { GlobalScan, ScanRow } from '../types'

const M = 1_000_000
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-10T02:00:00Z')

const rows: ScanRow[] = [
  ['2026-10-09', 10, 'Code/demo', 'claude-opus-5-5', M, 0, 0, 0, 0],
  ['2026-10-10', 10, 'Projects/oss', 'claude-sonnet-5-5', 0, M, 0, 0, 0],
  ['2026-08-01', 3, 'Workspaces/sys', 'claude-opus-5', M, 0, 0, 0, 0],
  ['2026-10-10', 9, 'Workspaces/sys', '<synthetic>', 5, 0, 0, 0, 0],
]
const scanWith = (windowCostTokens: number): GlobalScan => ({
  rows,
  windows: { five_hour: { start: NOW - 2 * HOUR, byModel: { 'claude-opus-5-5': [windowCostTokens, 0, 0, 0, 0] }, byProject: {} } },
  observations: [],
  today: '2026-10-10',
  tzOffsetMin: 480,
  files: 3,
  readBytes: 2048,
  ms: 12,
  at: NOW,
})
const five = (percentUsed: number) => ({ kind: 'five_hour', percentUsed, resetsAt: new Date(NOW + 3 * HOUR).toISOString() })

async function must(ui: { find: (q: never) => Promise<unknown> }, query: object): Promise<void> {
  if ((await ui.find(query as never)) === undefined) {
    throw new Error(`nothing drawn matches ${String(JSON.stringify(query, (k, v) => (v instanceof RegExp ? String(v) : v)))}`)
  }
}

describe('prices', () => {
  test('per kind of token, by id or its longest prefix', () => {
    expect(costOf('claude-opus-5-5', [M, M, M, M, M])).toBe(4 + 20 + 0.2 + 5 + 8)
    expect(priceOf('claude-opus-5-5-20261001')?.[0]).toBe(4)
    expect(priceOf('claude-opus-5')?.[0]).toBe(5)
    expect(priceOf('<synthetic>')).toBeNull()
  })
})

describe('global view', () => {
  test('the last 30 days by day, project, model and hour', () => {
    const g = globalView(scanWith(M), '30d')
    expect(g.days).toBe(2)
    expect(g.totalCost).toBe(4 + 10)
    expect(g.byProject.map(p => p.project)).toEqual(['Projects/oss', 'Code/demo', 'Workspaces/sys'])
    expect(g.daily.map(d => d.day)).toEqual(['2026-10-09', '2026-10-10'])
    expect(g.hourly[10]).toBe(7)
    expect(g.unpriced).toEqual(['<synthetic>'])
  })

  test('all of history', () => {
    const g = globalView(scanWith(M), 'all')
    expect(g.days).toBe(31 + 30 + 10)
    expect(g.totalCost).toBe(19)
    expect(g.daily[0]?.day).toBe('2026-08-01')
  })
})

test('the pane switches to the global view, scans, and changes range', { options: { language: 'zh' } }, async ($, on) => {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
  on('clock.sleep', () => ({ value: undefined }) as never)
  const store: Record<string, unknown> = {}
  on('store.get', ($: unknown, e: { key: string }) => ({ value: store[e.key] }) as never)
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('env.get', ($: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }) as never)
  on('process.run', ($: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: JSON.stringify(scanWith(M)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.measure', ($: unknown, e: { changed: string[] }) => ({ changed: e.changed }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.measure({
    context: { tokens: 1000, window: 200_000, percent: 1 },
    rateLimits: [five(40)],
    cost: { usd: 1 },
    changed: ['context', 'rateLimits', 'cost'],
  } as never)

  const pane = {
    plugin: 'token-almanac',
    component: 'Pane' as const,
    requestId: 'token-almanac',
    props: { title: 'Token 用量', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} },
  }
  const first = await $.ui.mount({ ...pane, surface: 'terminal' })
  await first.press({ key: 'tab-global' })
  await first.unmount()
  // The scanner ran over the whole projects folder, given the window's start and the readings.
  expect(runs[0]?.argv.slice(2)).toEqual(['global', 'C:/Users/me/.claude/projects', 'C:/Users/me/.claude/token-almanac/cache.json'])
  const input = JSON.parse(runs[0]?.stdin ?? '{}') as { windows: Record<string, number>; readings: unknown[] }
  expect(input.windows).toEqual({ five_hour: NOW + 3 * HOUR - 5 * HOUR })
  expect(input.readings).toEqual([[NOW, 'five_hour', 40, NOW + 3 * HOUR]])
  // Reopened within a minute, the view shows what it has and reads nothing again.
  const again = await $.ui.mount({ ...pane, surface: 'terminal' })
  await again.press({ key: 'tab-session' })
  await again.press({ key: 'tab-global' })
  expect(runs).toHaveLength(1)
  await again.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const p = await $.ui.mount({ ...pane, surface })
    await must(p, { text: /3 个文件 · 刚刚更新/ })
    await must(p, { text: '$7.00' })
    await must(p, { text: '日均' })
    await must(p, { text: 'Projects/oss' })
    // The details stay folded until asked for.
    expect(await p.find({ text: /未定价/ })).toBeUndefined()
    await p.press({ key: 'details' })
    await must(p, { text: /未定价、按 0 计：<synthetic>/ })
    await p.press({ key: 'details' })
    if (surface === 'desktop') await must(p, { type: 'Svg' })
    else await must(p, { text: /10-09/ })
    await p.unmount()
  }

  const p = await $.ui.mount({ ...pane, surface: 'terminal' })
  await p.press({ key: 'range-all' })
  await must(p, { text: /71 天/ })
  await p.press({ key: 'tab-session' })
  await must(p, { text: '构成' })
  await p.unmount()
})

test('the global view leads with what each window holds and has left', { options: { language: 'zh' } }, async ($, on) => {
  // Two limit hits on Pro, at $60 and $100 of Opus 5.5 output; this window has spent $20 so far.
  const hit = (t: number, outputTokens: number) => ({
    t,
    kind: 'five_hour',
    y: 1,
    resetsAt: t + HOUR,
    hit: true,
    byModel: { 'claude-opus-5-5': [0, outputTokens, 0, 0, 0] as [number, number, number, number, number] },
  })
  const scan: GlobalScan = {
    ...scanWith(0),
    windows: { five_hour: { start: NOW - 2 * HOUR, byModel: { 'claude-opus-5-5': [0, M, 0, 0, 0] }, byProject: {} } },
    observations: [hit(NOW - 100 * HOUR, 3 * M), hit(NOW - 50 * HOUR, 5 * M)],
  }
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
  on('clock.sleep', () => ({ value: undefined }) as never)
  const store: Record<string, unknown> = {}
  on('store.get', ($: unknown, e: { key: string }) => ({ value: store[e.key] }) as never)
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('env.get', ($: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(scan), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('session.measure', ($: unknown, e: { changed: string[] }) => ({ changed: e.changed }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [five(25)], cost: { usd: 1 }, changed: ['rateLimits'] } as never)

  const pane = {
    plugin: 'token-almanac',
    component: 'Pane' as const,
    requestId: 'token-almanac',
    props: { title: 'Token 用量', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} },
  }
  const first = await $.ui.mount({ ...pane, surface: 'terminal' })
  await first.press({ key: 'tab-global' })
  // No plan picked yet: the estimates say so and ask for one.
  await must(first, { text: '不确定 · 按 API 价格折算' })
  await must(first, { text: /选择你的套餐/ })
  await first.select({ key: 'plan', value: 'pro' })
  await first.unmount()
  expect((store.planChoices as { plan: string }[]).map(c => c.plan)).toEqual(['pro'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const p = await $.ui.mount({ ...pane, surface })
    await must(p, { text: '容量推算' })
    await must(p, { text: 'Pro · 按 API 价格折算' })
    await must(p, { text: '整窗' })
    // About $80 a window: $20 so far is a quarter of it, and three quarters are left.
    const whole = (await p.find({ text: /^≈ \$\d+$/ })) as { text?: string } | undefined
    const amounts = JSON.stringify(await p.findAll({ text: /^≈ \$\d+$/ }))
    expect(whole).toBeDefined()
    // Each amount is found on its cell and on its text: the drawn order, once each.
    const [cap, left] = [...new Set([...amounts.matchAll(/≈ \$(\d+)/g)].map(m => Number(m[1])))]
    expect(cap! > 60 && cap! < 100).toBe(true)
    expect(Math.abs(left! - cap! * 0.75) <= 1).toBe(true)
    await must(p, { text: '低' })
    await must(p, { text: '5 小时历史触限 2 次，每次折合 $60–$100' })
    await p.unmount()
  }
})
