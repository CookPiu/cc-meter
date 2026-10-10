import { describe, expect, test } from 'claude-code/testing'

import { fmtDuration, fmtTokens, forecast, moveTo, niceTicks, positionOf, ringsCard } from '../hooks/register'

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
    // The band keeps to the cost, the context, each limit and how soon one fills before its reset.
    await must(b, { type: 'Text', text: /\$1\.50 · 上下文 25%/ })
    await must(b, { text: /5 小时 40% 3h0m 后满/ })
    await must(b, { text: /每周 11%/ })
    expect(await b.find({ text: /重置|tok/ })).toBeUndefined()
    await b.unmount()

    const p = await $.ui.mount({ ...pane, surface })
    // The desktop sets its figures in drawn cards, the makeup and models behind the breakdown;
    // the terminal writes them all as text.
    if (surface === 'desktop') await p.press({ key: 'details' })
    const drawn = surface === 'desktop' ? JSON.stringify(await p.findAll({ type: 'Svg' })) : ''
    const shows = async (text: string | RegExp) => (surface === 'desktop' ? expect(drawn).toMatch(text) : must(p, { text }))
    // The limits lead: when each resets and the outlook in one line.
    await shows(/4h0m后重置 · 约 3h0m 后用满/)
    await shows(/按当前节奏用不满/)
    await shows('$1.50')
    await shows('25%')
    await shows('上下文 200k')
    await shows('opus-5-5')
    await shows('haiku-5-5')
    await shows(/cache 读 (\$[\d.]+ )?\d+%/)
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

  test('a new value glides; once the move is over the ring is drawn still, so a fresh image does not play it again', () => {
    const row = (percent: number, at: number) => ({ label: '5h', percent, move: moveTo('test:meter', percent, at), projected: null, elapsed: null, reset: '', outlook: '', lines: [] })
    const key = { elapsed: 'elapsed', projected: 'projected' }
    // A ring of radius 40 is 251.3 around: 40% leaves 150.8 of it undrawn.
    const a = ringsCard([row(40, T0)], key, T0)
    expect(a).toContain('<animate attributeName="stroke-dashoffset" from="251.3" to="150.8"')
    // Drawn again after the move: the still ring, the same as one drawn without a move.
    expect(ringsCard([row(40, T0 + 30_000)], key, T0 + 30_000)).toBe(ringsCard([{ ...row(40, T0 + 30_000), move: null }], key, T0 + 30_000))
    const b = ringsCard([row(55, T0 + 60_000)], key, T0 + 60_000)
    expect(b).toContain('from="150.8" to="113.1"')
  })

  test('a limit shows where it is headed, how far through its window the clock is and what it holds, with a key', () => {
    const svg = ringsCard(
      [{ label: '每周', percent: 46, move: null, projected: 80, elapsed: 0.3, reset: '4d21h后重置', outlook: '约 1d18h 后用满', lines: ['整窗 ≈ $294', '剩余 ≈ $159'] }],
      { elapsed: '窗口时间进度', projected: '按节奏预计到重置' },
      T0,
    )
    // The paler arc reaches 80% (a fifth undrawn); the tick sits three tenths of the way round.
    expect(svg).toContain('stroke-dashoffset="50.27" transform="rotate(-90 200.0 49)" stroke="#D97757" stroke-opacity="0.25"')
    expect(svg).toContain('x1="230.9" y1="59.0"')
    for (const text of ['46%', '每周', '4d21h后重置', '约 1d18h 后用满', '整窗 ≈ $294', '剩余 ≈ $159', '窗口时间进度', '按节奏预计到重置']) expect(svg).toContain(text)
  })

  test('gridlines fall on clean values just past the top', () => {
    expect(niceTicks(764)).toEqual([0, 200, 400, 600, 800])
    expect(niceTicks(12_000)).toEqual([0, 5000, 10000, 15000])
    expect(niceTicks(0)).toEqual([0])
  })
})
