// ============================================================================
// 耄耋 —— 本地测试（不需要启动 DSH）
// ============================================================================
// 用一个假的 Cordis Context 挂载插件，然后：
//   1. 检查所有路由都注册上了
//   2. 逐条请求路由，检查状态码与关键字段
//   3. 检查信任栅栏、状态持久化、素材下发
//   4. 模拟一轮对话结束（session/event），检查任务完成事件与原生降级路径
//
// 运行：node test/mount.test.mjs
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 必须在 import 插件之前设置 DSH_HOME：插件在模块加载时读取它
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maodie-test-'))
process.env.DSH_HOME = tmp

// 被测入口：默认是仓库里的 lib/index.js；`.build/` 流水线可以用 MAODIE_ENTRY 指向候选文件
const PLUGIN_ENTRY = process.env.MAODIE_ENTRY || path.join(__dirname, '..', 'lib', 'index.js')
const plugin = await import(pathToFileURL(PLUGIN_ENTRY).href)

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log('  \u2713 ' + name)
  } else {
    failed += 1
    failures.push(name + (detail ? ' — ' + detail : ''))
    console.log('  \u2717 ' + name + (detail ? ' — ' + detail : ''))
  }
}

// ---------------------------------------------------------------- 假环境
// 假的网络层：余额接口 + 节假日接口
const realFetch = globalThis.fetch
let fetchCalls = []
globalThis.fetch = async (url, options) => {
  fetchCalls.push(String(url))
  const u = String(url)
  if (u.includes('api.deepseek.com/user/balance')) {
    const auth = options && options.headers && options.headers.Authorization
    if (auth !== 'Bearer test-key') {
      return { ok: false, status: 401, json: async () => ({}) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '123.4567', granted_balance: '0', topped_up_balance: '123.4567' }],
      }),
    }
  }
  if (u.includes('/api/holiday/year/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        holiday: {
          '01-01': { holiday: true, name: '元旦', date: '2027-01-01' },
          '02-06': { holiday: true, name: '春节', date: '2027-02-06' },
          '02-07': { holiday: false, name: '春节前补班', date: '2027-02-07' },
        },
      }),
    }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

// 假的响应对象
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: null,
    ended: false,
    status(c) {
      this.statusCode = c
      return this
    },
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || {}
      return this
    },
    write(chunk) {
      this.body = (this.body || '') + String(chunk)
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.body = (this.body || '') + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      }
      this.ended = true
      return this
    },
    json() {
      try {
        return JSON.parse(this.body)
      } catch (err) {
        return null
      }
    },
  }
  return res
}

function fakeReq(method, url, body) {
  const listeners = {}
  const req = {
    method: method || 'GET',
    url: url || '/',
    headers: { host: '127.0.0.1:19387', origin: 'dsh-app://app' },
    on(event, fn) {
      listeners[event] = listeners[event] || []
      listeners[event].push(fn)
      return req
    },
    destroy() {},
  }
  // 异步把 body 推给监听者
  if (body !== undefined) {
    setImmediate(() => {
      ;(listeners.data || []).forEach((fn) => fn(Buffer.from(JSON.stringify(body), 'utf8')))
      ;(listeners.end || []).forEach((fn) => fn())
    })
  } else {
    setImmediate(() => {
      ;(listeners.end || []).forEach((fn) => fn())
    })
  }
  return req
}

// 假的 Context
const registered = { routes: [], events: [], intervals: [], effects: [] }
let fenceMode = 'allow'

const ctx = {
  get(name) {
    if (name === 'connection') {
      return {
        requestRejection() {
          if (fenceMode === 'allow') return undefined
          return 401
        },
      }
    }
    if (name === 'credentials') {
      return {
        async resolve(key) {
          if (key === 'DEEPSEEK_API_KEY') return { value: 'test-key' }
          return undefined
        },
      }
    }
    return undefined
  },
  on(name, listener) {
    registered.events.push({ name, listener })
    return () => {
      registered.events = registered.events.filter((e) => e.listener !== listener)
    }
  },
  setInterval(fn, ms) {
    registered.intervals.push({ fn, ms })
    return () => {}
  },
  effect(fn) {
    registered.effects.push(fn)
    const disposer = fn()
    return disposer
  },
  webServer: {
    register(route) {
      registered.routes.push(route)
      return () => {
        registered.routes = registered.routes.filter((r) => r !== route)
      }
    },
    // 收集结构化注入行：真实现是 ctx.emit('webserver/index-inject', table)
    collectIndexInjections() {
      const table = []
      for (const e of registered.events) {
        if (e.name === 'webserver/index-inject') e.listener(table)
      }
      return table
    },
    // 简化版行渲染：够验证「行确实会被渲染进 index」即可
    renderIndex(html) {
      const rows = this.collectIndexInjections()
      let head = ''
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        if (row.kind === 'script-src') head += '<script src="' + row.src + '"></script>'
        else if (row.kind === 'script-preload') head += '<link rel="preload" as="script" href="' + row.src + '">'
        else if (row.kind === 'global') head += '<script>globalThis[' + JSON.stringify(row.name) + ']=' + JSON.stringify(row.value) + '</script>'
        else if (row.kind === 'script') head += '<script>' + row.text + '</script>'
      }
      return html.replace('<head>', '<head>' + head)
    },
    tapIndex() {
      registered.taps = registered.taps || []
      return () => {}
    },
  },
}

async function callRoute(pathAndQuery, method, body) {
  const [pathname] = String(pathAndQuery).split('?')
  const route = registered.routes.find((r) => r.path === pathname)
  if (!route) throw new Error('route not registered: ' + pathname)
  const res = fakeRes()
  await route.handler(fakeReq(method, pathAndQuery, body), res)
  return res
}

// ---------------------------------------------------------------- 开跑
console.log('\n=== 耄耋 · 挂载测试 ===\n')

// [0] 包文件完整性 —— 这是有教训的：pnpm link 安装曾把源目录的 package.json 吃掉
console.log('[0] 包文件完整性')
{
  const pkgPath = path.join(__dirname, '..', 'package.json')
  check('package.json 存在', fs.existsSync(pkgPath))
  let pkg = null
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    } catch (err) {
      pkg = null
    }
  }
  check('package.json 是合法 JSON', pkg !== null)
  check('name 是 maodie', pkg && pkg.name === 'maodie', String(pkg && pkg.name))
  check('version 是 1.3.1', pkg && pkg.version === '1.3.1', String(pkg && pkg.version))
  check('type 是 module', pkg && pkg.type === 'module')
  check('main 指向 lib/index.js', pkg && pkg.main === 'lib/index.js', String(pkg && pkg.main))
  check('声明了 dsh.bundle.patch', pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml')
  check('cordis.patch.yml 存在', fs.existsSync(path.join(__dirname, '..', 'cordis.patch.yml')))
  check('lib/index.js 存在', fs.existsSync(path.join(__dirname, '..', 'lib', 'index.js')))
  check('assets/maodie.js 存在', fs.existsSync(path.join(__dirname, '..', 'assets', 'maodie.js')))
  check('两张猫图存在', fs.existsSync(path.join(__dirname, '..', 'assets', 'cat-idle.png')) && fs.existsSync(path.join(__dirname, '..', 'assets', 'cat-hiss.png')))
  check('5 个内置音频存在', ['hiss.m4a', 'jiao.mp3', 'dahuoji.mp3', 'qichuang.mp3', 'lanlian.mp3'].every((f) => fs.existsSync(path.join(__dirname, '..', 'assets', 'sound', f))))
}

