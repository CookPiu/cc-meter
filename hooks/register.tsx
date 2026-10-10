import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Fit, GlobalScan, GlobalView, InferredPlan, Machine, Observation, PlanChoice, Reading, Samples, ScanStatus, Snapshot, Tokens, TurnRow, Vec, Window } from '../types'

import { MESSAGES, localeOf } from './i18n'
import type { Locale, Messages } from './i18n'

const PANE = 'token-almanac'
// The plan in force when none was ever picked.
const CURRENT = 'current'

// The words drawn, in the language resolved at load (English until then).
let t: Messages = MESSAGES.en
export function setLocale(locale: Locale): void {
  t = MESSAGES[locale]
}
// The Node.js the scanner runs on, from the `nodePath` option.
let nodeBin = 'node'
const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const MINUTE = 60_000
const HOUR = 60 * MINUTE
// The forecast reads the growth over this much recent time, and needs at least the minimum.
const RATE_LOOKBACK_MS = 90 * MINUTE
const RATE_MIN_SPAN_MS = 10 * MINUTE

const since = atom({ plugin: 'token-almanac', key: 'since' } as const, 0)
const totals = atom({ plugin: 'token-almanac', key: 'totals' } as const, ZERO)
const byModel = atom({ plugin: 'token-almanac', key: 'byModel' } as const, {} as Record<string, Tokens>)
const turns = atom({ plugin: 'token-almanac', key: 'turns' } as const, [] as TurnRow[])
const snapshot = atom({ plugin: 'token-almanac', key: 'snapshot' } as const, null as Snapshot | null)
const samples = atom({ plugin: 'token-almanac', key: 'samples' } as const, {} as Record<string, Samples>)
const isBandHidden = atom({ plugin: 'token-almanac', key: 'isBandHidden' } as const, false)
const view = atom({ plugin: 'token-almanac', key: 'view' } as const, 'session' as 'session' | 'global')
const range = atom({ plugin: 'token-almanac', key: 'range' } as const, '30d' as '30d' | 'all')
const machine = atom({ plugin: 'token-almanac', key: 'machine' } as const, null as Machine | null)
const scanStatus = atom({ plugin: 'token-almanac', key: 'scanStatus' } as const, { state: 'idle' } as ScanStatus)
const planChoices = atom({ plugin: 'token-almanac', key: 'planChoices' } as const, [] as PlanChoice[])
const details = atom({ plugin: 'token-almanac', key: 'details' } as const, false)

// Kinds of token in the pane's palette: clay for output, its soft tint for cache writes, sand and
// stone for the reads and plain input that carry least weight.
const KIND_COLOR = { input: '#A39E93', output: '#D97757', cacheRead: '#D6CCBE', cacheWrite: '#E9A88C' } as const

// ---- Pure helpers ---------------------------------------------------------

function add(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

function sum(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

export function fmtDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  const d = Math.floor(minutes / 1440)
  const hrs = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d${hrs}h`
  if (hrs > 0) return `${hrs}h${m}m`
  return `${m}m`
}

function windowLabel(kind: string): string {
  return t.windows[kind] ?? kind.replace(/_/g, ' ')
}

function planLabel(plan: string): string {
  return t.plans[plan] ?? plan.replace(/_/g, ' ')
}

// True once a reply has come back with no limit readings: an account billed by the API (or a
// gateway that reports none), not one still waiting for its first reading.
function hasNoLimits(snap: Snapshot | null): boolean {
  return snap !== null && snap.windows.length === 0 && snap.contextTokens !== undefined
}

function levelColor(percent: number): string {
  return percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'claude'
}

// `etaMs` is set only when the window would be full before it resets; `state` says which of the
// outlooks applies, for the pane to word.
export type Forecast = { ratePerHour: number | null; etaMs: number | null; state: 'full' | 'unknown' | 'flat' | 'safe' | 'eta' }

// How fast a window fills, from its readings over the last 90 minutes up to now, and when it
// would be full at that pace. Measuring up to now (not the last reading) lets idle time slow it.
export function forecast(points: readonly [number, number][], percent: number, now: number, resetsAt?: string): Forecast {
  if (percent >= 100) return { ratePerHour: null, etaMs: null, state: 'full' }
  const recent = points.filter(([t]) => t >= now - RATE_LOOKBACK_MS)
  const base = recent[0] ?? points[points.length - 1]
  if (base === undefined || now - base[0] < RATE_MIN_SPAN_MS) {
    return { ratePerHour: null, etaMs: null, state: 'unknown' }
  }
  const ratePerHour = ((percent - base[1]) / (now - base[0])) * HOUR
  if (ratePerHour <= 0) return { ratePerHour: 0, etaMs: null, state: 'flat' }
  const etaMs = ((100 - percent) / ratePerHour) * HOUR
  const resetMs = resetsAt ? Date.parse(resetsAt) - now : Number.NaN
  if (!Number.isNaN(resetMs) && etaMs >= resetMs) {
    return { ratePerHour, etaMs: null, state: 'safe' }
  }
  return { ratePerHour, etaMs, state: 'eta' }
}

function resetText(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  return Number.isNaN(ms) ? '' : ms <= 0 ? t.resetting : t.resetsIn(fmtDuration(ms))
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
}

function toSnapshot(u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>, now: number): Snapshot {
  return {
    at: now,
    contextTokens: u.context.tokens,
    contextWindow: u.context.window,
    contextPercent: u.context.percent,
    costUsd: u.cost?.usd,
    windows: u.rateLimits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
  }
}

function withReading(all: Record<string, Samples>, w: Window, now: number): Record<string, Samples> {
  const current = all[w.kind]
  const series: Samples = current && current.resetsAt === w.resetsAt ? current : { resetsAt: w.resetsAt, points: [] }
  const last = series.points[series.points.length - 1]
  if (last && last[1] === w.percentUsed && now - last[0] < 10 * MINUTE) {
    return all
  }
  return { ...all, [w.kind]: { ...series, points: [...series.points, [now, w.percentUsed] as [number, number]].slice(-300) } }
}

// What `scan/scan.mjs session` prints: the session's counts as its transcript records them.
export type Parsed = { totals: Tokens; byModel: Record<string, Tokens>; turns: TurnRow[] }

// ---- Prices and the global view --------------------------------------------

// USD per million tokens: [input, output, cache read, cache write 5m, cache write 1h], from
// https://platform.claude.com/docs/en/about-claude/pricing as read on 2026-10-10. Haiku 5.5's
// higher rate for prompts over 100k tokens is not applied.
const PRICES: Record<string, Vec> = {
  'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-mythos-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-fable-5': [10, 50, 1, 12.5, 20],
  'claude-mythos-5': [10, 50, 1, 12.5, 20],
  'claude-opus-5-5': [4, 20, 0.2, 5, 8],
  'claude-opus-5': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-8': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-7': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-6': [5, 25, 0.5, 6.25, 10],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5, 4],
  'claude-sonnet-5': [2, 10, 0.2, 2.5, 4],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125, 0.2],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25, 2],
}

// A model's prices by its id, or by the longest id it starts with (a dated or suffixed id).
// Prices from <config>/token-almanac/prices.json, over the built-in ones: for another provider's
// rates (Bedrock, Vertex), a model this table lacks, or a price change before an update.
let priceOverrides: Record<string, Vec> = {}

export function setPriceOverrides(prices: Record<string, unknown>): void {
  priceOverrides = Object.fromEntries(
    Object.entries(prices).filter((e): e is [string, Vec] => Array.isArray(e[1]) && e[1].length === 5 && e[1].every(x => typeof x === 'number')),
  )
}

export function priceOf(model: string): Vec | null {
  const table = { ...PRICES, ...priceOverrides }
  const exact = table[model]
  if (exact) return exact
  const key = Object.keys(table)
    .filter(k => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return key === undefined ? null : table[key]!
}

export function costOf(model: string, v: readonly number[]): number {
  const p = priceOf(model)
  if (p === null) return 0
  let total = 0
  for (let i = 0; i < 5; i += 1) total += (v[i] ?? 0) * p[i]!
  return total / 1_000_000
}

const vsum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0)
const pad2 = (n: number) => String(n).padStart(2, '0')

function dayValue(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

function dayShift(day: string, delta: number): string {
  const t = new Date(dayValue(day) + delta * 86_400_000)
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}


// The scan over the chosen range: cost per day, project and model, and the average cost of each
// local hour of the day, the day's shape the forecast walks forward.
export function globalView(scan: GlobalScan, range: '30d' | 'all'): GlobalView {
  const start = range === '30d' ? dayShift(scan.today, -29) : ''
  const rows = scan.rows.filter(r => r[0] >= start)
  const firstDay = rows.reduce<string | null>((a, r) => (a === null || r[0] < a ? r[0] : a), null)
  const days = firstDay === null ? 0 : Math.round((dayValue(scan.today) - dayValue(firstDay)) / 86_400_000) + 1

  const perDay = new Map<string, Record<string, number>>()
  const projects = new Map<string, { cost: number; tokens: number }>()
  const models = new Map<string, { cost: number; tokens: number }>()
  const hours = new Array<number>(24).fill(0)
  const hoursByModel: Record<string, number[][]> = {}
  const unpriced = new Set<string>()
  let totalCost = 0
  let totalTokens = 0

  for (const [day, hour, project, model, ...v] of rows) {
    const cost = costOf(model, v)
    const tokens = vsum(v)
    if (priceOf(model) === null && tokens > 0) unpriced.add(model)
    totalCost += cost
    totalTokens += tokens
    const d = perDay.get(day) ?? {}
    d[model] = (d[model] ?? 0) + cost
    perDay.set(day, d)
    const p = projects.get(project) ?? { cost: 0, tokens: 0 }
    projects.set(project, { cost: p.cost + cost, tokens: p.tokens + tokens })
    const m = models.get(model) ?? { cost: 0, tokens: 0 }
    models.set(model, { cost: m.cost + cost, tokens: m.tokens + tokens })
    hours[hour] = (hours[hour] ?? 0) + cost
    const hm = (hoursByModel[model] ??= Array.from({ length: 24 }, () => [0, 0, 0, 0]))
    spendByKind(model, v).forEach((x, k) => (hm[hour]![k]! += x))
  }

  const daily: GlobalView['daily'] = []
  for (let i = 0; i < days; i += 1) {
    const day = dayShift(firstDay ?? scan.today, i)
    daily.push({ day, byModel: perDay.get(day) ?? {} })
  }
  const byCost = <T extends { cost: number; tokens: number }>(a: T, b: T) => b.cost - a.cost || b.tokens - a.tokens
  return {
    days,
    totalCost,
    totalTokens,
    daily,
    byProject: [...projects].map(([project, x]) => ({ project, ...x })).sort(byCost),
    byModel: [...models].map(([model, x]) => ({ model, ...x })).filter(x => x.tokens > 0).sort(byCost),
    hourly: hours.map(c => (days > 0 ? c / days : 0)),
    hourlyByModel: Object.fromEntries(Object.entries(hoursByModel).map(([m, hs]) => [m, hs.map(kinds => kinds.map(x => (days > 0 ? x / days : 0)))])),
    unpriced: [...unpriced],
  }
}

// The length of a limit window, to find where the current one began.
function windowLength(kind: string): number | null {
  if (kind === 'five_hour') return 5 * HOUR
  if (kind.startsWith('seven_day')) return 7 * 24 * HOUR
  return null
}

export const fmtUsd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)
// For estimates, where cents would claim a precision they do not have.
const roughUsd = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(1)}`)

// ---- The fit ----------------------------------------------------------------

// Each plan's window as a multiple of Pro's, as sold, where it is sold that way. The fit starts
// from these and moves them as far as the data says; the sold multiples are not taken as exact.
// A plan with none (Team, Enterprise, a tier not known here) starts level with the reference.
const NOMINAL: Record<string, number> = { pro: 1, max5x: 5, max20x: 20 }
// The plans the pane offers to pick.
const PLAN_CHOICES = ['pro', 'max5x', 'max20x', 'team', 'team_premium', 'enterprise'] as const
// The pick that says the plan is not known.
const UNKNOWN = 'unknown'
// How much a start with no sold multiple behind it counts: next to nothing.
const WEAK_PRIOR = 0.05

// One plan's window against another's, as sold; null when either is not sold as a multiple.
function nominalRatio(plan: string, against: string): number | null {
  const a = NOMINAL[plan]
  const b = NOMINAL[against]
  return a === undefined || b === undefined ? null : a / b
}

// A plan's window against the fit's reference plan: fitted, else as sold, else unknown.
function planScale(fit: Fit, plan: string): number | null {
  return fit.s[plan] ?? nominalRatio(plan, fit.refPlan)
}
// How many windows' worth of evidence the starting values (API prices, sold multiples) count as.
const PRIOR_WINDOWS = 0.5
// The pull of the kinds' weights toward each other, far weaker: a kind the pieces barely tell apart
// (cache reads, a small share of every piece's weighted spend) was dragged toward the rest, about a
// third too heavy on test data drawn from known weights; at this pull it is within a tenth, and its
// band still widens to "unclear" where the pieces cannot say.
const KIND_PRIOR = 0.05
// How many windows' worth a longer window kind's fit leans on the five-hour fit's way of weighing
// kinds and models, when that fit is at least of medium confidence: enough to steady a kind with
// a few pieces, little enough that a kind with its own evidence goes its own way.
const BORROW_WINDOWS = 2
// How many of its own spreads a piece may rise past what its spend says before it is taken for
// use this machine did not see and set aside. On test data with a few points of such use in three
// windows in eleven, weighing those pieces down (Huber) left shares about 5% heavy; setting them
// aside past 2 spreads leaves about 1.5%, with no piece of the clean data set aside, where past
// 1.5 spreads starts setting clean pieces aside too.
const UNSEEN_AT = 2
// Below this many pieces there is no rest to tell a piece apart from (two limit hits a third
// apart say nothing of which one had help): such fits only weigh down.
const UNSEEN_MIN_PIECES = 6

// Gaussian elimination with partial pivoting; null when the system is singular.
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let r = col + 1; r < n; r += 1) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    if (Math.abs(m[pivot]![col]!) < 1e-300) return null
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue
      const f = m[r]![col]! / m[col]![col]!
      for (let c = col; c <= n; c += 1) m[r]![c]! -= f * m[col]![c]!
    }
  }
  return m.map((row, i) => row[n]! / row[i]!)
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

