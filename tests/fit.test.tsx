import { describe, expect, test } from 'claude-code/testing'

import { costOf, fitKind, fittedWindow, segmentsOf, shareOf, spendByKind, tierPlan } from '../hooks/register'
import type { GlobalScan, Observation, Vec } from '../types'

const M = 1_000_000
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-10T02:00:00Z')

// The truth the data is made from, per API dollar against output: input 1, cache read 0.05,
// cache write 1.2. One API dollar of Opus 5.5 output takes 1% of a Pro five-hour window; Opus 5
// counts 0.6 as much per API dollar; Max 5x is really 3 times Pro.
const G = [0.01, 0.01, 0.0005, 0.012]
const F: Record<string, number> = { 'claude-opus-5-5': 1, 'claude-opus-5': 0.6 }
const S: Record<string, number> = { pro: 1, max5x: 3 }
const trueShare = (plan: string, model: string, v: Vec) => (F[model]! * spendByKind(model, v).reduce((a, x, k) => a + G[k]! * x, 0)) / S[plan]!

// A step of work in each way of using it: a long session reads its big context back from the
// cache; many short sessions keep writing new caches.
const LONG: Vec = [0, 20_000, 4 * M, 0, 50_000]
const MANY: Vec = [0, 20_000, 0.8 * M, 0, 400_000]
// And a stretch of long answers: much output, little context.
const WRITE: Vec = [0, 120_000, 0.6 * M, 0, 30_000]
const add = (a: Vec, b: Vec): Vec => a.map((x, i) => x + b[i]!) as Vec

let clock = 0
// One window worked in the given steps, read after each (percent rounded, as the limit reports
// it); a window that reaches 100% ends in a hit instead.
function windowOf(plan: string, model: string, steps: Vec[]): Observation[] {
  clock += 10 * HOUR
  const resetsAt = clock + 5 * HOUR
  let v: Vec = [0, 0, 0, 0, 0]
  const out: Observation[] = []
  steps.forEach((step, i) => {
    v = add(v, step)
    const share = trueShare(plan, model, v)
    const t = clock + i * 60_000
    if (share >= 1) {
      if (!out.some(o => o.hit)) out.push({ t, kind: 'five_hour', y: 1, resetsAt, hit: true, plan, byModel: { [model]: v } })
      return
    }
    out.push({ t, kind: 'five_hour', y: Math.round(share * 100) / 100, resetsAt, hit: false, plan, byModel: { [model]: v } })
  })
  return out
}
const times = (n: number, step: Vec) => new Array<Vec>(n).fill(step)

const data: Observation[] = [
  // Pro on Opus 5.5, some windows mostly one long session, some mostly many sessions, some mixed.
  ...windowOf('pro', 'claude-opus-5-5', times(40, LONG)),
  ...windowOf('pro', 'claude-opus-5-5', times(12, MANY)),
  ...windowOf('pro', 'claude-opus-5-5', [...times(20, LONG), ...times(6, MANY)]),
  ...windowOf('pro', 'claude-opus-5-5', [...times(8, MANY), ...times(25, LONG)]),
  ...windowOf('pro', 'claude-opus-5-5', [...times(10, WRITE), ...times(10, LONG), ...times(5, MANY)]),
  ...windowOf('pro', 'claude-opus-5-5', times(18, WRITE)),
  // Pro on Opus 5, run to the limit, as the August history has.
  ...windowOf('pro', 'claude-opus-5', times(200, LONG)),
  ...windowOf('pro', 'claude-opus-5', times(60, MANY)),
  ...windowOf('pro', 'claude-opus-5', [...times(60, LONG), ...times(30, MANY)]),
  // Max 5x on Opus 5.5.
  ...windowOf('max5x', 'claude-opus-5-5', times(60, MANY)),
  ...windowOf('max5x', 'claude-opus-5-5', times(150, LONG)),
]

