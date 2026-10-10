import { describe, expect, test } from 'claude-code/testing'

import { fmtDuration, fmtTokens, forecast, meterSvg, moveTo, positionOf } from '../hooks/register'

const PLUGIN = 'token-almanac'
const MIN = 60_000
const T0 = Date.parse('2026-10-10T08:00:00Z')

const band = {
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 140, scroll: { offset: 0, bodyRows: 6 }, view: {} },
}
const pane = {
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: 'token-almanac',
  props: { title: 'Token 用量', isFocused: false, bodyColumns: 70, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}

// A find that names what it was looking for when nothing matches.
async function must(ui: { find: (q: never) => Promise<unknown> }, query: object): Promise<void> {
  if ((await ui.find(query as never)) === undefined) {
    throw new Error(`nothing drawn matches ${String(JSON.stringify(query, (k, v) => (v instanceof RegExp ? String(v) : v)))}`)
  }
}

describe('forecast', () => {
  const reset = new Date(T0 + 5 * 60 * MIN).toISOString()

  test('needs ten minutes of readings', () => {
    expect(forecast([[T0, 10]], 12, T0 + 5 * MIN, reset).state).toBe('unknown')
  })

  test('projects the fill time from the last 90 minutes', () => {
    // 20% -> 40% over one hour: 20%/h, 60% left, 3h, inside the 4h to reset.
    const f = forecast([[T0, 20]], 40, T0 + 60 * MIN, reset)
    expect(f.ratePerHour).toBe(20)
    expect(f.etaMs).toBe(3 * 60 * MIN)
    expect(f.state).toBe('eta')
  })

  test('says it will not fill before the reset', () => {
    const f = forecast([[T0, 20]], 25, T0 + 60 * MIN, reset)
    expect(f.etaMs).toBeNull()
    expect(f.state).toBe('safe')
  })

  test('flat or full windows', () => {
    expect(forecast([[T0, 30]], 30, T0 + 30 * MIN, reset).state).toBe('flat')
    expect(forecast([[T0, 30]], 100, T0 + 30 * MIN, reset).state).toBe('full')
  })

  test('formats', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(2_345_678)).toBe('2.35M')
    expect(fmtDuration(26 * 60 * MIN)).toBe('1d2h')
    expect(fmtDuration(135 * MIN)).toBe('2h15m')
  })
})

test('turns, models, limits and context reach the band and the pane', { options: { language: 'zh' } }, async ($, on) => {
  let now = T0
  const store: Record<string, unknown> = {}
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }) as never)
  on('store.get', ($: unknown, e: { key: string }) => ({ value: store[e.key] }) as never)
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => ((store[e.key] = e.value), { value: undefined }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', ($: unknown, e: { changed: string[] }) => ({ changed: e.changed }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const measure = (five: number, week: number) =>
    $.session.measure({
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: five, resetsAt: new Date(T0 + 5 * 60 * MIN).toISOString() },
        { kind: 'seven_day', percentUsed: week, resetsAt: new Date(T0 + 3 * 1440 * MIN).toISOString() },
      ],
      cost: { usd: 1.5 },
      changed: ['context', 'rateLimits', 'cost'],
    } as never)

  await measure(20, 10)
  now = T0 + 60 * MIN
  await measure(40, 11)

  const usage = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number) => ({
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  })
  // A subagent turn on another model, then the main turn it belongs to, then a second main turn.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1', reason: 'answer', usage: usage('claude-haiku-5-5', 100, 50, 0, 0) } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: usage('claude-opus-5-5', 1000, 500, 8000, 2000) } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage: usage('claude-opus-5-5', 200, 300, 9000, 0) } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const b = await $.ui.mount({ ...band, surface })
    // 100 + 50 + 1000 + 500 + 8000 + 2000 + 200 + 300 + 9000 = 21,150 tokens.
    await must(b, { type: 'Text', text: /\$1\.50 · 21k tok · 上下文 25%/ })
    await must(b, { text: /5 小时 40%/ })
    await must(b, { text: /4h0m后重置 · 约 3h0m 后用满/ })
    await must(b, { text: /每周 11%/ })
    await b.unmount()

    const p = await $.ui.mount({ ...pane, surface })
    // The limits lead: when each resets and the outlook in one line.
    await must(p, { text: /4h0m后重置 · 约 3h0m 后用满/ })
    await must(p, { text: /按当前节奏用不满/ })
    await must(p, { text: '$1.50' })
    await must(p, { text: '25%' })
    await must(p, { text: '上下文 200k' })
    await must(p, { text: 'opus-5-5' })
    await must(p, { text: 'haiku-5-5' })
    await must(p, { text: /cache 读 \d+%/ })
    if (surface === 'desktop') {
      // The first main turn carries its subagent's turn.
      const charts = await p.findAll({ type: 'Svg' })
      expect(JSON.stringify(charts)).toMatch(/第 1 轮 {2}12k tokens.{1,2}output 550 · cache 写 2\.0k · cache 读 8\.0k.{1,2}含子代理 1 个/)
    } else {
      await must(p, { text: /^[▁▂▃▄▅▆▇█]{2}$/ })
    }
    await p.unmount()
  }
  // Readings were kept for a restart within the same window.
  expect(Object.keys(store.samples as object).sort()).toEqual(['five_hour', 'seven_day'])
})

describe('motion', () => {
  test('a figure rises from zero once, keeps its move while the value stays, and sets off from where it is', () => {
    const first = moveTo('test:a', 40, T0)
    expect([first.from, first.to]).toEqual([0, 40])
    // Drawn again with the same value: the same move, so a vector drawing does not play again.
    expect(moveTo('test:a', 40, T0 + 5_000)).toBe(first)
    expect(positionOf(first, T0)).toBe(0)
    expect(positionOf(first, T0 + 10_000)).toBe(40)
    // Halfway through a move to 60, a move to 20 sets off from where the figure is drawn.
    const up = moveTo('test:b', 60, T0, 60)
    expect(up.from).toBe(60)
    const back = moveTo('test:b', 20, T0)
    expect(back.from).toBe(60)
    const mid = positionOf(back, T0 + 200)
    expect(mid < 60 && mid > 20).toBe(true)
    expect(moveTo('test:b', 30, T0 + 200).from).toBe(mid)
  })

  test('a meter drawn twice at one value is the same drawing; a new value glides', () => {
    const at40 = moveTo('test:meter', 40, T0)
    const a = meterSvg(40, at40)
    expect(meterSvg(40, moveTo('test:meter', 40, T0 + 30_000))).toBe(a)
    expect(a).toContain('<animate attributeName="width" from="0.0" to="96.0"')
    const b = meterSvg(55, moveTo('test:meter', 55, T0 + 60_000))
    expect(b).toContain('from="96.0" to="132.0"')
    // Without a move, a still meter.
    expect(meterSvg(55)).not.toContain('<animate')
  })
})