// The four kinds of token the fit weighs apart: the two cache writes share one weight.
export const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

// A model's spend by kind of token, in API dollars: [input, output, cache read, cache write].
export function spendByKind(model: string, v: readonly number[]): number[] {
  const p = priceOf(model)
  if (p === null) return [0, 0, 0, 0]
  return [(v[0] ?? 0) * p[0], (v[1] ?? 0) * p[1], (v[2] ?? 0) * p[2], (v[3] ?? 0) * p[3] + (v[4] ?? 0) * p[4]].map(x => x / 1_000_000)
}

type Segment = { window: number; plan: string; dy: number; c: Record<string, number[]>; hit: boolean }

// The pieces the fit learns from. Within a window, from its start (0%, nothing spent) through
// its readings, a piece closes each time the percent has risen 5 points or more: what that piece
// spent, by model and kind, against how far the percent rose. A limit hit is the whole window
// to 100%. Pieces let the different ways a window was used (a long session's cache reads, many
// sessions' cache writes) each speak, where a window's running total would blur them.
export function segmentsOf(kind: string, all: readonly Observation[]): Segment[] {
  const byWindow = new Map<number, Observation[]>()
  for (const o of all) {
    if (o.kind !== kind) continue
    byWindow.set(o.resetsAt, [...(byWindow.get(o.resetsAt) ?? []), o])
  }
  const kindsOf = (byModel: Record<string, Vec>) =>
    Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, spendByKind(m, v)]).filter(([, c]) => (c as number[]).some(x => x > 0)))
  const minus = (a: Record<string, number[]>, b: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(a).map(([m, c]) => [m, c.map((x, k) => Math.max(0, x - (b[m]?.[k] ?? 0)))]))
  const out: Segment[] = []
  for (const [window, list] of byWindow) {
    for (const obs of list.filter(o => o.hit)) out.push({ window, plan: CURRENT, dy: 1, c: kindsOf(obs.byModel), hit: true })
    let anchor = { y: 0, c: {} as Record<string, number[]> }
    for (const o of list.filter(o => !o.hit).sort((a, b) => a.t - b.t)) {
      if (o.y - anchor.y < 0.05) continue
      const c = kindsOf(o.byModel)
      out.push({ window, plan: CURRENT, dy: o.y - anchor.y, c: minus(c, anchor.c), hit: false })
      anchor = { y: o.y, c }
    }
  }
  return out.filter(s => Object.values(s.c).some(c => c.some(x => x > 0)))
}

// One window's observations cut down to those segmentsOf closes a piece on: each reading 5 points
// or more past the last one kept, and the window's first hit. The pieces they make are the same.
export function compactWindow(obs: readonly Observation[]): Observation[] {
  const kept: Observation[] = []
  let last = 0
  for (const o of obs.filter(o => !o.hit).sort((a, b) => a.t - b.t)) {
    if (o.y - last < 0.05) continue
    kept.push(o)
    last = o.y
  }
  const hit = obs.filter(o => o.hit).sort((a, b) => a.t - b.t)[0]
  return hit === undefined ? kept : [...kept, hit]
}

// Fits one window kind on its pieces: rise × s[plan] ≈ Σ f[model] × Σ g[kind] × spend[model][kind].
// g (one per kind of token, shared by every model) is the share of a Pro window one API dollar of
// that kind of the reference model takes, on the reference plan (the one picked now, else the one
// with the most windows);
// f scales another model against the reference model (1); s is another plan's window against the
// reference plan's (1). All are fitted in logs, together (Levenberg–Marquardt). A
// piece's miss is told against what it can be off by: the limit reports whole percents, so each
// end of a piece may be half a point off (ROUNDING), and use the transcripts do not see adds a
// share of the rise (SPREAD). Each parameter starts where API prices and sold multiples put it
// (the kinds' g equal, f at 1, s at the sold ratio where both plans have one, else at 1), that
// start weighing as much as half a piece (PRIOR_WINDOWS, or WEAK_PRIOR with no sold ratio; the
// kinds' g far less, KIND_PRIOR), so the
// pieces move it as far as they agree to. Once the rest have settled, a piece that rose more than
// UNSEEN_AT of its own spreads past what its spend says is set aside: use this machine did not see
// (another device, the web app) only ever adds to a rise. A piece off the other way by more than
// 2.5 spreads, which no unseen use explains, is weighed down (Huber).
function fitSegments(kind: string, segs: Segment[], preferRef: string, borrow: Fit | null = null): Fit {

  const spend = new Map<string, number>()
  for (const sg of segs) for (const [m, c] of Object.entries(sg.c)) spend.set(m, (spend.get(m) ?? 0) + c.reduce((a, b) => a + b, 0))
  const models = [...spend].sort((a, b) => b[1] - a[1]).map(([m]) => m)
  const ref = models[0]!
  const others = models.slice(1)
  const planWindows: Record<string, number> = {}
  for (const p of new Set(segs.map(sg => sg.plan))) planWindows[p] = new Set(segs.filter(sg => sg.plan === p).map(sg => sg.window)).size
  const refPlan = planWindows[preferRef] !== undefined ? preferRef : Object.entries(planWindows).sort((a, b) => b[1] - a[1] || (a[0] === 'pro' ? -1 : 1))[0]![0]
  const plans = Object.keys(planWindows).filter(p => p !== refPlan)
  const startScale = (pl: string) => (pl === refPlan ? 1 : (nominalRatio(pl, refPlan) ?? 1))
  const priorWeight = (pl: string) => (nominalRatio(pl, refPlan) === null ? WEAK_PRIOR : PRIOR_WINDOWS)
  // Another window kind's fit to start from: its kinds' weights as a shape (logs about their mean),
  // and its models against this fit's reference model where it has that one. The size of the
  // window is never lent: it is this kind's own.
  const lent =
    borrow === null || !borrow.g.every(x => x > 0)
      ? null
      : (() => {
          const logs = borrow.g.map(Math.log)
          const mean = logs.reduce((a, b) => a + b, 0) / logs.length
          const base = borrow.f[ref]
          const f: Record<string, number> = base === undefined ? {} : Object.fromEntries(Object.entries(borrow.f).map(([m, x]) => [m, Math.log(x / base)]))
          return { g: logs.map(x => x - mean), f }
        })()

  // Parameters, in logs: g[0..3], then f of each other model, then s of each other plan.
  const nG = 4
  const nF = others.length
  const n = nG + nF + plans.length
  const totalOf = (sg: Segment) => Object.values(sg.c).reduce((a, c) => a + c.reduce((x, y) => x + y, 0), 0)
  const start = (() => {
    let num = 0
    let den = 0
    for (const sg of segs) {
      const target = sg.dy * startScale(sg.plan)
      num += totalOf(sg) / target
      den += (totalOf(sg) / target) ** 2
    }
    return Math.log(num / den)
  })()
  let p = [...new Array<number>(nG).fill(start), ...new Array<number>(nF).fill(0), ...plans.map(pl => Math.log(startScale(pl)))]

  const unpack = (q: number[]) => ({
    g: q.slice(0, nG).map(Math.exp),
    f: { [ref]: 1, ...Object.fromEntries(others.map((m, i) => [m, Math.exp(q[nG + i]!)])) } as Record<string, number>,
    s: { [refPlan]: 1, ...Object.fromEntries(plans.map((pl, i) => [pl, Math.exp(q[nG + nF + i]!)])) } as Record<string, number>,
  })
  // A hit is the whole window, exact at 100%: it counts double, unless the window's readings already
  // cut it into pieces, which say the same spend again.
  const read = new Set(segs.filter(sg => !sg.hit).map(sg => sg.window))
  const base = segs.map(sg => (sg.hit && !read.has(sg.window) ? 2 : 1))
  let robust = segs.map(() => 1)
  const ROUNDING = 0.006
  const SPREAD = 0.1

  // Residuals and their Jacobian: one row per piece (relative miss), then the start's pulls. The
  // cost of a trial step needs the residuals alone, so the Jacobian is built only when asked for.
  const NO_J: number[] = []
  const system = (q: number[], withJ = true) => {
    const { g, f, s } = unpack(q)
    const rows: { r: number; j: number[]; w: number }[] = []
    segs.forEach((sg, i) => {
      const target = sg.dy * s[sg.plan]!
      const perKind = [0, 1, 2, 3].map(k => models.reduce((acc, m) => acc + f[m]! * (sg.c[m]?.[k] ?? 0), 0))
      const pred = perKind.reduce((acc, x, k) => acc + g[k]! * x, 0)
      // What this piece can be off by, in shares of a window scaled by the plan's multiple.
      const d = Math.hypot(ROUNDING * s[sg.plan]!, SPREAD * target)
      if (!withJ) {
        rows.push({ r: (pred - target) / d, j: NO_J, w: base[i]! * robust[i]! })
        return
      }
      const j = new Array<number>(n).fill(0)
      perKind.forEach((x, k) => (j[k] = (g[k]! * x) / d))
      others.forEach((m, r) => (j[nG + r] = (f[m]! * (sg.c[m] ?? [0, 0, 0, 0]).reduce((acc, v, k) => acc + g[k]! * v, 0)) / d))
      const pi = plans.indexOf(sg.plan)
      if (pi >= 0) j[nG + nF + pi] = -target / d
      rows.push({ r: (pred - target) / d, j, w: base[i]! * robust[i]! })
    })
    const meanG = q.slice(0, nG).reduce((a, b) => a + b, 0) / nG
    for (let k = 0; k < nG; k += 1) {
      const j = new Array<number>(n).fill(0)
      for (let c = 0; c < nG; c += 1) j[c] = (c === k ? 1 : 0) - 1 / nG
      rows.push(lent === null ? { r: q[k]! - meanG, j, w: KIND_PRIOR } : { r: q[k]! - meanG - lent.g[k]!, j, w: BORROW_WINDOWS })
    }
    for (let i = 0; i < nF; i += 1) {
      const j = new Array<number>(n).fill(0)
      j[nG + i] = 1
      const at = lent?.f[others[i]!]
      rows.push(at === undefined ? { r: q[nG + i]!, j, w: PRIOR_WINDOWS } : { r: q[nG + i]! - at, j, w: BORROW_WINDOWS })
    }
    plans.forEach((pl, i) => {
      const j = new Array<number>(n).fill(0)
      j[nG + nF + i] = 1
      rows.push({ r: q[nG + nF + i]! - Math.log(startScale(pl)), j, w: priorWeight(pl) })
    })
    return rows
  }
  const sumSquares = (rows: { r: number; w: number }[]) => rows.reduce((acc, row) => acc + row.w * row.r * row.r, 0)

  // Weighs down the pieces the rest cannot explain: three times, each once the fit has settled or
  // had 30 rounds, whichever comes first, so a fit that settles fast is weighed all the same.
  let mu = 1e-3
  let reweighs = 0
  let since = 0
  for (let iter = 0; iter < 200; iter += 1) {
    const rows = system(p)
    const a = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    const b = new Array<number>(n).fill(0)
    for (const { r, j, w } of rows) {
      for (let x = 0; x < n; x += 1) {
        b[x]! -= w * j[x]! * r
        for (let y = 0; y < n; y += 1) a[x]![y]! += w * j[x]! * j[y]!
      }
    }
    for (let x = 0; x < n; x += 1) a[x]![x]! *= 1 + mu
    const step = solve(a, b)
    if (step === null) break
    const next = p.map((v, i) => v + Math.max(-2, Math.min(2, step[i]!)))
    let isSettled = false
    if (sumSquares(system(next, false)) < sumSquares(rows)) {
      p = next
      mu = Math.max(1e-9, mu / 3)
      isSettled = Math.max(...step.map(Math.abs)) < 1e-7
    } else {
      mu *= 4
      isSettled = mu > 1e9
    }
    since += 1
    if (isSettled || since >= 30) {
      if (reweighs === 3) {
        if (isSettled) break
        continue
      }
      robust = system(p, false)
        .slice(0, segs.length)
        .map(row => (row.r < -UNSEEN_AT && segs.length >= UNSEEN_MIN_PIECES ? 0.01 : Math.abs(row.r) <= 2.5 ? 1 : 2.5 / Math.abs(row.r)))
      reweighs += 1
      since = 0
      mu = 1e-3
    }
  }

  const { g, f, s } = unpack(p)
  // The pieces set aside as unseen use, and the rest weighed down.
  const unseen = robust.filter(w => w === 0.01).length

  // 95% bands for each kind's weight against output's, from the curvature at the fit: wide where
  // the pieces cannot tell two kinds apart (they always came together in the same proportion).
  const gBand: [number, number][] = (() => {
    const rows = system(p)
    const a = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    let rss = 0
    for (const { r, j, w } of rows) {
      rss += w * r * r
      for (let x = 0; x < n; x += 1) for (let y = 0; y < n; y += 1) a[x]![y]! += w * j[x]! * j[y]!
    }
    const sigma2 = rss / Math.max(1, segs.length - n)
    const column = (k: number) => solve(a, new Array<number>(n).fill(0).map((_, i) => (i === k ? 1 : 0)))
    const c1 = column(1)
    return [0, 1, 2, 3].map(k => {
      const ck = column(k)
      const rel = g[k]! / g[1]!
      if (ck === null || c1 === null) return [0, Infinity] as [number, number]
      const v = Math.max(0, sigma2 * (ck[k]! + c1[1]! - 2 * ck[1]!))
      const half = 1.96 * Math.sqrt(v)
      return [rel * Math.exp(-half), rel * Math.exp(half)] as [number, number]
    })
  })()

  const predOf = (sg: Segment) => [0, 1, 2, 3].reduce((acc, k) => acc + g[k]! * models.reduce((a, m) => a + f[m]! * (sg.c[m]?.[k] ?? 0), 0), 0)
  const misses = segs.map(sg => Math.abs(predOf(sg) / s[sg.plan]! - sg.dy) * 100)
  const mae = median(misses)
  const windows = new Set(segs.map(sg => sg.window)).size
  // How well the pieces pin the two kinds that set a way of use apart: cache reads and writes.
  const spreadOf = (k: number) => {
    const [lo, hi] = gBand[k] ?? [0, Infinity]
    return Number.isFinite(hi) && lo > 0 ? hi / lo : Infinity
  }
  const spread = Math.max(spreadOf(2), spreadOf(3))
  const confidence =
    segs.length >= 12 && windows >= 3 && (mae ?? 99) <= 3 && spread <= 4 ? 'high' : segs.length >= 5 && spread <= 15 ? 'medium' : 'low'
  return {
    kind,
    windows,
    segments: segs.filter(sg => !sg.hit).length,
    hits: segs.filter(sg => sg.hit).length,
    f,
    g,
    gBand,
    s,
    refPlan,
    planWindows,
    windowPlans: {},
    latest: null,
    inferred: [],
    mae,
    outliers: robust.filter(r => r < 1).length - unseen,
    unseen,
    confidence,
    ref,
    lent: lent === null ? null : (borrow?.kind ?? null),
  }
}

