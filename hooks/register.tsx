import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Fit, GlobalScan, Observation, PlanEntry, Reading, Samples, ScanStatus, Snapshot, Tokens, TurnRow, Vec, Window } from '../types'

import { MESSAGES, localeOf } from './i18n'
import type { Locale, Messages } from './i18n'

const PANE = 'cc-meter'
// The plan of every reading when no timeline says otherwise.
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

const since = atom({ plugin: 'cc-meter', key: 'since' } as const, 0)
const totals = atom({ plugin: 'cc-meter', key: 'totals' } as const, ZERO)
const byModel = atom({ plugin: 'cc-meter', key: 'byModel' } as const, {} as Record<string, Tokens>)
const turns = atom({ plugin: 'cc-meter', key: 'turns' } as const, [] as TurnRow[])
const snapshot = atom({ plugin: 'cc-meter', key: 'snapshot' } as const, null as Snapshot | null)
const samples = atom({ plugin: 'cc-meter', key: 'samples' } as const, {} as Record<string, Samples>)
const isBandHidden = atom({ plugin: 'cc-meter', key: 'isBandHidden' } as const, false)
const view = atom({ plugin: 'cc-meter', key: 'view' } as const, 'session' as 'session' | 'global')
const range = atom({ plugin: 'cc-meter', key: 'range' } as const, '30d' as '30d' | 'all')
const global = atom({ plugin: 'cc-meter', key: 'global' } as const, null as GlobalScan | null)
const scanStatus = atom({ plugin: 'cc-meter', key: 'scanStatus' } as const, { state: 'idle' } as ScanStatus)
const fits = atom({ plugin: 'cc-meter', key: 'fits' } as const, {} as Record<string, Fit>)
const draftPlan = atom({ plugin: 'cc-meter', key: 'draftPlan' } as const, 'pro')
const details = atom({ plugin: 'cc-meter', key: 'details' } as const, false)

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
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

function windowLabel(kind: string): string {
  return t.windows[kind] ?? kind.replace(/_/g, ' ')
}

function planLabel(plan: string): string {
  return t.plans[plan] ?? plan.replace(/^default_claude_/, '').replace(/_/g, ' ')
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
// Prices from <config>/cc-meter/prices.json, over the built-in ones: for another provider's
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

export type GlobalView = {
  days: number
  totalCost: number
  totalTokens: number
  daily: { day: string; byModel: Record<string, number> }[]
  byProject: { project: string; cost: number; tokens: number }[]
  byModel: { model: string; cost: number; tokens: number }[]
  hourly: number[]
  // Per model, per local hour of the day, the average API spend by kind of token.
  hourlyByModel: Record<string, number[][]>
  unpriced: string[]
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
// The plans a timeline entry may name in the pane.
const PLAN_CHOICES = ['pro', 'max5x', 'max20x', 'team', 'team_premium', 'enterprise'] as const
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
    for (const h of list.filter(o => o.hit)) out.push({ window, plan: h.plan ?? CURRENT, dy: 1, c: kindsOf(h.byModel), hit: true })
    let anchor = { y: 0, c: {} as Record<string, number[]> }
    for (const o of list.filter(o => !o.hit).sort((a, b) => a.t - b.t)) {
      if (o.y - anchor.y < 0.05) continue
      const c = kindsOf(o.byModel)
      out.push({ window, plan: o.plan ?? CURRENT, dy: o.y - anchor.y, c: minus(c, anchor.c), hit: false })
      anchor = { y: o.y, c }
    }
  }
  return out.filter(s => Object.values(s.c).some(c => c.some(x => x > 0)))
}

