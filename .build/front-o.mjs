// Frontend patch 12 (1.3.1)：
//   1. 气泡去掉所有「小字」（口径行 / 含一堆账户的 totals.note / 今日 tokens dim 行）
//      —— 这些信息搬到设置里的「用量」页；「仅供参考」改成并到数值后面的括号
//   2. 「本轮」改叫「本次消耗」（用户的说法）
//   3. 提醒页的占位符提示补上 {turnCost} / {turnTokens}
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'frontend.js')
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

rep('Y1 version', `  var MAODIE_VERSION = '1.3.0'`, `  var MAODIE_VERSION = '1.3.1'`)

rep(
  'Y2 气泡去掉小字',
  `      if (turnInfo) {
        var r0 = el('div', 'md-bubble-row')
        r0.appendChild(el('span', 'md-k', '本轮'))
        r0.appendChild(el('span', 'md-v', '¥ ' + fmtMoney(turnInfo.amount) + ' · ' + fmtTokens(turnInfo.tokens || 0) + ' tokens'))
        rows.appendChild(r0)
        var r0b = el('div', 'md-bubble-row md-dim')
        r0b.appendChild(el('span', 'md-k', ''))
        r0b.appendChild(el('span', 'md-v', (turnInfo.model || turnInfo.provider || '') + ' · ' + (turnInfo.amountBasis || '')))
        rows.appendChild(r0b)
      }
      // 今日（当前账户）+ 总消耗（所有账户）
      if (curProv && curProv.today) {
        var rt = el('div', 'md-bubble-row')
        rt.appendChild(el('span', 'md-k', '今日（本账户）'))
        var todayV =
          curProv.today.officialCost !== null && curProv.today.officialCost !== undefined
            ? '¥ ' + fmtMoney(curProv.today.officialCost) + '（官方）'
            : curProv.today.estimateCost
              ? '¥ ' + fmtMoney(curProv.today.estimateCost) + '（仅供参考）'
              : '--'
        rt.appendChild(el('span', 'md-v', todayV))
        rows.appendChild(rt)
      }
      if (provInfo && provInfo.totals) {
        var ra = el('div', 'md-bubble-row')
        ra.appendChild(el('span', 'md-k', '总消耗（全部）'))
        ra.appendChild(el('span', 'md-v', '¥ ' + fmtMoney(provInfo.totals.todayAmount) + ' · ' + fmtTokens(provInfo.totals.todayTokens || 0)))
        rows.appendChild(ra)
        if (provInfo.totals.note) {
          var rb = el('div', 'md-bubble-row md-dim')
          rb.appendChild(el('span', 'md-k', ''))
          rb.appendChild(el('span', 'md-v', provInfo.totals.note))
          rows.appendChild(rb)
        }
      }`,
  `      // 气泡里只留主行，不放小字（口径明细、账户清单都去设置里的「用量」页看）；
      // 「仅供参考」这类诚实标注并到数值后面的括号里，不额外占一行。
      if (turnInfo) {
        var r0 = el('div', 'md-bubble-row')
        r0.appendChild(el('span', 'md-k', '本次消耗'))
        var turnV = '¥ ' + fmtMoney(turnInfo.amount) + ' · ' + fmtTokens(turnInfo.tokens || 0) + ' tokens'
        if (String(turnInfo.amountBasis || '').indexOf('仅供参考') !== -1) turnV += '（仅供参考）'
        r0.appendChild(el('span', 'md-v', turnV))
        rows.appendChild(r0)
      }
      // 今日（当前账户）+ 总消耗（所有账户）
      if (curProv && curProv.today) {
        var rt = el('div', 'md-bubble-row')
        rt.appendChild(el('span', 'md-k', '今日（本账户）'))
        var todayV =
          curProv.today.officialCost !== null && curProv.today.officialCost !== undefined
            ? '¥ ' + fmtMoney(curProv.today.officialCost) + '（官方）'
            : curProv.today.estimateCost
              ? '¥ ' + fmtMoney(curProv.today.estimateCost) + '（仅供参考）'
              : '--'
        rt.appendChild(el('span', 'md-v', todayV))
        rows.appendChild(rt)
      }
      if (provInfo && provInfo.totals) {
        var ra = el('div', 'md-bubble-row')
        ra.appendChild(el('span', 'md-k', '总消耗（全部）'))
        var allV = '¥ ' + fmtMoney(provInfo.totals.todayAmount) + ' · ' + fmtTokens(provInfo.totals.todayTokens || 0)
        var estN = provInfo.totals.estimated ? provInfo.totals.estimated.length : 0
        if (estN > 0) allV += '（部分仅供参考）'
        ra.appendChild(el('span', 'md-v', allV))
        rows.appendChild(ra)
      }`,
)

// 原来的「今日 tokens（dim）」也去掉
rep(
  'Y3 去掉今日 tokens 小字',
  `      var r3 = el('div', 'md-bubble-row md-dim')
      r3.appendChild(el('span', 'md-k', '≈ tokens（今日）'))
      r3.appendChild(el('span', 'md-v', fmtTokens(data.usage.tokens) + ' · ' + (data.usage.costBasis || '')))
      rows.appendChild(r3)`,
  `      // （今日 token 总量与口径不再占气泡的行，去设置里看）`,
)

// 会话那两行的 dim 口径行也去掉（它也是小字）
rep(
  'Y4 会话区去掉小字',
  `        if (data.session && data.session.costBasis) {
          var r5 = el('div', 'md-bubble-row md-dim')
          r5.appendChild(el('span', 'md-k', ''))
          r5.appendChild(el('span', 'md-v', data.session.costBasis))
          rows.appendChild(r5)
        }`,
  `        // （会话口径也不在气泡里展开，避免又出现一行小字）`,
)

rep(
  'Y5 占位符提示',
  `}), '可用占位符：{today} {balance} {tokens} {peak} {currency}'))`,
  `}), '可用占位符：{turnCost} {turnTokens} {turnModel}（本次消耗）· {today} {balance} {tokens} {peak} {currency} · {session} {sessionTokens} {turns}（本次会话）'))`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
