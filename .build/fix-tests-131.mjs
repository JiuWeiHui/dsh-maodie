// 1.3.1 测试期望更新：
//   dom：气泡主行改叫「本次消耗」；并断言「小字」（口径行 / 账户清单）确实不在气泡里了
//   mount：通知文案的一次性迁移 + {turnCost} 渲染
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
}

patch(path.join('test', 'dom.test.mjs'), [
  [
    'Z1 气泡主行改名 + 断言没有小字',
    `  check('气泡里显示本轮金额', !!bubble && bubble.textContent.indexOf('本轮') !== -1 && bubble.textContent.indexOf('¥ 0.42') !== -1, bubble && bubble.textContent.slice(0, 160))`,
    `  check('气泡里显示「本次消耗」金额', !!bubble && bubble.textContent.indexOf('本次消耗') !== -1 && bubble.textContent.indexOf('¥ 0.42') !== -1, bubble && bubble.textContent.slice(0, 160))
  {
    // 用户要求：气泡里那些小字（口径明细、含一堆账户的清单）都要去掉
    const bt = bubble ? bubble.textContent : ''
    check('气泡里不再有账户清单小字（含 xx ¥…（仅供参考））', bt.indexOf('含 xiaomi ¥0.56（仅供参考）') === -1, bt.slice(0, 220))
    check('气泡里不再有会话口径小字', bt.indexOf('自本次会话开始') === -1 && bt.indexOf('余额差') === -1, bt.slice(0, 220))
    check('「仅供参考」改成并到数值括号里', bt.indexOf('（仅供参考）') !== -1, bt.slice(0, 220))
    check('气泡里没有只有一行空 key 的小字行', bt.indexOf('按自定义单价估算') === -1, bt.slice(0, 220))
  }`,
  ],
  [
    'Z2 去掉会话口径那行断言',
    `  check('气泡里带余额差口径说明', !!b && b.textContent.indexOf('自本次会话开始') !== -1)`,
    `  check('会话累计口径不再进气泡（用户要的是本次消耗）', !!b && b.textContent.indexOf('自本次会话开始') === -1, b && b.textContent.slice(0, 200))`,
  ],
])

patch(path.join('test', 'mount.test.mjs'), [
  [
    'Z3 通知文案迁移 + 占位符',
    `  check('推送了 alarm 事件', frame.indexOf('"type":"alarm"') !== -1)`,
    `  check('推送了 alarm 事件', frame.indexOf('"type":"alarm"') !== -1)
  {
    // 1.3.1：通知文案里能用 {turnCost}/{turnTokens}，并且挂载时一次性把「本次消耗」补进已有文案
    const st = (await callRoute('/maodie/state.json')).json()
    const tcfg = st.state && st.state.notify && st.state.notify.turnEnd
    check(
      '任务完成文案被补上「本次消耗」占位符',
      !!tcfg && typeof tcfg.body === 'string' && tcfg.body.indexOf('{turnCost}') !== -1,
      tcfg && tcfg.body,
    )
    check('迁移只做一次（有标记）', !!(st.state.meta && st.state.meta.turnCostInBody === true))
  }`,
  ],
])