// Fits one window kind on its pieces: rise × s[plan] ≈ Σ f[model] × Σ g[kind] × spend[model][kind].
// g (one per kind of token, shared by every model) is the share of a Pro window one API dollar of
// that kind of the reference model takes, on the reference plan (the one with the most windows);
// f scales another model against the reference model (1); s is another plan's window against the
// reference plan's (1). All are fitted in logs, together (Levenberg–Marquardt). A
// piece's miss is told against what it can be off by: the limit reports whole percents, so each
// end of a piece may be half a point off (ROUNDING), and use the transcripts do not see adds a
// share of the rise (SPREAD). Each parameter starts where API prices and sold multiples put it
// (the kinds' g equal, f at 1, s at the sold ratio where both plans have one, else at 1), that
// start weighing as much as half a piece (PRIOR_WINDOWS, or WEAK_PRIOR with no sold ratio), so the
// pieces move it as far as they agree to. A piece still off by more
// than 2.5 of its own spreads once the rest have settled (another device at work, most likely) is
// weighed down (Huber).
export function fitKind(kind: string, all: readonly Observation[]): Fit {
  const none: Fit = { kind, windows: 0, segments: 0, hits: 0, f: {}, g: [0, 0, 0, 0], gBand: [], s: {}, refPlan: CURRENT, planWindows: {}, mae: null, outliers: 0, confidence: 'none', ref: null }
  const segs = segmentsOf(kind, all)
  if (segs.length === 0) return none

  const spend = new Map<string, number>()
  for (const sg of segs) for (const [m, c] of Object.entries(sg.c)) spend.set(m, (spend.get(m) ?? 0) + c.reduce((a, b) => a + b, 0))
  const models = [...spend].sort((a, b) => b[1] - a[1]).map(([m]) => m)
  const ref = models[0]!
  const others = models.slice(1)
  const planWindows: Record<string, number> = {}
  for (const p of new Set(segs.map(sg => sg.plan))) planWindows[p] = new Set(segs.filter(sg => sg.plan === p).map(sg => sg.window)).size
  const refPlan = Object.entries(planWindows).sort((a, b) => b[1] - a[1] || (a[0] === 'pro' ? -1 : 1))[0]![0]
  const plans = Object.keys(planWindows).filter(p => p !== refPlan)
  const startScale = (pl: string) => (pl === refPlan ? 1 : (nominalRatio(pl, refPlan) ?? 1))
  const priorWeight = (pl: string) => (nominalRatio(pl, refPlan) === null ? WEAK_PRIOR : PRIOR_WINDOWS)

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
  const base = segs.map(sg => (sg.hit ? 2 : 1))
  let robust = segs.map(() => 1)
  const ROUNDING = 0.006
  const SPREAD = 0.1

  // Residuals and their Jacobian: one row per piece (relative miss), then the start's pulls.
  const system = (q: number[]) => {
    const { g, f, s } = unpack(q)
    const rows: { r: number; j: number[]; w: number }[] = []
    segs.forEach((sg, i) => {
      const target = sg.dy * s[sg.plan]!
      const perKind = [0, 1, 2, 3].map(k => models.reduce((acc, m) => acc + f[m]! * (sg.c[m]?.[k] ?? 0), 0))
      const pred = perKind.reduce((acc, x, k) => acc + g[k]! * x, 0)
      // What this piece can be off by, in shares of a window scaled by the plan's multiple.
      const d = Math.hypot(ROUNDING * s[sg.plan]!, SPREAD * target)
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
      rows.push({ r: q[k]! - meanG, j, w: PRIOR_WINDOWS })
    }
    for (let i = 0; i < nF; i += 1) {
      const j = new Array<number>(n).fill(0)
      j[nG + i] = 1
      rows.push({ r: q[nG + i]!, j, w: PRIOR_WINDOWS })
    }
    plans.forEach((pl, i) => {
      const j = new Array<number>(n).fill(0)
      j[nG + nF + i] = 1
      rows.push({ r: q[nG + nF + i]! - Math.log(startScale(pl)), j, w: priorWeight(pl) })
    })
    return rows
  }
  const cost = (q: number[]) => system(q).reduce((acc, row) => acc + row.w * row.r * row.r, 0)

  let mu = 1e-3
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
    const before = cost(p)
    if (cost(next) < before) {
      p = next
      mu = Math.max(1e-9, mu / 3)
      if (Math.max(...step.map(Math.abs)) < 1e-7) break
    } else {
      mu *= 4
      if (mu > 1e9) break
    }
    // Weigh down the pieces the rest cannot explain, once the fit has had some rounds.
    if (iter === 30 || iter === 60 || iter === 90) {
      robust = system(p)
        .slice(0, segs.length)
        .map(row => (Math.abs(row.r) <= 2.5 ? 1 : 2.5 / Math.abs(row.r)))
      mu = 1e-3
    }
  }

  const { g, f, s } = unpack(p)

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
    mae,
    outliers: robust.filter(r => r < 1).length,
    confidence,
    ref,
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
    hours.forEach((kinds, h) => {
      perHour[h]! += ((fit.f[m] ?? 1) * kinds.reduce((acc, x, k) => acc + fit.g[k]! * x, 0)) / s
      usdHour[h]! += kinds.reduce((a, b) => a + b, 0)
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

// A credentials tier as a plan of the timeline.
export function tierPlan(account: GlobalScan['account']): string | null {
  const tier = (account?.rateLimitTier ?? '').toLowerCase()
  const kind = (account?.subscriptionType ?? '').toLowerCase()
  if (tier.includes('max_20x')) return 'max20x'
  if (tier.includes('max_5x')) return 'max5x'
  if (tier.includes('enterprise') || kind === 'enterprise') return 'enterprise'
  if (tier.includes('team')) return tier.includes('premium') ? 'team_premium' : 'team'
  if (kind === 'team') return 'team'
  if (kind === 'pro' || tier.includes('pro')) return 'pro'
  // A tier this table does not know is a plan of its own, by its own name.
  return tier !== '' ? tier : kind !== '' ? kind : null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type PlanFile = { plans: PlanEntry[]; detected: string | null }

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
  const run = await $.process
    .run([nodeBin, `${$.plugin.root}/scan/scan.mjs`, 'session', path], { timeoutMs: 60_000 })
    .catch(() => null)
  if (run === null || run.exitCode !== 0) {
    $.ui.log(`cc-meter: could not read ${path}: ${run?.stderr.split('\n')[0] ?? 'node did not run'}`, { to: 'debug' })
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
    setPriceOverrides(JSON.parse(await $.fs.read(`${await configDir($)}/cc-meter/prices.json`)) as Record<string, unknown>)
  } catch {
    setPriceOverrides({})
  }
}

async function scanAll($: EngineInterface): Promise<void> {
  if ((await read($, scanStatus)).state === 'scanning') return
  await update($, scanStatus, () => ({ state: 'scanning' as const }))
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
    const readings = ((await $.store.get('readings')) ?? []) as Reading[]
    const run = await $.process.run([nodeBin, `${$.plugin.root}/scan/scan.mjs`, 'global', `${config}/projects`, `${config}/cc-meter/cache.json`], {
      timeoutMs: 300_000,
      stdin: JSON.stringify({ windows, readings }),
    })
    if (run.exitCode !== 0) throw new Error(run.stderr.split('\n')[0] || `scanner exited ${run.exitCode}`)
    const scan = JSON.parse(run.stdout) as GlobalScan
    const kinds = new Set([...scan.observations.map(o => o.kind), ...(snap?.windows ?? []).map(w => w.kind)])
    await update($, fits, () => Object.fromEntries([...kinds].map(k => [k, fitKind(k, scan.observations)])))
    await update($, global, () => scan)
    await update($, scanStatus, () => ({ state: 'idle' as const }))
    // A plan change the credentials show re-tags what follows it: scan again for it.
    if (await notePlanChange($, scan)) $.clock.after(0, () => void scanAll($))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A Node.js that cannot be started is said plainly; the pane words it.
    const isNodeMissing = /ENOENT|not found|cannot find|no such file|spawn/i.test(message)
    await update($, scanStatus, () => ({ state: 'error' as const, message: isNodeMissing ? NODE_MISSING : message }))
  }
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
}

// The plan timeline file, which the scanner reads to tag each observation with its plan.
async function planFilePath($: EngineInterface): Promise<string> {
  return `${await configDir($)}/cc-meter/plans.json`
}

async function readPlanFile($: EngineInterface): Promise<PlanFile> {
  try {
    const file = JSON.parse(await $.fs.read(await planFilePath($))) as Partial<PlanFile>
    return { plans: Array.isArray(file.plans) ? file.plans : [], detected: file.detected ?? null }
  } catch {
    return { plans: [], detected: null }
  }
}

async function writePlanFile($: EngineInterface, file: PlanFile): Promise<void> {
  const plans = [...file.plans].sort((a, b) => a.from.localeCompare(b.from)).map(({ fromMs, ...rest }) => rest)
  await $.fs.write(await planFilePath($), `${JSON.stringify({ ...file, plans }, null, 2)}\n`)
}

// Adds a plan change from the pane, then rescans so observations carry the new tags.
async function addPlan($: EngineInterface, date: string, plan: string): Promise<void> {
  const day = date.trim()
  if (!DATE_RE.test(day) || Number.isNaN(Date.parse(day))) {
    $.ui.toast(t.badDate)
    return
  }
  const file = await readPlanFile($)
  file.plans = [...file.plans.filter(p => p.from !== day), { from: day, plan, source: 'manual' }]
  await writePlanFile($, file)
  await scanAll($)
}

async function removePlan($: EngineInterface, from: string): Promise<void> {
  const file = await readPlanFile($)
  file.plans = file.plans.filter(p => p.from !== from)
  await writePlanFile($, file)
  await scanAll($)
}

// Records a plan change the credentials show: only a tier that differs from the last one seen
// (the first one seen is the baseline, stale or not) and from the plan the timeline has now.
// Answers whether the timeline changed.
async function notePlanChange($: EngineInterface, scan: GlobalScan): Promise<boolean> {
  const tier = scan.account?.rateLimitTier ?? null
  if (tier === null) return false
  const file = await readPlanFile($)
  if (tier === file.detected) return false
  const plan = tierPlan(scan.account)
  const before = file.detected === null ? null : tierPlan({ subscriptionType: null, rateLimitTier: file.detected })
  const isChange = file.detected !== null && plan !== null && plan !== (scan.planNow ?? before)
  if (isChange) {
    // An empty timeline learns what came before the change, so earlier readings keep their plan.
    const baseline: PlanEntry[] = file.plans.length === 0 && before !== null ? [{ from: '2000-01-01', plan: before, source: 'auto', note: `rateLimitTier=${file.detected}` }] : []
    file.plans = [...baseline, ...file.plans.filter(p => p.from !== scan.today), { from: scan.today, plan, source: 'auto', note: `rateLimitTier=${tier}` }]
    $.ui.toast(t.planDetected(planLabel(plan)))
  }
  await writePlanFile($, { ...file, detected: tier })
  return isChange
}

function ago(ms: number): string {
  return ms < MINUTE ? t.updatedNow : t.updatedAgo(fmtDuration(ms))
}

// ---- Drawing --------------------------------------------------------------

// Claude's clay is the one accent; warm neutrals carry everything else. Amber and red appear only
// when a limit runs high.
const CLAY = '#D97757'
const CLAY_SOFT = '#E9A88C'
const SAND = '#D6CCBE'
const STONE = '#A39E93'
const AMBER = '#D99A3A'
const RED = '#C9533E'
const SERIES = [CLAY, '#B98A6E', STONE, SAND] as const

function levelHex(percent: number): string {
  return percent >= 90 ? RED : percent >= 70 ? AMBER : CLAY
}

// A thin rounded meter.
function meterSvg(percent: number, width = 240): string {
  const w = Math.max(0, Math.min(1, percent / 100)) * width
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">` +
    `<rect width="${width}" height="6" rx="3" fill="${STONE}" fill-opacity="0.22"/>` +
    (w > 0 ? `<rect width="${Math.max(6, w).toFixed(1)}" height="6" rx="3" fill="${levelHex(percent)}"/>` : '') +
    `</svg>`
  )
}

// A short share bar for a ranked row, sized in pixels so it never runs into the figures beside it.
function shareSvg(fraction: number, width = 64): string {
  const w = Math.max(0, Math.min(1, fraction)) * width
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">` +
    `<rect width="${Math.max(3, w).toFixed(1)}" height="6" rx="3" fill="${CLAY}"/></svg>`
  )
}

