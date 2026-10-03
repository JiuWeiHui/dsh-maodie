// Host patch 13 (1.3.0 第 4 步)：新路由改名，避免和原有 /maodie/usage.json（今日账本）撞名
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

// 新路由（第二个 usage.json）改名成 turn.json；原有 usage.json 保持不动
rep(
  'T1 新路由改名',
  `      path: ROUTE_BASE + '/providers.json',
      handler: (req, res) => {
        const view = mdProvidersView()
        sendJson(res, 200, Object.assign({ ok: true, at: Date.now(), current: runtime.modelCtx || null }, view))
      },
    })
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/usage.json',
      handler: (req, res) => {
        sendJson(res, 200, Object.assign({ ok: true, at: Date.now() }, mdUsageView()))
      },
    })`,
  `      path: ROUTE_BASE + '/providers.json',
      handler: (req, res) => {
        const view = mdProvidersView()
        sendJson(res, 200, Object.assign({ ok: true, at: Date.now(), current: runtime.modelCtx || null }, view))
      },
    })
    // 注意：不要叫 usage.json —— 原插件已经用它当日记账本路由了（撞名会被先注册的那个吃掉）
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/turn.json',
      handler: (req, res) => {
        sendJson(res, 200, Object.assign({ ok: true, at: Date.now() }, mdUsageView()))
      },
    })`,
)
fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
