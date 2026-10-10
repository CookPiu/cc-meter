import { describe, expect, test } from 'claude-code/testing'

import { fitKind, fittedWindow, pickLocale, priceOf, setPriceOverrides, spendByKind } from '../hooks/register'
import { localeOf } from '../hooks/i18n'
import type { Observation, PlanChoice, Vec } from '../types'

const M = 1_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse('2026-10-10T08:00:00Z')

async function must(ui: { find: (q: never) => Promise<unknown> }, query: object): Promise<void> {
  if ((await ui.find(query as never)) === undefined) {
    throw new Error(`nothing drawn matches ${String(JSON.stringify(query, (k, v) => (v instanceof RegExp ? String(v) : v)))}`)
  }
}

const band = {
  plugin: 'token-almanac',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 140, scroll: { offset: 0, bodyRows: 6 }, view: {} },
}
const pane = {
  plugin: 'token-almanac',
  component: 'Pane' as const,
  requestId: 'token-almanac',
  props: { title: 'Token usage', isFocused: false, bodyColumns: 70, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}

// The engine beneath the plugin, for the views: a clock, a store, a scanner.
function engine(on: any, scan?: () => unknown) {
  let now = T0
  const store: Record<string, unknown> = {}
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
  on('clock.sleep', () => ({ value: undefined }) as never)
  on('clock.after', () => ({ value: { cancel: () => undefined } }) as never)
  on('store.get', ($: unknown, e: { key: string }) => ({ value: store[e.key] }) as never)
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('env.get', ($: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('process.run', () => {
    // As the engine answers a command it cannot start.
    if (scan === undefined) return { deny: 'spawn node ENOENT' } as never
    return { value: { exitCode: 0, stdout: JSON.stringify(scan()), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.measure', ($: unknown, e: { changed: string[] }) => ({ changed: e.changed }) as never)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { store, advance: (ms: number) => (now += ms) }
}

describe('language', () => {
  test('names and tags map to a locale', () => {
    expect(localeOf('chinese')).toBe('zh')
    expect(localeOf('zh_CN.UTF-8')).toBe('zh')
    expect(localeOf('简体中文')).toBe('zh')
    expect(localeOf('en-US')).toBe('en')
    expect(localeOf('ja_JP.UTF-8')).toBeNull()
    expect(localeOf('C')).toBeNull()
  })

  test('the option wins, then the setting, LC_ALL, LANG, the system; else English', () => {
    expect(pickLocale('en', 'chinese', 'zh_CN', 'zh_CN', 'zh-CN')).toBe('en')
    expect(pickLocale('auto', 'chinese', 'en_US', undefined, 'en-US')).toBe('zh')
    expect(pickLocale('auto', undefined, undefined, 'zh_CN.UTF-8', 'en-US')).toBe('zh')
    expect(pickLocale('auto', 'japanese', undefined, undefined, 'ja-JP')).toBe('en')
    expect(pickLocale('auto')).toBe('en')
  })
})

test('the views speak English when asked', { options: { language: 'en' } }, async ($, on) => {
  engine(on, () => ({ rows: [], windows: {}, observations: [], today: '2026-10-10', tzOffsetMin: 0, files: 2, readBytes: 0, ms: 3, at: T0 }))
  await $.session.measure({
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: new Date(T0 + 4 * HOUR).toISOString() },
      { kind: 'seven_day_opus', percentUsed: 12, resetsAt: new Date(T0 + 3 * 24 * HOUR).toISOString() },
      { kind: 'some_new_window', percentUsed: 5 },
    ],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'],
  } as never)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const b = await $.ui.mount({ ...band, surface })
    await must(b, { text: /Session \$1\.50 · 0 tok · context 25%/ })
    await must(b, { text: /5-hour 40% resets in 4h0m/ })
    await must(b, { text: /Weekly Opus 12%/ })
    // A window this mod has no name for is shown by its own.
    await must(b, { text: /some new window 5%/ })
    await b.unmount()

    const p = await $.ui.mount({ ...pane, surface })
    await must(p, { text: 'This session' })
    await must(p, { text: 'API-equivalent' })
    await must(p, { text: 'Makeup' })
    expect(await p.find({ text: /[一-龥]/ })).toBeUndefined()
    if (surface !== 'mobile') {
      await p.press({ key: 'tab-global' })
      await must(p, { text: /2 files · just now/ })
      await must(p, { text: 'Not sure · API-equivalent' })
      await must(p, { text: /Pick your plan/ })
      await p.press({ key: 'details' })
      await must(p, { text: /From the Claude Code transcripts/ })
      await p.press({ key: 'details' })
      await p.press({ key: 'tab-session' })
    }
    await p.unmount()
  }
})

test('an account with no plan limits says so instead of waiting', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 0.2 }, changed: ['context', 'cost'] } as never)
  const b = await $.ui.mount({ ...band, surface: 'terminal' })
  await must(b, { text: /API billing · no plan limits/ })
  await b.unmount()
  const p = await $.ui.mount({ ...pane, surface: 'desktop' })
  await must(p, { text: /no plan limits \(API billing\)/ })
  await p.unmount()
})

