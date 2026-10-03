// Host patch 9 (1.2.9): the sound heal's intent gate must default to "on" for a missing
// notify.turnEnd block, exactly like the delivery code does. Otherwise a state file that
// simply omits notify.turnEnd would make the heal think "the user wants no sound".
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

rep('P1 version', `const PLUGIN_VERSION = '1.2.8'`, `const PLUGIN_VERSION = '1.2.9'`)

rep(
  'P2 heal intent defaults to on',
  `      const wants = []
      const te = state.notify && state.notify.turnEnd
      if (te && te.enabled !== false && te.sound !== false) wants.push('turn.end')`,
  `      const wants = []
      // 缺省即「要声音」：投递那边也是这么默认的（没有 notify.turnEnd 就当成开着），
      // 否则一个没写这一段的状态文件会让自愈误判成「用户不要声音」。
      const te = (state.notify && state.notify.turnEnd) || {}
      if (te.enabled !== false && te.sound !== false) wants.push('turn.end')`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
