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
  sources: { manual: 'manual', auto: 'auto', inferred: 'inferred' } as Record<string, string>,
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

  bandSession: 'Session',
  bandContext: (p: number) => `context ${p}%`,
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
  turnAlt: (n: number, tokens: string) => `turn ${n} ${tokens}`,
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
  fitMiss: (x: string) => ` · off by ${x} pts`,
  fitOutliers: (n: number) => ` · ${n} outliers`,
  kindWeights: 'Per API dollar, against output: ',
  undetermined: 'unclear',
  against: (ref: string) => `Against ${ref}: `,
  multipleNote: (nominal: number | null, n: number) => (nominal !== null ? ` (sold as ×${nominal}, ${n} windows)` : ` (${n} windows)`),
  plan: 'Plan',
  delete: 'Delete',
  emptyTimeline: 'No plan changes recorded: everything counts as the current plan.',
  planField: 'Plan',
  dateField: 'From',
  add: 'Add',
  badDate: 'token-almanac: write the date as YYYY-MM-DD',
  planDetected: (p: string) => `token-almanac: plan changed to ${p}, added to the timeline`,
  dataNote:
    'From the Claude Code transcripts on this machine (subagents included); claude.ai and other devices are not in them. API-equivalent uses list prices (override in token-almanac/prices.json). Estimates fit pieces of 5 points or more and past limit hits, as model factor × token kind factor and plan multiples. How limits are counted is not published: these are inferences.',
  unpriced: (list: string) => ` Not priced, counted as 0: ${list}.`,
}

export type Messages = typeof en

const zh: Messages = {
  kinds: { input: 'input', output: 'output', cacheRead: 'cache 读', cacheWrite: 'cache 写' },
  windows: { five_hour: '5 小时', seven_day: '每周', seven_day_opus: '每周 Opus', seven_day_sonnet: '每周 Sonnet', spend_limit: '花费上限' },
  plans: { pro: 'Pro', max5x: 'Max 5x', max20x: 'Max 20x', team: 'Team', team_premium: 'Team Premium', enterprise: 'Enterprise', current: '当前套餐' },
  sources: { manual: '手动', auto: '自动', inferred: '推断' },
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

  bandSession: '会话',
  bandContext: p => `上下文 ${p}%`,
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
  turnAlt: (n, tokens) => `第 ${n} 轮 ${tokens}`,
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
  fitMiss: x => ` · 误差 ${x} 点`,
  fitOutliers: n => ` · ${n} 段离群`,
  kindWeights: '每 API 美元相对 output：',
  undetermined: '未定',
  against: ref => `相对 ${ref}：`,
  multipleNote: (nominal, n) => (nominal !== null ? `（标称 ×${nominal}，${n} 个窗口）` : `（${n} 个窗口）`),
  plan: '套餐',
  delete: '删除',
  emptyTimeline: '时间线为空：全部按当前套餐处理',
  planField: '套餐',
  dateField: '生效日期',
  add: '添加',
  badDate: 'token-almanac: 日期请写成 YYYY-MM-DD',
  planDetected: p => `token-almanac: 检测到套餐变为 ${p}，已记入时间线`,
  dataNote:
    '数据来自本机的 Claude Code 会话记录（含子代理），不含网页版和其他设备。折算按官方 API 价格（可用 token-almanac/prices.json 覆盖）。推算用每涨 5 个点的分段和历史触限，拟合模型系数 × token 类型系数与套餐倍数；限额的真实算法未公开，结果是推断。',
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
