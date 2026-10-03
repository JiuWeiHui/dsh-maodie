// Host patch 10 (1.3.0): 账户隔开 + 每轮金额（按官方单价估算）+ 官方余额/今日已用
//
// 金额口径参考同机插件 dsh-whale-widget（它的做法才是对的）：
//   * 金额来自「每次调用的真实 usage × 该模型单价」，不是余额相减；
//   * 按 (sessionId, turn) 分桶聚合 —— 主会话与子代理并行也不会串账（免疫并发）；
//   * reasoningTokens ⊆ outputTokens，所以输出侧不能重复计费；
//   * 余额只用来给「账号级」的余额与今日已用做官方读数，不承担每轮金额。
// 另外按用户要求：
//   * 有官方余额来源的（DeepSeek）→ 余额/今日已用直接读官方；
//   * 没有官方来源的（小米这类）→ 余额写「未知」，金额按自填单价估算并标注「仅供参考」。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'index.js')

let s = fs.readFileSync(TARGET, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
s = s.split('\r\n').join('\n')

function rep(name, from, to, expect = 1) {
  const n = s.split(from).length - 1
  if (n !== expect) {
    console.error('MISMATCH [' + name + '] found=' + n + ' expected=' + expect)
    process.exit(1)
  }
  s = s.split(from).join(to)
  console.log('ok  ' + name)
}

rep('Q1 version', `const PLUGIN_VERSION = '1.2.9'`, `const PLUGIN_VERSION = '1.3.0'`)

// ---------------------------------------------------------------- Q2 价格表（照抄鲸鱼的口径）
rep(
  'Q2 价格表与峰谷',
  `  const fetchBalance = async () => {`,
  `  // ---------------- 单价表（元/百万 token）----------------
  // 口径与同机插件 dsh-whale-widget 一致（含峰谷价、周末全天谷价），保证两个插件数字对得上。
  // 价格来源：官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
  // [谷价, 峰价]：工作日 9:00-12:00、14:00-18:00（北京时间）为高峰；2026-08-23 起周末全天谷价。
  const MD_PEAK_HOURS = [
    [9, 12],
    [14, 18],
  ]
  const MD_WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
  const MD_BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
  const MD_PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
  const MD_BUILTIN_PRICES = {
    'deepseek-flash': MD_BASE_PRICE,
    'deepseek-v4-flash': MD_BASE_PRICE,
    'deepseek-v4-flash-vision-exp': MD_BASE_PRICE,
    'deepseek-v4-pro': MD_PRO_PRICE,
  }
  const MD_PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

  const mdIsPeakTime = (timeSec) => {
    const n = Number(timeSec)
    if (!isFinite(n)) return false
    const bj = new Date(n * 1000 + 8 * 3600 * 1000)
    if (n >= MD_WEEKEND_VALLEY_FROM_SEC) {
      const dow = bj.getUTCDay()
      if (dow === 0 || dow === 6) return false
    }
    const hour = bj.getUTCHours()
    for (const range of MD_PEAK_HOURS) {
      if (hour >= range[0] && hour < range[1]) return true
    }
    return false
  }

  // 自定义单价（设置页里给第三方模型填的「元/百万 token」），按键长降序做子串匹配，优先于内置价
  const mdCustomPrices = () => {
    const out = {}
    try {
      const pricing = state.pricing || {}
      const custom = isPlainObject(pricing.custom) ? pricing.custom : {}
      for (const key of Object.keys(custom)) {
        const p = custom[key]
        if (!isPlainObject(p)) continue
        const num = (v) => (isFinite(Number(v)) ? Number(v) : 0)
        const cur = String(p.cur || 'CNY').toUpperCase()
        const rate = num(p.rate)
        out[key] = {
          hit: [num(p.hit), num(p.hit)],
          miss: [num(p.miss), num(p.miss)],
          out: [num(p.out), num(p.out)],
          cur,
          rate: cur === 'USD' && rate > 0 ? rate : 0,
        }
      }
    } catch (err) {
      /* 忽略 */
    }
    return out
  }

  const mdPriceFor = (model) => {
    const m = String(model || '').toLowerCase()
    const custom = mdCustomPrices()
    for (const key of Object.keys(custom).sort((a, b) => b.length - a.length)) {
      if (key && m.indexOf(key.toLowerCase()) !== -1) return custom[key]
    }
    for (const key of Object.keys(MD_BUILTIN_PRICES).sort((a, b) => b.length - a.length)) {
      if (m.indexOf(key) !== -1) return MD_BUILTIN_PRICES[key]
    }
    return MD_BASE_PRICE
  }

  // 一次调用的金额（元）。usage 的 reasoning ⊆ output，所以输出侧不重复计费。
  const mdMessageCost = (usage, model, atMs) => {
    const input = Number(usage && usage.inputTokens) || 0
    const cache = Number(usage && usage.cacheReadTokens) || 0
    const output = Number(usage && usage.outputTokens) || 0
    const reasoning = Number(usage && usage.reasoningTokens) || 0
    const outputBilled = reasoning > output ? output + reasoning : output
    const p = mdPriceFor(model)
    const off = mdIsPeakTime(Math.floor((atMs || Date.now()) / 1000)) ? 1 : 0
    let cost = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (outputBilled / 1e6) * p.out[off]
    if (p.cur === 'USD' && p.rate > 0) cost = cost * p.rate
    return {
      cost,
      tokens: input + cache + outputBilled,
      input,
      cache,
      output: outputBilled,
      reasoning,
      priceBasis: p.cur === 'USD' && p.rate > 0 ? '自定义单价（USD×汇率）' : p === MD_BASE_PRICE || p === MD_PRO_PRICE ? '官方参考价' : '自定义单价',
    }
  }

  const fetchBalance = async () => {`,
)

// ---------------------------------------------------------------- Q3 runtime 字段
rep(
  'Q3 runtime providers/turn',
  `    // 事件双通道：SSE 即时送达 + 收件箱轮询兜底。`,
  `    // 账户维度：每个供应商一份余额 / 今日消耗（有官方来源的读官方，没有的写未知）
    providers: {},
    providerOrder: [],
    modelCtx: { provider: '', model: '', at: 0, source: '' },
    // 每轮对话的聚合桶：按 (sessionId) 分桶，桶里带 turn —— 主会话与子代理并行也不会串账
    turnAggs: null,
    lastTurn: null,
    lastTurnSeq: 0,
    // 事件双通道：SSE 即时送达 + 收件箱轮询兜底。`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
