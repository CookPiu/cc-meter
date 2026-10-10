// token-almanac's transcript scanner, run by the mod through `$.process.run(["node", ...])`.
//
// The hooks environment reads at most 4 MiB per file and has no streams, while Claude Code's
// transcripts run to hundreds of MB, so the reading happens here and only sums go back.
//
//   node scan.mjs session <transcript.jsonl>
//     One session: its main transcript plus <session>/subagents/*.jsonl, as turns.
//   node scan.mjs global <projects dir> <cache.json>   (stdin: { windows, readings })
//     Every transcript under the projects dir, read incrementally (the cache keeps each file's
//     read offset, 10-minute buckets and the limit hits it met), summed per local day, hour,
//     project and model; sums since each window's start; and, for the fit, each limit reading
//     and limit hit with what each model cost in its window up to that moment.
//
// Token vectors are [input, output, cacheRead, cacheWrite5m, cacheWrite1h].

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUCKET_MS = 10 * 60_000
const CACHE_VERSION = 3
// Responses this recent are kept one by one, so a window's sums are exact to the response (a
// week's window is the longest); older ones only in the 10-minute buckets.
const RECENT_MS = 8 * 24 * 3_600_000
// Rows of one response share its message id and request id; they are written close together.
const KEYS_KEPT = 500

export function usageOf(entry) {
  const m = entry?.message
  if (entry?.type !== 'assistant' || !m?.usage) return null
  const u = m.usage
  const write = u.cache_creation_input_tokens ?? 0
  const write1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens ?? 0)
  return {
    key: `${m.id ?? ''}:${entry.requestId ?? ''}`,
    model: m.model ?? 'unknown',
    at: Date.parse(entry.timestamp ?? '') || 0,
    agentId: entry.agentId,
    isSidechain: entry.isSidechain === true,
    v: [u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, write - write1h, write1h],
  }
}

// A prompt the person typed: not a tool result, a meta row or a command's <tagged> record.
export function isPrompt(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) return false
  const content = entry.message?.content
  if (typeof content === 'string') return !content.startsWith('<')
  if (!Array.isArray(content)) return false
  return !content.some(b => b?.type === 'tool_result') && content.some(b => b?.type === 'text' && !(b.text ?? '').startsWith('<'))
}

function addInto(target, v) {
  for (let i = 0; i < 5; i += 1) target[i] += v[i]
  return target
}

const zero = () => [0, 0, 0, 0, 0]

function parseLines(text, onEntry) {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    onEntry(entry)
  }
}

async function readFrom(path, offset) {
  const handle = await fsp.open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= offset) return { text: '', end: offset, size }
    const buffer = Buffer.alloc(size - offset)
    await handle.read(buffer, 0, buffer.length, offset)
    // Only whole lines: a line still being written is read next time.
    const last = buffer.lastIndexOf(10)
    if (last < 0) return { text: '', end: offset, size }
    return { text: buffer.subarray(0, last + 1).toString('utf8'), end: offset + last + 1, size }
  } finally {
    await handle.close()
  }
}

// ---- session ---------------------------------------------------------------

const asTokens = v => ({ input: v[0], output: v[1], cacheRead: v[2], cacheWrite: v[3] + v[4] })

export function sessionFrom(mainText, subagentTexts) {
  const seen = new Set()
  const turns = []
  let current = null
  const total = zero()
  const byModel = {}
  const agentsByTurn = new Map()

  const count = (use, turn) => {
    if (seen.has(use.key)) return
    seen.add(use.key)
    addInto(total, use.v)
    addInto((byModel[use.model] ??= zero()), use.v)
    if (turn === null) return
    addInto(turn.v, use.v)
    if (use.isSidechain) {
      const agents = agentsByTurn.get(turn) ?? new Set()
      agents.add(use.agentId ?? use.model)
      agentsByTurn.set(turn, agents)
    }
  }

  parseLines(mainText, entry => {
    if (isPrompt(entry)) {
      current = { at: Date.parse(entry.timestamp ?? '') || 0, v: zero() }
      turns.push(current)
      return
    }
    const use = usageOf(entry)
    if (use) count(use, current)
  })
  // A subagent's response counts into the last turn that started before it.
  for (const text of subagentTexts) {
    parseLines(text, entry => {
      const use = usageOf(entry)
      if (!use) return
      let turn = null
      for (const t of turns) if (t.at <= use.at) turn = t
      count({ ...use, isSidechain: true }, turn)
    })
  }
  // A prompt that has no response yet is the turn running now: the live count adds it.
  while (turns.length > 0 && turns[turns.length - 1].v.every(n => n === 0)) turns.pop()

  return {
    totals: asTokens(total),
    byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, asTokens(v)])),
    turns: turns.slice(-60).map((t, i, list) => ({
      n: turns.length - list.length + i + 1,
      at: t.at,
      tokens: asTokens(t.v),
      subagentTurns: agentsByTurn.get(t)?.size ?? 0,
    })),
  }
}

