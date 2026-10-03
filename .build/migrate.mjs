// Re-apply the DSH 0.2 desktop migration onto a clean lib/index.js.
// Every replacement is a literal, verified, single-occurrence anchor.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'index.js')
const block = (name) => fs.readFileSync(path.join(ROOT, '.build', name), 'utf8').replace(/\r?\n$/, '')

let s = fs.readFileSync(TARGET, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
// normalize the in-memory copy to LF for matching, restore at the end
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

// ---------------------------------------------------------------- E1 header
rep(
  'E1 header',
  `//   - 本插件完全自包含，不引用、不依赖、不修改任何其它已装插件
// ============================================================================`,
  `//   - 本插件完全自包含，不引用、不依赖、不修改任何其它已装插件
//
// 前端怎么进页面（2026-10 桌面版迁移，见 README「桌面端注入」）：
//   唯一正确通道是 webServer 的**结构化 index 注入行**——监听
//   \`webserver/index-inject\` 事件，往收集表里 push 一行
//   \`{ kind: 'script-src', placement: 'head', src: '/maodie/maodie.js?v=…' }\`。
//   - 浏览器直连：frontend-static 渲染 index 时把行渲染成真正的 <script>
//   - 桌面端主窗口：页面跑在 dsh-app://app/ 下，Electron 壳不消费被改造过的
//     dist/index.html，而是启动时调 \`ctx.webServer.collectIndexInjections()\`
//     拿整张表，经 \`dshDesktopBoot.ready()\` 交给页面里的解释器逐行执行
//   - 相对路径 /maodie/… 在桌面端由 dsh-app:// 协议处理器转发给 Host（带会话
//     cookie），所以前端用相对路径即可，不需要知道 Host 端口
// ============================================================================`,
)

// ---------------------------------------------------------------- E2 version + base
rep(
  'E2 version/SCRIPT_SRC',
  `// 插件版本：用作前端脚本的缓存失效参数（页面 HTML 可能被缓存）
const PLUGIN_VERSION = '1.0.0'
const SCRIPT_TAG_MARK = '<!--maodie-injected-->'

// 前端该从哪个源取数据：桌面端主界面可能跑在自定义协议（dsh-app://app/）下，
// 那时相对路径发出的 fetch 不带 HTTP 会话；这里把真实 HTTP 基址明确告诉前端。
function resolveWebBase() {`,
  `// 插件版本：既做前端脚本的缓存失效参数，也是「前端脚本 vs Host 模块」版本对齐的依据
const PLUGIN_VERSION = '1.2.0'
// 前端脚本的 URL 前缀；注入行与自检页都用它拼，保持单一事实来源
const SCRIPT_SRC = ROUTE_BASE + '/maodie.js'

// 前端该从哪个源取数据。桌面端主界面跑在 dsh-app://app/ 下：
//   - 相对路径会被 dsh-app:// 协议处理器转发给 Host（并带上会话 cookie），
//     这是首选，因此这里默认返回空串（= 同源相对路径）。
//   - 若部署方确实需要绝对 HTTP 基址（例如把页面嵌到别的源里），
//     可用环境变量 DSH_WEB_URL 覆盖。
function resolveWebBase() {`,
)

// ---------------------------------------------------------------- E3 drop module-level electron hook
{
  const from = `// ---------------------------------------------------------------- 模块级协议钩子`
  const to = `// ---------------------------------------------------------------- 插件本体`
  const a = s.indexOf(from)
  const b = s.indexOf(to)
  if (a === -1 || b === -1 || b < a) {
    console.error('MISMATCH [E3 hook removal] markers not found')
    process.exit(1)
  }
  s = s.slice(0, a) + s.slice(b)
  console.log('ok  E3 hook removal')
}

// ---------------------------------------------------------------- E4 index injection block
{
  const from = `  // ---------------- 桌面端主窗口注入（关键） ----------------`
  const to = `  // ---------------- 自定义素材（用户上传） ----------------`
  const a = s.indexOf(from)
  const b = s.indexOf(to)
  if (a === -1 || b === -1 || b < a) {
    console.error('MISMATCH [E4 injection block] markers not found')
    process.exit(1)
  }
  s = s.slice(0, a) + block('blk-inject.js') + '\n\n' + s.slice(b)
  console.log('ok  E4 injection block')
}

// ---------------------------------------------------------------- E5 start() wiring
rep(
  'E5 start() wiring',
  `    // 桌面端主窗口注入（tapIndex 对 dsh-app:// 主窗口无效，必须走这条路）
    uninstallInjector = installMainWindowInjector(ctx)
    if (uninstallInjector) disposers.push(uninstallInjector)`,
  `    // 前端入页：结构化 index 注入行（浏览器直连与桌面端主窗口共用同一张表）
    disposers.push(installIndexInjector())`,
)

// ---------------------------------------------------------------- E6 tapIndex -> beacon/report/inbox routes
{
  const from = `    // —— index 注入 ——`
  const to = `    // —— 自检页（不设信任栅栏：只读诊断，便于排查"看不到猫"）——`
  const a = s.indexOf(from)
  const b = s.indexOf(to)
  if (a === -1 || b === -1 || b < a) {
    console.error('MISMATCH [E6 routes] markers not found')
    process.exit(1)
  }
  s = s.slice(0, a) + block('blk-beacon.js') + '\n' + s.slice(b)
  console.log('ok  E6 routes')
}

// ---------------------------------------------------------------- E7 diag
{
  const from = `    // —— 无认证诊断：看真实渲染后的 index HTML，确认脚本标签进去了没有 ——`
  const to = `    // —— 会话事件：任务完成 + usage ——`
  const a = s.indexOf(from)
  const b = s.indexOf(to)
  if (a === -1 || b === -1 || b < a) {
    console.error('MISMATCH [E7 diag] markers not found')
    process.exit(1)
  }
  s = s.slice(0, a) + block('blk-diag.js') + s.slice(b)
  console.log('ok  E7 diag')
}

// ---------------------------------------------------------------- E8 probeNative
rep(
  'E8 probeNative',
  `  // ---------------- 原生能力探针 ----------------
  let electronMod = null
  const probeNative = () => {
    if (runtime.native.probed) return runtime.native
    runtime.native.probed = true
    try {
      // 仅在 Electron 主进程里可解析；普通 Node 会抛 MODULE_NOT_FOUND
      // 用 createRequire 语义的 import 不行（同步需要 require），这里用动态 import 探测
      const req = typeof require === 'function' ? require : null
      if (req) {
        const electron = req('electron')
        if (electron && typeof electron === 'object') {
          electronMod = electron
          runtime.native.electron = true
          runtime.native.window = typeof electron.BrowserWindow === 'function'
          runtime.native.notify = typeof electron.Notification === 'function'
          runtime.native.reason = 'ok'
        } else {
          runtime.native.reason = 'electron module is not an object'
        }
      } else {
        runtime.native.reason = 'require unavailable'
      }
    } catch (err) {
      runtime.native.reason = String((err && err.code) || (err && err.message) || err)
    }
    return runtime.native
  }`,
  `  // ---------------- 原生能力探针 ----------------
  // 事实：桌面版把 Host 跑在**独立的 Node 子进程**里（process.execPath + ELECTRON_RUN_AS_NODE），
  // 所以 \`require('electron')\` 永远拿不到 BrowserWindow / Notification —— 原生
  // 闪烁与系统通知在这里注定不可用，前端会自动降级成
  // 「页面通知 + 标题闪烁 + 声音 + 气泡」（见 assets/maodie.js 的 runTurnEndDelivery）。
  // 保留这段探测是为了：① 万一将来 Host 被放回主进程也能用；② 在设置页如实报告状态。
  let electronMod = null
  const probeNative = () => {
    if (runtime.native.probed) return runtime.native
    runtime.native.probed = true
    try {
      const req = resolveRequire()
      if (req) {
        const electron = req('electron')
        if (electron && typeof electron === 'object' && typeof electron.BrowserWindow === 'function') {
          electronMod = electron
          runtime.native.electron = true
          runtime.native.window = typeof electron.BrowserWindow === 'function'
          runtime.native.notify = typeof electron.Notification === 'function'
          runtime.native.reason = 'ok'
        } else {
          runtime.native.reason = 'desktop-host-process(renderer-degrades)'
        }
      } else {
        runtime.native.reason = 'require unavailable'
      }
    } catch (err) {
      runtime.native.reason = 'desktop-host-process(renderer-degrades)'
    }
    return runtime.native
  }`,
)

// ---------------------------------------------------------------- E9 defaultState comment
rep(
  'E9 injectMainWindow comment',
  `      // 是否向桌面端主窗口注入前端（tapIndex 对 dsh-app:// 主窗口无效，走运行时读取注入）
      injectMainWindow: true,`,
  `      // 是否往 index 注入前端脚本行（webserver/index-inject）。
      // 关掉它 = 页面里不再出现猫；注入表是启动时收集的，改完需重新收集才生效
      injectMainWindow: true,`,
)

// ---------------------------------------------------------------- E10 doctor next-step text
rep(
  'E10 doctor text',
  `          'L.push("回到 DeepSeek Harness 主窗口，按 Ctrl+Shift+R 硬刷新；若还是不出现，按 F12 把 Console 里的红色报错发我。");',`,
  `          'L.push("回到 DeepSeek Harness 主窗口刷新页面；刚装好/刚改过 Host 代码的话桌面端需要重启一次。");',
          'L.push("还不出现就打开 /maodie/diag 看 frontend.booted 与 indexInjection，再按 F12 看 Console 红色报错。");',`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