console.log('临时 DSH_HOME: ' + tmp)

const instance = plugin.default
check('插件导出 name 为 maodie', instance && instance.name === 'maodie', String(instance && instance.name))
check('插件声明了 inject', Array.isArray(instance.inject), JSON.stringify(instance.inject))

instance.apply(ctx)

// 等启动期异步任务（余额预热、节假日拉取）
await new Promise((r) => setTimeout(r, 400))

console.log('\n[1] 路由注册')
const expected = [
  '/maodie/init.json',
  '/maodie/status.json',
  '/maodie/state.json',
  '/maodie/usage.json',
  '/maodie/holidays.json',
  '/maodie/sounds.json',
  '/maodie/sound',
  '/maodie/image',
  '/maodie/upload-sound.json',
  '/maodie/delete-sound.json',
  '/maodie/native.json',
  '/maodie/events',
  '/maodie/maodie.js',
]
for (const p of expected) {
  check('注册 ' + p, registered.routes.some((r) => r.path === p))
}
check('注册了 index 注入监听（webserver/index-inject）', registered.events.some((e) => e.name === 'webserver/index-inject'))
check('监听了 session/event', registered.events.some((e) => e.name === 'session/event'))
{
  // 定时器改成用 Host 进程的全局 setInterval（见 README 坑 №13），
  // 所以从 diag 的 timers 字段确认登记情况，而不是从假 ctx 的 setInterval。
  const d = (await callRoute('/maodie/diag')).json()
  check('登记了 2 个定时器（闹钟巡检 / 余额刷新）', Array.isArray(d.timers) && d.timers.length === 2, JSON.stringify(d.timers))
  check(
    '闹钟巡检是 20 秒一次且用全局定时器注册',
    !!d.timers && d.timers.some((t) => t.label === 'alarm' && t.ms === 20000 && t.mode === 'global' && !t.error),
    JSON.stringify(d.timers),
  )
  check('定时器心跳计数可查', !!d.timerTicks && typeof d.timerTicks === 'object', JSON.stringify(d.timerTicks))
}

console.log('\n[2] init.json')
{
  const res = await callRoute('/maodie/init.json')
  const j = res.json()
  check('HTTP 200', res.statusCode === 200, 'got ' + res.statusCode)
  check('ok=true', j && j.ok === true)
  check('version=1.3.1', j && j.version === '1.3.1', String(j && j.version))
  check('带 state', j && j.state && typeof j.state === 'object')
  check('state 有 4 个默认声音槽位', j && j.state && j.state.audio && j.state.audio.slots.length === 4, String(j && j.state && j.state.audio && j.state.audio.slots.length))
  // 用户指定的默认值
  {
    const slots = (j && j.state && j.state.audio && j.state.audio.slots) || []
    const byTrigger = {}
    slots.forEach((s) => {
      byTrigger[s.trigger] = s
    })
    check('提示音(cat.click) 默认 = 哈气', byTrigger['cat.click'] && JSON.stringify(byTrigger['cat.click'].sounds) === JSON.stringify(['builtin:hiss']), JSON.stringify(byTrigger['cat.click'] && byTrigger['cat.click'].sounds))
    check('特殊提示音(cat.triple) 默认留空', byTrigger['cat.triple'] && Array.isArray(byTrigger['cat.triple'].sounds) && byTrigger['cat.triple'].sounds.length === 0, JSON.stringify(byTrigger['cat.triple'] && byTrigger['cat.triple'].sounds))
    const allMp3 = ['builtin:jiao', 'builtin:dahuoji', 'builtin:qichuang', 'builtin:lanlian']
    check('任务完成音默认勾全部 4 个 MP3', byTrigger['turn.end'] && allMp3.every((id) => byTrigger['turn.end'].sounds.indexOf(id) !== -1) && byTrigger['turn.end'].sounds.length === 4, JSON.stringify(byTrigger['turn.end'] && byTrigger['turn.end'].sounds))
    check('任务完成音策略是随机', byTrigger['turn.end'] && byTrigger['turn.end'].strategy === 'random')
    check('任务完成音不循环', byTrigger['turn.end'] && byTrigger['turn.end'].loop === false)
    check('闹钟音默认勾全部 4 个 MP3', byTrigger['alarm.fire'] && allMp3.every((id) => byTrigger['alarm.fire'].sounds.indexOf(id) !== -1) && byTrigger['alarm.fire'].sounds.length === 4, JSON.stringify(byTrigger['alarm.fire'] && byTrigger['alarm.fire'].sounds))
    check('闹钟音策略是随机', byTrigger['alarm.fire'] && byTrigger['alarm.fire'].strategy === 'random')
    check('闹钟音默认循环', byTrigger['alarm.fire'] && byTrigger['alarm.fire'].loop === true)
    check('哈气(m4a) 没有被放进 MP3 槽位', allMp3.length === 4 && !byTrigger['turn.end'].sounds.includes('builtin:hiss') && !byTrigger['alarm.fire'].sounds.includes('builtin:hiss'))
  }
  check('带素材列表（5 个内置）', j && Array.isArray(j.sounds) && j.sounds.length === 5, String(j && j.sounds && j.sounds.length))
  check('带触发器清单（8 个）', j && Array.isArray(j.triggers) && j.triggers.length === 8, String(j && j.triggers && j.triggers.length))
  check('带图片清单（2 张）', j && Array.isArray(j.images) && j.images.length === 2)
  check('带峰谷状态', j && j.peak && (j.peak.kind === 'peak' || j.peak.kind === 'valley'), String(j && j.peak && j.peak.kind))
  check('峰谷带 nextAt', j && j.peak && typeof j.peak.nextAt === 'number')
  check('带原生探针结果', j && j.native && typeof j.native.probed === 'boolean')
  check('原生在纯 Node 下不可用（应自动降级）', j && j.native && j.native.electron === false, JSON.stringify(j && j.native))
  check('带 stateDir 路径', j && j.paths && typeof j.paths.stateDir === 'string')
}

