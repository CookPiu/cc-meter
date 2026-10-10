import { describe, expect, test } from 'claude-code/testing'

import { costOf, fitKind, fittedWindow, guessPlan, segmentsOf, shareOf, spendByKind, stretchesOf } from '../hooks/register'
import type { Observation, PlanChoice, Vec } from '../types'

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
      if (!out.some(o => o.hit)) out.push({ t, kind: 'five_hour', y: 1, resetsAt, hit: true, byModel: { [model]: v } })
      return
    }
    out.push({ t, kind: 'five_hour', y: Math.round(share * 100) / 100, resetsAt, hit: false, byModel: { [model]: v } })
  })
  return out
}
const times = (n: number, step: Vec) => new Array<Vec>(n).fill(step)
// When the next window windowOf makes begins.
const nextStart = () => clock + 10 * HOUR

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
]
// Max 5x on Opus 5.5, picked as it began.
const choices: PlanChoice[] = [
  { at: 0, plan: 'pro' },
  { at: nextStart(), plan: 'max5x' },
]
data.push(...windowOf('max5x', 'claude-opus-5-5', times(60, MANY)), ...windowOf('max5x', 'claude-opus-5-5', times(150, LONG)))

describe('fit', () => {
  const fit = fitKind('five_hour', data, choices)
  const rel = (k: number) => fit.g[k]! / fit.g[1]!

  test('learns that cache reads count far less, and cache writes more, than API prices say', () => {
    // Opus 5's limit runs spend the most API dollars: it is the reference, Opus 5.5 counts 1/0.6.
    expect(fit.ref).toBe('claude-opus-5')
    expect(rel(2) > 0.03 && rel(2) < 0.08).toBe(true)
    expect(rel(3) > 1.05 && rel(3) < 1.35).toBe(true)
    expect(Math.abs(fit.f['claude-opus-5-5']! - 1 / 0.6) < 0.15).toBe(true)
    // The band holds the truth and is narrow enough to say something.
    expect(fit.gBand[2]![0] < 0.05 && fit.gBand[2]![1] > 0.05 && fit.gBand[2]![1] < 0.15).toBe(true)
    // The plan picked now is the reference; Pro's window is a third of it.
    expect(fit.refPlan).toBe('max5x')
    expect(Math.abs(fit.s['max5x']! / fit.s['pro']! - 3) < 0.4).toBe(true)
    expect(fit.inferred).toEqual([])
    expect(fit.latest).toBe('max5x')
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
    const back: PlanChoice = { at: nextStart(), plan: 'pro' }
    const polluted = windowOf('pro', 'claude-opus-5-5', times(10, MANY)).map(o => (o.hit ? o : { ...o, y: Math.min(0.99, o.y + 0.4) }))
    const f2 = fitKind('five_hour', [...data, ...polluted], [...choices, back])
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

})

describe('plans picked and inferred', () => {
  // A window of mixed work, long-session or many-session by turns, as days go.
  let turn = 0
  const worked = (plan: string) => {
    turn += 1
    return windowOf(plan, 'claude-opus-5-5', turn % 2 ? [...times(10, LONG), ...times(4, MANY)] : [...times(4, LONG), ...times(8, MANY)])
  }
  const run = (plan: string, n: number) => Array.from({ length: n }, () => worked(plan)).flat()

  test('windows before the first pick whose rate stood apart are a plan of their own, named by its multiple', () => {
    const before = run('pro', 8)
    const pick: PlanChoice = { at: nextStart(), plan: 'max5x' }
    const fit = fitKind('five_hour', [...before, ...run('max5x', 5)], [pick])
    expect(fit.inferred).toHaveLength(1)
    const x = fit.inferred[0]!
    expect([x.against, x.guess, x.windows]).toEqual(['max5x', 'pro', 8])
    expect(Math.abs(x.ratio - 1 / 3) < 0.08).toBe(true)
    expect(x.from).toBe(before[0]!.resetsAt - 5 * HOUR)
    expect(fit.latest).toBe('max5x')
    expect(fit.windowPlans[String(before[0]!.resetsAt)]).toBe(x.label)
  })

  test('a pick made after the change: the latest stretch takes the pick, the one before is inferred', () => {
    const all = [...run('pro', 7), ...run('max5x', 5)]
    const fit = fitKind('five_hour', all, [{ at: nextStart(), plan: 'max5x' }])
    expect(fit.inferred.map(x => [x.guess, x.windows])).toEqual([['pro', 7]])
    expect(fit.latest).toBe('max5x')
  })

  test('no change, nothing inferred', () => {
    const fit = fitKind('five_hour', run('pro', 10), [{ at: nextStart(), plan: 'pro' }])
    expect(fit.inferred).toEqual([])
    expect(fit.refPlan).toBe('pro')
    expect(Object.values(fit.windowPlans).every(p => p === 'pro')).toBe(true)
  })

  test('with no pick the earlier stretch is told against the current plan, unnamed', () => {
    const fit = fitKind('five_hour', [...run('pro', 6), ...run('max5x', 6)])
    expect(fit.inferred.map(x => [x.against, x.guess, x.windows])).toEqual([['current', null, 6]])
    expect(Math.abs(fit.inferred[0]!.ratio - 1 / 3) < 0.08).toBe(true)
    expect(fit.latest).toBe('current')
  })

  test('stretches split where the level moves, and only that far', () => {
    expect(stretchesOf([0, 0.02, -0.01, 0.01, 1.1, 1.08, 1.12], 0.05)).toEqual([
      [0, 4],
      [4, 7],
    ])
    // A move under 1.8x is the way a window was used, not a plan.
    expect(stretchesOf([0, 0.01, 0, 0.4, 0.41, 0.39], 0.05)).toEqual([[0, 6]])
    // Too short a stretch to say.
    expect(stretchesOf([0, 0, 0, 0, 1.1, 1.1], 0.05)).toEqual([[0, 6]])
  })

  test('a multiple names the plan sold closest to it, within a factor of 2', () => {
    expect(guessPlan(1 / 3, 'max5x')).toBe('pro')
    expect(guessPlan(3.2, 'max5x')).toBe('max20x')
    expect(guessPlan(1, 'max5x')).toBeNull()
    expect(guessPlan(0.3, 'team')).toBeNull()
  })
})
