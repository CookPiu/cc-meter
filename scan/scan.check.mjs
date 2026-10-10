// Checks for the scanner: `node --test scan/scan.check.mjs`.
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { projectLabel, scanGlobal, sessionFrom } from './scan.mjs'

const usage = (input, output, cacheRead, cacheWrite, write1h = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: cacheWrite - write1h },
})
const line = o => JSON.stringify(o)
const reply = (id, at, model, u, extra = {}) =>
  line({ type: 'assistant', requestId: `r${id}`, timestamp: at, cwd: 'D:\\Code\\demo', message: { id: `m${id}`, model, usage: u }, ...extra })

test('a session counts each response once, by turn, with its subagents', () => {
  const main = [
    line({ type: 'user', timestamp: '2026-10-10T01:00:00Z', message: { content: 'first prompt' } }),
    // One response written as two rows: counted once.
    reply(1, '2026-10-10T01:00:05Z', 'claude-opus-5-5', usage(1, 10, 100, 1000, 1000)),
    reply(1, '2026-10-10T01:00:05Z', 'claude-opus-5-5', usage(1, 10, 100, 1000, 1000)),
    // A tool result and a command record start no turn.
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ type: 'user', message: { content: '<command-name>/token-almanac</command-name>' } }),
    reply(2, '2026-10-10T01:01:00Z', 'claude-opus-5-5', usage(2, 20, 200, 0)),
    line({ type: 'user', timestamp: '2026-10-10T01:05:00Z', message: { content: [{ type: 'text', text: 'second prompt' }] } }),
    reply(4, '2026-10-10T01:05:10Z', 'claude-opus-5-5', usage(3, 30, 300, 0)),
    'not json',
    // The prompt running now has no response yet: the live count adds it.
    line({ type: 'user', timestamp: '2026-10-10T01:09:00Z', message: { content: 'third prompt' } }),
  ].join('\n')
  // A subagent file: its response belongs to the turn that was running at its time.
  const sub = reply(3, '2026-10-10T01:02:00Z', 'claude-haiku-5-5', usage(5, 5, 0, 0), { isSidechain: true, agentId: 'a1' })

  const p = sessionFrom(main, [sub])
  assert.deepEqual(p.totals, { input: 11, output: 65, cacheRead: 600, cacheWrite: 1000 })
  assert.deepEqual(Object.keys(p.byModel).sort(), ['claude-haiku-5-5', 'claude-opus-5-5'])
  assert.deepEqual(
    p.turns.map(t => [t.n, t.tokens.output, t.subagentTurns]),
    [
      [1, 35, 1],
      [2, 30, 0],
    ],
  )
  assert.equal(p.turns[0].at, Date.parse('2026-10-10T01:00:00Z'))
})

test('project labels keep the last two folders', () => {
  assert.equal(projectLabel('D:\\Code\\demo'), 'Code/demo')
  assert.equal(projectLabel('/home/me/code/app'), 'code/app')
})

test('the global scan reads incrementally and sums windows to the bucket', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'token-almanac-'))
  const projects = join(dir, 'projects')
  const cache = join(dir, 'cache.json')
  await fsp.mkdir(join(projects, 'D--Code-demo', 's1', 'subagents'), { recursive: true })
  const file = join(projects, 'D--Code-demo', 's1.jsonl')
  await fsp.writeFile(
    file,
    [
      reply(1, '2026-10-09T10:00:00Z', 'claude-opus-5-5', usage(1, 2, 3, 4, 4)),
      reply(1, '2026-10-09T10:00:00Z', 'claude-opus-5-5', usage(1, 2, 3, 4, 4)),
      reply(2, '2026-10-10T02:00:00Z', 'claude-opus-5-5', usage(10, 20, 30, 0)),
    ].join('\n') + '\n',
  )
  await fsp.writeFile(
    join(projects, 'D--Code-demo', 's1', 'subagents', 'agent-a.jsonl'),
    reply(9, '2026-10-10T02:30:00Z', 'claude-haiku-5-5', usage(100, 0, 0, 0), { isSidechain: true }) + '\n',
  )

  const windows = { five_hour: Date.parse('2026-10-10T01:00:00Z') }
  const first = await scanGlobal(projects, cache, windows, Date.parse('2026-10-10T03:00:00Z'))
  assert.equal(first.files, 2)
  const total = first.rows.reduce((a, r) => a + r.slice(4).reduce((x, y) => x + y, 0), 0)
  assert.equal(total, 10 + 60 + 100)
  assert.deepEqual(first.windows.five_hour.byModel, { 'claude-opus-5-5': [10, 20, 30, 0, 0], 'claude-haiku-5-5': [100, 0, 0, 0, 0] })
  assert.deepEqual(Object.keys(first.windows.five_hour.byProject), ['Code/demo'])
  // The 1h cache write is kept apart from the 5m one.
  assert.ok(first.rows.some(r => r[3] === 'claude-opus-5-5' && r[7] === 0 && r[8] === 4))

  // A second run reads only what was appended, and a half-written line waits.
  await fsp.appendFile(file, reply(3, '2026-10-10T02:40:00Z', 'claude-opus-5-5', usage(1, 1, 1, 0)) + '\n{"type":"assist')
  const second = await scanGlobal(projects, cache, windows, Date.parse('2026-10-10T03:00:00Z'))
  assert.ok(second.readBytes > 0 && second.readBytes < 400)
  assert.deepEqual(second.windows.five_hour.byModel['claude-opus-5-5'], [11, 21, 31, 0, 0])
  const third = await scanGlobal(projects, cache, windows, Date.parse('2026-10-10T03:00:00Z'))
  assert.equal(third.readBytes, 0)

  await fsp.rm(dir, { recursive: true, force: true })
})