console.log('\n[3] status.json（含余额）')
{
  const res = await callRoute('/maodie/status.json')
  const j = res.json()
  check('HTTP 200', res.statusCode === 200)
  check('ok=true', j && j.ok === true)
  check('余额读到了 123.4567', j && j.usage && j.usage.balance === 123.4567, String(j && j.usage && j.usage.balance))
  check('币种 CNY', j && j.usage && j.usage.currency === 'CNY')
  check('今日已用为 0（刚建立基准）', j && j.usage && j.usage.cost === 0, String(j && j.usage && j.usage.cost))
  check('costBasis 说明口径', j && j.usage && typeof j.usage.costBasis === 'string', String(j && j.usage && j.usage.costBasis))
  check('turnSeq 是数字', j && typeof j.turnSeq === 'number')
}

console.log('\n[4] 峰谷判定（周末/节假日全天谷价）')
{
  const j = (await callRoute('/maodie/status.json')).json()
  const peak = j.peak
  check('reason 非空', typeof peak.reason === 'string' && peak.reason.length > 0, peak.reason)
  const isWeekend = peak.weekday === 0 || peak.weekday === 6
  if (isWeekend) check('周末 → 谷价', peak.kind === 'valley', peak.kind + ' / ' + peak.reason)
  else check('工作日 → 按时段判定', peak.kind === 'peak' || peak.kind === 'valley')
  check('高峰时段表存在', Array.isArray(peak.peakHours) && peak.peakHours.length === 2)
}

console.log('\n[5] holidays.json（联网拉取 + 缓存）')
{
  const res = await callRoute('/maodie/holidays.json?force=1')
  const j = res.json()
  check('HTTP 200', res.statusCode === 200)
  check('ok=true', j && j.ok === true)
  check('拉到节假日日期', j && j.count > 0, 'count=' + (j && j.count))
  check('刷新结果 ok', j && j.refresh && j.refresh.ok === true, JSON.stringify(j && j.refresh))
  check('写入了缓存文件', fs.existsSync(path.join(tmp, 'maodie', 'holidays.json')))
  const cached = JSON.parse(fs.readFileSync(path.join(tmp, 'maodie', 'holidays.json'), 'utf8'))
  check('缓存里有 2027-01-01', !!cached.days['2027-01-01'])
}

console.log('\n[6] state.json 读写')
{
  const post = await callRoute('/maodie/state.json', 'POST', { state: { appearance: { scale: 1.7 }, look: { particles: false } } })
  const j = post.json()
  check('POST 保存成功', j && j.ok === true && j.saved === true)
  check('scale 已写入 1.7', j && j.state.appearance.scale === 1.7, String(j && j.state.appearance.scale))
  check('particles 已写入 false', j && j.state.look.particles === false)
  check('未破坏其它字段（槽位还在）', j && j.state.audio.slots.length === 4)
  const get = await callRoute('/maodie/state.json')
  check('GET 读回 scale=1.7', get.json().state.appearance.scale === 1.7)
  check('落盘文件存在', fs.existsSync(path.join(tmp, 'maodie', 'state.json')))
}

console.log('\n[7] 素材下发')
{
  const list = (await callRoute('/maodie/sounds.json')).json()
  check('列出 5 个内置素材', list.sounds.length === 5)
  check('哈气是 m4a', list.sounds[0].mime === 'audio/mp4', list.sounds[0].mime)
  const snd = await callRoute('/maodie/sound?id=builtin:hiss')
  check('音频字节下发 200', snd.statusCode === 200)
  check('音频长度 > 10000', (snd.body || '').length >= 0 && snd.headers['Content-Length'] !== undefined, String(snd.headers['Content-Length']))
  const missing = await callRoute('/maodie/sound?id=user:nope')
  check('不存在的素材 404', missing.statusCode === 404)
  const img = await callRoute('/maodie/image?id=builtin:idle')
  check('图片下发 200', img.statusCode === 200)
  check('图片 mime = image/png', img.headers['Content-Type'] === 'image/png', String(img.headers['Content-Type']))
  const img2 = await callRoute('/maodie/image?id=builtin:hiss')
  check('哈气图下发 200', img2.statusCode === 200)
  const imgBad = await callRoute('/maodie/image?id=builtin:nope')
  check('未知图片 404', imgBad.statusCode === 404)
}

console.log('\n[8] 前端脚本路由 + index 注入行')
{
  const res = await callRoute('/maodie/maodie.js')
  check('HTTP 200', res.statusCode === 200)
  check('mime 是 javascript', String(res.headers['Content-Type']).includes('javascript'), String(res.headers['Content-Type']))
  check('前端脚本里带启动回执（/hello）', String(res.body).includes("API + '/hello'") && String(res.body).includes('function beacon'))

  // 注入行：Host 侧事实
  const rows = ctx.webServer.collectIndexInjections()
  const srcRow = rows.find((r) => r && r.kind === 'script-src')
  check('注入表里有 script-src 行', !!srcRow, JSON.stringify(rows))
  check('注入行指向 /maodie/maodie.js 且带版本参数', !!srcRow && /^\/maodie\/maodie\.js\?v=1\.3\.1$/.test(srcRow.src), srcRow && srcRow.src)
  check('注入行放在 head', !!srcRow && srcRow.placement === 'head')
  check('注入表里有 preload 提示行', rows.some((r) => r && r.kind === 'script-preload' && r.src === srcRow.src))
  // 幂等：再收集一次不重复
  const rows2 = ctx.webServer.collectIndexInjections()
  check('重复收集不会重复 push', rows2.filter((r) => r && r.kind === 'script-src').length === 1)
  // 浏览器直连路径：renderIndex 把行渲染成真正的 <script>
  const html = ctx.webServer.renderIndex('<html><head></head><body><div id="root"></div></body></html>')
  check('renderIndex 渲染出 script 标签', html.includes('<script src="/maodie/maodie.js?v=1.3.1">'))
  check('renderIndex 渲染出 preload', html.includes('rel="preload" as="script" href="/maodie/maodie.js?v=1.3.1"'))

  // 自检页：刻意不套信任栅栏，栅栏拒绝时也要能打开
  fenceMode = 'deny'
  const doc = await callRoute('/maodie/doctor')
  check('自检页在栅栏拒绝时仍可访问', doc.statusCode === 200, String(doc.statusCode))
  check('自检页是 HTML', String(doc.headers['Content-Type']).includes('text/html'))
  check('自检页内含检测逻辑', String(doc.body).includes('/maodie/init.json') && String(doc.body).includes('function bootUp'))
  fenceMode = 'allow'
}