// The plan a pick puts in force at a moment; null before any pick, or after "not sure".
export function planAt(choices: readonly PlanChoice[], t: number): string | null {
  let plan: string | null = null
  for (const c of choices) if (c.at <= t) plan = c.plan
  return plan
}

// The plan picked last, passing over "not sure".
export function pickedPlan(choices: readonly PlanChoice[]): string | null {
  return [...choices].reverse().find(c => c.plan !== null)?.plan ?? null
}

// A move in share per API dollar this large, between stretches of 3 windows or more, reads as a
// change of plan: smaller ones are the noise of how a window was used.
const LOG_JUMP = Math.log(1.8)
const MIN_STRETCH = 3

// Splits a series into stretches with a level of their own: the cut with the clearest difference
// of means, while that difference is at least LOG_JUMP and 4 spreads of the means (the spread
// within the two sides, or the one given if larger), then each half again, three levels deep at
// most.
export function stretchesOf(xs: readonly number[], spread: number): [number, number][] {
  const mean = (a: number, b: number) => xs.slice(a, b).reduce((acc, x) => acc + x, 0) / (b - a)
  const squares = (a: number, b: number) => {
    const m = mean(a, b)
    return xs.slice(a, b).reduce((acc, x) => acc + (x - m) ** 2, 0)
  }
  const out: [number, number][] = []
  const split = (a: number, b: number, depth: number) => {
    let best = -1
    let bestZ = 4
    if (depth < 3) {
      for (let k = a + MIN_STRETCH; k <= b - MIN_STRETCH; k += 1) {
        const d = Math.abs(mean(a, k) - mean(k, b))
        const within = Math.max(spread, Math.sqrt((squares(a, k) + squares(k, b)) / (b - a - 2)))
        const z = d / (within * Math.sqrt(1 / (k - a) + 1 / (b - k)))
        if (d >= LOG_JUMP && z >= bestZ) {
          bestZ = z
          best = k
        }
      }
    }
    if (best < 0) {
      out.push([a, b])
      return
    }
    split(a, best, depth + 1)
    split(best, b, depth + 1)
  }
  if (xs.length > 0) split(0, xs.length, 0)
  return out
}

// The plan sold at about this multiple of another, within a factor of 2; null when none is, or
// when the other is not sold as a multiple.
export function guessPlan(ratio: number, against: string): string | null {
  const base = NOMINAL[against]
  if (base === undefined || !(ratio > 0)) return null
  let best: string | null = null
  let miss = Math.LN2
  for (const [plan, n] of Object.entries(NOMINAL)) {
    const d = Math.abs(Math.log(ratio) - Math.log(n / base))
    if (plan !== against && d <= miss) {
      miss = d
      best = plan
    }
  }
  return best
}

// Fits one window kind, with each window counted under the plan picked when it began. Windows no
// pick covers count under the plan picked next (else the last one picked, else the current plan),
// unless their share per API dollar stood apart: a first fit gives each window how far its rise
// strayed from what its spend predicts, and stretches that moved by LOG_JUMP or more from the ones
// next to the picks are each fitted again as a plan of their own, then named by the sold multiple
// they come closest to.
export function fitKind(kind: string, all: readonly Observation[], choices: readonly PlanChoice[] = [], borrow: Fit | null = null): Fit {
  const none: Fit = {
    kind, windows: 0, segments: 0, hits: 0, f: {}, g: [0, 0, 0, 0], gBand: [], s: {}, refPlan: CURRENT, planWindows: {},
    windowPlans: {}, latest: null, inferred: [], mae: null, outliers: 0, confidence: 'none', ref: null,
  }
  const raw = segmentsOf(kind, all)
  if (raw.length === 0) return none
  const sorted = [...choices].sort((a, b) => a.at - b.at)
  const length = windowLength(kind) ?? 0
  const windows = [...new Set(raw.map(sg => sg.window))].sort((a, b) => a - b)
  const picked = windows.map(w => planAt(sorted, w - length))
  const preferRef = pickedPlan(sorted) ?? CURRENT

  // Each stretch of windows no pick covers, and the plan it counts under until shown otherwise.
  const runs: { from: number; to: number; plan: string }[] = []
  for (let i = 0; i < windows.length; i += 1) {
    if (picked[i] !== null || (i > 0 && picked[i - 1] === null)) continue
    let j = i
    while (j + 1 < windows.length && picked[j + 1] === null) j += 1
    const next = sorted.find(c => c.at > windows[j]! - length && c.plan !== null)
    runs.push({ from: i, to: j, plan: next?.plan ?? preferRef })
  }
  const labels = picked.map(p => p ?? '')
  for (const run of runs) for (let i = run.from; i <= run.to; i += 1) labels[i] = run.plan
  const withLabels = () => {
    const at = new Map(windows.map((w, i) => [w, labels[i]!]))
    return raw.map(sg => ({ ...sg, plan: at.get(sg.window)! }))
  }
  const first = fitSegments(kind, withLabels(), preferRef, borrow)

  // How far each window's rise strayed from its spend, in logs: positive where a dollar took more.
  const predicted = (fit: Fit, sg: Segment) =>
    [0, 1, 2, 3].reduce((acc, k) => acc + fit.g[k]! * Object.entries(sg.c).reduce((a, [m, c]) => a + (fit.f[m] ?? 1) * (c[k] ?? 0), 0), 0)
  const strays = windows.map((w, i) => {
    const xs = raw
      .filter(sg => sg.window === w)
      .map(sg => Math.log((sg.dy * (first.s[labels[i]!] ?? 1)) / predicted(first, sg)))
      .filter(Number.isFinite)
    return median(xs)
  })

  const inferredRuns: { label: string; members: number[]; against: string }[] = []
  for (const run of runs) {
    // The run, with the picked windows next to it under the same plan as its anchor.
    const anchors: number[] = []
    for (let j = run.to + 1; j < windows.length && picked[j] === run.plan && anchors.length < 12; j += 1) anchors.push(j)
    if (anchors.length === 0) for (let j = run.from - 1; j >= 0 && picked[j] === run.plan && anchors.length < 12; j -= 1) anchors.unshift(j)
    const members = [...new Set([...anchors, ...Array.from({ length: run.to - run.from + 1 }, (_, k) => run.from + k)])]
      .sort((a, b) => a - b)
      .filter(i => strays[i] !== null)
    if (members.length < 2 * MIN_STRETCH) continue
    const xs = members.map(i => strays[i]!)
    const steps = xs.slice(1).map((x, k) => Math.abs(x - xs[k]!))
    const spread = Math.max(0.05, (1.4826 * (median(steps) ?? 0)) / Math.SQRT2)
    const parts = stretchesOf(xs, spread)
    if (parts.length < 2) continue
    const level = ([a, b]: [number, number]) => xs.slice(a, b).reduce((acc, x) => acc + x, 0) / (b - a)
    const home = parts.find(([a, b]) => members.slice(a, b).some(i => anchors.includes(i))) ?? parts[parts.length - 1]!
    for (const part of parts) {
      if (part === home || Math.abs(level(part) - level(home)) < LOG_JUMP) continue
      const own = members.slice(part[0], part[1]).filter(i => !anchors.includes(i))
      if (own.length === 0) continue
      const label = `~${inferredRuns.length + 1}`
      for (const i of own) labels[i] = label
      inferredRuns.push({ label, members: own, against: run.plan })
    }
  }

  const fit = inferredRuns.length === 0 ? first : fitSegments(kind, withLabels(), preferRef, borrow)
  const inferred: InferredPlan[] = inferredRuns.map(({ label, members, against }) => {
    const ratio = (fit.s[label] ?? 1) / (planScale(fit, against) ?? 1)
    return {
      label,
      from: windows[members[0]!]! - length,
      to: windows[members[members.length - 1]!]!,
      windows: members.length,
      ratio,
      against,
      guess: guessPlan(ratio, against),
    }
  })
  return {
    ...fit,
    windowPlans: Object.fromEntries(windows.map((w, i) => [String(w), labels[i]!])),
    latest: labels[labels.length - 1] ?? null,
    inferred,
  }
}

// The share of a plan's window a spend takes, by the fit.
export function shareOf(fit: Fit, plan: string, byModel: Record<string, Vec>): number {
  const s = planScale(fit, plan) ?? 1
  let share = 0
  for (const [m, v] of Object.entries(byModel)) {
    share += ((fit.f[m] ?? 1) * spendByKind(m, v).reduce((acc, x, k) => acc + fit.g[k]! * x, 0)) / s
  }
  return share
}

export type FittedEstimate = {
  plan: string
  capacityUsd: number
  remainingUsd: number
  explained: number
  etaMs: number | null
  // The share used at the reset when it does not fill before; null when there is no reset time.
  atReset: number | null
}

// Reads the current window through a fit. What is left comes from the official percent (so other
// devices' use counts). Dollars are told at this window's own way of using it: its API spend over
// the share the fit gives that spend. The coming hours each spend what that hour of the day has
// averaged, by model and kind, until what is left is used.
export function fittedWindow(
  w: Window,
  fit: Fit | undefined,
  plan: string | null,
  windowByModel: Record<string, Vec> | undefined,
  hourly: Record<string, number[][]>,
  tzOffsetMin: number,
  now: number,
): FittedEstimate | null {
  if (fit === undefined || fit.confidence === 'none') return null
  const s = planScale(fit, plan ?? CURRENT)
  if (s === null) return null

  const y = w.percentUsed / 100
  const left = Math.max(0, 1 - y)
  const explained = shareOf(fit, plan ?? CURRENT, windowByModel ?? {})
  const windowUsd = Object.entries(windowByModel ?? {}).reduce((acc, [m, v]) => acc + costOf(m, v), 0)

  const perHour = new Array<number>(24).fill(0)
  const usdHour = new Array<number>(24).fill(0)
  for (const [m, hours] of Object.entries(hourly)) {
    hours.forEach((kinds, hour) => {
      perHour[hour]! += ((fit.f[m] ?? 1) * kinds.reduce((acc, x, k) => acc + fit.g[k]! * x, 0)) / s
      usdHour[hour]! += kinds.reduce((a, b) => a + b, 0)
    })
  }
  // Dollars per whole window: this window's if it has spent enough to say, else the day's average.
  const profileShare = perHour.reduce((a, b) => a + b, 0)
  const usdPerWindow = explained >= 0.03 ? windowUsd / explained : profileShare > 0 ? usdHour.reduce((a, b) => a + b, 0) / profileShare : 0

  const reset = Date.parse(w.resetsAt ?? '')
  let etaMs: number | null = null
  let used = 0
  if (!Number.isNaN(reset)) {
    const offset = tzOffsetMin * MINUTE
    let t = now
    while (t < reset && etaMs === null) {
      const end = Math.min((Math.floor((t + offset) / HOUR) + 1) * HOUR - offset, reset)
      const rate = perHour[new Date(t + offset).getUTCHours()]! / HOUR
      if (rate > 0 && used + rate * (end - t) >= left) etaMs = t + (left - used) / rate - now
      used += rate * (end - t)
      t = end
    }
  }
  const atReset = Number.isNaN(reset) || etaMs !== null ? null : Math.min(1, y + used)
  return { plan: plan ?? CURRENT, capacityUsd: usdPerWindow, remainingUsd: left * usdPerWindow, explained, etaMs, atReset }
}

// ---- Engine calls ---------------------------------------------------------

// Claude Code's own folder: CLAUDE_CONFIG_DIR, else ~/.claude.
async function configDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
}

