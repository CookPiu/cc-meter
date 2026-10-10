// The words token-almanac draws, in each language it speaks. English is the fallback and the
// shape every other table follows; a new language is one more table of the same type.

export type Locale = 'en' | 'zh'

const en = {
  kinds: { input: 'input', output: 'output', cacheRead: 'cache read', cacheWrite: 'cache write' },
  windows: {
    five_hour: '5-hour',
    seven_day: 'Weekly',
    seven_day_opus: 'Weekly Opus',
    seven_day_sonnet: 'Weekly Sonnet',
    spend_limit: 'Spend limit',
  } as Record<string, string>,
  plans: {
    pro: 'Pro',
    max5x: 'Max 5x',
    max20x: 'Max 20x',
    team: 'Team',
    team_premium: 'Team Premium',
    enterprise: 'Enterprise',
    current: 'Current plan',
  } as Record<string, string>,
  confidence: { none: 'no data', low: 'low', medium: 'medium', high: 'high' },

  resetsIn: (d: string) => `resets in ${d}`,
  resetting: 'resetting',
  fullIn: (d: string) => `full in ~${d}`,
  full: 'used up',
  flat: 'not rising lately',
  safe: 'on pace to last',
  atReset: (p: string) => `~${p}% at reset`,
  updatedNow: 'just now',
  updatedAgo: (d: string) => `${d} ago`,

  paneTitle: 'Token usage',
  paneOpened: 'Token usage pane opened.',
  paneWaiting: 'The token usage pane is waiting for room to open.',
  commandDescription: 'Open the token usage pane and show its band again',

  bandContext: (p: number) => `context ${p}%`,
  bandFull: (d: string) => `full in ${d}`,
  bandWaiting: 'limits: waiting for a reply',
  bandNoLimits: 'API billing · no plan limits',
  bandOpen: 'Details',
  bandHide: 'Hide',

  tabSession: 'This session',
  tabGlobal: 'This machine',
  waitingLimits: 'Limits show after the next reply',
  noLimits: 'This account has no plan limits (API billing)',
  close: 'Close',

  statCost: 'API-equivalent',
  statTokens: 'tokens',
  statContext: (w: string) => `of ${w} context`,
  statTurns: 'turns',
  statRange30: 'last 30 days',
  statRangeAll: 'all time',
  statPerDay: 'per day',
  statSpan: 'span',
  days: (n: number) => `${n} d`,

  composition: 'Makeup',
  byCost: 'by API-equivalent cost',
  perTurn: 'Turns',
  perTurnAside: (n: number, peakN: number, peak: string) => `last ${n} · peak #${peakN} ${peak}`,
  noTurns: 'No finished turns yet',
  turnTitle: (n: number, tokens: string, out: string, write: string, read: string, subagents: number) =>
    `Turn ${n}  ${tokens} tokens\noutput ${out} · cache write ${write} · cache read ${read}${subagents ? `\nwith ${subagents} subagent${subagents > 1 ? 's' : ''}` : ''}`,
  models: 'Models',
  projects: 'Projects',
  daily: 'Daily',
  peak: (usd: string) => `peak ${usd}`,
  noUsage: 'No usage in this range',
  other: 'other',
  sessionNote: (d: string) => `Covers this session's ${d}, subagents included · API-equivalent at list prices`,

  scanning: 'Scanning…',
  scanFailed: (m: string) => `Scan failed: ${m}`,
  nodeMissing: 'Reading history needs Node.js 18+ (set its path in /config). Session figures still work.',
  files: (n: number, ago: string) => `${n} files · ${ago}`,
  range30: '30 days',
  rangeAll: 'All',
  refresh: 'Refresh',
  history: 'Usage history',
  keyElapsed: 'time through the window',
  keyProjected: 'where it is headed by the reset',
  showMore: 'Show breakdown',
  showLess: 'Hide breakdown',
  firstScan: 'The first scan reads every transcript under your Claude config folder and takes a few seconds; later ones read only what is new.',

  capacity: 'Capacity',
  capacityAside: (plan: string) => `${plan} · API-equivalent`,
  colWhole: 'Window',
  colLeft: 'Left',
  colOutlook: 'At your usual pace',
  colConfidence: 'Confidence',
  capacityNone: 'Not enough history yet: estimates start once a window has risen 5 points.',
  hitsLine: (kind: string, n: number, lo: string, hi: string) => `${kind}: hit the limit ${n} time${n > 1 ? 's' : ''}, at ${n > 1 ? `${lo}–${hi}` : lo} each`,
  details: 'How it is estimated',
  hideDetails: 'Hide estimate details',
  fitHead: (conf: string, segments: number, hits: number) => `· confidence ${conf} · ${segments} pieces · ${hits} limit hits`,
  fitCounts: (segments: number, hits: number) => `${segments} pieces · ${hits} limit hits`,
  fitMiss: (x: string) => ` · off by ${x} pts`,
  fitOutliers: (n: number) => ` · ${n} outliers`,
  fitLent: (kind: string) => ` · leaning on the ${kind} fit`,
  fitUnseen: (n: number) => ` · ${n} piece${n > 1 ? 's' : ''} likely with use from elsewhere, set aside`,
  kindWeights: 'Per API dollar, against output: ',
  undetermined: 'unclear',
  against: (ref: string) => `Against ${ref}: `,
  multipleNote: (nominal: number | null, n: number) => (nominal !== null ? ` (sold as ×${nominal}, ${n} windows)` : ` (${n} windows)`),
  planPick: 'Plan',
  planUnknown: 'Not sure',
  planHint: 'Pick your plan to have estimates told against it; until then they are relative to whatever plan you are on.',
  inferredLine: (from: string, to: string, ratio: string, against: string, guess: string | null, n: number) =>
    `${from} – ${to}: ×${ratio} of ${against}${guess !== null ? `, likely ${guess}` : ''} (inferred, ${n} windows)`,
  dataNote:
    'From the Claude Code transcripts on this machine (subagents included); claude.ai and other devices are not in them. API-equivalent uses list prices (override in token-almanac/prices.json). Estimates fit pieces of 5 points or more and past limit hits, as model factor × token kind factor and plan multiples. Before the plan you pick, a stretch whose rate moved by 1.8× or more is taken as another plan. How limits are counted is not published: these are inferences.',
  unpriced: (list: string) => ` Not priced, counted as 0: ${list}.`,
}

