// Host patch 14 (1.3.0 第 5 步)：我的「本轮统计」改名，避开原插件已有的 runtime.lastTurn（它存的是上一次投递负载）
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

rep('U1 runtime 字段改名', `    lastTurn: null,\n    lastTurnSeq: 0,`, `    lastTurnUsage: null,\n    lastTurnSeq: 0,`)
rep('U2 结算写入改名', `      runtime.lastTurn = turn`, `      runtime.lastTurnUsage = turn`)
rep('U3 账本写入改名', `      ledger.lastTurn = turn`, `      ledger.lastTurnUsage = turn`)
rep('U4 启动恢复改名', `      runtime.lastTurn = l.lastTurn || null`, `      runtime.lastTurnUsage = l.lastTurnUsage || null`)
rep('U5 usage 视图改名', `      turn: runtime.lastTurn || null,`, `      turn: runtime.lastTurnUsage || null,`)
rep('U6 status 字段改名', `          turn: runtime.lastTurn,\n          modelCtx: runtime.modelCtx,`, `          turn: runtime.lastTurnUsage,\n          modelCtx: runtime.modelCtx,`)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')

// 顺手把测试里的调试详情改回去
const t = path.join(ROOT, 'test', 'mount.test.mjs')
let ts = fs.readFileSync(t, 'utf8')
const a = "    'DEBUG2 ' + JSON.stringify(usage.turn),"
const b = "    String(usage.turn && usage.turn.tokens),"
if (ts.indexOf(a) !== -1) {
  ts = ts.split(a).join(b)
  fs.writeFileSync(t, ts)
  console.log('ok  测试详情改回')
}