// Where Claude Code keeps this session's transcript: <config>/projects/<root, each
// character outside [A-Za-z0-9] made '-'>/<session id>.jsonl.
async function transcriptPath($: EngineInterface): Promise<string> {
  const id = await $.session.id()
  const root = await $.session.root()
  return `${await configDir($)}/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
}

// Fills the session's counts from its transcript and its subagents', so what ran before the mod
// loaded counts. The scanner reads them: a transcript outgrows what `$.fs.read` takes (4 MiB).
// Answers whether it read one; the live counts stand when it cannot.
async function backfill($: EngineInterface, path: string): Promise<boolean> {
  const run = await $.process.run([nodeBin, `${$.plugin.root}/scan/scan.mjs`, 'session', path], { timeoutMs: 60_000 }).catch(() => null)
  if (run === null || run.exitCode !== 0) {
    $.ui.log(`token-almanac: could not read ${path}: ${run?.stderr.split('\n')[0] ?? 'node did not run'}`, { to: 'debug' })
    return false
  }
  const parsed = JSON.parse(run.stdout) as Parsed
  const startedAt = (await $.session.usage()).startedAt
  await update($, totals, () => parsed.totals)
  await update($, byModel, () => parsed.byModel)
  await update($, turns, () => parsed.turns)
  await update($, since, () => startedAt)
  return true
}

// Reads every transcript on this machine through the scanner (incremental: its cache keeps each
// file's read offset) and keeps the sums for the global view.
const NODE_MISSING = 'node-missing'

// The language: the `language` option, else Claude Code's `language` setting, else LC_ALL or LANG,
// else what the runtime says the system's locale is; English when none names one spoken here.
export function pickLocale(option: string, ...sources: (string | null | undefined)[]): Locale {
  const chosen = localeOf(option)
  if (option !== 'auto' && chosen !== null) return chosen
  for (const source of sources) {
    const locale = localeOf(source)
    if (locale !== null) return locale
  }
  return 'en'
}

async function resolveLocale($: EngineInterface, option: string): Promise<Locale> {
  const settings = (await $.settings.read().catch(() => ({}))) as { language?: unknown }
  let system: string | undefined
  try {
    system = Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    system = undefined
  }
  return pickLocale(option, typeof settings.language === 'string' ? settings.language : null, await $.env.get('LC_ALL'), await $.env.get('LANG'), system)
}

async function loadPriceOverrides($: EngineInterface): Promise<void> {
  try {
    setPriceOverrides(JSON.parse(await $.fs.read(`${await configDir($)}/token-almanac/prices.json`)) as Record<string, unknown>)
  } catch {
    setPriceOverrides({})
  }
}

// Whether a scan is in flight, so no second one starts beside it; what the last one read, so a
// pick fits again without reading the transcripts; and the fits of the last observations and
// picks, kept while neither changes.
let isScanning = false
let lastScan: GlobalScan | null = null
let fitMemo: { key: string; fits: Record<string, Fit> } | null = null

// The history of windows that have reset, kept for good in the store: each window's observations
// cut down to those the fit reads, with spend exact to the response. Readings stay in their log
// only while their window runs, so its cap holds open windows, and a window's pieces keep their
// spend however old they grow (the scanner keeps spend response by response for 8 days only).
const ARCHIVE_MAX = 20_000
const windowKey = (o: { kind: string; resetsAt: number }) => `${o.kind}|${o.resetsAt}`
// When this process last looked for windows to put into the history.
let archiveCheckedAt = 0

// Puts each window that has reset, has readings and still has exact spend into the history, and
// takes its readings out of the log. A window whose spend is no longer exact is left as it is:
// archiving it would keep its error for good. Returns the whole history.
async function archiveClosed($: EngineInterface, scan: GlobalScan, now: number): Promise<Observation[]> {
  const archive = ((await $.store.get('archive')) ?? []) as Observation[]
  const known = new Set(archive.map(windowKey))
  const byWindow = new Map<string, Observation[]>()
  for (const o of scan.observations) {
    const key = windowKey(o)
    if (!known.has(key)) byWindow.set(key, [...(byWindow.get(key) ?? []), o])
  }
  const fresh = [...byWindow.values()]
    .filter(list => list[0]!.resetsAt <= now && list.some(o => !o.hit) && list.every(o => o.exact === true))
    .flatMap(compactWindow)
  if (fresh.length === 0) return archive
  const next = [...archive, ...fresh].sort((a, b) => a.resetsAt - b.resetsAt || a.t - b.t).slice(-ARCHIVE_MAX)
  await $.store.set('archive', next)
  const done = new Set(next.map(windowKey))
  const log = ((await $.store.get('readings')) ?? []) as Reading[]
  const open = log.filter(r => !done.has(windowKey({ kind: r[1], resetsAt: r[3] })))
  if (open.length !== log.length) await $.store.set('readings', open)
  return next
}

// A scan the user asked for says so while it runs. One in the background (after a turn, on opening
// the view) keeps the figures shown until the new ones replace them, all in one change.
async function scanAll($: EngineInterface, isShown = false): Promise<void> {
  if (isScanning) return
  isScanning = true
  // One redraw, so a terminal pane starts its spinner.
  $.ui.invalidate('ui.render')
  if (isShown) await update($, scanStatus, () => ({ state: 'scanning' as const }))
  try {
    const config = await configDir($)
    const snap = await read($, snapshot)
    const windows = Object.fromEntries(
      (snap?.windows ?? []).flatMap(w => {
        const length = windowLength(w.kind)
        const reset = Date.parse(w.resetsAt ?? '')
        return length === null || Number.isNaN(reset) ? [] : [[w.kind, reset - length]]
      }),
    )
    const kept = new Set((((await $.store.get('archive')) ?? []) as Observation[]).map(windowKey))
    const readings = (((await $.store.get('readings')) ?? []) as Reading[]).filter(r => !kept.has(windowKey({ kind: r[1], resetsAt: r[3] })))
    const run = await $.process.run([nodeBin, `${$.plugin.root}/scan/scan.mjs`, 'global', `${config}/projects`, `${config}/token-almanac/cache.json`], {
      timeoutMs: 300_000,
      stdin: JSON.stringify({ windows, readings }),
    })
    if (run.exitCode !== 0) throw new Error(run.stderr.split('\n')[0] || `scanner exited ${run.exitCode}`)
    const scan = JSON.parse(run.stdout) as GlobalScan
    // The fit reads the history and the scan's windows not in it (a hit the scanner keeps is there).
    const archive = await archiveClosed($, scan, await $.clock.now())
    archiveCheckedAt = await $.clock.now()
    const archived = new Set(archive.map(windowKey))
    lastScan = { ...scan, observations: [...archive, ...scan.observations.filter(o => !archived.has(windowKey(o)))] }
    await refit($)
    if ((await read($, scanStatus)).state !== 'idle') await update($, scanStatus, () => ({ state: 'idle' as const }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A Node.js that cannot be started is said plainly; the pane words it.
    const isNodeMissing = /ENOENT|not found|cannot find|no such file|spawn/i.test(message)
    await update($, scanStatus, () => ({ state: 'error' as const, message: isNodeMissing ? NODE_MISSING : message }))
  } finally {
    isScanning = false
  }
}

// Works out what the machine view draws from the last scan and the plans picked, and sets it in
// one change. The fits are the slow part: they are kept while the observations and picks stay the
// same, and the pane gets a turn between one window kind's and the next.
async function refit($: EngineInterface): Promise<void> {
  const scan = lastScan
  if (scan === null) return
  const snap = await read($, snapshot)
  const choices = await read($, planChoices)
  const kinds = [...new Set([...scan.observations.map(o => o.kind), ...(snap?.windows ?? []).map(w => w.kind)])].sort()
  const key = JSON.stringify([scan.observations.length, scan.observations.reduce((a, o) => Math.max(a, o.t), 0), choices, kinds])
  let fits = fitMemo?.key === key ? fitMemo.fits : null
  if (fits === null) {
    // The five-hour window first: the others lean on it once it is sure enough.
    const fresh: Record<string, Fit> = {}
    for (const kind of [...kinds].sort((a, b) => (b === 'five_hour' ? 1 : 0) - (a === 'five_hour' ? 1 : 0))) {
      await $.clock.sleep(0)
      const lend = fresh.five_hour
      fresh[kind] = fitKind(kind, scan.observations, choices, kind !== 'five_hour' && lend !== undefined && (lend.confidence === 'medium' || lend.confidence === 'high') ? lend : null)
    }
    fits = fresh
    fitMemo = { key, fits }
  }
  await $.clock.sleep(0)
  const views = { '30d': globalView(scan, '30d'), all: globalView(scan, 'all') }
  // Each limit hit's API-equivalent cost, for the windows counted under the plan in force now.
  const hits: Record<string, number[]> = {}
  for (const o of scan.observations) {
    const fit = fits[o.kind]
    if (!o.hit || (fit !== undefined && fit.windowPlans[String(o.resetsAt)] !== fit.latest)) continue
    const cost = Object.entries(o.byModel).reduce((acc, [m, v]) => acc + costOf(m, v), 0)
    if (cost > 0) (hits[o.kind] ??= []).push(cost)
  }
  const next: Machine = { at: scan.at, files: scan.files, tzOffsetMin: scan.tzOffsetMin, windows: scan.windows, views, fits, hits }
  await update($, machine, () => next)
}

// Takes a reading: the snapshot the band and pane draw, and a forecast sample per window,
// kept in the store too so the forecast survives a restart within the same window.
async function record($: EngineInterface, u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Promise<void> {
  const now = await $.clock.now()
  const snap = toSnapshot(u, now)
  await update($, snapshot, () => snap)
  const next = await update($, samples, all => snap.windows.reduce((acc, w) => withReading(acc, w, now), all))
  await $.store.set('samples', next)

  // Every reading that moved, across windows and sessions: the fit's observations.
  const log = ((await $.store.get('readings')) ?? []) as Reading[]
  let isGrown = false
  for (const w of snap.windows) {
    const reset = Date.parse(w.resetsAt ?? '')
    if (Number.isNaN(reset)) continue
    const last = [...log].reverse().find(r => r[1] === w.kind)
    if (last && last[2] === w.percentUsed && last[3] === reset) continue
    log.push([now, w.kind, w.percentUsed, reset])
    isGrown = true
  }
  if (isGrown) await $.store.set('readings', log.slice(-3000))
  // A window in the log has reset: scan behind everything, so it goes into the history while its
  // spend is still exact, whether or not the machine view is ever opened. At most twice an hour.
  if (log.some(r => r[3] <= now) && now - archiveCheckedAt > 30 * MINUTE) {
    archiveCheckedAt = now
    $.clock.after(0, () => void scanAll($))
  }
}

// Picks the plan in force from now on. A pick made less than a day ago is taken as a correction of
// it, keeping its moment; an earlier one stays, so the windows before now keep the plan they had.
async function pickPlan($: EngineInterface, value: string): Promise<void> {
  const plan = value === UNKNOWN ? null : value
  const now = await $.clock.now()
  const next = await update($, planChoices, list => {
    const last = list[list.length - 1]
    if (last !== undefined && last.plan === plan) return list
    if (last !== undefined && now - last.at < 24 * HOUR) return [...list.slice(0, -1), { at: last.at, plan }]
    return list.length === 0 && plan === null ? list : [...list, { at: now, plan }]
  })
  await $.store.set('planChoices', next)
  // A reload forgets the last scan: read the transcripts again for it.
  if (lastScan === null) await scanAll($)
  else await refit($)
}

function ago(ms: number): string {
  return ms < MINUTE ? t.updatedNow : t.updatedAgo(fmtDuration(ms))
}

// ---- Drawing --------------------------------------------------------------

// Claude's clay is the one accent; warm neutrals carry everything else. Amber and red appear only
// when a limit runs high.
const CLAY = '#D97757'
const CLAY_SOFT = '#E9A88C'
const STONE = '#A39E93'
const AMBER = '#D99A3A'
const RED = '#C9533E'

function levelHex(percent: number): string {
  return percent >= 90 ? RED : percent >= 70 ? AMBER : CLAY
}

// ---- Motion -------------------------------------------------------------------

// Whether figures move into place, from the `motion` option.
let isMotion = true
// How long a figure takes to move to a new value, and how often the terminal draws it on the way.
const MOVE_MS = 450
const FRAME_MS = 50
// A figure on its way: the value it left, the one it goes to, and when it set off.
export type Move = { from: number; to: number; at: number }
// Each figure by where it is drawn: `t:` keys in the terminal, `g:` keys in vector drawings.
const moves = new Map<string, Move>()
const easeOut = (x: number) => 1 - (1 - x) ** 3

// The move that takes a figure to this value. It is kept while the value stays, so drawing the
// same value draws the same thing (a vector drawing does not play again); a new value sets off
// from wherever the figure is now, and a figure seen for the first time rises from `start`.
export function moveTo(key: string, value: number, now: number, start = 0): Move {
  const last = moves.get(key)
  if (last !== undefined && last.to === value) return last
  const from = !isMotion ? value : last === undefined ? start : positionOf(last, now)
  const move = { from, to: value, at: now }
  moves.set(key, move)
  return move
}

export function positionOf(move: Move, now: number): number {
  const x = Math.min(1, Math.max(0, (now - move.at) / MOVE_MS))
  return move.from + (move.to - move.from) * easeOut(x)
}

const isOnTheWay = (move: Move, now: number) => move.from !== move.to && now - move.at < MOVE_MS

// SMIL that moves one attribute of a shape from where it was to where it is drawn, easing out;
// nothing once the move is over, so a surface that draws the frame afresh (on scroll, on the
// half-minute redraw) shows the figure where it stands rather than playing the move again.
function glide(attribute: string, move: Move, now: number): string {
  if (!isOnTheWay(move, now)) return ''
  return `<animate attributeName="${attribute}" from="${move.from.toFixed(1)}" to="${move.to.toFixed(1)}" dur="${MOVE_MS}ms" calcMode="spline" keyTimes="0;1" keySplines="0.22 1 0.36 1" fill="freeze"/>`
}

// The braille spinner a scan turns while it runs.
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const spinnerAt = (now: number) => SPINNER[Math.floor(now / 80) % SPINNER.length]!

// The terminal is drawn again every frame while a figure there is on its way or a scan runs, and
// the frames stop when neither is. Only a terminal drawing starts them: on the other surfaces a
// redraw every frame would replace the buttons under a press, so a click could be lost.
let ticker: { cancel: () => void } | null = null
function animate($: EngineInterface): void {
  if (ticker !== null || !isMotion) return
  ticker = $.clock.every(FRAME_MS, () => {
    void $.clock.now().then(now => {
      const isBusy = isScanning || [...moves].some(([key, move]) => key.startsWith('t:') && isOnTheWay(move, now - FRAME_MS))
      $.ui.invalidate('ui.render')
      if (!isBusy) {
        ticker?.cancel()
        ticker = null
      }
    })
  })
}

// The terminal's sparkline: one block per value, eight heights.
function sparkText(values: readonly number[]): string {
  const blocks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...values, 1e-9)
  return values.map(v => (v <= 0 ? ' ' : blocks[Math.min(7, Math.floor((v / max) * 7.999))]!)).join('')
}

// ---- Cards --------------------------------------------------------------------

// The desktop, editor and phone draw the pane's figures as whole images that set their own type
// and spacing, so the pane reads as a few calm cards rather than rows of text beside small bars.
// They are images, not frames: nothing reloads when the pane redraws or scrolls.
const CARD_W = 400
const FONT = "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"
// Ink, hairlines and the model series by role, light and dark: an image follows the viewer's
// colour scheme. The series are the first three of a palette checked for colour-blind separation.
const CARD_STYLE =
  '<style>' +
  '.i1{fill:#1f1e1b}.i2{fill:#5e5d59}.i3{fill:#8a8780}.trk{fill:#ebe8e1}.trkS{stroke:#ebe8e1}.hair{stroke:#e6e3dc}.tk{stroke:#5e5d59}' +
  '.s0{fill:#2a78d6}.s1{fill:#eb6834}.s2{fill:#1baf7a}.s3{fill:#b4b2a9}' +
  '@media (prefers-color-scheme: dark){' +
  '.i1{fill:#f4f3ee}.i2{fill:#c3c2b7}.i3{fill:#8f8d86}.trk{fill:#33322e}.trkS{stroke:#33322e}.hair{stroke:#33322e}.tk{stroke:#c3c2b7}' +
  '.s0{fill:#3987e5}.s1{fill:#d95926}.s2{fill:#199e70}.s3{fill:#6b6a64}}' +
  '</style>'
// The models in fixed order: the three largest, then the rest as one.
const MODEL_SERIES = ['s0', 's1', 's2', 's3'] as const

const END = ' text-anchor="end"'
const MIDDLE = ' text-anchor="middle"'
const BOLD = ' font-weight="600"'
const TABULAR = ' style="font-variant-numeric:tabular-nums"'
// A colour is a role class or, for the session's token kinds, a fixed hex.
const paint = (color: string) => (color.startsWith('#') ? `fill="${color}"` : `class="${color}"`)

function card(width: number, height: number, body: string): string {
  const tall = Math.ceil(height)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${tall}" viewBox="0 0 ${width} ${tall}" font-family="${FONT}">${CARD_STYLE}${body}</svg>`
}