test('limit hits and readings become observations tagged with their plan', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'token-almanac-'))
  const projects = join(dir, 'projects')
  await fsp.mkdir(join(projects, 'p'), { recursive: true })
  await fsp.mkdir(join(dir, 'token-almanac'), { recursive: true })
  await fsp.writeFile(
    join(dir, 'token-almanac', 'plans.json'),
    JSON.stringify({ plans: [{ from: '2026-08-01', plan: 'pro' }, { from: '2026-09-01', plan: 'max5x' }] }),
  )
  await fsp.writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'secret', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }))
  const hitAt = '2026-08-20T08:26:00Z'
  const resets = Date.parse('2026-08-20T10:40:00Z')
  const rejected = {
    type: 'assistant',
    timestamp: hitAt,
    requestId: 'rq',
    message: { id: 'mq', model: '<synthetic>', usage: usage(0, 0, 0, 0) },
    quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resets / 1000 },
  }
  await fsp.writeFile(
    join(projects, 'p', 's.jsonl'),
    [
      reply(1, '2026-08-20T06:00:00Z', 'claude-opus-5', usage(0, 1000, 0, 0)),
      // Before the window: not counted.
      reply(2, '2026-08-20T05:00:00Z', 'claude-opus-5', usage(0, 7, 0, 0)),
      line(rejected),
      line(rejected),
      reply(3, '2026-09-05T03:00:00Z', 'claude-fable-5-1', usage(0, 50, 0, 0)),
      // In the reading's 10-minute bucket but after it: an exact sum leaves it out.
      reply(4, '2026-09-05T04:05:00Z', 'claude-fable-5-1', usage(0, 999, 0, 0)),
    ].join('\n') + '\n',
  )
  const reading = [Date.parse('2026-09-05T04:00:00Z'), 'five_hour', 40, Date.parse('2026-09-05T07:00:00Z')]
  const g = await scanGlobal(projects, join(dir, 'cache.json'), {}, Date.parse('2026-09-05T04:00:00Z'), [reading])

  assert.equal(g.planNow, 'max5x')
  assert.deepEqual(g.account, { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' })
  assert.ok(!JSON.stringify(g).includes('secret'))
  const hit = g.observations.find(o => o.hit)
  assert.deepEqual([hit.kind, hit.y, hit.plan, hit.resetsAt], ['five_hour', 1, 'pro', resets])
  assert.deepEqual(hit.byModel, { 'claude-opus-5': [0, 1000, 0, 0, 0] })
  assert.equal(g.observations.filter(o => o.hit).length, 1)
  const read = g.observations.find(o => !o.hit)
  assert.deepEqual([read.y, read.plan, read.exact, read.byModel], [0.4, 'max5x', true, { 'claude-fable-5-1': [0, 50, 0, 0, 0] }])
  // The August hit lies before the responses kept one by one: summed to the bucket.
  assert.equal(hit.exact, false)

  await fsp.rm(dir, { recursive: true, force: true })
})