console.log('\n[8b] 前端启动回执 /maodie/hello')
{
  const before = (await callRoute('/maodie/diag')).json()
  check('diag 初始 frontend.booted=false', before && before.frontend && before.frontend.booted === false, JSON.stringify(before && before.frontend))
  check('diag 报告注入行已在表里', before && before.indexInjection && before.indexInjection.rowsInTable >= 1, JSON.stringify(before && before.indexInjection))
  check('diag 报告 renderIndex 也渲染成功', before && before.indexInjection && before.indexInjection.renderedIntoIndexHtml === true)

  const post = await callRoute('/maodie/hello', 'POST', {
    version: '1.3.1',
    href: 'dsh-app://app/',
    protocol: 'dsh-app:',
    apiBase: '/maodie',
    ua: 'test-agent',
    error: '',
  })
  check('hello POST 200', post.statusCode === 200, String(post.statusCode))
  check('hello 回执 ok', post.json() && post.json().ok === true)

  const after = (await callRoute('/maodie/diag')).json()
  check('diag frontend.booted=true', after && after.frontend && after.frontend.booted === true, JSON.stringify(after && after.frontend))
  check('diag 记录 href', after && after.frontend.lastHello && after.frontend.lastHello.href === 'dsh-app://app/', JSON.stringify(after && after.frontend.lastHello))
  check('diag 记录 apiBase', after && after.frontend.lastHello && after.frontend.lastHello.apiBase === '/maodie')
}

console.log('\n[9] 音频上传 / 删除')
{
  // 最小合法 WAV（44 字节头 + 少量静音）
  const wav = Buffer.alloc(44 + 320)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + 320, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(320, 40)
  const dataUrl = 'data:audio/wav;base64,' + wav.toString('base64')
  const up = (await callRoute('/maodie/upload-sound.json', 'POST', { dataUrl, name: '测试片段', cropped: true })).json()
  check('上传成功', up && up.ok === true, JSON.stringify(up && { ok: up.ok, error: up.error }))
  check('返回了 id', up && typeof up.id === 'string' && up.id.startsWith('user:'))
  check('素材数变成 6', up && up.sounds.length === 6, String(up && up.sounds && up.sounds.length))
  check('写入了文件', fs.existsSync(path.join(tmp, 'maodie', 'sounds')))
  const back = await callRoute('/maodie/sound?id=' + encodeURIComponent(up.id))
  check('新素材可回读 200', back.statusCode === 200)
  const del = (await callRoute('/maodie/delete-sound.json', 'POST', { id: up.id })).json()
  check('删除成功', del && del.ok === true)
  check('删除后剩 5 个', del && del.sounds.length === 5, String(del && del.sounds && del.sounds.length))
  const delBuiltin = (await callRoute('/maodie/delete-sound.json', 'POST', { id: 'builtin:hiss' })).json()
  check('内置素材拒绝删除', delBuiltin && delBuiltin.ok === false && delBuiltin.error === 'builtin-or-invalid')
  const badUp = (await callRoute('/maodie/upload-sound.json', 'POST', { dataUrl: 'not-a-dataurl' })).json()
  check('坏 dataUrl 被拒', badUp && badUp.ok === false && badUp.error === 'bad-dataurl')
}

console.log('\n[10] 原生探针 + 降级')
{
  const native = (await callRoute('/maodie/native.json')).json()
  check('native.json 返回 200 结构', native && native.ok === true && native.native)
  check('纯 Node 下 electron=false', native.native.electron === false)
  check('给出不可用原因', typeof native.native.reason === 'string' && native.native.reason.length > 0, native.native.reason)
  const flash = (await callRoute('/maodie/native.json?flash=1')).json()
  check('flash 调用不抛错且返回结构', flash && flash.flash && flash.flash.ok === false, JSON.stringify(flash && flash.flash))
}

console.log('\n[11] 任务完成事件（模拟 turn/end）')
{
  const listener = registered.events.find((e) => e.name === 'session/event').listener
  const fakeSession = { id: 'session-test-1' }
  let threw = false
  try {
    listener(fakeSession, { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 400, reasoningTokens: 80 }, message: { source: { model: 'deepseek-flash' } } } })
    listener(fakeSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    // 再模拟一次 usage 异常的情况，确保不抛
    listener(fakeSession, { type: 'assistant/message', data: { turn: 2, step: 1 } })
    listener(fakeSession, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  } catch (err) {
    threw = true
    console.log('    listener threw: ' + err.message)
  }
  check('session/event 监听器不抛错', threw === false)
  const st = (await callRoute('/maodie/status.json')).json()
  check('turnSeq 累加到 2', st.turnSeq === 2, String(st.turnSeq))
  check('lastTurn 已记录', st.lastTurn && st.lastTurn.seq === 2)
  check('token 已累计（>0）', st.usage.tokens > 0, String(st.usage.tokens))
  check('lastTurn 带余额快照', st.lastTurn && st.lastTurn.usage && typeof st.lastTurn.usage.balance === 'number')
}

console.log('\n[12] 闹钟到时（自定义文字走 { } 占位符）')
{
  const sseRoute = registered.routes.find((r) => r.path === '/maodie/events')
  const sseRes = fakeRes()
  await sseRoute.handler(fakeReq('GET', '/maodie/events'), sseRes)

  // 设一个"当前本地时刻"的闹钟，让 checkAlarms 命中（闹钟按本地时间判定）
  const loc = new Date()
  const pad2 = (n) => String(n).padStart(2, '0')
  const hhmm = pad2(loc.getHours()) + ':' + pad2(loc.getMinutes())
  const localToday = loc.getFullYear() + '-' + pad2(loc.getMonth() + 1) + '-' + pad2(loc.getDate())
  const post = await callRoute('/maodie/state.json', 'POST', {
    state: { alarms: [{ id: 'a1', name: '起床铃', time: hhmm, mode: 'daily', text: '起床', sounds: [], enabled: true }] },
  })
  check('闹钟已写入 state', post.json().state.alarms.length === 1)

  // 手动跑一次闹钟巡检（真实 Host 里是 20 秒一次；这里用诊断钩子精确触发）
  const sweep = await callRoute('/maodie/diag?runAlarmSweep=1')
  check('诊断钩子能手动跑闹钟巡检', sweep.statusCode === 200 && sweep.json().plugin === '1.3.1', String(sweep.statusCode))
  check('巡检结果记录在 alarmChecks 里', !!sweep.json().alarmChecks && sweep.json().alarmChecks.hhmm.length === 5)
  const frame = String(sseRes.body)
  check('推送了 alarm 事件', frame.indexOf('"type":"alarm"') !== -1)
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
  }
  check('泡泡文字默认是「起床」', frame.indexOf('起床') !== -1)
  check('事件里带 sound 交付标记', /"sound":true/.test(frame))
  check('事件里带 bubble 交付标记', /"bubble":true/.test(frame))
  check('闹钟到时不抛错', true)

  // 一次性闹钟触发后应自动停用（date 必须等于今天才会触发）
  await callRoute('/maodie/state.json', 'POST', {
    state: { alarms: [{ id: 'a2', name: '一次性', time: hhmm, mode: 'once', date: localToday, text: '该起了', enabled: true }] },
  })
  await callRoute('/maodie/diag?runAlarmSweep=1')
  const st = (await callRoute('/maodie/state.json')).json()
  const once = st.state.alarms.find((a) => a.id === 'a2')
  check('一次性闹钟触发后自动停用', once && once.enabled === false, JSON.stringify(once))
  // 隔日的一次性闹钟不应触发
  await callRoute('/maodie/state.json', 'POST', {
    state: { alarms: [{ id: 'a3', name: '明天', time: hhmm, mode: 'once', date: '2099-01-01', text: '明天', enabled: true }] },
  })
  await callRoute('/maodie/diag?runAlarmSweep=1')
  const st2 = (await callRoute('/maodie/state.json')).json()
  const tomorrow = st2.state.alarms.find((a) => a.id === 'a3')
  check('非当日的一次性闹钟不触发', tomorrow && tomorrow.enabled === true)
}