function label(x: number, y: number, text: string, cls: string, size: number, extra = ''): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}" font-size="${size}"${extra}>${escapeXml(text)}</text>`
}

// How wide a line sets, roughly: CJK at a full em, capitals a little wider than the rest.
export function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += /[⺀-￿]/.test(ch) ? size : /[A-Z@%]/.test(ch) ? size * 0.66 : size * 0.56
  return w
}

function clip(text: string, size: number, max: number): string {
  if (textWidth(text, size) <= max) return text
  const chars = [...text]
  while (chars.length > 1 && textWidth(`${chars.join('')}…`, size) > max) chars.pop()
  return `${chars.join('')}…`
}

// Gridline values from zero to just past the top, on a 1-2-2.5-5 step, three to five of them.
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0]
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find(f => f * pow >= raw) ?? 10) * pow
  const ticks: number[] = []
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)))
  return ticks
}

export type LimitCard = {
  label: string
  percent: number
  move: Move | null
  projected: number | null
  elapsed: number | null
  reset: string
  outlook: string
  // What the window holds and has left in API dollars, a line each, when there is an estimate.
  lines: readonly string[]
}

// The limits side by side, each a ring: the arc is what is used, a paler arc beyond it where the
// window is headed by its reset, and a tick at how far through the window the clock is, so an arc
// past its tick is ahead of an even pace. Under each ring, when it resets, how it is going and what
// it holds. The arc glides while a move is under way.
export function ringsCard(rows: readonly LimitCard[], keyText: { elapsed: string; projected: string }, now: number, width = CARD_W): string {
  const R = 40
  const STROKE = 9
  const cy = R + STROKE
  const C = 2 * Math.PI * R
  const col = width / Math.max(rows.length, 1)
  const offset = (p: number) => C * (1 - Math.max(0, Math.min(100, p)) / 100)
  const most = Math.max(0, ...rows.map(r => r.lines.length))
  const body = rows
    .map((row, i) => {
      const cx = col * i + col / 2
      const color = levelHex(row.percent)
      const arc = (p: number, extra: string, inner = '') =>
        `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${R}" fill="none" stroke-width="${STROKE}" stroke-dasharray="${C.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${offset(p).toFixed(2)}" transform="rotate(-90 ${cx.toFixed(1)} ${cy})"${extra}>${inner}</circle>`
      const move = row.move !== null && isOnTheWay(row.move, now) ? { from: offset(row.move.from), to: offset(row.percent), at: row.move.at } : null
      const ahead = row.projected !== null && row.projected > row.percent ? arc(row.projected, ` stroke="${color}" stroke-opacity="0.25"`) : ''
      const fill = row.percent > 0 || move !== null ? arc(row.percent, ` stroke="${color}" stroke-linecap="round"`, move === null ? '' : glide('stroke-dashoffset', move, now)) : ''
      let tick = ''
      if (row.elapsed !== null) {
        const a = Math.max(0, Math.min(1, row.elapsed)) * 2 * Math.PI - Math.PI / 2
        const px = (r: number) => (cx + r * Math.cos(a)).toFixed(1)
        const py = (r: number) => (cy + r * Math.sin(a)).toFixed(1)
        const [r0, r1] = [R - STROKE / 2 - 3, R + STROKE / 2 + 3]
        tick = `<line x1="${px(r0)}" y1="${py(r0)}" x2="${px(r1)}" y2="${py(r1)}" class="tk" stroke-width="2" stroke-linecap="round"/>`
      }
      const under = [row.reset, row.outlook].filter(Boolean)
      return (
        `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${R}" fill="none" stroke-width="${STROKE}" class="trkS"/>${ahead}${fill}${tick}` +
        label(cx, cy + 7, `${row.percent}%`, 'i1', 20, MIDDLE + BOLD) +
        label(cx, cy + R + STROKE + 22, row.label, 'i1', 13, MIDDLE + BOLD) +
        under.map((text, k) => label(cx, cy + R + STROKE + 42 + k * 18, clip(text, 12, col - 12), k === 0 ? 'i3' : 'i2', 12, MIDDLE)).join('') +
        row.lines.map((text, k) => label(cx, cy + R + STROKE + 42 + (2 + k) * 18 + 6, clip(text, 12, col - 12), 'i2', 12, MIDDLE + TABULAR)).join('')
      )
    })
    .join('')
  // A key for the two marks that are not plain data, once, under the rings.
  const textEnd = cy + R + STROKE + 42 + (most > 0 ? (2 + most) * 18 + 6 : 2 * 18) - 14
  const keyY = textEnd + 22
  let key = ''
  let x = 0
  if (rows.some(row => row.elapsed !== null)) {
    key += `<line x1="1" x2="1" y1="${keyY - 9}" y2="${keyY + 1}" class="tk" stroke-width="2" stroke-linecap="round"/>${label(8, keyY, keyText.elapsed, 'i3', 11)}`
    x = 8 + textWidth(keyText.elapsed, 11) + 18
  }
  if (rows.some(row => row.projected !== null && row.projected > row.percent)) {
    key += `<rect x="${x.toFixed(1)}" y="${keyY - 7}" width="16" height="6" rx="3" fill="${CLAY}" fill-opacity="0.25"/>${label(x + 22, keyY, keyText.projected, 'i3', 11)}`
  }
  return card(width, key === '' ? textEnd + 6 : keyY + 4, body + key)
}

// Headline figures side by side: the value large, what it is beneath.
export function statsCard(items: readonly [string, string][], width = CARD_W): string {
  const col = width / Math.max(items.length, 1)
  return card(width, 46, items.map(([value, name], i) => label(i * col, 20, value, 'i1', 20, BOLD) + label(i * col, 40, clip(name, 12, col - 8), 'i3', 12)).join(''))
}

export type Column = { id: string; label?: string; parts: { value: number; color: string }[] }

// Columns over time on a few clean gridlines, stacked where a column has parts; the tallest is
// named over its cap, and a legend follows when there is more than one series. With a key, each
// part grows from where it stood, by its own id.
export function columnsCard(
  cols: readonly Column[],
  opts: { format: (v: number) => string; legend?: readonly { name: string; color: string }[]; key: string | null; now: number },
  width = CARD_W,
): string {
  const n = cols.length
  const totals = cols.map(c => c.parts.reduce((a, p) => a + p.value, 0))
  const ticks = niceTicks(Math.max(0, ...totals))
  const top = ticks[ticks.length - 1]!
  const x0 = Math.max(...ticks.map(v => textWidth(opts.format(v), 10))) + 8
  const plotW = width - x0
  const y0 = 18
  const chartH = 104
  const base = y0 + chartH
  const slot = plotW / Math.max(n, 1)
  const barW = Math.min(24, Math.max(1.5, slot - (n > 40 ? 1 : 2)))
  const yOf = (v: number) => base - (top > 0 ? (v / top) * chartH : 0)
  let s = ''
  for (const v of ticks) {
    const y = yOf(v).toFixed(1)
    s += `<line x1="${x0}" x2="${width}" y1="${y}" y2="${y}" class="hair" stroke-width="1"/>${label(x0 - 6, Number(y) + 3.5, opts.format(v), 'i3', 10, END + TABULAR)}`
  }
  const every = Math.max(1, Math.ceil(n / 4))
  cols.forEach((c, i) => {
    const x = x0 + slot * i + (slot - barW) / 2
    let y = base
    const shown = c.parts.filter(p => p.value > 0)
    shown.forEach((p, k) => {
      // A hairline of the surface between stacked parts, and a rounded cap on the top one.
      const full = (p.value / (top || 1)) * chartH
      const segH = Math.max(0, k < shown.length - 1 && full > 2 ? full - 1 : full)
      y -= full
      const id = `${opts.key}:${c.id}:${k}`
      const motion = opts.key === null ? '' : glide('height', moveTo(`${id}:h`, segH, opts.now), opts.now) + glide('y', moveTo(`${id}:y`, y, opts.now, base), opts.now)
      const rx = k === shown.length - 1 ? ` rx="${Math.min(2, barW / 2)}"` : ''
      s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}"${rx} ${paint(p.color)}>${motion}</rect>`
    })
    if (c.label !== undefined && i % every === 0) {
      const lx = Math.min(width - 14, Math.max(x0 + 14, x + barW / 2))
      s += label(lx, base + 14, c.label, 'i3', 10, MIDDLE)
    }
  })
  const peak = totals.indexOf(Math.max(...totals))
  if (peak >= 0 && totals[peak]! > 0) {
    const px = Math.min(width - 20, Math.max(x0 + 20, x0 + slot * peak + slot / 2))
    s += label(px, yOf(totals[peak]!) - 5, opts.format(totals[peak]!), 'i2', 10, MIDDLE + BOLD + TABULAR)
  }
  let height = base + (cols.some(c => c.label !== undefined) ? 20 : 6)
  if (opts.legend !== undefined && opts.legend.length > 1) {
    const ly = height + 12
    let x = 0
    for (const item of opts.legend) {
      s += `<circle cx="${(x + 4).toFixed(1)}" cy="${ly - 4}" r="4" ${paint(item.color)}/>${label(x + 12, ly, item.name, 'i2', 11)}`
      x += 12 + textWidth(item.name, 11) + 16
    }
    height = ly + 4
  }
  return card(width, height, s)
}

export type ListRow = { name: string; amount: string; share: string; fraction: number; color: string | null }

// Ranked rows: the name, the amount and its share at the right. Rows without a colour of their own
// carry a thin bar under the name sized to the largest; rows with one are led by a single bar split
// by share, each row's dot naming its part.
export function listCard(rows: readonly ListRow[], width = CARD_W, stack: readonly { value: number; color: string }[] | null = null): string {
  let s = ''
  let y = 0
  if (stack !== null) {
    const total = stack.reduce((a, p) => a + p.value, 0)
    const parts = stack.filter(p => p.value > 0)
    const room = width - 2 * Math.max(0, parts.length - 1)
    let x = 0
    s += `<clipPath id="stack"><rect width="${width}" height="10" rx="5"/></clipPath><g clip-path="url(#stack)"><rect width="${width}" height="10" class="trk"/>`
    for (const p of parts) {
      const w = total > 0 ? (p.value / total) * room : 0
      s += `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="10" ${paint(p.color)}/>`
      x += w + 2
    }
    s += '</g>'
    y = 24
  }
  const amountX = width - 52
  const rowH = stack === null ? 32 : 24
  for (const row of rows) {
    const nx = row.color === null ? 0 : 14
    if (row.color !== null) s += `<circle cx="4" cy="${y + 9}" r="4" ${paint(row.color)}/>`
    s += label(nx, y + 13, clip(row.name, 13, amountX - nx - 72), 'i1', 13)
    s += label(amountX, y + 13, row.amount, 'i1', 13, END + TABULAR)
    s += label(width, y + 13, row.share, 'i3', 12, END + TABULAR)
    if (row.color === null) {
      const room = amountX - 72
      s += `<rect y="${y + 20}" width="${room}" height="4" rx="2" class="trk"/><rect y="${y + 20}" width="${Math.max(4, row.fraction * room).toFixed(1)}" height="4" rx="2" fill="${CLAY}"/>`
    }
    y += rowH
  }
  return card(width, y - (stack === null ? 4 : 6), s)
}

// How sure a fit is, as three dots filled one per step and its word after them, right-aligned at x.
function confidenceMark(x: number, y: number, level: Fit['confidence'], word: string): string {
  const filled = { none: 0, low: 1, medium: 2, high: 3 }[level]
  const textW = textWidth(word, 12)
  const dots = [0, 1, 2]
    .map(i => `<circle cx="${(x - textW - 8 - (2 - i) * 11 - 4).toFixed(1)}" cy="${y - 4}" r="3.5" ${i < filled ? `fill="${CLAY}"` : 'class="trk"'}/>`)
    .join('')
  return dots + label(x, y, word, 'i2', 12, END)
}

export type CapacityRow = {
  label: string
  percent: number
  whole: string
  left: string
  outlook: string
  confidence: Fit['confidence']
  confidenceWord: string
  // Each past limit hit's API-equivalent dollars, and the line that says so.
  hits: readonly number[]
  hitsLine: string
}