// One rounded bar split into parts, for what a total is made of.
function stackSvg(parts: readonly { value: number; color: string; label: string }[], width = 240): string {
  const total = parts.reduce((a, p) => a + p.value, 0)
  let x = 0
  const rects = parts
    .filter(p => p.value > 0)
    .map(p => {
      const w = total > 0 ? (p.value / total) * width : 0
      const r = `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="8" fill="${p.color}"><title>${escapeXml(`${p.label} ${((p.value / total) * 100).toFixed(1)}%`)}</title></rect>`
      x += w
      return r
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8">` +
    `<clipPath id="r"><rect width="${width}" height="8" rx="4"/></clipPath><g clip-path="url(#r)">` +
    `<rect width="${width}" height="8" fill="${STONE}" fill-opacity="0.22"/>${rects}</g></svg>`
  )
}

// Small bars over time, each with its own hover text; the last one stands out.
function sparkSvg(items: readonly { value: number; title: string; label?: string }[], width = 240, height = 36): string {
  const n = items.length
  const gap = n > 40 ? 1 : 2
  const barWidth = Math.max(2, (width - gap * (n - 1)) / Math.max(n, 1))
  const max = Math.max(...items.map(i => i.value), 1e-9)
  const labelled = items.some(i => i.label)
  const chart = labelled ? height - 12 : height
  const bars = items
    .map((item, i) => {
      const h = Math.max(item.value > 0 ? 1.5 : 0, (item.value / max) * chart)
      const x = i * (barWidth + gap)
      const fill = i === n - 1 ? CLAY : CLAY_SOFT
      const label = item.label ? `<text x="${x.toFixed(1)}" y="${height - 1}" font-size="9" fill="${STONE}">${escapeXml(item.label)}</text>` : ''
      return (
        `<g><title>${escapeXml(item.title)}</title>` +
        `<rect x="${x.toFixed(1)}" y="0" width="${barWidth.toFixed(1)}" height="${chart}" fill="transparent"/>` +
        `<rect x="${x.toFixed(1)}" y="${(chart - h).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${fill}"/></g>${label}`
      )
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">${bars}</svg>`
}

// Stacked bars of each day's cost by model, the top models apart and the rest as one.
function dailySvg(daily: GlobalView['daily'], models: readonly string[], width = 240, height = 64): string {
  const n = daily.length
  const gap = n > 40 ? 1 : 2
  const barWidth = Math.max(1.5, (width - gap * (n - 1)) / Math.max(n, 1))
  const chart = height - 12
  const totalOf = (d: GlobalView['daily'][number]) => Object.values(d.byModel).reduce((a, b) => a + b, 0)
  const max = Math.max(0.01, ...daily.map(totalOf))
  const every = Math.max(1, Math.ceil(n / 4))
  const bars = daily
    .map((d, i) => {
      const x = i * (barWidth + gap)
      const parts = models.map(m => d.byModel[m] ?? 0)
      parts.push(Math.max(0, totalOf(d) - parts.reduce((a, b) => a + b, 0)))
      let y = chart
      const rects = parts
        .map((cost, k) => {
          const h = (cost / max) * chart
          y -= h
          return h > 0 ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" fill="${SERIES[Math.min(k, 3)]}"/>` : ''
        })
        .join('')
      const detail = Object.entries(d.byModel)
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([m, c]) => `${m.replace(/^claude-/, '')} ${fmtUsd(c)}`)
        .join(', ')
      const label = i % every === 0 ? `<text x="${x.toFixed(1)}" y="${height - 1}" font-size="9" fill="${STONE}">${d.day.slice(5)}</text>` : ''
      return `<g><title>${escapeXml(`${d.day}  ${fmtUsd(totalOf(d))}${detail ? `\n${detail}` : ''}`)}</title><rect x="${x.toFixed(1)}" y="0" width="${barWidth.toFixed(1)}" height="${chart}" fill="transparent"/>${rects}</g>${label}`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">${bars}</svg>`
}

// The terminal's sparkline: one block per value, eight heights.
function sparkText(values: readonly number[]): string {
  const blocks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...values, 1e-9)
  return values.map(v => (v <= 0 ? ' ' : blocks[Math.min(7, Math.floor((v / max) * 7.999))]!)).join('')
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '–'
  const p = (part / whole) * 100
  return p > 0 && p < 1 ? '<1%' : `${p.toFixed(0)}%`
}

// Shows the global view and refreshes its scan.
async function openGlobal($: EngineInterface): Promise<void> {
  await update($, view, () => 'global' as const)
  await scanAll($)
}

export const register: Register = (on, options) => {
  nodeBin = typeof options.nodePath === 'string' && options.nodePath.trim() !== '' ? options.nodePath.trim() : 'node'
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
    await $.command.register({ name: 'cc-meter', description: t.commandDescription })

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
      // The global view reads the transcripts this turn just grew; scan after the turn settles.
      if ((await read($, view)) === 'global') {
        $.clock.after(0, () => void scanAll($))
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

  on('command.run', { command: 'cc-meter' }, async $ => {
    await update($, isBandHidden, () => false)
    const opened = await $.ui.open({ id: PANE, title: t.paneTitle })
    return { text: opened.isPlaced ? t.paneOpened : t.paneWaiting }
  })

  // The one-line summary above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) {
      return next(e)
    }
    const snap = await read($, snapshot)
    const spent = await read($, totals)
    const series = await read($, samples)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Text color="claude" bold>
          ◆ Token
        </Text>
        <Text>
          {t.bandSession} {snap?.costUsd !== undefined ? `${fmtUsd(snap.costUsd)} · ` : ''}
          {fmtTokens(sum(spent))} tok
          {snap?.contextPercent !== undefined ? ` · ${t.bandContext(snap.contextPercent)}` : ''}
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
              <Text dimColor>
                {' '}
                {[resetText(w.resetsAt, now), f.etaMs !== null ? t.fullIn(fmtDuration(f.etaMs)) : ''].filter(Boolean).join(' · ')}
              </Text>
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
    const scan = await read($, global)
    const fitted = await read($, fits)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const lineWidth = Math.max(12, Math.min(32, e.props.bodyColumns - 22))
    const shortModel = (m: string) => m.replace(/^claude-/, '')
    const span = await read($, range)
    const g = scan === null ? null : globalView(scan, span)
    const kindLabel = (k: number) => t.kinds[TOKEN_KINDS[k]!]

    const section = (title: string, aside?: string) => (
      <Box flexDirection="row" columnGap={1}>
        <Text bold>{title}</Text>
        {aside !== undefined && <Text dimColor>{aside}</Text>}
      </Box>
    )
    // Figures side by side: the value, and what it is under it.
    const stats = (items: readonly [string, string][]) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={4}>
        {items.map(([value, label]) => (
          <Box flexDirection="column">
            <Text bold>{value}</Text>
            <Text dimColor>{label}</Text>
          </Box>
        ))}
      </Box>
    )
    const meter = (percent: number) =>
      Svg !== undefined ? (
        <Svg source={meterSvg(percent)} alt={`${percent}%`} />
      ) : (
        <Text>
          <Text color={levelHex(percent)}>{'━'.repeat(Math.round((Math.min(100, percent) / 100) * lineWidth))}</Text>
          <Text dimColor>{'─'.repeat(lineWidth - Math.round((Math.min(100, percent) / 100) * lineWidth))}</Text>
        </Text>
      )
    // Rows of names with a share bar, an amount and a share, the largest first.
    const ranked = (items: readonly { name: string; value: number; amount: string }[], total: number) => {
      const max = Math.max(...items.map(i => i.value), 1e-9)
      return (
        <Box flexDirection="column">
          {items.map(item => (
            <Box flexDirection="row" columnGap={1}>
              <Box width={24}>
                <Text wrap="truncate-end">{item.name}</Text>
              </Box>
              <Box width={10}>
                {Svg !== undefined ? (
                  <Svg source={shareSvg(item.value / max)} alt={pct(item.value, total)} />
                ) : (
                  <Text color={CLAY}>{'▬'.repeat(Math.max(1, Math.round((item.value / max) * 8)))}</Text>
                )}
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
    const outlookOf = (w: Window) => {
      const fit = fitted[w.kind]
      const est = scan !== null && g !== null ? fittedWindow(w, fit, scan.planNow, scan.windows[w.kind]?.byModel, g.hourlyByModel, scan.tzOffsetMin, now) : null
      if (est !== null && fit !== undefined && fit.confidence !== 'low') {
        return est.etaMs !== null ? t.fullIn(fmtDuration(est.etaMs)) : est.atReset !== null ? t.atReset((est.atReset * 100).toFixed(0)) : ''
      }
      const f = forecast(series[w.kind]?.points ?? [], w.percentUsed, now, w.resetsAt)
      return { eta: f.etaMs !== null ? t.fullIn(fmtDuration(f.etaMs)) : '', full: t.full, flat: t.flat, safe: t.safe, unknown: '' }[f.state]
    }
    const limits =
      (snap?.windows.length ?? 0) === 0 ? (
        <Text dimColor>{hasNoLimits(snap) ? t.noLimits : t.waitingLimits}</Text>
      ) : (
        <Box flexDirection="column" rowGap={1}>
          {(snap?.windows ?? []).map(w => {
            const detail = [resetText(w.resetsAt, now), outlookOf(w)].filter(Boolean).join(' · ')
            return (
              <Box flexDirection="column">
                <Box flexDirection="row" columnGap={2} alignItems="center">
                  <Box width={11}>
                    <Text>{windowLabel(w.kind)}</Text>
                  </Box>
                  {meter(w.percentUsed)}
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

      return (
        <Box flexDirection="column" rowGap={1}>
          {tabs}
          {limits}
          {stats([
            [snap?.costUsd !== undefined ? fmtUsd(snap.costUsd) : '–', t.statCost],
            [fmtTokens(total), t.statTokens],
            [snap?.contextPercent !== undefined ? `${snap.contextPercent}%` : '–', t.statContext(fmtTokens(snap?.contextWindow ?? 0))],
            [String(rows.length), t.statTurns],
          ])}
          <Box flexDirection="column">
            {section(t.composition, t.byCost)}
            {Svg !== undefined ? (
              <Svg source={stackSvg(kinds)} alt={kinds.map(k => `${k.label} ${pct(k.value, spentTotal)}`).join(', ')} isInteractive />
            ) : (
              <Text>
                {kinds.map(k => (
                  <Text color={k.color}>{'█'.repeat(spentTotal > 0 ? Math.round((k.value / spentTotal) * lineWidth) : 0)}</Text>
                ))}
              </Text>
            )}
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
          <Box flexDirection="column">
            {section(t.perTurn, recent.length > 0 && peak !== null ? t.perTurnAside(recent.length, peak.n, fmtTokens(sum(peak.tokens))) : undefined)}
            {recent.length === 0 ? (
              <Text dimColor>{t.noTurns}</Text>
            ) : Svg !== undefined ? (
              <Svg
                source={sparkSvg(
                  recent.map(r => ({
                    value: sum(r.tokens),
                    title: t.turnTitle(r.n, fmtTokens(sum(r.tokens)), fmtTokens(r.tokens.output), fmtTokens(r.tokens.cacheWrite), fmtTokens(r.tokens.cacheRead), r.subagentTurns),
                  })),
                )}
                alt={recent.map(r => t.turnAlt(r.n, fmtTokens(sum(r.tokens)))).join(', ')}
                isInteractive
              />
            ) : (
              <Text color={CLAY}>{sparkText(recent.map(r => sum(r.tokens)))}</Text>
            )}
          </Box>
          {modelRows.length > 1 && (
            <Box flexDirection="column">
              {section(t.models)}
              {ranked(modelRows, total)}
            </Box>
          )}
          <Text dimColor>{t.sessionNote(fmtDuration(now - from))}</Text>
          {close}
        </Box>
      )
    }

    // The global view.
    const status = await read($, scanStatus)
    const isOpen = await read($, details)
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
        <Button key="rescan" label={t.refresh} dimColor onPress={() => void scanAll($)} />
        {status.state === 'error' ? <Text color={RED}>{statusText}</Text> : <Text dimColor>{statusText}</Text>}
      </Box>
    )
    if (scan === null || g === null) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {tabs}
          {limits}
          {controls}
          <Text dimColor>{t.firstScan}</Text>
          {close}
        </Box>
      )
    }

    const top = g.byModel.slice(0, 3).map(m => m.model)
    const Form = e.surface === 'mobile' ? null : $.ui.resolve(e)
    const draft = await read($, draftPlan)
    const detailView = (
      <Box flexDirection="column" rowGap={1}>
        {Object.values(fitted).map(f => {
          const band = (i: number) => {
            const [lo, hi] = f.gBand[i] ?? [0, Infinity]
            return Number.isFinite(hi) && hi / Math.max(lo, 1e-9) < 50 ? `${lo.toFixed(2)}–${hi.toFixed(2)}` : t.undetermined
          }
          const kindsLine = f.g[1]! > 0 ? [2, 3, 0].map(i => `${kindLabel(i)} ×${(f.g[i]! / f.g[1]!).toFixed(2)} (${band(i)})`).join(' · ') : ''
          const others = Object.entries(f.f).filter(([m]) => m !== f.ref)
          const multiples = Object.entries(f.planWindows).filter(([p]) => p !== f.refPlan)
          return (
            <Box flexDirection="column">
              <Text>
                {windowLabel(f.kind)}
                <Text dimColor>
                  {' '}
                  {t.fitHead(t.confidence[f.confidence], f.segments, f.hits)}
                  {f.mae !== null ? t.fitMiss(f.mae.toFixed(1)) : ''}
                  {f.outliers > 0 ? t.fitOutliers(f.outliers) : ''}
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
            </Box>
          )
        })}
        <Box flexDirection="column">
          <Text>{t.plan}</Text>
          {scan.plans.map(p => (
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Box width={11}>
                <Text dimColor>{p.from}</Text>
              </Box>
              <Box width={13}>
                <Text>{planLabel(p.plan)}</Text>
              </Box>
              <Box width={9}>
                <Text dimColor>{t.sources[p.source ?? 'manual'] ?? p.source}</Text>
              </Box>
              <Button key={`del-${p.from}`} label={t.delete} plain dimColor onPress={() => void removePlan($, p.from)} />
            </Box>
          ))}
          {scan.plans.length === 0 && <Text dimColor>{t.emptyTimeline}</Text>}
          {Form !== null && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
              <Form.Select
                key="plan-new"
                label={t.planField}
                value={draft}
                options={PLAN_CHOICES.map(value => ({ value, label: planLabel(value) }))}
                onSelect={value => update($, draftPlan, () => value)}
              />
              <Form.Input key="date-new" label={t.dateField} placeholder="YYYY-MM-DD" submitLabel={t.add} onSubmit={value => void addPlan($, value, draft)} />
            </Box>
          )}
        </Box>
        <Text dimColor>
          {t.dataNote}
          {g.unpriced.length > 0 ? t.unpriced(g.unpriced.join(', ')) : ''}
        </Text>
      </Box>
    )

    // What each window holds and has left in API dollars, how it goes at the usual pace, and the
    // limit hits on the current plan as a check that needs no fit.
    const planNow = scan.planNow ?? CURRENT
    const capacityRows = (snap?.windows ?? []).map(w => {
      const fit = fitted[w.kind]
      const est = fittedWindow(w, fit, scan.planNow, scan.windows[w.kind]?.byModel, g.hourlyByModel, scan.tzOffsetMin, now)
      const outlook =
        est === null ? '' : w.percentUsed >= 100 ? t.full : est.etaMs !== null ? t.fullIn(fmtDuration(est.etaMs)) : est.atReset !== null ? t.atReset((est.atReset * 100).toFixed(0)) : ''
      return { w, fit, est, outlook }
    })
    const hits = [...new Set(scan.observations.filter(o => o.hit).map(o => o.kind))].flatMap(kind => {
      const costs = scan.observations
        .filter(o => o.hit && o.kind === kind && (o.plan ?? CURRENT) === planNow)
        .map(o => Object.entries(o.byModel).reduce((acc, [m, v]) => acc + costOf(m, v), 0))
        .filter(c => c > 0)
      return costs.length === 0 ? [] : [t.hitsLine(windowLabel(kind), costs.length, roughUsd(Math.min(...costs)), roughUsd(Math.max(...costs)))]
    })
    const cell = (width: number, child: unknown) => <Box width={width}>{child as never}</Box>
    const capacity =
      capacityRows.length === 0 ? null : (
        <Box flexDirection="column">
          {section(t.capacity, t.capacityAside(planLabel(planNow)))}
          {capacityRows.every(r => r.est === null) ? (
            <Text dimColor>{t.capacityNone}</Text>
          ) : (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={2}>
                {cell(11, <Text> </Text>)}
                {cell(8, <Text dimColor>{t.colWhole}</Text>)}
                {cell(8, <Text dimColor>{t.colLeft}</Text>)}
                {cell(17, <Text dimColor>{t.colOutlook}</Text>)}
                <Text dimColor>{t.colConfidence}</Text>
              </Box>
              {capacityRows.map(({ w, fit, est, outlook }) => (
                <Box flexDirection="row" columnGap={2}>
                  {cell(11, <Text>{windowLabel(w.kind)}</Text>)}
                  {cell(8, <Text bold>{est !== null ? `≈ ${roughUsd(est.capacityUsd)}` : '–'}</Text>)}
                  {cell(8, <Text color={est !== null && w.percentUsed >= 70 ? levelHex(w.percentUsed) : undefined}>{est !== null ? `≈ ${roughUsd(est.remainingUsd)}` : '–'}</Text>)}
                  {cell(17, <Text>{outlook || '–'}</Text>)}
                  <Text dimColor>{t.confidence[fit?.confidence ?? 'none']}</Text>
                </Box>
              ))}
            </Box>
          )}
          {hits.map(line => (
            <Text dimColor>{line}</Text>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column" rowGap={1}>
        {tabs}
        {limits}
        {capacity}
        {controls}
        {stats([
          [fmtUsd(g.totalCost), span === '30d' ? t.statRange30 : t.statRangeAll],
          [fmtUsd(g.days > 0 ? g.totalCost / g.days : 0), t.statPerDay],
          [fmtTokens(g.totalTokens), t.statTokens],
          [t.days(g.days), t.statSpan],
        ])}
        <Box flexDirection="column">
          {section(t.daily, g.daily.length > 0 ? t.peak(fmtUsd(Math.max(...g.daily.map(d => Object.values(d.byModel).reduce((a, b) => a + b, 0))))) : undefined)}
          {g.daily.length === 0 ? (
            <Text dimColor>{t.noUsage}</Text>
          ) : Svg !== undefined ? (
            <Svg source={dailySvg(g.daily, top)} alt={g.daily.map(d => `${d.day} ${fmtUsd(Object.values(d.byModel).reduce((a, b) => a + b, 0))}`).join(', ')} isInteractive />
          ) : (
            <Box flexDirection="column">
              <Text color={CLAY}>{sparkText(g.daily.slice(-lineWidth * 2).map(d => Object.values(d.byModel).reduce((a, b) => a + b, 0)))}</Text>
              <Text dimColor>
                {g.daily[Math.max(0, g.daily.length - lineWidth * 2)]!.day.slice(5)} → {g.daily[g.daily.length - 1]!.day.slice(5)}
              </Text>
            </Box>
          )}
          {Svg !== undefined && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {[...top.map(shortModel), t.other].map((m, i) => (
                <Text>
                  <Text color={SERIES[Math.min(i, 3)]}>●</Text>
                  <Text dimColor> {m}</Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>
        <Box flexDirection="column">
          {section(t.projects)}
          {ranked(
            g.byProject.slice(0, 5).map(x => ({ name: x.project, value: x.cost, amount: fmtUsd(x.cost) })),
            g.totalCost,
          )}
        </Box>
        <Box flexDirection="column">
          {section(t.models)}
          {ranked(
            g.byModel.slice(0, 4).map(x => ({ name: shortModel(x.model), value: x.cost, amount: fmtUsd(x.cost) })),
            g.totalCost,
          )}
        </Box>
        <Box flexDirection="column" rowGap={1}>
          <Button key="details" label={isOpen ? t.hideDetails : t.details} plain dimColor onPress={() => update($, details, open => !open)} />
          {isOpen && detailView}
        </Box>
        {close}
      </Box>
    )
  })
}