describe('fit', () => {
  const fit = fitKind('five_hour', data)
  const rel = (k: number) => fit.g[k]! / fit.g[1]!

  test('learns that cache reads count far less, and cache writes more, than API prices say', () => {
    // Opus 5's limit runs spend the most API dollars: it is the reference, Opus 5.5 counts 1/0.6.
    expect(fit.ref).toBe('claude-opus-5')
    expect(rel(2) > 0.03 && rel(2) < 0.08).toBe(true)
    expect(rel(3) > 1.05 && rel(3) < 1.35).toBe(true)
    expect(Math.abs(fit.f['claude-opus-5-5']! - 1 / 0.6) < 0.15).toBe(true)
    // The band holds the truth and is narrow enough to say something.
    expect(fit.gBand[2]![0] < 0.05 && fit.gBand[2]![1] > 0.05 && fit.gBand[2]![1] < 0.15).toBe(true)
    expect(Math.abs(fit.s['max5x']! - 3) < 0.4).toBe(true)
    expect(fit.hits).toBe(3)
    expect(fit.confidence).toBe('high')
    expect((fit.mae ?? 99) < 1.5).toBe(true)
  })

  test('so a long session and many sessions of the same API spend take different shares', () => {
    // The same $16 of Opus 5.5 either way: the truth, the fit, and one flat API-price ratio.
    const long = { 'claude-opus-5-5': LONG.map(x => x * 10) as Vec }
    const many = { 'claude-opus-5-5': MANY.map(x => (x * 16) / costOf('claude-opus-5-5', MANY)) as Vec }
    expect(Math.abs(costOf('claude-opus-5-5', long['claude-opus-5-5']) - 16) < 0.01).toBe(true)
    expect(Math.abs(costOf('claude-opus-5-5', many['claude-opus-5-5']) - 16) < 0.01).toBe(true)
    const truth = [trueShare('pro', 'claude-opus-5-5', long['claude-opus-5-5']), trueShare('pro', 'claude-opus-5-5', many['claude-opus-5-5'])]
    const fitted = [shareOf(fit, 'pro', long), shareOf(fit, 'pro', many)]
    // Many sessions take about twice the share of a long session for the same API dollars.
    expect(truth[1]! / truth[0]! > 1.8).toBe(true)
    expect(Math.abs(fitted[0]! - truth[0]!) / truth[0]! < 0.1).toBe(true)
    expect(Math.abs(fitted[1]! - truth[1]!) / truth[1]! < 0.1).toBe(true)
  })

  test('pieces close every 5 points from the window start; a hit is the whole window', () => {
    const segs = segmentsOf('five_hour', data)
    expect(segs.every(sg => sg.hit || sg.dy >= 0.05 - 1e-9)).toBe(true)
    expect(segs.filter(sg => sg.hit)).toHaveLength(3)
    expect(segs.filter(sg => sg.hit).every(sg => sg.dy === 1)).toBe(true)
  })

  test('weighs down a piece another device inflated', () => {
    // One window where the percent ran 40 points ahead of this machine's spend.
    const polluted = windowOf('pro', 'claude-opus-5-5', times(10, MANY)).map(o => (o.hit ? o : { ...o, y: Math.min(0.99, o.y + 0.4) }))
    const f2 = fitKind('five_hour', [...data, ...polluted])
    expect(f2.outliers >= 1).toBe(true)
    expect(Math.abs(f2.g[2]! / f2.g[1]! - rel(2)) < 0.03).toBe(true)
  })

  test('tells dollars at this window\'s own way of use, and walks the hours ahead', () => {
    // Pro, half used by long-session work; $1 of Opus 5.5 output an hour ahead (1% an hour).
    const spent = { 'claude-opus-5-5': LONG.map(x => x * 54) as Vec }
    const w = { kind: 'five_hour', percentUsed: 50, resetsAt: new Date(NOW + 5 * HOUR).toISOString() }
    const hourly = { 'claude-opus-5-5': Array.from({ length: 24 }, () => [0, 1, 0, 0]) }
    const e = fittedWindow(w, fit, 'pro', spent, hourly, 480, NOW)!
    expect(Math.abs(e.explained - trueShare('pro', 'claude-opus-5-5', spent['claude-opus-5-5'])) < 0.05).toBe(true)
    // A long-session window holds about $1.6 / 0.92% ≈ $174 of API spend.
    expect(Math.abs(e.capacityUsd / 174 - 1) < 0.15).toBe(true)
    expect(e.etaMs).toBeNull()
    expect(e.atReset !== null && e.atReset > 0.54 && e.atReset < 0.56).toBe(true)
  })

  test('no data, no fit', () => {
    expect(fitKind('seven_day', data).confidence).toBe('none')
    expect(fittedWindow({ kind: 'seven_day', percentUsed: 10 }, fitKind('seven_day', data), 'pro', {}, {}, 480, NOW)).toBeNull()
  })

  test('plans from the credentials tier', () => {
    expect(tierPlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })).toBe('max20x')
    expect(tierPlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' })).toBe('max5x')
    expect(tierPlan({ subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' })).toBe('pro')
    expect(tierPlan(null)).toBeNull()
  })
})

test('a tier change the credentials show joins the timeline; the first tier seen does not', async ($, on) => {
  const files: Record<string, string> = {
    'C:/Users/me/.claude/token-runway/plans.json': JSON.stringify({ plans: [{ from: '2026-10-07', plan: 'pro', source: 'manual' }], detected: null }),
  }
  let tier = 'default_claude_max_5x'
  const scan = (): GlobalScan => ({
    rows: [],
    windows: {},
    observations: [],
    plans: [{ from: '2026-10-07', plan: 'pro' }],
    planNow: 'pro',
    account: { subscriptionType: 'max', rateLimitTier: tier },
    today: '2026-10-10',
    tzOffsetMin: 480,
    files: 0,
    readBytes: 0,
    ms: 1,
    at: NOW,
  })
  on('clock.now', () => ({ value: NOW }))
  on('clock.after', () => ({ value: { cancel: () => undefined } }) as never)
  on('store.get', () => ({ value: undefined }))
  on('env.get', ($: unknown, e: { name: string }) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }) as never)
  // The engine hands paths over in the platform's own spelling.
  const key = (path: string) => path.replace(/\\/g, '/')
  on('fs.read', ($: unknown, e: { path: string }) => ({ value: files[key(e.path)] ?? '' }) as never)
  on('fs.write', ($: unknown, e: { path: string; text: string }) => ((files[key(e.path)] = e.text), { value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(scan()), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const pane = {
    plugin: 'token-runway',
    component: 'Pane' as const,
    requestId: 'token-runway',
    props: { title: 'Token 用量', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} },
  }
  const plansFile = () => JSON.parse(files['C:/Users/me/.claude/token-runway/plans.json']!) as { plans: { plan: string }[]; detected: string }

  // The stale max_5x seen first is only the baseline.
  const p = await $.ui.mount({ ...pane, surface: 'desktop' })
  await p.press({ key: 'tab-global' })
  expect(plansFile().detected).toBe('default_claude_max_5x')
  expect(plansFile().plans.map(x => x.plan)).toEqual(['pro'])

  // A real change to 20x is recorded from today.
  tier = 'default_claude_max_20x'
  await p.press({ key: 'rescan' })
  expect(plansFile().plans).toEqual([
    { from: '2026-10-07', plan: 'pro', source: 'manual' },
    { from: '2026-10-10', plan: 'max20x', source: 'auto', note: 'rateLimitTier=default_claude_max_20x' },
  ])
  await p.unmount()
})