// What each window holds: a bar for the whole window, filled to the share used, the dollars it
// holds and has left under it, and how sure the estimate is. Past limit hits sit on a dollar
// scale beneath, a dot each, so their spread shows at a glance.
export function capacityCard(rows: readonly CapacityRow[], width = CARD_W): string {
  let s = ''
  let y = 0
  for (const row of rows) {
    s += label(0, y + 14, row.label, 'i1', 13, BOLD) + confidenceMark(width, y + 14, row.confidence, row.confidenceWord)
    const used = Math.max(0, Math.min(100, row.percent))
    s += `<rect y="${y + 24}" width="${width}" height="10" rx="5" class="trk"/>`
    if (used > 0) s += `<rect y="${y + 24}" width="${Math.max(10, (used / 100) * width).toFixed(1)}" height="10" rx="5" fill="${levelHex(row.percent)}"/>`
    s += label(0, y + 52, `${row.whole} · ${row.left}`, 'i2', 12, TABULAR)
    if (row.outlook) s += label(width, y + 52, row.outlook, 'i2', 12, END)
    y += 62
    if (row.hits.length > 0) {
      s += label(0, y + 12, row.hitsLine, 'i3', 11)
      const lo = Math.min(...row.hits)
      const hi = Math.max(...row.hits)
      const pad = Math.max((hi - lo) * 0.15, hi * 0.05, 1)
      const [a, b] = [Math.max(0, lo - pad), hi + pad]
      const x0 = 34
      const x1 = width - 34
      const xOf = (v: number) => x0 + ((v - a) / (b - a || 1)) * (x1 - x0)
      const ay = y + 30
      s += `<line x1="${x0}" x2="${x1}" y1="${ay}" y2="${ay}" class="hair" stroke-width="1"/>`
      s += label(x0 - 6, ay + 4, `$${Math.round(a)}`, 'i3', 10, END + TABULAR) + label(x1 + 6, ay + 4, `$${Math.round(b)}`, 'i3', 10, TABULAR)
      for (const v of row.hits) s += `<circle cx="${xOf(v).toFixed(1)}" cy="${ay}" r="4.5" fill="${CLAY}" fill-opacity="0.55"/>`
      y += 44
    }
    y += 16
  }
  return card(width, y - 16, s)
}

export type FitCard = {
  label: string
  confidence: Fit['confidence']
  confidenceWord: string
  // What it learned from and how far it misses, one line.
  head: string
  kindsTitle: string
  // Each kind's weight against output's, with its 95% band; unclear when the band is too wide to say.
  kinds: readonly { name: string; value: number; band: [number, number] | null }[]
  reference: string
  modelsTitle: string | null
  models: readonly { name: string; value: number; color: string }[]
  unclear: string
}