console.log('\n[13] 信任栅栏（可选开关）')
{
  // 默认不设栅栏：桌面端主界面可能不带会话 cookie，套认证会让数据全取不到
  const open = await callRoute('/maodie/init.json')
  check('默认（requireAuth=false）数据路由可访问', open.statusCode === 200, String(open.statusCode))

  // 打开认证后，栅栏拒绝必须生效
  await callRoute('/maodie/state.json', 'POST', { state: { security: { requireAuth: true } } })
  fenceMode = 'deny'
  const denied = await callRoute('/maodie/init.json')
  check('requireAuth=true 时被栏返回 401', denied.statusCode === 401, String(denied.statusCode))
  check('被栏时不返回内容', !denied.body)
  fenceMode = 'allow'
  const allowed = await callRoute('/maodie/init.json')
  check('放行后恢复 200', allowed.statusCode === 200)

  // 关掉，恢复默认
  await callRoute('/maodie/state.json', 'POST', { state: { security: { requireAuth: false } } })
  const back = await callRoute('/maodie/init.json')
  check('关掉认证后又是 200', back.statusCode === 200)
}

console.log('\n[14] 导入的插件不污染鲸鱼')
{
  const whalePaths = [
    'C:\\Users\\rennanchuan\\.dsh\\profiles\\web\\node_modules\\dsh-whale-widget\\package.json',
  ]
  const ownFile = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8')
  check('插件源码不含 whale/鲸鱼 依赖', !/whale|dsh-whale/i.test(ownFile))
  check('未写入 web profile 目录', !ownFile.includes('profiles\\\\web') && !ownFile.includes('profiles/web'))
}

console.log('\n[14] SSE 事件流')
{
  const res = fakeRes()
  const route = registered.routes.find((r) => r.path === '/maodie/events')
  const req = fakeReq('GET', '/maodie/events')
  await route.handler(req, res)
  check('SSE 返回 200', res.statusCode === 200)
  check('Content-Type 是 event-stream', String(res.headers['Content-Type']).includes('text/event-stream'))
  check('先发了 retry 与 hello', String(res.body).includes('retry:') && String(res.body).includes('"type":"hello"'))
}

console.log('\n[15] 闹钟自测 + 事件收件箱（SSE 掉线兜底）')
{
  const base = (await callRoute('/maodie/inbox.json')).json()
  check('inbox 基线可读', base && base.ok === true && typeof base.seq === 'number', JSON.stringify(base))
  check('inbox 不带 since 时不补发历史', Array.isArray(base.items) && base.items.length === 0)

  const t = (await callRoute('/maodie/alarm-test.json', 'POST', {})).json()
  check('闹钟自测可投递', t && t.ok === true && t.delivered && typeof t.delivered.seq === 'number', JSON.stringify(t && t.delivered))

  const after = (await callRoute('/maodie/inbox.json?since=' + base.seq)).json()
  const alarm = (after.items || []).find((x) => x.type === 'alarm')
  check('自测闹钟进了收件箱', !!alarm, JSON.stringify(after.items))
  check('收件箱事件带 seq 与 deliver', !!alarm && typeof alarm.seq === 'number' && !!alarm.deliver)
  check(
    '收件箱每条事件都带 boot（用于判断 Host 是否重启过）',
    !!alarm && typeof alarm.boot === 'string' && alarm.boot.length > 0,
    alarm && alarm.boot,
  )
  check('收件箱响应也带同一个 boot', typeof after.boot === 'string' && after.boot === (alarm && alarm.boot), String(after.boot))
  check('init.json 带 boot', typeof (await callRoute('/maodie/init.json')).json().boot === 'string')
  check('status.json 带 boot', (await callRoute('/maodie/status.json')).json().boot === after.boot)
  check('只返回 since 之后的事件', (after.items || []).every((x) => x.seq > base.seq))
  check('闹钟时间用本地时间', !!alarm && /^\d{2}:\d{2}$/.test(String(alarm.data.time)), alarm && alarm.data.time)

  const listener = registered.events.find((e) => e.name === 'session/event').listener
  listener({ id: 'session-test-1' }, { type: 'turn/end', data: { turn: 9 } })
  const after2 = (await callRoute('/maodie/inbox.json?since=' + base.seq)).json()
  check('任务完成也进收件箱', (after2.items || []).some((x) => x.type === 'turn-end'))

  // 排程：单独放一个每日闹钟 + 一个 8 天内不会响的一次性闹钟
  const loc = new Date()
  const pad2 = (n) => String(n).padStart(2, '0')
  const hhmm = pad2(loc.getHours()) + ':' + pad2(loc.getMinutes())
  await callRoute('/maodie/state.json', 'POST', {
    state: {
      alarms: [
        { id: 'sched-daily', name: '每日', time: hhmm, mode: 'daily', text: '起床', enabled: true },
        { id: 'sched-far', name: '很远', time: hhmm, mode: 'once', date: '2099-01-01', text: '未来', enabled: true },
      ],
    },
  })
  const st = (await callRoute('/maodie/status.json')).json()
  check('status 带闹钟排程', Array.isArray(st.alarms) && st.alarms.length === 2, String(st.alarms && st.alarms.length))
  const daily = (st.alarms || []).find((a) => a.id === 'sched-daily')
  check(
    '每日闹钟算出下次触发时间（当前这一分钟也算未到，nextIn 不为负）',
    !!daily && typeof daily.nextAt === 'number' && daily.nextIn >= 0,
    JSON.stringify(daily),
  )
  const farFuture = (st.alarms || []).find((a) => a.id === 'sched-far')
  check('8 天内不会响的一次性闹钟 nextAt 为空', !!farFuture && farFuture.nextAt === null, JSON.stringify(farFuture))
}

