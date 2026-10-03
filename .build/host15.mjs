// Host patch 15 (1.3.1)：
//   1. 通知文案里可以用 {turnCost} / {turnTokens}（本次消耗＝这一轮对话）
//   2. 一次性把「本次消耗」补进用户已有的通知文案（只补一次，之后用户自己的编辑不再被动）
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

rep('X1 version', `const PLUGIN_VERSION = '1.3.0'`, `const PLUGIN_VERSION = '1.3.1'`)

rep(
  'X2 占位符 turnCost/turnTokens',
  `  const renderTemplate = (tpl, extra = {}) => {
    const usage = usageView()
    const peak = peakInfo()
    const session = sessionView()`,
  `  const renderTemplate = (tpl, extra = {}) => {
    const usage = usageView()
    const peak = peakInfo()
    const session = sessionView()
    const turnNow = runtime.lastTurnUsage || null`,
)
rep(
  'X2b 占位符表',
  `        // 本次消耗（当前会话）
        session: session && session.cost !== null ? session.cost.toFixed(4) : '--',`,
  `        // 本次消耗 = 这一轮对话（一次指令 → 一次完成）：金额 + token
        turnCost: turnNow && isFinite(turnNow.amount) ? Number(turnNow.amount).toFixed(4) : '--',
        turnTokens: turnNow ? String(turnNow.tokens || 0) : '0',
        turnModel: turnNow ? String(turnNow.model || '') : '',
        // 本次会话（累计口径，保留兼容）
        session: session && session.cost !== null ? session.cost.toFixed(4) : '--',`,
)

rep(
  'X3 一次性补进通知文案',
  `    mdRegisterProviders()`,
  `    mdRegisterProviders()
    // 一次性把「本次消耗」补进已有的任务完成文案：只补一次，
    // 之后你在设置里怎么改都不会再被动（记在 state.meta.turnCostInBody）
    try {
      const cfg = state.notify && state.notify.turnEnd
      const meta = state.meta || (state.meta = {})
      if (
        cfg &&
        typeof cfg.body === 'string' &&
        cfg.body.indexOf('{turnCost}') === -1 &&
        meta.turnCostInBody !== true
      ) {
        cfg.body = (cfg.body ? cfg.body + ' · ' : '') + '本次消耗 ¥{turnCost}（{turnTokens} tokens）'
        meta.turnCostInBody = true
        saveState()
      }
    } catch (err) {
      /* 忽略 */
    }`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