test('without Node.js the global view says how to fix it, and the session view still works', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  const p = await $.ui.mount({ ...pane, surface: 'terminal' })
  await p.press({ key: 'tab-global' })
  await must(p, { text: /needs Node\.js 18\+/ })
  await p.press({ key: 'tab-session' })
  await must(p, { text: 'Makeup' })
  await p.unmount()
})

describe('plans', () => {
  // One API dollar of output fills 1% of the reference window; Team's window is 2.5 times it.
  const S: Record<string, number> = { current: 1, pro: 1, team: 2.5 }
  const STEP: Vec = [0, 50_000, 0, 0, 0]
  let clock = 0
  const windowOf = (plan: string | null, steps: number): Observation[] => {
    clock += 10 * HOUR
    const resetsAt = clock + 5 * HOUR
    return Array.from({ length: steps }, (_, i) => {
      const v = STEP.map(x => x * (i + 1)) as Vec
      const share = (spendByKind('claude-opus-5-5', v)[1]! * 0.01) / S[plan ?? 'current']!
      return { t: clock + i * MIN, kind: 'five_hour', y: Math.round(share * 100) / 100, resetsAt, hit: false, byModel: { 'claude-opus-5-5': v } }
    })
  }

  test('with no pick, every window is the current plan and the fit still works', () => {
    const fit = fitKind('five_hour', [...windowOf(null, 40), ...windowOf(null, 60)])
    expect(fit.refPlan).toBe('current')
    expect(fit.confidence === 'none').toBe(false)
    const w = { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(T0 + HOUR).toISOString() }
    const e = fittedWindow(w, fit, null, { 'claude-opus-5-5': STEP.map(x => x * 30) as Vec }, {}, 0, T0)
    expect(e !== null && Math.abs(e.explained - 0.3) < 0.03).toBe(true)
  })

  test('a plan sold without a multiple is fitted from its own windows', () => {
    const pro = [...windowOf('pro', 40), ...windowOf('pro', 60), ...windowOf('pro', 30)]
    const choices: PlanChoice[] = [
      { at: 0, plan: 'pro' },
      { at: clock + 10 * HOUR, plan: 'team' },
    ]
    const fit = fitKind('five_hour', [...pro, ...windowOf('team', 100), ...windowOf('team', 150)], choices)
    // Team's readings were made from 2.5x: with no sold ratio to lean on, the data sets it.
    expect(fit.refPlan).toBe('team')
    expect(Math.abs((fit.s['team'] ?? 0) / (fit.s['pro'] ?? 1) - 2.5) < 0.25).toBe(true)
  })
})

test('a plan picked in the pane is kept; a change within a day corrects it, a later one adds to it', { options: { language: 'en' } }, async ($, on) => {
  const { store, advance } = engine(on, () => ({ rows: [], windows: {}, observations: [], today: '2026-10-10', tzOffsetMin: 0, files: 0, readBytes: 0, ms: 1, at: T0 }))
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: new Date(T0 + HOUR).toISOString() }], cost: { usd: 0.2 }, changed: ['rateLimits'] } as never)
  const p = await $.ui.mount({ ...pane, surface: 'terminal' })
  await p.press({ key: 'tab-global' })
  await p.select({ key: 'plan', value: 'max5x' })
  await must(p, { text: 'Max 5x · API-equivalent' })
  advance(HOUR)
  await p.select({ key: 'plan', value: 'max20x' })
  expect(store.planChoices).toEqual([{ at: T0, plan: 'max20x' }])
  advance(3 * 24 * HOUR)
  await p.select({ key: 'plan', value: 'pro' })
  advance(2 * 24 * HOUR)
  await p.select({ key: 'plan', value: 'unknown' })
  expect(store.planChoices).toEqual([
    { at: T0, plan: 'max20x' },
    { at: T0 + 73 * HOUR, plan: 'pro' },
    { at: T0 + 121 * HOUR, plan: null },
  ])
  await must(p, { text: 'Not sure · API-equivalent' })
  await p.unmount()
})

test('a price file adds models and overrides list prices, by id or prefix', () => {
  setPriceOverrides({ 'claude-opus-5-5': [1, 2, 3, 4, 5], 'acme-model': [9, 9, 9, 9, 9], broken: [1, 2] })
  expect(priceOf('claude-opus-5-5')?.[0]).toBe(1)
  expect(priceOf('acme-model-2026')?.[1]).toBe(9)
  expect(priceOf('broken')).toBeNull()
  setPriceOverrides({})
  expect(priceOf('claude-opus-5-5')?.[0]).toBe(4)
})
