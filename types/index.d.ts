// Token counts in the four kinds the API reports.
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

// One main-thread turn, with the subagent turns that finished while it ran.
export type TurnRow = { n: number; at: number; tokens: Tokens; subagentTurns: number }

// One rate-limit window as the last API response reported it.
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

// The status line's figures, as `$.session.usage()` and `session.measure` give them.
export type Snapshot = {
  at: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  costUsd?: number
  windows: Window[]
}

// Readings of one window's percent over time, for the burn-rate forecast.
export type Samples = { resetsAt?: string; points: [number, number][] }

// [input, output, cacheRead, cacheWrite5m, cacheWrite1h], as the scanner sums them.
export type Vec = [number, number, number, number, number]

// One local day and hour of one project and model: [day, hour, project, model, ...Vec].
export type ScanRow = [string, number, string, string, number, number, number, number, number]

// One entry of the plan timeline in ~/.claude/token-almanac/plans.json: the plan from that local day.
export type PlanEntry = { from: string; plan: string; source?: 'manual' | 'auto' | 'inferred'; note?: string; fromMs?: number }

// A limit reading kept by the mod: [at, window kind, percent used, resets at].
export type Reading = [number, string, number, number]

// A reading or a limit hit (100% at that moment), with what each model cost in its window so far.
export type Observation = { t: number; kind: string; y: number; resetsAt: number; hit: boolean; plan: string | null; exact?: boolean; byModel: Record<string, Vec> }

// One window kind's fit: rise × plan multiple ≈ Σ f[model] × Σ g[kind] × API spend[model][kind].
export type Fit = {
  kind: string
  windows: number
  // Pieces of windows (5 points or more each) and limit hits it learned from.
  segments: number
  hits: number
  // Per model, against the reference model (1).
  f: Record<string, number>
  // Per kind of token (input, output, cache read, cache write): the share of a Pro window one API
  // dollar of it takes, on the reference model.
  g: number[]
  // 95% band of each kind's weight against output's.
  gBand: [number, number][]
  // Per plan: its window's size as a multiple of the reference plan's.
  s: Record<string, number>
  // The plan with the most windows; 'current' stands for every reading with no timeline entry.
  refPlan: string
  planWindows: Record<string, number>
  // Median miss, in percentage points; pieces weighed down as unexplained.
  mae: number | null
  outliers: number
  confidence: 'none' | 'low' | 'medium' | 'high'
  // The model with the most spend.
  ref: string | null
}

// What `scan/scan.mjs global` prints: every transcript on this machine, summed.
export type GlobalScan = {
  rows: ScanRow[]
  windows: Record<string, { start: number; byModel: Record<string, Vec>; byProject: Record<string, Vec> }>
  observations: Observation[]
  plans: PlanEntry[]
  planNow: string | null
  account: { subscriptionType: string | null; rateLimitTier: string | null } | null
  today: string
  tzOffsetMin: number
  files: number
  readBytes: number
  ms: number
  at: number
}

export type ScanStatus = { state: 'idle' | 'scanning' | 'error'; message?: string }

declare module 'claude-code' {
  interface PluginState {
    'token-almanac': {
      since: number
      totals: Tokens
      byModel: Record<string, Tokens>
      turns: TurnRow[]
      snapshot: Snapshot | null
      samples: Record<string, Samples>
      isBandHidden: boolean
      view: 'session' | 'global'
      range: '30d' | 'all'
      global: GlobalScan | null
      scanStatus: ScanStatus
      fits: Record<string, Fit>
      draftPlan: string
      details: boolean
    }
  }
}
