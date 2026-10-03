// 1.3.1 修正：
//   A. Host：把「通知文案一次性迁移」挪到 loadState() 之后（原来在之前 —— 会把默认配置写回、覆盖用户设置）
//   B. 前端：气泡里去掉原来那行「本次消耗（会话累计）」—— 现在它和新加的本轮同名，会混
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

function patch(rel, edits) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  const eol = s.includes('\r\n') ? '\r\n' : '\n'
  s = s.split('\r\n').join('\n')
  for (const [name, from, to, expect = 1] of edits) {
    const n = s.split(from).length - 1
    if (n !== expect) {
      console.error('MISMATCH [' + rel + ' ' + name + '] found=' + n + ' expected=' + expect)
      process.exit(1)
    }
    s = s.split(from).join(to)
    console.log('ok  ' + rel + ' :: ' + name)
  }
  fs.writeFileSync(p, s.split('\n').join(eol))
  console.log('written ' + rel)
}

const MIGRATION = `    // 一次性把「本次消耗」补进已有的任务完成文案：只补一次，
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
    }`

patch(path.join('.build', 'index.js'), [
  ['A1 摘掉位置不对的迁移', '\n' + MIGRATION + '\n', '\n'],
  [
    'A2 放到 loadState 之后',
    `    runtime.soundHeal = healSilentTriggers()`,
    `    runtime.soundHeal = healSilentTriggers()
${MIGRATION}`,
  ],
])

patch(path.join('.build', 'frontend.js'), [
  [
    'B1 去掉会话版「本次消耗」行',
    `      // 本次消耗：当前会话花了多少（余额差口径 + 真实 usage）
      if (state.look.showSessionCost !== false) {
        var r4 = el('div', 'md-bubble-row')
        r4.appendChild(el('span', 'md-k', '本次消耗'))
        r4.appendChild(el('span', 'md-v', data.session ? fmtSessionLine(data.session) : '等待会话数据'))
        rows.appendChild(r4)
        // （会话口径也不在气泡里展开，避免又出现一行小字）
      }`,
    `      // 会话累计口径不再进气泡（用户要的是「本次消耗」＝这一轮）：
      // 会话数据仍在 status.json / diag / 「用量」页里，想看随时能看。`,
  ],
])
