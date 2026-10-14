import { describe, expect, test } from 'claude-code/testing'

import { compactWindow, costOf, fitKind, fittedWindow, guessPlan, segmentsOf, shareOf, spendByKind, stretchesOf } from '../hooks/register'
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

// Windows begin after the latest official change to the five-hour limit, as a fresh history would.
let clock = Date.parse('2026-09-23T00:00:00Z')
// One window worked in the given steps, read after each (percent rounded, as the limit reports
// it); a window that reaches 100% ends in a hit instead.
// With `extra`, that much use this machine never sees joins the window from step `from` on.
function windowOf(plan: string, model: string, steps: Vec[], extra = 0, from = 0): Observation[] {
  clock += 10 * HOUR
  const resetsAt = clock + 5 * HOUR
  let v: Vec = [0, 0, 0, 0, 0]
  const out: Observation[] = []
  steps.forEach((step, i) => {
    v = add(v, step)
    const share = trueShare(plan, model, v) + (i >= from ? extra : 0)
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

// One weekly window worked in the given steps on Pro, its percents rounded; g is the truth it is
// counted by, cap how many Pro five-hour windows' worth it holds.
function weekOf(model: string, steps: Vec[], g: number[], cap: number): Observation[] {
  clock += 8 * 24 * HOUR
  const resetsAt = clock + 7 * 24 * HOUR
  let v: Vec = [0, 0, 0, 0, 0]
  const out: Observation[] = []
  steps.forEach((step, i) => {
    v = add(v, step)
    const share = (F[model]! * spendByKind(model, v).reduce((a, x, k) => a + g[k]! * x, 0)) / cap
    if (share < 1) out.push({ t: clock + i * 60_000, kind: 'seven_day', y: Math.round(share * 100) / 100, resetsAt, hit: false, byModel: { [model]: v } })
  })
  return out
}
// How far a fit's share of a spend is from the truth's, as a fraction of the truth.
const missOf = (f: ReturnType<typeof fitKind>, g: number[], cap: number, v: Vec) => {
  const truth = (F['claude-opus-5-5']! * spendByKind('claude-opus-5-5', v).reduce((a, x, k) => a + g[k]! * x, 0)) / cap
  return Math.abs(shareOf(f, 'current', { 'claude-opus-5-5': v }) / truth - 1)
}

describe('fit', () => {
  const fit = fitKind('five_hour', data, choices)
  const rel = (k: number) => fit.g[k]! / fit.g[1]!

  test('learns that cache reads count far less, and cache writes more, than API prices say', () => {
    // Opus 5's limit runs spend the most API dollars: it is the reference, Opus 5.5 counts 1/0.6.
    expect(fit.ref).toBe('claude-opus-5')
    // Within 15% of the truth: the kinds' pull toward each other no longer drags it a third heavy.
    expect(Math.abs(rel(2) / 0.05 - 1) < 0.15).toBe(true)
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

  test('a weekly window with a few pieces leans on the five-hour fit, and one with its own evidence does not', () => {
    const long: Vec = LONG.map(x => x * 30) as Vec
    const many: Vec = MANY.map(x => x * 30) as Vec
    // Counted as the five-hour window is: one week of mixed use, four or so pieces.
    const thin = weekOf('claude-opus-5-5', [...times(80, LONG), ...times(20, MANY)], G, 8)
    const alone = fitKind('seven_day', thin)
    const leaning = fitKind('seven_day', thin, [], fit)
    // A way of use the week has not seen (long answers) is told right only by leaning.
    const write: Vec = WRITE.map(x => x * 30) as Vec
    expect(alone.segments <= 4).toBe(true)
    expect([alone.lent, leaning.lent]).toEqual([null, 'five_hour'])
    expect(missOf(alone, G, 8, write) > 0.3).toBe(true)
    for (const v of [long, many, write]) expect(missOf(leaning, G, 8, v) < 0.08).toBe(true)
    // A week of one way of use alone: the others are guesses without the five-hour fit.
    const one = weekOf('claude-opus-5-5', times(120, LONG), G, 8)
    const oneAlone = fitKind('seven_day', one)
    const oneLeaning = fitKind('seven_day', one, [], fit)
    expect(missOf(oneAlone, G, 8, many) > 0.3).toBe(true)
    for (const v of [long, many, write]) expect(missOf(oneLeaning, G, 8, v) < 0.1).toBe(true)
    // Counted otherwise: cache reads weigh four times as much, over six weeks of varied use.
    const G2 = [G[0]!, G[1]!, G[2]! * 4, G[3]!]
    const rich = [
      ...weekOf('claude-opus-5-5', times(200, LONG), G2, 8),
      ...weekOf('claude-opus-5-5', times(60, MANY), G2, 8),
      ...weekOf('claude-opus-5-5', [...times(100, LONG), ...times(30, MANY)], G2, 8),
      ...weekOf('claude-opus-5-5', times(60, WRITE), G2, 8),
      ...weekOf('claude-opus-5-5', [...times(40, WRITE), ...times(100, LONG)], G2, 8),
      ...weekOf('claude-opus-5-5', [...times(30, MANY), ...times(40, WRITE)], G2, 8),
    ]
    // With its own evidence it follows that, not the five-hour fit's way of counting.
    const lent = fitKind('seven_day', rich, [], fit)
    for (const v of [long, many]) expect(missOf(lent, G2, 8, v) < 0.05).toBe(true)
  })

  test('a window cut down for the history makes the same pieces, from far fewer observations', () => {
    const byWindow = new Map<number, Observation[]>()
    for (const o of data) byWindow.set(o.resetsAt, [...(byWindow.get(o.resetsAt) ?? []), o])
    let kept = 0
    for (const list of byWindow.values()) {
      const cut = compactWindow(list)
      kept += cut.length
      expect(segmentsOf('five_hour', cut)).toEqual(segmentsOf('five_hour', list))
    }
    expect(kept * 3 < data.length).toBe(true)
  })

  test('weighs down a piece another device inflated', () => {
    // One window where the percent ran 40 points ahead of this machine's spend.
    const back: PlanChoice = { at: nextStart(), plan: 'pro' }
    const polluted = windowOf('pro', 'claude-opus-5-5', times(10, MANY)).map(o => (o.hit ? o : { ...o, y: Math.min(0.99, o.y + 0.4) }))
    const f2 = fitKind('five_hour', [...data, ...polluted], [...choices, back])
    // Use this machine did not see only adds to a rise: that piece is set aside as such.
    expect((f2.unseen ?? 0) >= 1).toBe(true)
    expect(f2.unseen ?? 0).toBeLessThanOrEqual(2)
    expect(Math.abs(f2.g[2]! / f2.g[1]! - rel(2)) < 0.03).toBe(true)
  })

  test('sets aside the pieces a few points of use from elsewhere lifted, so shares stay true', () => {
    // Three more Pro windows, each with 3 points of web use partway through.
    const back: PlanChoice = { at: nextStart(), plan: 'pro' }
    const elsewhere = [
      ...windowOf('pro', 'claude-opus-5-5', [...times(20, LONG), ...times(6, MANY)], 0.03, 9),
      ...windowOf('pro', 'claude-opus-5-5', [...times(10, WRITE), ...times(12, LONG)], 0.03, 14),
      ...windowOf('pro', 'claude-opus-5-5', [...times(6, MANY), ...times(20, LONG)], 0.03, 4),
    ]
    const f2 = fitKind('five_hour', [...data, ...elsewhere], [...choices, back])
    const misses = [LONG.map(x => x * 10), MANY.map(x => x * 3), WRITE.map(x => x * 3)].map(v => shareOf(f2, 'pro', { 'claude-opus-5-5': v as Vec }) / trueShare('pro', 'claude-opus-5-5', v as Vec) - 1)
    // Weighing those pieces down only (Huber) left the long-session share 1.2% heavy. The one
    // piece left in (2.3 points, under 2 spreads) moves the level of the latest days, which these
    // windows are, the level being free to drift: within 2.5%, and on the safe side.
    expect(f2.unseen ?? 0).toBeGreaterThanOrEqual(2)
    for (const miss of misses) expect(Math.abs(miss) < 0.025).toBe(true)
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

describe('levels and checks', () => {
  // Mixed ways of use, by turns, so every few windows see them all.
  const ways = [times(40, LONG), times(12, MANY), [...times(20, LONG), ...times(6, MANY)], [...times(10, WRITE), ...times(10, LONG)]]
  const worked = (plan: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => windowOf(plan, 'claude-opus-5-5', ways[(i + from) % ways.length]!)).flat()
  // How far a fit tells each way of use from the truth on a plan, at worst.
  const worst = (fit: ReturnType<typeof fitKind>, plan: string) =>
    Math.max(...[LONG.map(x => x * 10), MANY.map(x => x * 3), WRITE.map(x => x * 3)].map(v => Math.abs(shareOf(fit, 'current', { 'claude-opus-5-5': v as Vec }) / trueShare(plan, 'claude-opus-5-5', v as Vec) - 1)))

  test('an official change gives the windows on each side a level of their own', () => {
    // Before 2026-09-22 a window held 0.6 of what one holds now; four windows since.
    S['before'] = 0.6
    clock = Date.parse('2026-09-12T00:00:00Z')
    const before = worked('before', 8)
    clock = Date.parse('2026-09-24T00:00:00Z')
    const fit = fitKind('five_hour', [...before, ...worked('pro', 4, 1)])
    expect(fit.eras).toBe(1)
    expect(fit.later).toBe(1)
    expect(worst(fit, 'pro') < 0.05).toBe(true)
  })

  test('a quiet cut is followed within days', () => {
    // Two weeks at one size, then three days at three quarters of it.
    S['cut'] = 0.75
    clock = Date.parse('2026-09-24T00:00:00Z')
    const steady = worked('pro', 30)
    const fit = fitKind('five_hour', [...steady, ...worked('cut', 7)])
    expect(worst(fit, 'cut') < 0.08).toBe(true)
  })

  test('confidence rests on how well windows it has not seen are foretold', () => {
    // Clean windows: foretold within a few percent, and sure.
    const clean = fitKind('five_hour', data, choices)
    expect(clean.heldOutWindows).toBe(8)
    expect((clean.heldOut ?? 1) < 0.05).toBe(true)
    expect(clean.confidence).toBe('high')
    // Windows whose size strays by a fifth or so at random: the fit says so, and is less sure.
    const sizes = [1, 0.75, 1.3, 0.85, 1.2, 0.8, 1.25, 1, 0.7, 1.15]
    sizes.forEach((x, i) => (S[`stray${i}`] = x))
    clock = Date.parse('2026-09-24T00:00:00Z')
    const strays = sizes.flatMap((_, i) => windowOf(`stray${i}`, 'claude-opus-5-5', ways[i % ways.length]!))
    const loose = fitKind('five_hour', strays)
    expect((loose.heldOut ?? 0) > 0.12).toBe(true)
    expect(loose.confidence).not.toBe('high')
    expect((loose.tau ?? 0) > 0.1).toBe(true)
  })

  test('a change of size not published since the latest window leaves the fit unsure', () => {
    clock = Date.parse('2026-09-01T00:00:00Z')
    const fit = fitKind('five_hour', worked('pro', 12))
    expect(fit.later).toBeNull()
    expect(fit.confidence).toBe('low')
    clock = Date.parse('2026-09-24T00:00:00Z')
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