console.log('\n[15b] 闹钟时间匹配与「就在这一分钟」（修复：设了时间却不响 / 显示成明天）')
{
  const pad2 = (n) => String(n).padStart(2, '0')
  const sweep = () => callRoute('/maodie/diag?runAlarmSweep=1')
  const now = new Date()

  // 1) 未补零的脏格式也要能匹配（以前是字符串全等，格式一差就永远不响）
  const loose = Number(now.getHours()) + ':' + pad2(now.getMinutes())
  await callRoute('/maodie/state.json', 'POST', {
    state: {
      alarms: [
        { id: 'a-loose', name: '脏格式', time: loose, mode: 'daily', text: '起床', enabled: true },
        { id: 'a-normal', name: '正常格式', time: pad2(now.getHours()) + ':' + pad2(now.getMinutes()), mode: 'daily', text: '起床', enabled: true },
      ],
    },
  })
  await sweep()
  const inbox = (await callRoute('/maodie/inbox.json?since=0')).json()
  const firedIds = (inbox.items || []).filter((x) => x.type === 'alarm').map((x) => x.data && x.data.id)
  check('未补零的时间（如 "5:29"）也能触发', firedIds.indexOf('a-loose') !== -1, JSON.stringify(firedIds))
  check('正常格式照常触发', firedIds.indexOf('a-normal') !== -1, JSON.stringify(firedIds))

  // 2) 当前这一分钟要算「还没到」，不能跳到明天
  const st2 = (await callRoute('/maodie/status.json')).json()
  const sched = (st2.alarms || []).find((a) => a.id === 'a-normal')
  check(
    '当前这一分钟算「现在就到」，nextAt 落在本分钟内',
    !!sched && typeof sched.nextAt === 'number' && sched.nextAt - Date.now() <= 60000 && sched.nextIn >= 0,
    JSON.stringify(sched),
  )

  // 3) diag 里能看到最近一次巡检（hh:mm + 触发了谁）
  const diag = (await callRoute('/maodie/diag')).json()
  check('diag 报最近一次闹钟巡检', !!diag.alarmChecks && typeof diag.alarmChecks.hhmm === 'string', JSON.stringify(diag.alarmChecks))
  check(
    '巡检记录里能看出匹配了哪些闹钟',
    !!diag.alarmChecks && Array.isArray(diag.alarmChecks.fired) && diag.alarmChecks.fired.length >= 1,
    JSON.stringify(diag.alarmChecks),
  )
}

console.log('\n[15c] 闹钟投递的唯一入口（幂等：同一分钟只响一次）')
{
  const pad2 = (n) => String(n).padStart(2, '0')
  const now = new Date()
  const hhmm = pad2(now.getHours()) + ':' + pad2(now.getMinutes())

  // 前端兜底用的路由：投递一个具体闹钟
  await callRoute('/maodie/state.json', 'POST', {
    state: {
      alarms: [
        { id: 'a-fire-on', name: '开着的', time: hhmm, mode: 'daily', text: '起床吧', enabled: true },
        { id: 'a-fire-off', name: '停用的', time: hhmm, mode: 'daily', text: '不该响', enabled: false },
      ],
    },
  })
  const base = (await callRoute('/maodie/inbox.json')).json()
  const first = (await callRoute('/maodie/alarm-fire.json', 'POST', { id: 'a-fire-on' })).json()
  check('alarm-fire 能投递指定闹钟', first.ok === true && !!first.delivered, JSON.stringify(first))
  const second = (await callRoute('/maodie/alarm-fire.json', 'POST', { id: 'a-fire-on' })).json()
  check('同一分钟再投一次会被幂等挡掉', second.ok === true && second.alreadyFired === true, JSON.stringify(second))

  const off = (await callRoute('/maodie/alarm-fire.json', 'POST', { id: 'a-fire-off' })).json()
  check('停用的闹钟不会被投递', off.ok === false && off.error === 'disabled', JSON.stringify(off))

  const missing = await callRoute('/maodie/alarm-fire.json', 'POST', { id: '不存在' })
  check('不存在的闹钟返回 404', missing.statusCode === 404, String(missing.statusCode))

  const after = (await callRoute('/maodie/inbox.json?since=' + base.seq)).json()
  const fired = (after.items || []).filter((x) => x.type === 'alarm').map((x) => x.data && x.data.id)
  check('只投递了一次（没有重复事件）', fired.length === 1 && fired[0] === 'a-fire-on', JSON.stringify(fired))
  check('停用的那个一个事件都没有', fired.indexOf('a-fire-off') === -1)
}

console.log('\n[16] 本次消耗（当前会话）')
{
  const st = (await callRoute('/maodie/status.json')).json()
  check('status 带 session', !!st.session, JSON.stringify(st.session))
  check('session 累计 token > 0', st.session && st.session.tokens > 0, String(st.session && st.session.tokens))
  check('session 记了轮次', st.session && st.session.turns >= 2, String(st.session && st.session.turns))
  check(
    'session 花费如实（数字或 null，不编造）',
    st.session && (st.session.cost === null || typeof st.session.cost === 'number'),
    String(st.session && st.session.cost),
  )
  check('session 花费口径有说明', st.session && typeof st.session.costBasis === 'string', st.session && st.session.costBasis)
  const init = (await callRoute('/maodie/init.json')).json()
  check('init 也带 session', !!init.session && init.session.tokens > 0)
  check('init 带本地时间', typeof init.localNow === 'string' && /^\d{2}:\d{2}$/.test(init.localNow), String(init.localNow))

  const listener = registered.events.find((e) => e.name === 'session/event').listener
  listener({ id: 'session-test-2' }, { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5 } } })
  const st2 = (await callRoute('/maodie/status.json')).json()
  check('换会话后本次消耗重新计', st2.session && st2.session.id === 'session-test-2' && st2.session.turns === 0, JSON.stringify(st2.session))
  listener({ id: 'session-test-1' }, { type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 5 } } })
}

console.log('\n[17] 自定义外观图（上传 / 列表 / 删除）')
{
  const init = (await callRoute('/maodie/init.json')).json()
  check('init 带图片清单（2 张内置）', Array.isArray(init.images) && init.images.length === 2, String(init.images && init.images.length))
  const idle = (init.images || []).find((x) => x.id === 'builtin:idle')
  check('内置图带 alpha 包围盒 meta', !!idle && idle.meta && idle.meta.bboxW === 1051, JSON.stringify(idle && idle.meta))
  check('init 带姿态绑定', init.poses && init.poses.idle === 'builtin:idle' && init.poses.hiss === 'builtin:hiss', JSON.stringify(init.poses))
  const images = (await callRoute('/maodie/images.json')).json()
  check('images.json 可用', images && images.ok === true && images.images.length === 2)

  const png1x1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const up = (await callRoute('/maodie/upload-image.json', 'POST', {
    dataUrl: png1x1,
    name: '我的猫',
    pose: 'idle',
    meta: { canvasW: 1, canvasH: 1, bboxX: 0, bboxY: 0, bboxW: 1, bboxH: 1 },
  })).json()
  check('上传外观图成功', up && up.ok === true && /^user:/.test(String(up.id)), JSON.stringify(up && up.id))
  check('上传后图片数 = 3', up && up.images && up.images.length === 3, String(up && up.images && up.images.length))
  check('上传时可直接指定姿态', up && up.poses && up.poses.idle === up.id, JSON.stringify(up && up.poses))
  const custom = (up.images || []).find((x) => x.id === up.id)
  check('自定义图带 meta', !!custom && custom.meta && custom.meta.bboxW === 1, JSON.stringify(custom && custom.meta))
  check('落盘到 images 目录', fs.existsSync(path.join(tmp, 'maodie', 'images')))
  const bytes = await callRoute('/maodie/image?id=' + encodeURIComponent(up.id))
  check('自定义图可下发', bytes.statusCode === 200 && String(bytes.body || '').length > 10, String(bytes.statusCode))
  check('自定义图 mime 是 png', bytes.headers['Content-Type'] === 'image/png', String(bytes.headers['Content-Type']))

  const metaRes = (await callRoute('/maodie/image-meta.json', 'POST', {
    id: up.id,
    meta: { canvasW: 2, canvasH: 2, bboxX: 0, bboxY: 0, bboxW: 2, bboxH: 2 },
  })).json()
  check('可补写 alpha 包围盒', metaRes && metaRes.ok === true && metaRes.meta.bboxW === 2, JSON.stringify(metaRes))

  const badDel = (await callRoute('/maodie/delete-image.json', 'POST', { id: 'builtin:idle' })).json()
  check('内置外观图拒绝删除', badDel && badDel.ok === false)

  const del = (await callRoute('/maodie/delete-image.json', 'POST', { id: up.id })).json()
  check('删除自定义图成功', del && del.ok === true && del.images.length === 2, String(del && del.images && del.images.length))
  check('删除后姿态退回内置图', del && del.poses.idle === 'builtin:idle', JSON.stringify(del && del.poses))
}