// A fit as an interval plot on one logarithmic scale from ×0.01 to ×10: each kind's weight per API
// dollar against output's (the line at ×1), its 95% band as a bar, a pale band across the scale
// where the pieces cannot tell; then each model against the reference model on the same scale.
export function fitCard(fit: FitCard, width = CARD_W): string {
  const x0 = 92
  const x1 = width - 70
  const [lo, hi] = [-2, 1]
  const xOf = (v: number) => x0 + ((Math.log10(Math.max(10 ** lo, Math.min(10 ** hi, v))) - lo) / (hi - lo)) * (x1 - x0)
  const times = (v: number) => `×${v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)}`
  let s = label(0, 14, fit.label, 'i1', 13, BOLD) + confidenceMark(width, 14, fit.confidence, fit.confidenceWord)
  // The head runs on to a second line, at a " · ", where it is wider than the card.
  const lines: string[] = []
  for (const part of fit.head.split(' · ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && textWidth(`${last} · ${part}`, 11) <= width) lines[lines.length - 1] = `${last} · ${part}`
    else lines.push(part)
  }
  lines.forEach((line, i) => (s += label(0, 34 + i * 15, line, 'i3', 11)))
  let y = 50 + (lines.length - 1) * 15
  const scale = (top: number, bottom: number) => {
    let g = ''
    for (let e = lo; e <= hi; e += 1) {
      const x = xOf(10 ** e).toFixed(1)
      g += `<line x1="${x}" x2="${x}" y1="${top}" y2="${bottom}" class="${e === 0 ? 'tk' : 'hair'}" stroke-width="1"/>`
      g += label(Number(x), bottom + 12, `×${Number((10 ** e).toPrecision(1))}`, 'i3', 10, MIDDLE + TABULAR)
    }
    return g
  }
  const rows = (items: readonly { name: string; value: number; band: [number, number] | null; color: string }[], title: string) => {
    let g = label(0, y + 12, title, 'i2', 12)
    const top = y + 20
    items.forEach((item, i) => {
      const cy = top + 10 + i * 22
      g += label(0, cy + 4, clip(item.name, 12, x0 - 10), 'i1', 12)
      if (item.band === null) {
        g += `<rect x="${x0}" y="${cy - 4}" width="${x1 - x0}" height="8" rx="4" fill="${CLAY}" fill-opacity="0.12"/>`
        g += `<circle cx="${xOf(item.value).toFixed(1)}" cy="${cy}" r="4" fill="none" stroke="${CLAY}" stroke-width="1.5"/>`
        g += label(width, cy + 4, `${times(item.value)} ${fit.unclear}`, 'i3', 12, END + TABULAR)
      } else {
        const [a, b] = item.band
        if (b > a) g += `<line x1="${xOf(a).toFixed(1)}" x2="${xOf(b).toFixed(1)}" y1="${cy}" y2="${cy}" stroke="${CLAY}" stroke-opacity="0.45" stroke-width="4" stroke-linecap="round"/>`
        g += `<circle cx="${xOf(item.value).toFixed(1)}" cy="${cy}" r="4.5" ${paint(item.color)}/>`
        g += label(width, cy + 4, times(item.value), 'i1', 12, END + TABULAR)
      }
    })
    const bottom = top + items.length * 22 + 2
    g = scale(top, bottom) + g
    y = bottom + 24
    return g
  }
  // The kinds, then output itself at ×1, the mark the others are read against.
  s += rows([...fit.kinds.map(k => ({ ...k, color: CLAY })), { name: fit.reference, value: 1, band: [1, 1], color: STONE }], fit.kindsTitle)
  if (fit.modelsTitle !== null && fit.models.length > 0) s += rows(fit.models.map(m => ({ ...m, band: [m.value, m.value] as [number, number] })), fit.modelsTitle)
  return card(width, y - 8, s)
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '–'
  const p = (part / whole) * 100
  return p > 0 && p < 1 ? '<1%' : `${p.toFixed(0)}%`
}

// Shows the global view and refreshes its scan.
// Shows the global view at once with the figures it has, then refreshes them behind it when they
// are over a minute old, without holding the press that opened it; with none yet, it scans in the
// open.
async function openGlobal($: EngineInterface): Promise<void> {
  await update($, view, () => 'global' as const)
  const shown = await read($, machine)
  if (shown === null) await scanAll($, true)
  else if ((await $.clock.now()) - shown.at > MINUTE) $.clock.after(0, () => void scanAll($))
}

export const register: Register = (on, options) => {
  nodeBin = typeof options.nodePath === 'string' && options.nodePath.trim() !== '' ? options.nodePath.trim() : 'node'
  isMotion = options.motion !== 'off'
  const language = typeof options.language === 'string' ? options.language : 'auto'
  setLocale(localeOf(language) ?? 'en')

  // Subagent turns that finished since the last main-thread turn completed.
  let bucket: Tokens = ZERO
  let bucketTurns = 0
  // Whether the counts came from the transcript; if the computed path missed, the next
  // prompt's settings-hook input names the file.
  let isBackfilled = false

  on('session.start', async ($, e, next) => {
    setLocale(await resolveLocale($, language))
    await loadPriceOverrides($)
    await $.command.register({ name: 'token-almanac', description: t.commandDescription })

    const now = await $.clock.now()
    if ((await read($, since)) === 0) {
      await update($, since, () => now)
    }
    isBackfilled = await backfill($, await transcriptPath($))
    // Readings from earlier sessions, for windows that have not reset yet.
    const stored = ((await $.store.get('samples')) ?? {}) as Record<string, Samples>
    const live = Object.fromEntries(
      Object.entries(stored).filter(([, s]) => !s.resetsAt || Date.parse(s.resetsAt) > now),
    )
    await update($, samples, current => ({ ...live, ...current }))
    const picks = ((await $.store.get('planChoices')) ?? []) as PlanChoice[]
    await update($, planChoices, () => picks)
    // The readings log began after the forecast's samples did: start it from them.
    if ((await $.store.get('readings')) === undefined) {
      const seeded: Reading[] = Object.entries(stored).flatMap(([kind, series]) =>
        series.points.map(([t, pct]): Reading => [t, kind, pct, Date.parse(series.resetsAt ?? '')]).filter(r => !Number.isNaN(r[3])),
      )
      await $.store.set('readings', seeded.sort((a, b) => a[0] - b[0]))
    }
    await record($, await $.session.usage())

    // A scan a reload cut short left its mark: clear it, and refresh a global view left open.
    await update($, scanStatus, () => ({ state: 'idle' as const }))
    if ((await read($, view)) === 'global') {
      $.clock.after(0, () => void scanAll($))
    }

    // Countdowns and forecasts move with the clock: redraw twice a minute.
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (!isBackfilled) {
      isBackfilled = await backfill($, e.transcript_path)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await record($, e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u !== undefined) {
      const t: Tokens = {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      }
      await update($, totals, s => add(s, t))
      await update($, byModel, m => ({ ...m, [u.model]: add(m[u.model] ?? ZERO, t) }))
      if (e.agentId !== undefined) {
        bucket = add(bucket, t)
        bucketTurns += 1
      }
    }
    if (e.agentId === undefined) {
      const own: Tokens = u
        ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }
        : ZERO
      const at = await $.clock.now()
      const withSubagents = add(own, bucket)
      const subagentTurns = bucketTurns
      bucket = ZERO
      bucketTurns = 0
      await update($, turns, list => [...list, { n: (list[list.length - 1]?.n ?? 0) + 1, at, tokens: withSubagents, subagentTurns }].slice(-60))
      // The global view reads the transcripts this turn just grew: refresh it after the turn
      // settles, behind the figures shown, at most twice a minute.
      if ((await read($, view)) === 'global') {
        const shown = await read($, machine)
        if (shown === null || at - shown.at > 30_000) $.clock.after(0, () => void scanAll($))
      }
    }
    return next(e)
  })

  // A /clear starts the conversation over: so do the session's counts.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await update($, since, () => now)
      await update($, totals, () => ZERO)
      await update($, byModel, () => ({}))
      await update($, turns, () => [])
      bucket = ZERO
      bucketTurns = 0
    }
    return next(e)
  })

  on('command.run', { command: 'token-almanac' }, async $ => {
    await update($, isBandHidden, () => false)
    const opened = await $.ui.open({ id: PANE, title: t.paneTitle })
    return { text: opened.isPlaced ? t.paneOpened : t.paneWaiting }
  })

  // The one-line summary above the prompt, kept short: the session's cost and context, each
  // limit's percent, and when a limit will fill before it resets, how soon. The rest is in the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) {
      return next(e)
    }
    const snap = await read($, snapshot)
    const series = await read($, samples)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Text>
          <Text color="claude" bold>
            ◆{' '}
          </Text>
          {[snap?.costUsd !== undefined ? fmtUsd(snap.costUsd) : '', snap?.contextPercent !== undefined ? t.bandContext(snap.contextPercent) : ''].filter(Boolean).join(' · ')}
        </Text>
        {(snap?.windows ?? []).map(w => {
          const f = forecast(series[w.kind]?.points ?? [], w.percentUsed, now, w.resetsAt)
          return (
            <Text>
              <Text dimColor>│ </Text>
              {windowLabel(w.kind)}{' '}
              <Text color={levelColor(w.percentUsed)} bold>
                {w.percentUsed}%
              </Text>
              {f.etaMs !== null && <Text dimColor> {t.bandFull(fmtDuration(f.etaMs))}</Text>}
            </Text>
          )
        })}
        {(snap?.windows.length ?? 0) === 0 && <Text dimColor>│ {hasNoLimits(snap) ? t.bandNoLimits : t.bandWaiting}</Text>}
        <Button key="open" label={t.bandOpen} dimColor onPress={() => void $.ui.open({ id: PANE, title: t.paneTitle })} />
        <Button key="hide" label={t.bandHide} dimColor role="dismiss" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  // The detail pane: the limits on top, then this session or this machine, the rest folded away.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    const series = await read($, samples)
    const mode = await read($, view)
    const scan = await read($, machine)
    const fitted = scan?.fits ?? {}
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const lineWidth = Math.max(12, Math.min(32, e.props.bodyColumns - 22))
    const shortModel = (m: string) => m.replace(/^claude-/, '')
    const span = await read($, range)
    const g = scan?.views[span] ?? null
    const kindLabel = (k: number) => t.kinds[TOKEN_KINDS[k]!]

    const section = (title: string, aside?: string) => (
      <Box flexDirection="row" columnGap={1}>
        <Text bold>{title}</Text>
        {aside !== undefined && <Text dimColor>{aside}</Text>}
      </Box>
    )
    // Figures side by side: the value, and what it is under it.
    const stats = (items: readonly [string, string][]) =>
      Svg !== undefined ? (
        <Svg source={statsCard(items)} alt={items.map(([value, name]) => `${name} ${value}`).join(', ')} />
      ) : (
      <Box flexDirection="row" flexWrap="wrap" columnGap={4}>
        {items.map(([value, label]) => (
          <Box flexDirection="column">
            <Text bold>{value}</Text>
            <Text dimColor>{label}</Text>
          </Box>
        ))}
      </Box>
    )
    // The terminal's meter, drawn frame by frame while it glides to a new value.
    const meter = (key: string, percent: number) => {
      const move = moveTo(`t:meter:${key}`, percent, now)
      if (isOnTheWay(move, now)) animate($)
      const filled = Math.round((Math.min(100, positionOf(move, now)) / 100) * lineWidth)
      return (
        <Text>
          <Text color={levelHex(percent)}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(lineWidth - filled)}</Text>
        </Text>
      )
    }
    // Rows of names with a share bar, an amount and a share, the largest first. Given colours, the
    // rows are parts of one whole, led by a bar split by share.
    const ranked = (items: readonly { name: string; value: number; amount: string; color?: string }[], total: number) => {
      const max = Math.max(...items.map(i => i.value), 1e-9)
      if (Svg !== undefined) {
        const isParts = items.some(i => i.color !== undefined)
        const rows = items.map(i => ({ name: i.name, amount: i.amount, share: pct(i.value, total), fraction: i.value / max, color: i.color ?? null }))
        const stack = isParts ? items.map(i => ({ value: i.value, color: i.color ?? MODEL_SERIES[3] })) : null
        return <Svg source={listCard(rows, CARD_W, stack)} alt={items.map(i => `${i.name} ${i.amount} ${pct(i.value, total)}`).join(', ')} />
      }
      return (
        <Box flexDirection="column">
          {items.map(item => (
            <Box flexDirection="row" columnGap={1}>
              <Box width={24}>
                <Text wrap="truncate-end">{item.name}</Text>
              </Box>
              <Box width={10}>
                <Text color={CLAY}>{'▬'.repeat(Math.max(1, Math.round((item.value / max) * 8)))}</Text>
              </Box>
              <Box width={9}>
                <Text>{item.amount}</Text>
              </Box>
              <Text dimColor>{pct(item.value, total)}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    const tabs = (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Button key="tab-session" label={t.tabSession} variant={mode === 'session' ? 'primary' : 'secondary'} onPress={() => update($, view, () => 'session' as const)} />
        <Button key="tab-global" label={t.tabGlobal} variant={mode === 'global' ? 'primary' : 'secondary'} onPress={() => void openGlobal($)} />
      </Box>
    )

    // The limits: each one's meter, and one line on when it resets and how it is going. The most
    // trusted outlook wins: the fit where it has enough to go on, else the last 90 minutes' pace.
    // Where the window is headed by its reset, in percent, when the outlook says.
    const outlookOf = (w: Window): { text: string; projected: number | null } => {
      const fit = fitted[w.kind]
      const est = scan !== null && g !== null ? fittedWindow(w, fit, fit?.latest ?? null, scan.windows[w.kind]?.byModel, g.hourlyByModel, scan.tzOffsetMin, now) : null
      if (est !== null && fit !== undefined && fit.confidence !== 'low') {
        if (est.etaMs !== null) return { text: t.fullIn(fmtDuration(est.etaMs)), projected: 100 }
        return est.atReset !== null ? { text: t.atReset((est.atReset * 100).toFixed(0)), projected: est.atReset * 100 } : { text: '', projected: null }
      }
      const f = forecast(series[w.kind]?.points ?? [], w.percentUsed, now, w.resetsAt)
      const hoursLeft = (Date.parse(w.resetsAt ?? '') - now) / HOUR
      const projected =
        f.state === 'eta' || f.state === 'full'
          ? 100
          : f.state === 'safe' && f.ratePerHour !== null && Number.isFinite(hoursLeft)
            ? Math.min(100, w.percentUsed + f.ratePerHour * hoursLeft)
            : null
      return { text: { eta: f.etaMs !== null ? t.fullIn(fmtDuration(f.etaMs)) : '', full: t.full, flat: t.flat, safe: t.safe, unknown: '' }[f.state], projected }
    }
    const limits =
      (snap?.windows.length ?? 0) === 0 ? (
        <Text dimColor>{hasNoLimits(snap) ? t.noLimits : t.waitingLimits}</Text>
      ) : Svg !== undefined ? (
        <Svg
          source={ringsCard(
            (snap?.windows ?? []).map(w => {
              const length = windowLength(w.kind)
              const reset = Date.parse(w.resetsAt ?? '')
              const outlook = outlookOf(w)
              const fit = fitted[w.kind]
              const est = scan !== null && g !== null ? fittedWindow(w, fit, fit?.latest ?? null, scan.windows[w.kind]?.byModel, g.hourlyByModel, scan.tzOffsetMin, now) : null
              return {
                lines: est === null ? [] : [`${t.colWhole} ≈ ${roughUsd(est.capacityUsd)}`, `${t.colLeft} ≈ ${roughUsd(est.remainingUsd)}`],
                label: windowLabel(w.kind),
                percent: w.percentUsed,
                move: moveTo(`g:meter:${w.kind}`, w.percentUsed, now),
                projected: outlook.projected,
                elapsed: length === null || Number.isNaN(reset) ? null : Math.max(0, Math.min(1, 1 - (reset - now) / length)),
                reset: resetText(w.resetsAt, now),
                outlook: outlook.text,
              }
            }),
            { elapsed: t.keyElapsed, projected: t.keyProjected },
            now,
          )}
          alt={(snap?.windows ?? []).map(w => `${windowLabel(w.kind)} ${w.percentUsed}% ${[resetText(w.resetsAt, now), outlookOf(w).text].filter(Boolean).join(' · ')}`).join('; ')}
        />
      ) : (
        <Box flexDirection="column" rowGap={1}>
          {(snap?.windows ?? []).map(w => {
            const detail = [resetText(w.resetsAt, now), outlookOf(w).text].filter(Boolean).join(' · ')
            return (
              <Box flexDirection="column">
                <Box flexDirection="row" columnGap={2} alignItems="center">
                  <Box width={11}>
                    <Text>{windowLabel(w.kind)}</Text>
                  </Box>
                  {meter(w.kind, w.percentUsed)}
                  <Text bold color={w.percentUsed >= 70 ? levelHex(w.percentUsed) : undefined}>
                    {w.percentUsed}%
                  </Text>
                </Box>
                <Box marginLeft={13}>
                  <Text dimColor>{detail}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )

    const close = (
      <Box flexDirection="row">
        <Button key="close" label={t.close} role="dismiss" dimColor onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
    )

    if (mode === 'session') {
      const tokens = await read($, totals)
      const models = await read($, byModel)
      const rows = await read($, turns)
      const from = await read($, since)
      const total = sum(tokens)
      // What the session is made of, in API dollars: by count, cache reads are nearly all of it
      // and the bar says nothing. Writes are priced as the hour-long cache Claude Code keeps.
      const spent = [0, 0, 0, 0]
      for (const [m, x] of Object.entries(models)) {
        spendByKind(m, [x.input, x.output, x.cacheRead, 0, x.cacheWrite]).forEach((usd, k) => (spent[k]! += usd))
      }
      const spentTotal = spent.reduce((a, b) => a + b, 0)
      const kinds = [
        { label: t.kinds.output, value: spent[1]!, color: KIND_COLOR.output },
        { label: t.kinds.cacheWrite, value: spent[3]!, color: KIND_COLOR.cacheWrite },
        { label: t.kinds.cacheRead, value: spent[2]!, color: KIND_COLOR.cacheRead },
        { label: t.kinds.input, value: spent[0]!, color: KIND_COLOR.input },
      ]
      const recent = rows.slice(-24)
      const peak = recent.reduce<TurnRow | null>((a, r) => (a === null || sum(r.tokens) > sum(a.tokens) ? r : a), null)
      const modelRows = Object.entries(models)
        .map(([m, x]) => ({ name: shortModel(m), value: sum(x), amount: fmtTokens(sum(x)) }))
        .sort((a, b) => b.value - a.value)

      const figures = stats([
        [snap?.costUsd !== undefined ? fmtUsd(snap.costUsd) : '–', t.statCost],
        [fmtTokens(total), t.statTokens],
        [snap?.contextPercent !== undefined ? `${snap.contextPercent}%` : '–', t.statContext(fmtTokens(snap?.contextWindow ?? 0))],
        [String(rows.length), t.statTurns],
      ])
      const composition = (
          <Box flexDirection="column">
            {section(t.composition, t.byCost)}
            {Svg !== undefined ? (
              ranked(
                kinds.map(k => ({ name: k.label, value: k.value, amount: fmtUsd(k.value), color: k.color })),
                spentTotal,
              )
            ) : (
              <Box flexDirection="column">
              <Text>
                {kinds.map(k => (
                  <Text color={k.color}>{'█'.repeat(spentTotal > 0 ? Math.round((k.value / spentTotal) * lineWidth) : 0)}</Text>
                ))}
              </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {kinds.map(k => (
                <Text>
                  <Text color={k.color}>●</Text>
                  <Text dimColor>
                    {' '}
                    {k.label} {pct(k.value, spentTotal)}
                  </Text>
                </Text>
              ))}
            </Box>
              </Box>
            )}
          </Box>
      )
      const perTurn = (
          <Box flexDirection="column">
            {section(t.perTurn, recent.length > 0 && peak !== null ? t.perTurnAside(recent.length, peak.n, fmtTokens(sum(peak.tokens))) : undefined)}
            {recent.length === 0 ? (
              <Text dimColor>{t.noTurns}</Text>
            ) : Svg !== undefined ? (
              <Svg
                source={columnsCard(
                  recent.map((r, i) => ({
                    id: String(r.n),
                    label: `#${r.n}`,
                    parts: [{ value: sum(r.tokens), color: i === recent.length - 1 ? CLAY : CLAY_SOFT }],
                  })),
                  { format: fmtTokens, key: isMotion ? 'g:turns' : null, now },
                )}
                alt={recent.map(r => t.turnTitle(r.n, fmtTokens(sum(r.tokens)), fmtTokens(r.tokens.output), fmtTokens(r.tokens.cacheWrite), fmtTokens(r.tokens.cacheRead), r.subagentTurns)).join('; ')}
              />
            ) : (
              <Text color={CLAY}>{sparkText(recent.map(r => sum(r.tokens)))}</Text>
            )}
          </Box>
      )
      const modelsBlock = modelRows.length > 1 && (
            <Box flexDirection="column">
              {section(t.models)}
              {ranked(modelRows, total)}
            </Box>
      )
      const note = <Text dimColor>{t.sessionNote(fmtDuration(now - from))}</Text>

      // The drawing surfaces lead with the limits, the session's figures and its turns, roomily;
      // what the session is made of and by which models open on asking.
      if (Svg !== undefined) {
        const isOpen = await read($, details)
        return (
          <Box flexDirection="column" rowGap={2}>
            {tabs}
            {limits}
            {figures}
            {perTurn}
            <Box flexDirection="column" rowGap={2}>
              <Button key="details" label={isOpen ? t.showLess : t.showMore} plain dimColor onPress={() => update($, details, open => !open)} />
              {isOpen && composition}
              {isOpen && modelsBlock}
              {isOpen && note}
            </Box>
            {close}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" rowGap={1}>
          {tabs}
          {limits}
          {figures}
          {composition}
          {perTurn}
          {modelsBlock}
          {note}
          {close}
        </Box>
      )
    }

    // The global view.
    const status = await read($, scanStatus)
    const isOpen = await read($, details)
    // A scan in flight turns a spinner after the status, the line's end, so nothing else moves.
    const spinner = isScanning && e.surface === 'terminal' ? ` ${spinnerAt(now)}` : ''
    if (spinner !== '') animate($)
    const statusText =
      status.state === 'scanning'
        ? t.scanning
        : status.state === 'error'
          ? status.message === NODE_MISSING
            ? t.nodeMissing
            : t.scanFailed(status.message ?? '')
          : scan
            ? t.files(scan.files, ago(now - scan.at))
            : ''
    const controls = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Button key="range-30d" label={t.range30} variant={span === '30d' ? 'primary' : 'secondary'} onPress={() => update($, range, () => '30d' as const)} />
        <Button key="range-all" label={t.rangeAll} variant={span === 'all' ? 'primary' : 'secondary'} onPress={() => update($, range, () => 'all' as const)} />
        <Button key="rescan" label={t.refresh} dimColor onPress={() => void scanAll($, true)} />
        {status.state === 'error' ? <Text color={RED}>{statusText}</Text> : <Text dimColor>{`${statusText}${spinner}`}</Text>}
      </Box>
    )
    if (scan === null || g === null) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {tabs}
          {limits}
          {controls}
          <Text dimColor>{`${t.firstScan}${spinner}`}</Text>
          {close}
        </Box>
      )
    }

    const top = g.byModel.slice(0, 3).map(m => m.model)
    const Form = e.surface === 'mobile' ? null : $.ui.resolve(e)
    const picks = await read($, planChoices)
    const pickNow = planAt(picks, now)
    const day = (ms: number) => new Date(ms + scan.tzOffsetMin * MINUTE).toISOString().slice(0, 10)
    const detailView = (
      <Box flexDirection="column" rowGap={1}>
        {Object.values(fitted).map(f => {
          const band = (i: number) => {
            const [lo, hi] = f.gBand[i] ?? [0, Infinity]
            return Number.isFinite(hi) && hi / Math.max(lo, 1e-9) < 50 ? `${lo.toFixed(2)}–${hi.toFixed(2)}` : t.undetermined
          }
          const kindsLine = f.g[1]! > 0 ? [2, 3, 0].map(i => `${kindLabel(i)} ×${(f.g[i]! / f.g[1]!).toFixed(2)} (${band(i)})`).join(' · ') : ''
          const others = Object.entries(f.f).filter(([m]) => m !== f.ref)
          const multiples = Object.entries(f.planWindows).filter(([p]) => p !== f.refPlan && !p.startsWith('~'))
          return (
            <Box flexDirection="column">
              <Text>
                {windowLabel(f.kind)}
                <Text dimColor>
                  {' '}
                  {t.fitHead(t.confidence[f.confidence], f.segments, f.hits)}
                  {f.mae !== null ? t.fitMiss(f.mae.toFixed(1)) : ''}
                  {f.outliers > 0 ? t.fitOutliers(f.outliers) : ''}
                  {f.unseen ? t.fitUnseen(f.unseen) : ''}
                  {f.lent ? t.fitLent(windowLabel(f.lent)) : ''}
                </Text>
              </Text>
              {kindsLine !== '' && (
                <Text dimColor>
                  {t.kindWeights}
                  {kindsLine}
                </Text>
              )}
              {others.length > 0 && (
                <Text dimColor>
                  {t.against(shortModel(f.ref ?? ''))}
                  {others.map(([m, x]) => `${shortModel(m)} ×${x.toFixed(2)}`).join(' · ')}
                </Text>
              )}
              {multiples.length > 0 && (
                <Text dimColor>
                  {t.against(planLabel(f.refPlan))}
                  {multiples.map(([p, n]) => `${planLabel(p)} ×${(f.s[p] ?? 0).toFixed(1)}${t.multipleNote(nominalRatio(p, f.refPlan), n)}`).join(' · ')}
                </Text>
              )}
              {f.inferred.map(x => (
                <Text dimColor>
                  {t.inferredLine(day(x.from), day(x.to), x.ratio.toFixed(2), planLabel(x.against), x.guess === null ? null : planLabel(x.guess), x.windows)}
                </Text>
              ))}
            </Box>
          )
        })}
        <Text dimColor>
          {t.dataNote}
          {g.unpriced.length > 0 ? t.unpriced(g.unpriced.join(', ')) : ''}
        </Text>
      </Box>
    )

    // What each window holds and has left in API dollars, how it goes at the usual pace, and the
    // limit hits under the plan in force now as a check that needs no fit.
    const capacityRows = (snap?.windows ?? []).map(w => {
      const fit = fitted[w.kind]
      const est = fittedWindow(w, fit, fit?.latest ?? null, scan.windows[w.kind]?.byModel, g.hourlyByModel, scan.tzOffsetMin, now)
      const outlook =
        est === null ? '' : w.percentUsed >= 100 ? t.full : est.etaMs !== null ? t.fullIn(fmtDuration(est.etaMs)) : est.atReset !== null ? t.atReset((est.atReset * 100).toFixed(0)) : ''
      return { w, fit, est, outlook }
    })
    const hits = Object.entries(scan.hits).map(([kind, costs]) => t.hitsLine(windowLabel(kind), costs.length, roughUsd(Math.min(...costs)), roughUsd(Math.max(...costs))))
    // The table is laid out by columns, each heading over its own values: a row of fixed-width cells
    // drifts out of line on the desktop, where each row's cells are sized by their own text.
    const column = (heading: string, values: unknown[]) => (
      <Box flexDirection="column">
        <Text dimColor>{heading === '' ? ' ' : heading}</Text>
        {values as never}
      </Box>
    )
    const picker =
      Form === null ? null : (
        <Form.Select
          key="plan"
          label={t.planPick}
          value={pickNow ?? UNKNOWN}
          options={[UNKNOWN, ...PLAN_CHOICES].map(value => ({ value, label: value === UNKNOWN ? t.planUnknown : planLabel(value) }))}
          onSelect={value => void pickPlan($, value)}
        />
      )
    // The terminal's estimates: a table under the plan picker.
    const capacity =
      capacityRows.length === 0 ? null : (
        <Box flexDirection="column">
          {section(t.capacity, t.capacityAside(pickNow === null ? t.planUnknown : planLabel(pickNow)))}
          {picker}
          {pickNow === null && <Text dimColor>{t.planHint}</Text>}
          {capacityRows.every(r => r.est === null) ? (
            <Text dimColor>{t.capacityNone}</Text>
          ) : (
            <Box flexDirection="row" columnGap={3}>
              {column('', capacityRows.map(({ w }) => <Text>{windowLabel(w.kind)}</Text>))}
              {column(t.colWhole, capacityRows.map(({ est }) => <Text bold>{est !== null ? `≈ ${roughUsd(est.capacityUsd)}` : '–'}</Text>))}
              {column(
                t.colLeft,
                capacityRows.map(({ w, est }) => <Text color={est !== null && w.percentUsed >= 70 ? levelHex(w.percentUsed) : undefined}>{est !== null ? `≈ ${roughUsd(est.remainingUsd)}` : '–'}</Text>),
              )}
              {column(t.colOutlook, capacityRows.map(({ outlook }) => <Text>{outlook || '–'}</Text>))}
              {column(t.colConfidence, capacityRows.map(({ fit }) => <Text dimColor>{t.confidence[fit?.confidence ?? 'none']}</Text>))}
            </Box>
          )}
          {hits.map(line => (
            <Text dimColor>{line}</Text>
          ))}
        </Box>
      )

    const daily = (
        <Box flexDirection="column">
          {section(t.daily, Svg === undefined && g.daily.length > 0 ? t.peak(fmtUsd(Math.max(...g.daily.map(d => Object.values(d.byModel).reduce((a, b) => a + b, 0))))) : undefined)}
          {g.daily.length === 0 ? (
            <Text dimColor>{t.noUsage}</Text>
          ) : Svg !== undefined ? (
            <Svg
              source={columnsCard(
                g.daily.map(d => {
                  const parts = top.map(m => d.byModel[m] ?? 0)
                  const rest = Math.max(0, Object.values(d.byModel).reduce((a, b) => a + b, 0) - parts.reduce((a, b) => a + b, 0))
                  return { id: d.day, label: d.day.slice(5), parts: [...parts, rest].map((value, k) => ({ value, color: MODEL_SERIES[Math.min(k, 3)]! })) }
                }),
                {
                  format: v => (v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `$${Number(v.toPrecision(3))}`),
                  legend: [...top.map(shortModel), t.other].map((name, k) => ({ name, color: MODEL_SERIES[Math.min(k, 3)]! })),
                  key: isMotion ? `g:daily:${span}` : null,
                  now,
                },
              )}
              alt={g.daily.map(d => `${d.day} ${fmtUsd(Object.values(d.byModel).reduce((a, b) => a + b, 0))}`).join(', ')}
            />
          ) : (
            <Box flexDirection="column">
              <Text color={CLAY}>{sparkText(g.daily.slice(-lineWidth * 2).map(d => Object.values(d.byModel).reduce((a, b) => a + b, 0)))}</Text>
              <Text dimColor>
                {g.daily[Math.max(0, g.daily.length - lineWidth * 2)]!.day.slice(5)} → {g.daily[g.daily.length - 1]!.day.slice(5)}
              </Text>
            </Box>
          )}
        </Box>
    )
    const modelsBlock = (
        <Box flexDirection="column">
          {section(t.models)}
          {ranked(
            g.byModel.slice(0, 4).map((x, i) => ({
              name: shortModel(x.model),
              value: x.cost,
              amount: fmtUsd(x.cost),
              color: Svg !== undefined ? MODEL_SERIES[Math.min(i, 3)] : undefined,
            })),
            g.totalCost,
          )}
        </Box>
    )
    const projectsBlock = (
        <Box flexDirection="column">
          {section(t.projects)}
          {ranked(
            g.byProject.slice(0, 5).map(x => ({ name: x.project, value: x.cost, amount: fmtUsd(x.cost) })),
            g.totalCost,
          )}
        </Box>
    )

    // The drawing surfaces lead with the limits as rings, what each holds, the plan they are told
    // against, and the days; the models, projects and the fit open on asking, all with room around.
    if (Svg !== undefined) {
      const heading = (text: string) => text.replace(/[:：]\s*$/, '')
      const capacityCards = capacityRows.length === 0 ? null : (
        <Box flexDirection="column" rowGap={1}>
          {section(t.capacity, t.capacityAside(pickNow === null ? t.planUnknown : planLabel(pickNow)))}
          {pickNow === null && <Text dimColor>{t.planHint}</Text>}
          {capacityRows.every(r => r.est === null) ? (
            <Text dimColor>{t.capacityNone}</Text>
          ) : (
            <Svg
              source={capacityCard(
                capacityRows.flatMap(({ w, fit, est, outlook }) => {
                  if (est === null) return []
                  const costs = scan.hits[w.kind] ?? []
                  return [
                    {
                      label: windowLabel(w.kind),
                      percent: w.percentUsed,
                      whole: `${t.colWhole} ≈ ${roughUsd(est.capacityUsd)}`,
                      left: `${t.colLeft} ≈ ${roughUsd(est.remainingUsd)}`,
                      outlook,
                      confidence: fit?.confidence ?? 'none',
                      confidenceWord: `${t.colConfidence} ${t.confidence[fit?.confidence ?? 'none']}`,
                      hits: costs,
                      hitsLine: costs.length === 0 ? '' : t.hitsLine(windowLabel(w.kind), costs.length, roughUsd(Math.min(...costs)), roughUsd(Math.max(...costs))),
                    },
                  ]
                }),
              )}
              alt={[
                ...capacityRows.map(({ w, fit, est, outlook }) =>
                  [windowLabel(w.kind), est !== null ? `${t.colWhole} ≈ ${roughUsd(est.capacityUsd)}` : '', est !== null ? `${t.colLeft} ≈ ${roughUsd(est.remainingUsd)}` : '', outlook, `${t.colConfidence} ${t.confidence[fit?.confidence ?? 'none']}`]
                    .filter(Boolean)
                    .join(' · '),
                ),
                ...hits,
              ].join('; ')}
            />
          )}
        </Box>
      )
      // Each fit drawn as an interval plot, the plan multiples and inferred plans as the sentences
      // they are, and where the figures come from.
      const fitCards = (
        <Box flexDirection="column" rowGap={2}>
          {Object.values(fitted)
            .filter(f => f.confidence !== 'none' && f.g[1]! > 0)
            .map(f => {
              const kinds = [2, 3, 0].map(i => {
                const [lo, hi] = f.gBand[i] ?? [0, Infinity]
                const band: [number, number] | null = Number.isFinite(hi) && hi / Math.max(lo, 1e-9) < 50 ? [lo, hi] : null
                return { name: kindLabel(i), value: f.g[i]! / f.g[1]!, band }
              })
              const order = g.byModel.map(m => m.model)
              const models = Object.entries(f.f)
                .filter(([m]) => m !== f.ref)
                .map(([m, value]) => ({ name: shortModel(m), value, color: MODEL_SERIES[Math.min(Math.max(order.indexOf(m), 0), 3)]! }))
              const multiples = Object.entries(f.planWindows).filter(([p]) => p !== f.refPlan && !p.startsWith('~'))
              const head = `${t.fitCounts(f.segments, f.hits)}${f.mae !== null ? t.fitMiss(f.mae.toFixed(1)) : ''}${f.outliers > 0 ? t.fitOutliers(f.outliers) : ''}${f.unseen ? t.fitUnseen(f.unseen) : ''}${f.lent ? t.fitLent(windowLabel(f.lent)) : ''}`
              return (
                <Box flexDirection="column" rowGap={1}>
                  <Svg
                    source={fitCard({
                      label: windowLabel(f.kind),
                      confidence: f.confidence,
                      confidenceWord: `${t.colConfidence} ${t.confidence[f.confidence]}`,
                      head,
                      kindsTitle: heading(t.kindWeights),
                      kinds,
                      reference: kindLabel(1),
                      modelsTitle: f.ref === null ? null : heading(t.against(shortModel(f.ref))),
                      models,
                      unclear: t.undetermined,
                    })}
                    alt={`${windowLabel(f.kind)} · ${t.colConfidence} ${t.confidence[f.confidence]} · ${head} · ${kinds.map(k => `${k.name} ×${k.value.toFixed(2)}${k.band === null ? ` ${t.undetermined}` : ` (${k.band[0].toFixed(2)}–${k.band[1].toFixed(2)})`}`).join(' · ')}`}
                  />
                  {multiples.length > 0 && (
                    <Text dimColor>
                      {t.against(planLabel(f.refPlan))}
                      {multiples.map(([p, n]) => `${planLabel(p)} ×${(f.s[p] ?? 0).toFixed(1)}${t.multipleNote(nominalRatio(p, f.refPlan), n)}`).join(' · ')}
                    </Text>
                  )}
                  {f.inferred.map(x => (
                    <Text dimColor>
                      {t.inferredLine(day(x.from), day(x.to), x.ratio.toFixed(2), planLabel(x.against), x.guess === null ? null : planLabel(x.guess), x.windows)}
                    </Text>
                  ))}
                </Box>
              )
            })}
          <Text dimColor>
            {t.dataNote}
            {g.unpriced.length > 0 ? t.unpriced(g.unpriced.join(', ')) : ''}
          </Text>
        </Box>
      )
      return (
        <Box flexDirection="column" rowGap={2}>
          {tabs}
          {limits}
          {picker !== null && capacityRows.length > 0 && (
            <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
              {picker}
              <Text dimColor>{t.capacityAside(pickNow === null ? t.planUnknown : planLabel(pickNow))}</Text>
            </Box>
          )}
          <Box flexDirection="column" rowGap={1}>
            {controls}
            {stats([
              [fmtUsd(g.totalCost), span === '30d' ? t.statRange30 : t.statRangeAll],
              [fmtUsd(g.days > 0 ? g.totalCost / g.days : 0), t.statPerDay],
            ])}
          </Box>
          {daily}
          <Box flexDirection="column" rowGap={2}>
            <Button key="details" label={isOpen ? t.showLess : t.showMore} plain dimColor onPress={() => update($, details, open => !open)} />
            {isOpen && modelsBlock}
            {isOpen && projectsBlock}
            {isOpen && capacityCards}
            {isOpen && fitCards}
          </Box>
          {close}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" rowGap={1}>
        {tabs}
        {limits}
        {capacity}
        <Box flexDirection="column">
          {section(t.history)}
          {controls}
        </Box>
        {stats([
          [fmtUsd(g.totalCost), span === '30d' ? t.statRange30 : t.statRangeAll],
          [fmtUsd(g.days > 0 ? g.totalCost / g.days : 0), t.statPerDay],
          [fmtTokens(g.totalTokens), t.statTokens],
          [t.days(g.days), t.statSpan],
        ])}
        {daily}
        {modelsBlock}
        {projectsBlock}
        <Box flexDirection="column" rowGap={1}>
          <Button key="details" label={isOpen ? t.hideDetails : t.details} plain dimColor onPress={() => update($, details, open => !open)} />
          {isOpen && detailView}
        </Box>
        {close}
      </Box>
    )
  })
}