async function scanSession(mainPath) {
  const mainText = (await readFrom(mainPath, 0)).text
  const dir = join(dirname(mainPath), basename(mainPath, '.jsonl'), 'subagents')
  const names = await fsp.readdir(dir).catch(() => [])
  const subagentTexts = []
  for (const name of names.filter(n => n.endsWith('.jsonl'))) {
    subagentTexts.push((await readFrom(join(dir, name), 0)).text)
  }
  return sessionFrom(mainText, subagentTexts)
}

// ---- global ----------------------------------------------------------------

async function listTranscripts(dir) {
  const out = []
  const walk = async d => {
    for (const entry of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  await walk(dir)
  return out
}

// The project a transcript belongs to, by the last two parts of the folder it ran in.
export function projectLabel(cwd) {
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('/') || String(cwd)
}

function emptyCache(now) {
  return { version: CACHE_VERSION, files: {}, buckets: {}, hits: {}, recent: [], recentFrom: now - RECENT_MS }
}

// How long a limit window runs, to find where one began from where it resets.
export function windowLength(kind) {
  if (kind === 'five_hour') return 5 * 3_600_000
  if (String(kind).startsWith('seven_day')) return 7 * 24 * 3_600_000
  return null
}

// What each model cost in [start, end), from buckets sorted by start, to the bucket.
function sumRange(sorted, start, end) {
  const byModel = {}
  for (const [t, model, v] of sorted) {
    if (t >= end) break
    if (t + BUCKET_MS <= start) continue
    addInto((byModel[model] ??= zero()), v)
  }
  return byModel
}

// What each model cost in [start, end), from single responses sorted by time, exactly.
function sumExact(recent, start, end) {
  const byModel = {}
  for (const [t, model, ...v] of recent) {
    if (t >= end) break
    if (t < start) continue
    addInto((byModel[model] ??= zero()), v)
  }
  return byModel
}

// Every limit reading and limit hit, with its window's cost per model up to that moment: exact
// where the kept responses cover the whole window, to the bucket before that.
export function observations(buckets, hits, readings, recent = [], recentFrom = Infinity) {
  const sorted = Object.entries(buckets)
    .map(([id, v]) => {
      const [t, , model] = id.split('|')
      return [Number(t), model, v]
    })
    .sort((a, b) => a[0] - b[0])
  const merged = [
    ...readings.map(([t, kind, pct, resetsAt]) => ({ t, kind, y: pct / 100, resetsAt, hit: false })),
    ...Object.values(hits).map(h => ({ t: h.at, kind: h.kind, y: 1, resetsAt: h.resetsAt, hit: true })),
  ]
  return merged.flatMap(o => {
    const length = windowLength(o.kind)
    if (length === null || !Number.isFinite(o.resetsAt)) return []
    const start = o.resetsAt - length
    const exact = start >= recentFrom
    const byModel = exact ? sumExact(recent, start, o.t) : sumRange(sorted, start, o.t)
    return [{ ...o, exact, byModel }]
  })
}

export async function scanGlobal(projectsDir, cachePath, windows, now = Date.now(), readings = []) {
  const startedAt = Date.now()
  let cache = await fsp
    .readFile(cachePath, 'utf8')
    .then(JSON.parse)
    .catch(() => emptyCache(now))
  if (cache.version !== CACHE_VERSION) cache = emptyCache(now)

  const paths = await listTranscripts(projectsDir)
  // A transcript that shrank was rewritten: its earlier sums cannot be taken back, so start over.
  for (const path of paths) {
    const meta = cache.files[path]
    const size = (await fsp.stat(path).catch(() => null))?.size ?? 0
    if (meta && size < meta.offset) {
      cache = emptyCache(now)
      break
    }
  }

  let readBytes = 0
  for (const path of paths) {
    const meta = (cache.files[path] ??= { offset: 0, project: null, keys: [] })
    const { text, end } = await readFrom(path, meta.offset).catch(() => ({ text: '', end: meta.offset }))
    readBytes += end - meta.offset
    meta.offset = end
    if (text === '') continue
    const keys = new Set(meta.keys)
    parseLines(text, entry => {
      if (meta.project === null && entry.cwd) meta.project = projectLabel(entry.cwd)
      // A request the limit refused: that window stood at 100% at that moment.
      const q = entry.quotaLimits
      if (q?.status === 'rejected' && q.rateLimitType && Number.isFinite(q.resetsAt)) {
        const resetsAt = q.resetsAt * 1000
        const at = Date.parse(entry.timestamp ?? '') || 0
        const id = `${q.rateLimitType}|${resetsAt}`
        if (at > 0 && !(cache.hits[id]?.at <= at)) cache.hits[id] = { kind: q.rateLimitType, resetsAt, at }
      }
      const use = usageOf(entry)
      // A refused request's placeholder reply carries all-zero usage: nothing to count.
      if (!use || keys.has(use.key) || use.at === 0 || use.v.every(n => n === 0)) return
      keys.add(use.key)
      const bucket = Math.floor(use.at / BUCKET_MS) * BUCKET_MS
      const id = `${bucket}|${meta.project ?? basename(dirname(path))}|${use.model}`
      addInto((cache.buckets[id] ??= zero()), use.v)
      if (use.at >= cache.recentFrom) cache.recent.push([use.at, use.model, ...use.v])
    })
    meta.keys = [...keys].slice(-KEYS_KEPT)
  }
  cache.recentFrom = Math.max(cache.recentFrom, now - RECENT_MS)
  cache.recent = cache.recent.filter(r => r[0] >= cache.recentFrom).sort((a, b) => a[0] - b[0])

  const tmp = `${cachePath}.tmp`
  await fsp.mkdir(dirname(cachePath), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify(cache))
  await fsp.rename(tmp, cachePath)

  return {
    ...summarize(cache.buckets, windows),
    observations: observations(cache.buckets, cache.hits, readings, cache.recent, cache.recentFrom),
    // The mod's environment may not keep this machine's time zone: days and hours are ours.
    today: localDay(new Date(now)),
    tzOffsetMin: -new Date(now).getTimezoneOffset(),
    files: paths.length,
    readBytes,
    ms: Date.now() - startedAt,
    at: now,
  }
}

const pad = n => String(n).padStart(2, '0')
const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// Per local day and hour, project and model; and since each window's start.
export function summarize(buckets, windows) {
  const rows = new Map()
  const win = Object.fromEntries(Object.entries(windows).map(([kind, start]) => [kind, { start, byModel: {}, byProject: {} }]))
  for (const [id, v] of Object.entries(buckets)) {
    const [startText, project, model] = id.split('|')
    const start = Number(startText)
    const date = new Date(start)
    const key = `${localDay(date)}|${date.getHours()}|${project}|${model}`
    addInto(rows.get(key) ?? (rows.set(key, zero()), rows.get(key)), v)
    for (const w of Object.values(win)) {
      if (start + BUCKET_MS <= w.start) continue
      addInto((w.byModel[model] ??= zero()), v)
      addInto((w.byProject[project] ??= zero()), v)
    }
  }
  return {
    rows: [...rows].map(([key, v]) => {
      const [day, hour, project, model] = key.split('|')
      return [day, Number(hour), project, model, ...v]
    }),
    windows: win,
  }
}

// ---- command line ----------------------------------------------------------

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function main(argv) {
  const [mode, ...rest] = argv
  if (mode === 'session') {
    return scanSession(rest[0])
  }
  if (mode === 'global') {
    const [projectsDir, cachePath] = rest
    const input = JSON.parse((await readStdin()) || '{}')
    return scanGlobal(projectsDir, cachePath, input.windows ?? {}, Date.now(), input.readings ?? [])
  }
  throw new Error(`usage: scan.mjs session <file> | global <projects dir> <cache>  (stdin: { windows, readings })`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    result => process.stdout.write(JSON.stringify(result)),
    error => {
      process.stderr.write(String(error?.stack ?? error))
      process.exit(1)
    },
  )
}