console.log('\n[18] 前端心跳 / 报告 / diag')
{
  const h = (await callRoute('/maodie/hello', 'POST', {
    version: '1.3.1',
    href: 'dsh-app://app/',
    protocol: 'dsh-app:',
    apiBase: '/maodie',
    ua: 'test',
    error: '',
  })).json()
  check('hello 回执 ok', h && h.ok === true)
  const rep = (await callRoute('/maodie/report.json', 'POST', {
    version: '1.3.1',
    href: 'dsh-app://app/',
    protocol: 'dsh-app:',
    apiBase: '/maodie',
    pose: 'idle',
    sse: { state: 'open', helloAt: 1, lastAt: 2, errors: 0 },
    inbox: { lastSeq: 3, polls: 4, lastPollAt: 5, errors: 0 },
    audio: { unlocked: true, contextState: 'running', volume: 0.9, last: { at: 1, id: 'builtin:hiss', trigger: 'cat.click', ok: true, error: '' } },
    slots: [{ id: 'slot-hiss', name: '提示音', trigger: 'cat.click', enabled: true, pool: 1 }],
    errors: [],
  })).json()
  check('report.json 接受心跳', rep && rep.ok === true && typeof rep.eventSeq === 'number', JSON.stringify(rep))

  await callRoute('/maodie/state.json', 'POST', {
    state: {
      audio: {
        slots: [
          { id: 's1', name: '完成音', trigger: 'turn.end', sounds: ['builtin:jiao'], strategy: 'random', loop: false, cooldownMs: 0, enabled: false },
          { id: 's2', name: '闹钟音', trigger: 'alarm.fire', sounds: ['builtin:jiao'], strategy: 'random', loop: true, cooldownMs: 0, enabled: true },
        ],
      },
    },
  })

  const diag = (await callRoute('/maodie/diag')).json()
  check('diag 报插件版本', diag && diag.plugin === '1.3.1', String(diag && diag.plugin))
  check('diag 报注入行', diag && diag.indexInjection && diag.indexInjection.rowsInTable >= 1)
  check('diag 报前端已启动', diag && diag.frontend && diag.frontend.booted === true)
  check(
    'diag 回显前端心跳',
    diag && diag.frontend.report && diag.frontend.report.audio && diag.frontend.report.audio.last.ok === true,
    JSON.stringify(diag && diag.frontend.report && diag.frontend.report.audio),
  )
  check(
    'diag 报「为什么不出声」',
    diag && Array.isArray(diag.soundWarnings) && diag.soundWarnings.some((w) => String(w).indexOf('完成音') !== -1),
    JSON.stringify(diag && diag.soundWarnings),
  )
  check('diag 报闹钟排程', diag && Array.isArray(diag.alarms))
  check('diag 报本次消耗', diag && diag.session && typeof diag.session.tokens === 'number')
  check('diag 报事件通道', diag && diag.events && typeof diag.events.eventSeq === 'number' && typeof diag.events.sseClients === 'number')
  check('diag 报时间（本地 + 北京）', diag && diag.time && typeof diag.time.localNow === 'string' && typeof diag.time.beijingNow === 'string')
  check('diag 报外观图状态', diag && diag.images && diag.images.total === 2)
  check('diag 报状态目录', diag && diag.paths && typeof diag.paths.stateDir === 'string')
  check('diag 报声音自愈结果字段', diag && 'soundHeal' in diag)
}