export type Messages = typeof en

const zh: Messages = {
  kinds: { input: 'input', output: 'output', cacheRead: 'cache 读', cacheWrite: 'cache 写' },
  windows: { five_hour: '5 小时', seven_day: '每周', seven_day_opus: '每周 Opus', seven_day_sonnet: '每周 Sonnet', spend_limit: '花费上限' },
  plans: { pro: 'Pro', max5x: 'Max 5x', max20x: 'Max 20x', team: 'Team', team_premium: 'Team Premium', enterprise: 'Enterprise', current: '当前套餐' },
  confidence: { none: '无数据', low: '低', medium: '中', high: '高' },

  resetsIn: d => `${d}后重置`,
  resetting: '即将重置',
  fullIn: d => `约 ${d} 后用满`,
  full: '已用满',
  flat: '近期未增长',
  safe: '按当前节奏用不满',
  atReset: p => `重置时约 ${p}%`,
  updatedNow: '刚刚更新',
  updatedAgo: d => `${d}前更新`,

  paneTitle: 'Token 用量',
  paneOpened: 'Token 用量面板已打开。',
  paneWaiting: 'Token 用量面板等待空间打开。',
  commandDescription: '打开 Token 用量面板，并重新显示横条',

  bandContext: p => `上下文 ${p}%`,
  bandFull: d => `${d} 后满`,
  bandWaiting: '限额：等待首个响应',
  bandNoLimits: 'API 计费 · 无订阅限额',
  bandOpen: '详情',
  bandHide: '隐藏',

  tabSession: '本次会话',
  tabGlobal: '本机全局',
  waitingLimits: '等待首个响应带回限额读数',
  noLimits: '这个账户没有订阅限额（API 计费）',
  close: '关闭',

  statCost: '折算花费',
  statTokens: 'tokens',
  statContext: w => `上下文 ${w}`,
  statTurns: '轮',
  statRange30: '近 30 天折算',
  statRangeAll: '全部折算',
  statPerDay: '日均',
  statSpan: '跨度',
  days: n => `${n} 天`,

  composition: '构成',
  byCost: '按折算花费',
  perTurn: '每轮',
  perTurnAside: (n, peakN, peak) => `最近 ${n} 轮 · 峰值第 ${peakN} 轮 ${peak}`,
  noTurns: '还没有完成的轮次',
  turnTitle: (n, tokens, out, write, read, subagents) =>
    `第 ${n} 轮  ${tokens} tokens\noutput ${out} · cache 写 ${write} · cache 读 ${read}${subagents ? `\n含子代理 ${subagents} 个` : ''}`,
  models: '模型',
  projects: '项目',
  daily: '每日',
  peak: usd => `峰值 ${usd}`,
  noUsage: '这段时间没有用量',
  other: '其他',
  sessionNote: d => `覆盖本会话 ${d}，含子代理 · 折算按 API 价格`,

  scanning: '扫描中…',
  scanFailed: m => `扫描失败：${m}`,
  nodeMissing: '读取历史记录需要 Node.js 18 以上（可在 /config 里设置路径），会话内统计不受影响。',
  files: (n, ago) => `${n} 个文件 · ${ago}`,
  range30: '近 30 天',
  rangeAll: '全部',
  refresh: '刷新',
  history: '历史用量',
  keyElapsed: '窗口时间进度',
  keyProjected: '按节奏预计到重置',
  showMore: '展开明细',
  showLess: '收起明细',
  firstScan: '首次扫描读取 Claude 配置目录下的全部会话记录，约需数秒；之后只读新增部分。',

  capacity: '容量推算',
  capacityAside: plan => `${plan} · 按 API 价格折算`,
  colWhole: '整窗',
  colLeft: '剩余',
  colOutlook: '按历史节奏',
  colConfidence: '可信度',
  capacityNone: '历史数据不足：窗口用量涨满 5 个点后开始推算。',
  hitsLine: (kind, n, lo, hi) => `${kind}历史触限 ${n} 次，每次折合 ${n > 1 ? `${lo}–${hi}` : lo}`,
  details: '推算细节',
  hideDetails: '收起推算细节',
  fitHead: (conf, segments, hits) => `· 可信度 ${conf} · ${segments} 段 · ${hits} 次触限`,
  fitCounts: (segments, hits) => `${segments} 段 · ${hits} 次触限`,
  fitMiss: x => ` · 误差 ${x} 点`,
  fitOutliers: n => ` · ${n} 段离群`,
  fitLent: kind => ` · 参照 ${kind}窗口`,
  fitUnseen: n => ` · ${n} 段疑似有本机之外的用量，已排除`,
  kindWeights: '每 API 美元相对 output：',
  undetermined: '未定',
  against: ref => `相对 ${ref}：`,
  multipleNote: (nominal, n) => (nominal !== null ? `（标称 ×${nominal}，${n} 个窗口）` : `（${n} 个窗口）`),
  planPick: '套餐',
  planUnknown: '不确定',
  planHint: '选择你的套餐后，推算会按该套餐给出；未选择时按相对倍数显示。',
  inferredLine: (from, to, ratio, against, guess, n) => `${from} – ${to}：约为 ${against} 的 ×${ratio}${guess !== null ? `，可能是 ${guess}` : ''}（推测，${n} 个窗口）`,
  dataNote:
    '数据来自本机的 Claude Code 会话记录（含子代理），不含网页版和其他设备。折算按官方 API 价格（可用 token-almanac/prices.json 覆盖）。推算用每涨 5 个点的分段和历史触限，拟合模型系数 × token 类型系数与套餐倍数；所选套餐之前，比率变化 1.8 倍以上的时段视为另一个套餐。限额的真实算法未公开，结果是推断。',
  unpriced: list => ` 未定价、按 0 计：${list}。`,
}

export const MESSAGES: Record<Locale, Messages> = { en, zh }

// A locale from a language name or tag, as Claude Code's `language` setting, LANG or Intl give
// it ("chinese", "简体中文", "zh_CN.UTF-8", "en-US"); null when it names none we speak.
export function localeOf(value: string | undefined | null): Locale | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === '' || v === 'c' || v === 'posix') return null
  if (/^zh|chinese|中文|汉语|漢語/.test(v)) return 'zh'
  if (/^en|english/.test(v)) return 'en'
  return null
}