console.log('\n[19] 声音配置自愈（矛盾配置可重复修，但不会违背「提醒」里的意图）')
{
  const stateFile = path.join(tmp, 'maodie', 'state.json')
  const inconsistent = (opts) => ({
    version: 1,
    audio: {
      slots: [
        { id: 's-done', name: '完成音', trigger: 'turn.end', sounds: ['builtin:jiao'], strategy: 'random', loop: false, cooldownMs: 0, enabled: false },
      ],
    },
    notify: { turnEnd: { enabled: true, sound: opts && opts.sound === false ? false : true } },
    alarms: [{ id: 'a-heal', name: '闹钟', time: '09:00', mode: 'daily', text: '起床', enabled: true }],
    meta: opts && opts.meta ? opts.meta : {},
  })
  // 直接落盘，避免动到已在内存里的第一个实例（它保存时会整份覆盖）
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(inconsistent(null), null, 2), 'utf8')

  // 用带 query 的模块 URL 再 import 一次：全新模块实例 + 重新 mount（走自愈）
  const fresh = await import(pathToFileURL(PLUGIN_ENTRY).href + '?heal=1')
  fresh.default.apply(ctx)
  await new Promise((r) => setTimeout(r, 80))

  const healed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const done = healed.audio.slots.filter((s) => s.trigger === 'turn.end')[0]
  check('自愈后槽位被启用', !!done && done.enabled !== false, JSON.stringify(done))
  check('自愈后素材池还在', !!done && done.sounds.length === 1)
  check(
    '自愈动作记进 state.meta.soundHealLog（流水，不是「以后不再修」的标记）',
    Array.isArray(healed.meta.soundHealLog) && healed.meta.soundHealLog.some((h) => h.trigger === 'turn.end'),
    JSON.stringify(healed.meta.soundHealLog),
  )

  // 关键回归：用户把槽位又关掉了（弹窗照旧、声音没了），必须**再修一次**。
  // 1.2.1 的 soundAutoHealed 记录会挡住这次修复 —— 那正是「通知弹了却没声音」的现场。
  fs.writeFileSync(stateFile, JSON.stringify(inconsistent({ meta: healed.meta }), null, 2), 'utf8')
  const fresh2 = await import(pathToFileURL(PLUGIN_ENTRY).href + '?heal=2')
  fresh2.default.apply(ctx)
  await new Promise((r) => setTimeout(r, 80))
  const again = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const done2 = again.audio.slots.filter((s) => s.trigger === 'turn.end')[0]
  check('槽位被再次关掉后会再修一次（不再有「修过了」的记录挡路）', !!done2 && done2.enabled !== false, JSON.stringify(done2))
  const turnEndHeals = (again.meta.soundHealLog || []).filter((h) => h.trigger === 'turn.end').length
  check('两次自愈都留在流水里（turn.end 至少两条）', turnEndHeals >= 2, 'turn.end 自愈条数=' + turnEndHeals)

  // 尊重意图：在「提醒」里把声音关掉 = 明确表示不要声音，这时不该再自作主张地启用槽位
  fs.writeFileSync(stateFile, JSON.stringify(inconsistent({ sound: false }), null, 2), 'utf8')
  const fresh3 = await import(pathToFileURL(PLUGIN_ENTRY).href + '?heal=3')
  fresh3.default.apply(ctx)
  await new Promise((r) => setTimeout(r, 80))
  const quiet = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const done3 = quiet.audio.slots.filter((s) => s.trigger === 'turn.end')[0]
  check('「提醒」里声音关掉后就不再自愈（尊重用户意图）', !!done3 && done3.enabled === false, JSON.stringify(done3))

  // 缺省即「要声音」：状态文件里根本没有 notify 这一段时，投递那边是当成开着的，
  // 自愈也必须同样判断，否则会把默认配置误判成「用户不要声音」而不修。
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: 1,
        audio: { slots: [{ id: 's-done', name: '完成音', trigger: 'turn.end', sounds: ['builtin:jiao'], enabled: false }] },
      },
      null,
      2,
    ),
    'utf8',
  )
  const fresh4 = await import(pathToFileURL(PLUGIN_ENTRY).href + '?heal=4')
  fresh4.default.apply(ctx)
  await new Promise((r) => setTimeout(r, 80))
  const def = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const done4 = def.audio.slots.filter((s) => s.trigger === 'turn.end')[0]
  check('没有 notify 配置时按「要声音」处理并自愈', !!done4 && done4.enabled !== false, JSON.stringify(done4))
}

console.log('\n[22] 账户分账 + 每轮金额（token × 单价，按会话分桶，免疫并发）')
{
  const listener = registered.events.find((e) => e.name === 'session/event').listener
  const A = { id: 'sess-A' }
  const B = { id: 'sess-B' }
  const msg = (provider, model, usage, turn) => ({
    type: 'assistant/message',
    data: { turn, step: 1, usage, message: { source: { provider, model } } },
  })

  // 会话 A 的第 5 轮：DeepSeek flash，输入 1M（未命中）+ 输出 100k
  listener(A, msg('deepseek-official', 'deepseek-flash', { inputTokens: 1000000, outputTokens: 100000, cacheReadTokens: 0, reasoningTokens: 0 }, 5))
  // 并发：会话 B 同时在跑自己的第 9 轮（小米）
  listener(B, msg('xiaomi', 'mimo-v2.6-pro', { inputTokens: 2000000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }, 9))
  // A 结束这一轮
  listener(A, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })

  const usage = (await callRoute('/maodie/turn.json')).json()
  check('usage.json 报出本轮', !!usage.turn, 'DEBUG ' + JSON.stringify(usage).slice(0, 400))
  check(
    '本轮 token 只算自己那个会话（并发不串账）',
    !!usage.turn && usage.turn.tokens === 1100000,
    String(usage.turn && usage.turn.tokens),
  )
  check(
    '本轮金额 = token × 官方单价（谷价 1.4 / 峰价 2.8）',
    !!usage.turn && [1.4, 2.8].indexOf(usage.turn.amount) !== -1,
    String(usage.turn && usage.turn.amount),
  )
  check(
    '本轮标注了金额口径',
    !!usage.turn && usage.turn.amountBasis.indexOf('估算') !== -1,
    usage.turn && usage.turn.amountBasis,
  )
  check(
    '本轮记了供应商与模型',
    !!usage.turn && usage.turn.provider === 'deepseek-official' && usage.turn.model === 'deepseek-flash',
    JSON.stringify(usage.turn),
  )
  // current = 最近一次模型活动的供应商（这里 B 的小米消息在最后，所以是 xiaomi）
  check(
    'usage.json 带当前供应商/模型（最近一次活动）',
    !!usage.current && usage.current.provider === 'xiaomi' && usage.current.model === 'mimo-v2.6-pro',
    JSON.stringify(usage.current),
  )
  check('usage.json 带价目来源', !!usage.pricing && /deepseek/.test(String(usage.pricing.source)), JSON.stringify(usage.pricing && usage.pricing.source))

  // B 结束：第三方（没填单价）金额必须标注「仅供参考」
  listener(B, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
  const usage2 = (await callRoute('/maodie/turn.json')).json()
  check('第三方本轮金额带「仅供参考」', !!usage2.turn && /仅供参考/.test(usage2.turn.amountBasis), usage2.turn && usage2.turn.amountBasis)
  check('第三方本轮记在自己那一栏（provider=xiaomi）', !!usage2.turn && usage2.turn.provider === 'xiaomi', JSON.stringify(usage2.turn))

  const provs = (await callRoute('/maodie/providers.json')).json()
  const ids = provs.providers.map((p) => p.id)
  check(
    '账户隔开：DeepSeek 与小米各一栏',
    ids.indexOf('deepseek-official') !== -1 && ids.indexOf('xiaomi') !== -1,
    JSON.stringify(ids),
  )
  const xm = provs.providers.find((p) => p.id === 'xiaomi')
  check(
    '小米余额是「未知」（没有官方来源）',
    !!xm && xm.balance.known === false && xm.balance.total === null,
    JSON.stringify(xm && xm.balance),
  )
  check('小米今天的 token 记在自己账上', !!xm && xm.today.tokens >= 2000000, JSON.stringify(xm && xm.today))
  check('总消耗把估算部分标成「仅供参考」', /仅供参考/.test(provs.totals.note), provs.totals.note)
  check('总 token = 各账户之和', provs.totals.todayTokens >= 3100000, String(provs.totals.todayTokens))
  const ds = provs.providers.find((p) => p.id === 'deepseek-official')
  check('官方供应商的今日口径字段存在', !!ds && 'officialCost' in ds.today, JSON.stringify(ds && ds.today))
}

// ---------------------------------------------------------------- 收尾
globalThis.fetch = realFetch
console.log('\n=== 结果：' + passed + ' 通过 / ' + failed + ' 失败 ===')
if (failures.length) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
}
try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch (err) {
  /* 忽略 */
}
process.exit(failed === 0 ? 0 : 1)
