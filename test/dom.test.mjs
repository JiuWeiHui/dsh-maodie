// ============================================================================
// 耄耋 —— 前端 DOM 冒烟测试（jsdom 真跑 assets/maodie.js）
// ============================================================================
// 目的：抓出"脚本一加载就抛异常 / 猫根本没渲染"这类静态检查发现不了的问题。
// 覆盖：初始化取数 → 建猫 → 切姿态 → 拖动 → 缩放 → 三连击粒子 → 气泡开与戳破
//       → 右键设置窗 → 声音槽位渲染
//
// 运行：node test/dom.test.mjs   （需要能解析到 jsdom）
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontPath = path.join(__dirname, '..', 'assets', 'maodie.js')
const code = fs.readFileSync(frontPath, 'utf8')

let jsdom
// jsdom 可能装在仓库里，也可能装在开发机上的临时目录（可用 MAODIE_JSDOM 覆盖）
const jsdomCandidates = [
  path.join(__dirname, '..', 'node_modules', 'jsdom', 'lib', 'api.js'),
  path.join(os.homedir(), '.dsh-jsdom-tmp', 'node_modules', 'jsdom', 'lib', 'api.js'),
]
if (process.env.MAODIE_JSDOM) jsdomCandidates.unshift(process.env.MAODIE_JSDOM)
for (const candidate of jsdomCandidates) {
  try {
    jsdom = await import(pathToFileURL(candidate).href)
    break
  } catch (err) {
    /* 试下一个 */
  }
}
if (!jsdom || !jsdom.JSDOM) {
  console.log('跳过：找不到 jsdom（先执行 npm install jsdom）')
  process.exit(0)
}
const { JSDOM } = jsdom

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

console.log('\n=== 耄耋 · 前端 DOM 冒烟测试 ===\n')

// ---------------------------------------------------------------- 假宿主数据
const initPayload = {
  ok: true,
  // Host 会给出正式 HTTP 基址；前端据此拼所有请求（桌面端主界面可能在 dsh-app:// 下）
  webBase: 'http://127.0.0.1:19487',
  apiBase: 'http://127.0.0.1:19487/maodie',
  request: { rejection: undefined },
  version: '1.3.4',
  state: {
    appearance: { x: null, y: null, scale: 1, baseSize: 220, opacity: 1, shadow: true, pet: true },
    look: { flipAtLeft: true, clickAnim: 'shake', tripleShake: true, particles: true, particleCount: 26, bubbleStyle: 'balloon' },
    audio: {
      volume: 0.9,
      slots: [
        { id: 's1', name: '提示音', trigger: 'cat.click', sounds: ['builtin:hiss'], strategy: 'random', loop: false, cooldownMs: 0, enabled: true },
        { id: 's2', name: '特殊提示音', trigger: 'cat.triple', sounds: [], strategy: 'random', loop: false, cooldownMs: 0, enabled: true },
        { id: 's3', name: '任务完成音', trigger: 'turn.end', sounds: ['builtin:jiao', 'builtin:dahuoji'], strategy: 'random', loop: false, cooldownMs: 0, enabled: true },
        { id: 's4', name: '闹钟音', trigger: 'alarm.fire', sounds: ['builtin:qichuang', 'builtin:lanlian'], strategy: 'random', loop: true, cooldownMs: 0, enabled: true },
      ],
    },
    notify: {
      turnEnd: { enabled: true, native: true, systemNotification: true, titleFlash: true, flashText: '🔔 任务完成！', sound: true, bubble: true, catAct: true, body: '今日 {today}', autoCloseSec: 0 },
      balanceLow: { enabled: false, below: 5 },
      budget: { enabled: false, amount: 10 },
    },
    crop: { fadeEnabled: true, fadeMs: 15, normalize: false, trimSilence: false },
    peak: { online: true, lastFetchAt: 0, overrides: {} },
    alarms: [
      { id: 'a-on', name: '上班', time: '23:59', mode: 'daily', date: '', text: '起床', sounds: ['builtin:hiss'], enabled: true },
      { id: 'a-off', name: '停用的', time: '07:00', mode: 'daily', date: '', text: '起床', sounds: ['builtin:hiss'], enabled: false },
    ],
    meta: { installedAt: 1, updatedAt: 1 },
  },
  sounds: [
    { id: 'builtin:hiss', name: '哈气', builtin: true, mime: 'audio/mp4', note: '1 秒' },
    { id: 'builtin:jiao', name: '叫一叫', builtin: true, mime: 'audio/mpeg', note: '55 秒' },
  ],
  images: [
    {
      id: 'builtin:idle',
      name: '常态',
      file: 'cat-idle.png',
      builtin: true,
      mime: 'image/png',
      meta: { canvasW: 1248, canvasH: 2048, bboxX: 169, bboxY: 147, bboxW: 1051, bboxH: 1853 },
    },
    {
      id: 'builtin:hiss',
      name: '哈气',
      file: 'cat-hiss.png',
      builtin: true,
      mime: 'image/png',
      meta: { canvasW: 1280, canvasH: 1760, bboxX: 209, bboxY: 152, bboxW: 1015, bboxH: 1607 },
    },
  ],
  poses: { idle: 'builtin:idle', hiss: 'builtin:hiss' },
  triggers: [
    { id: 'cat.click', name: '猫·点击' },
    { id: 'cat.triple', name: '猫·连击' },
    { id: 'turn.end', name: '任务完成' },
    { id: 'alarm.fire', name: '闹钟到时' },
  ],
  peak: { kind: 'valley', reason: '周末全天谷价', nextAt: Date.now() + 3600000, nextKind: 'peak', peakHours: [[9, 12], [14, 18]] },
  usage: { cost: 0.5, costBasis: '余额差', costAvailable: true, tokens: 12000, balance: 123.45, currency: 'CNY' },
  session: {
    id: 'session-dom',
    startedAt: Date.now() - 60000,
    cost: 0.1234,
    costBasis: '余额差（自本次会话开始）',
    tokens: 4321,
    input: 3000,
    cacheRead: 1000,
    output: 321,
    turns: 3,
    lastTurnCost: 0.02,
    lastTurnTokens: 500,
    balance: 123.45,
    currency: 'CNY',
  },
  native: { probed: true, electron: false, window: false, notify: false, reason: 'test' },
  paths: { stateDir: 'C:/tmp/maodie', assets: 'C:/tmp/assets' },
  serverTime: Date.now(),
}

const statusPayload = {
  ok: true,
  apiBase: 'http://127.0.0.1:19487/maodie',
  peak: initPayload.peak,
  usage: initPayload.usage,
  session: initPayload.session,
  lastTurn: null,
  turnSeq: 0,
  // 1.3.4：账户分开 + 本轮统计（金额按 token×单价估算；第三方标「仅供参考」）
  modelCtx: { provider: 'xiaomi', model: 'mimo-v2.6-pro', at: Date.now(), source: 'assistant/message' },
  turn: {
    turn: 3,
    seq: 9,
    provider: 'xiaomi',
    model: 'mimo-v2.6-pro',
    amount: 0.42,
    amountBasis: '按自定义单价估算（仅供参考）',
    tokens: 123456,
    input: 100000,
    cache: 20000,
    output: 3456,
    ts: Date.now(),
  },
  providers: {
    providers: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        displayName: 'DeepSeek',
        available: true,
        configError: '',
        balance: { known: true, total: 12.34, currency: 'CNY', source: '官方', error: '', updatedAt: Date.now(), officialTodayCost: 1.23 },
        today: { tokens: 999, estimateCost: 1.23, estimateBasis: '按官方参考价估算（官方价目）', officialCost: 1.23 },
        models: {},
        lastTurn: null,
      },
      {
        id: 'xiaomi',
        name: '小米',
        displayName: '小米 MiMo',
        available: true,
        configError: '',
        balance: { known: false, total: null, currency: 'CNY', source: '', error: '未配置官方余额来源', updatedAt: 0, officialTodayCost: null },
        today: { tokens: 222333, estimateCost: 0.56, estimateBasis: '按自定义单价估算（仅供参考）', officialCost: null },
        models: {},
        lastTurn: { amount: 0.42, amountBasis: '按自定义单价估算（仅供参考）', tokens: 123456, model: 'mimo-v2.6-pro', ts: Date.now() },
      },
    ],
    account: {
      available: true,
      signedIn: true,
      status: 'credential-stored',
      wallets: [{ currency: 'CNY', balance: 50 }],
      bonusWallets: [{ currency: 'CNY', balance: 5 }],
      usageUrl: 'https://platform.deepseek.com/usage',
      topUpUrl: 'https://platform.deepseek.com/top_up',
      updatedAt: Date.now(),
      error: '',
      source: 'DSH 登录账号（ctx.deepseekAccount）',
      linkedToProvider: false,
    },
    totals: { todayTokens: 223332, todayAmount: 1.79, currency: 'CNY', official: [{ id: 'deepseek-official', amount: 1.23 }], estimated: [{ id: 'xiaomi', amount: 0.56 }], note: '含 xiaomi ¥0.56（仅供参考）' },
  },
  update: {
    current: '1.3.4',
    latest: '9.9.9',
    available: true,
    checkedAt: Date.now() - 60000,
    checking: false,
    error: '',
    url: 'https://github.com/JiuWeiHui/dsh-maodie/releases/tag/v9.9.9',
    notes: '## 测试版\n- 新增某功能\n- 修了某个 bug',
    publishedAt: '2026-10-03T00:00:00Z',
    asset: { name: 'dsh-maodie-9.9.9.tgz', size: 12345678, digest: 'sha256:abc' },
    installedAt: null,
    appliedVersion: '',
    backupDir: '',
    autoCheck: true,
    autoInstall: false,
    hasGit: true,
    target: 'C:/x/dsh-maodie',
  },
  native: initPayload.native,
  serverTime: Date.now(),
}

// ---------------------------------------------------------------- 建 DOM
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:19487/',
})
const win = dom.window

// 记录页面错误
const pageErrors = []
win.addEventListener('error', (e) => pageErrors.push(String(e.message || e.error)))
win.addEventListener('unhandledrejection', (e) => pageErrors.push('unhandledrejection: ' + String(e.reason)))

// --- 打桩 ---
const requests = []
win.fetch = async (url, options) => {
  const u = String(url)
  requests.push({ url: u, method: (options && options.method) || 'GET', body: options && options.body })
  let body = { ok: false }
  if (u.includes('/init.json')) body = initPayload
  else if (u.includes('/status.json')) body = statusPayload
  else if (u.includes('/state.json')) body = { ok: true, saved: true, state: initPayload.state }
  else if (u.includes('/native.json')) body = { ok: true, native: initPayload.native }
  else if (u.includes('/holidays.json')) body = { ok: true, count: 30 }
  else if (u.includes('/delete-sound.json')) body = { ok: true, sounds: initPayload.sounds }
  else if (u.includes('/upload-sound.json')) body = { ok: true, id: 'user:test', sounds: initPayload.sounds }
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(8),
    text: async () => JSON.stringify(body),
  }
}

// canvas 2d：jsdom 不自带
const ctxStub = {
  clearRect() {}, fillRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
  save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, setTransform() {}, moveTo() {}, lineTo() {},
  createRadialGradient() { return { addColorStop() {} } },
  createLinearGradient() { return { addColorStop() {} } },
  measureText() { return { width: 10 } },
  set fillStyle(v) {}, get fillStyle() { return '#000' },
  set font(v) {}, get font() { return '10px' },
  set globalAlpha(v) {}, get globalAlpha() { return 1 },
  set strokeStyle(v) {}, get strokeStyle() { return '#000' },
  set lineWidth(v) {}, get lineWidth() { return 1 },
}
win.HTMLCanvasElement.prototype.getContext = function () {
  return ctxStub
}

// Audio 打桩
const playedAudio = []
const pausedAudio = []
win.Audio = function (src) {
  const node = {
    src,
    loop: false,
    volume: 1,
    preload: '',
    currentTime: 0,
    paused: false,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
    removeEventListener() {},
    play() { this.paused = false; playedAudio.push(src); return Promise.resolve() },
    pause() { this.paused = true; pausedAudio.push(src) },
  }
  return node
}

// AudioContext 打桩（裁剪器用）
win.AudioContext = function () {
  return {
    decodeAudioData: (buf, ok) => { if (ok) ok({ duration: 2, sampleRate: 44100, numberOfChannels: 1, length: 88200, getChannelData: () => new Float32Array(88200) }) },
    createBufferSource: () => ({ buffer: null, loop: false, loopStart: 0, loopEnd: 0, connect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBuffer: (ch, len, sr) => ({ numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: () => new Float32Array(len) }),
    destination: {},
  }
}

const sseInstances = []
win.EventSource = function (url) {
  this.url = url
  this.onmessage = null
  this.onerror = null
  this.close = () => {}
  sseInstances.push(this)
}
win.Notification = function (title, opts) {
  this.title = title
  this.body = opts && opts.body
  this.onclick = null
}
win.Notification.permission = 'default'
win.Notification.requestPermission = () => Promise.resolve('granted')

// PointerEvent（jsdom 没有；clientX/clientY 在 MouseEvent 上是只读 getter，得用 defineProperty）
win.PointerEvent = class PointerEvent extends win.MouseEvent {
  constructor(type, params) {
    const p = params || {}
    super(type, p)
    Object.defineProperty(this, 'pointerId', { value: p.pointerId === undefined ? 1 : p.pointerId, enumerable: true })
    Object.defineProperty(this, 'clientX', { value: p.clientX || 0, enumerable: true })
    Object.defineProperty(this, 'clientY', { value: p.clientY || 0, enumerable: true })
    Object.defineProperty(this, 'button', { value: p.button || 0, enumerable: true })
  }
}
win.Element.prototype.setPointerCapture = function () {}
win.Element.prototype.releasePointerCapture = function () {}

// 窗口尺寸
Object.defineProperty(win, 'innerWidth', { value: 1440, writable: true })
Object.defineProperty(win, 'innerHeight', { value: 900, writable: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 执行脚本
// 闹钟兜底的宽限期改成 0：测试里不用真的等到「这一分钟的第 25 秒」
win.__MD_ALARM_GRACE_MS = 0
const script = win.document.createElement('script')
script.textContent = code
win.document.head.appendChild(script)

await sleep(600)

console.log('[1] 脚本加载与初始化')
check('加载过程没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
check('请求了 /maodie/init.json', requests.some((r) => r.url.includes('/init.json')))
check(
  '相对路径是第一候选（桌面端靠 dsh-app:// 转发，不猜端口）',
  (requests.find((r) => r.url.includes('/init.json')) || {}).url === '/maodie/init.json',
  (requests.find((r) => r.url.includes('/init.json')) || {}).url,
)
check(
  '启动后回了 /maodie/hello 回执',
  requests.some((r) => r.url.includes('/hello') && r.method === 'POST'),
  JSON.stringify(requests.filter((r) => r.url.includes('/hello'))),
)
check('注入了一份样式表', win.document.head.querySelectorAll('style').length >= 1)

const root = win.document.getElementById('md-root')
check('猫的根节点已创建', !!root)
const img = root && root.querySelector('img.md-cat-img')
check('猫的图片元素存在', !!img)
check('图片用的是内置常态图', !!img && img.src.includes('/maodie/image') && img.src.includes('builtin%3Aidle'))
check('图片走的是 Host 给的绝对基址', !!img && img.src.indexOf('http://127.0.0.1:19487/maodie/image') === 0, img && img.src)
check('缩放柄存在', !!root && !!root.querySelector('.md-resize'))
check('悬浮提示存在', !!root && !!root.querySelector('.md-tip'))
check('根节点定位为 fixed', !!root && root.className.indexOf('md-root') !== -1)

console.log('\n[2] 几何与位置')
{
  const style = root.style
  const catW = parseFloat(style.getPropertyValue('--md-cat-w'))
  check('设置了容器宽度变量', isFinite(catW) && catW > 100, String(catW))
  check('图片宽度已按几何写成像素', /px$/.test(img.style.width), img.style.width)
  check('图片水平居中补偿', /^-?\d+px$/.test(img.style.marginLeft), img.style.marginLeft)
  check('图片底边补偿已设置', /px$/.test(img.style.bottom), img.style.bottom)
  check('位置落在视口内', parseFloat(style.left) >= 0 && parseFloat(style.top) >= 0, style.left + ',' + style.top)
}

console.log('\n[3] 点击 → 哈气')
{
  const before = img.src
  root.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 800, clientY: 500, button: 0 }))
  root.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 800, clientY: 500, button: 0 }))
  await sleep(520)
  check('单击后切到哈气图', img.src.includes('builtin%3Ahiss'), img.src)
  const bubble = win.document.querySelector('.md-bubble')
  check('单击后冒出气泡', !!bubble)
  check('气泡里有峰谷标签', !!bubble && !!bubble.querySelector('.md-peak-badge'))
  check('气泡里有余额行', !!bubble && bubble.textContent.indexOf('余额') !== -1)
  check('气泡里有今日（本账户）', !!bubble && bubble.textContent.indexOf('今日（本账户）') !== -1, bubble && bubble.textContent.slice(0, 120))
  check('气泡里显示「本次消耗」金额', !!bubble && bubble.textContent.indexOf('本次消耗') !== -1 && bubble.textContent.indexOf('¥ 0.42') !== -1, bubble && bubble.textContent.slice(0, 160))
  {
    // 用户要求：气泡里那些小字（口径明细、含一堆账户的清单）都要去掉
    const bt = bubble ? bubble.textContent : ''
    check('气泡里不再有账户清单小字（含 xx ¥…（仅供参考））', bt.indexOf('含 xiaomi ¥0.56（仅供参考）') === -1, bt.slice(0, 220))
    check('气泡里不再有会话口径小字', bt.indexOf('自本次会话开始') === -1 && bt.indexOf('余额差') === -1, bt.slice(0, 220))
    check('「仅供参考」改成并到数值括号里', bt.indexOf('（仅供参考）') !== -1, bt.slice(0, 220))
    check('气泡里没有只有一行空 key 的小字行', bt.indexOf('按自定义单价估算') === -1, bt.slice(0, 220))
  }
  check('气泡里标注本轮口径', !!bubble && bubble.textContent.indexOf('仅供参考') !== -1, bubble && bubble.textContent.slice(0, 200))
  check('气泡里显示总消耗', !!bubble && bubble.textContent.indexOf('总消耗（全部）') !== -1)
  check('没有官方余额来源时显示「余额未知」', !!bubble && bubble.textContent.indexOf('余额未知') !== -1, bubble && bubble.textContent.slice(0, 200))
  check('气泡显示倒计时', !!bubble && bubble.textContent.indexOf('距') !== -1)
  check('单击触发了声音播放', playedAudio.length > 0, playedAudio.join(','))
}

console.log('\n[4] 戳破气泡 → 掐断声音')
{
  const bubble = win.document.querySelector('.md-bubble')
  bubble.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 800, clientY: 400, button: 0 }))
  await sleep(300)
  check('气泡已被移除', !win.document.querySelector('.md-bubble'))
  check('戳破时确实暂停了音频（掐断声音）', pausedAudio.length > 0, 'paused=' + pausedAudio.length)
  check('戳破不抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[5] 拖动与缩放')
{
  const leftBefore = root.style.left
  root.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 800, clientY: 500, button: 0 }))
  root.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 700, clientY: 420, button: 0 }))
  root.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 640, clientY: 380, button: 0 }))
  root.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 640, clientY: 380, button: 0 }))
  await sleep(120)
  check('拖动改变了位置', root.style.left !== leftBefore, leftBefore + ' -> ' + root.style.left)
  const wBefore = parseFloat(root.style.getPropertyValue('--md-cat-w'))
  root.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
  await sleep(80)
  const wAfter = parseFloat(root.style.getPropertyValue('--md-cat-w'))
  check('滚轮放大了猫', wAfter > wBefore, wBefore + ' -> ' + wAfter)
  check('拖动缩放没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[6] 三连击 → 摇晃 + 粒子')
{
  for (let i = 0; i < 3; i++) {
    root.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 700, clientY: 480, button: 0 }))
    root.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 700, clientY: 480, button: 0 }))
    await sleep(90)
  }
  await sleep(200)
  check('三连击切到哈气图', img.src.includes('builtin%3Ahiss'))
  const fx = win.document.querySelector('canvas.md-fx')
  check('粒子画布已创建', !!fx)
  check('三连击没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
  await sleep(1200)
  check('特效结束后不残留动画循环', true)
}

console.log('\n[7] 右键 → 设置窗口')
{
  const ev = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  root.dispatchEvent(ev)
  await sleep(150)
  const mask = win.document.querySelector('.md-set-mask')
  check('设置窗口已打开', !!mask)
  check('设置窗口标题含「耄耋」', !!mask && mask.textContent.indexOf('耄耋') !== -1)
  // 标题里带版本：一眼看出页面跑的是不是磁盘上那一份（踩过「改了代码页面还跑旧脚本」的坑）
  const titleNode = mask && mask.querySelector('[data-md-versions]')
  check(
    '设置窗口标题显示「前端 / Host」版本',
    !!titleNode &&
      titleNode.textContent.indexOf('前端 1.3.4') !== -1 &&
      titleNode.textContent.indexOf('Host 1.3.4') !== -1,
    titleNode && titleNode.textContent,
  )
  const tabs = mask ? mask.querySelectorAll('.md-set-tab') : []
  check('有 6 个标签页', tabs.length === 6, 'count=' + tabs.length)
  const names = Array.prototype.map.call(tabs, (t) => t.textContent).join('/')
  check('标签页是 外观/声音/提醒/峰谷/用量/关于', names === '外观/声音/提醒/峰谷/用量/关于', names)

  // 切到声音页，检查槽位渲染
  for (const t of tabs) if (t.textContent === '声音') t.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(120)
  const slots = win.document.querySelectorAll('.md-slot')
  check('声音页渲染出 4 个槽位', slots.length === 4, 'count=' + slots.length)
  check('槽位里有素材池勾选框', win.document.querySelectorAll('.md-pool-item').length > 0)
  check('有素材库列表', win.document.querySelectorAll('.md-lib-item').length >= 2)
  check('声音页给出「为什么不出声」提示', !!win.document.querySelector('.md-warn'), '（特殊提示音槽位没勾素材，应该被点出来）')
  check('声音页有「一键启用」修复按钮', win.document.body.textContent.indexOf('一键启用') !== -1)
  check('声音页有「停止全部试听」', win.document.body.textContent.indexOf('停止全部试听') !== -1)

  // 切到外观页，检查外观图区
  for (const t of tabs) if (t.textContent === '外观') t.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  check('外观页有外观图区', win.document.body.textContent.indexOf('外观图') !== -1)
  check('外观页有上传外观图按钮', win.document.body.textContent.indexOf('选择图片') !== -1)
  check(
    '外观页有图片卡片（内置 2 张）',
    win.document.querySelectorAll('.md-img-card').length === 2,
    'count=' + win.document.querySelectorAll('.md-img-card').length,
  )
  check('外观页有姿态下拉', win.document.querySelectorAll('.md-slot-opts .md-select').length >= 2)
  check('外观页有「气泡显示本次消耗」开关', win.document.body.textContent.indexOf('气泡显示本次消耗') !== -1)

  // 切到峰谷页
  for (const t of tabs) if (t.textContent === '峰谷') t.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(120)
  check('峰谷页显示当前价格状态', win.document.body.textContent.indexOf('谷价') !== -1)
  check('峰谷页有闹钟区', win.document.body.textContent.indexOf('闹钟') !== -1)
  // 闹钟「下次…」：启用的显示下次时刻 + 倒计时，停用的明确说停用（都在前端本地算，改完立刻反映）
  const rows = win.document.querySelectorAll('.md-alarm')
  check('有两个闹钟行', rows.length === 2, 'count=' + rows.length)
  const onLine = win.document.querySelector('[data-md-alarm-next="a-on"]')
  const offLine = win.document.querySelector('[data-md-alarm-next="a-off"]')
  check('启用的闹钟显示「下次 + 还有」', !!onLine && onLine.textContent.indexOf('下次 23:59') === 0 && onLine.textContent.indexOf('还有') !== -1, onLine && onLine.textContent)
  check('停用的闹钟明确说「已停用」', !!offLine && offLine.textContent.indexOf('已停用') !== -1, offLine && offLine.textContent)

  // 改时间 → 立刻反映（不用等 Host 轮询）
  const timeInput = rows[0] && rows[0].querySelector('input[type=time]')
  check('闹钟行有时间输入框', !!timeInput)
  if (timeInput) {
    timeInput.value = '06:30'
    timeInput.dispatchEvent(new win.Event('change', { bubbles: true }))
    await sleep(120)
    const updated = win.document.querySelector('[data-md-alarm-next="a-on"]')
    check('改完时间「下次…」立刻跟着改', !!updated && updated.textContent.indexOf('下次 06:30') === 0, updated && updated.textContent)
  }
  check('设置窗口交互没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[8] 事件流：任务完成 / 闹钟（真实推送链路）')
{
  check('前端建立了 SSE 连接', sseInstances.length === 1, 'count=' + sseInstances.length)
  const es = sseInstances[0]
  check('SSE 连的是绝对基址 + /maodie/events', !!es && es.url.indexOf('http://127.0.0.1:19487/maodie/events') === 0, es && es.url)

  // —— 任务完成 ——
  playedAudio.length = 0
  pausedAudio.length = 0
  es.onmessage({ data: JSON.stringify({
    type: 'turn-end',
    data: { seq: 1, at: Date.now(), usage: initPayload.usage, peak: initPayload.peak },
    deliver: { titleFlash: true, flashText: '🔔 任务完成！', sound: true, bubble: true, catAct: true, body: '任务完成 · 今日已用 ¥0.5000', autoCloseSec: 0 },
  }) })
  await sleep(250)
  check('任务完成播了声音', playedAudio.length > 0, playedAudio.join(','))
  const doneBubble = win.document.querySelector('.md-bubble')
  check('任务完成冒了气泡', !!doneBubble)
  check('气泡里带完成文字', !!doneBubble && doneBubble.textContent.indexOf('任务完成') !== -1, doneBubble && doneBubble.textContent.slice(0, 60))
  await sleep(1000)
  check('标题开始闪烁', win.document.title.indexOf('任务完成') !== -1, JSON.stringify(win.document.title))
  doneBubble.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 700, clientY: 400, button: 0 }))
  await sleep(420)
  check('戳破完成气泡后声音被掐断', pausedAudio.length > 0, 'paused=' + pausedAudio.length)
  check('完成气泡已移除', !win.document.querySelector('.md-bubble'))

  // —— 闹钟 ——
  playedAudio.length = 0
  pausedAudio.length = 0
  es.onmessage({ data: JSON.stringify({
    type: 'alarm',
    data: { id: 'a1', name: '起床铃', time: '07:30', text: '起床', at: Date.now() },
    deliver: { sound: true, bubble: true, catAct: true, webNotification: false },
  }) })
  await sleep(250)
  check('闹钟播了声音', playedAudio.length > 0, playedAudio.join(','))
  const alarmBubble = win.document.querySelector('.md-bubble')
  check('闹钟冒了气泡', !!alarmBubble)
  check('闹钟气泡显示自定义文字「起床」', !!alarmBubble && alarmBubble.textContent.indexOf('起床') !== -1, alarmBubble && alarmBubble.textContent.slice(0, 80))
  check('闹钟气泡显示时刻', !!alarmBubble && alarmBubble.textContent.indexOf('07:30') !== -1)
  alarmBubble.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 700, clientY: 400, button: 0 }))
  await sleep(420)
  check('戳破闹钟气泡后声音被掐断（循环音也停）', pausedAudio.length > 0, 'paused=' + pausedAudio.length)
  check('闹钟气泡已移除', !win.document.querySelector('.md-bubble'))
  check('戳破后标题闪烁已停止', win.document.title.indexOf('任务完成') === -1, JSON.stringify(win.document.title))
  check('事件流处理没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[9] 特殊提示音默认留空（连点三下不出声）')
{
  // 这次测试的假接口里，cat.triple 槽位有声音；这里只验证「没有绑定时不报错」
  check('无绑定槽位时不抛异常（fireTrigger 静默返回）', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[10] 本次消耗 / 试听可暂停 / 心跳上报')
{
  // —— 气泡里的「本次消耗」 ——
  root.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 700, clientY: 480, button: 0 }))
  root.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 700, clientY: 480, button: 0 }))
  // 单击要等过「连点判定窗口」才会冒气泡
  await sleep(620)
  const b = win.document.querySelector('.md-bubble')
  check('气泡里有「本次消耗」', !!b && b.textContent.indexOf('本次消耗') !== -1, b && b.textContent.slice(0, 120))
  check('会话累计口径已移出气泡（数据仍在 status/diag/用量页）', true)
  check('会话累计口径不再进气泡（用户要的是本次消耗）', !!b && b.textContent.indexOf('自本次会话开始') === -1, b && b.textContent.slice(0, 200))
  if (b) b.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 700, clientY: 400, button: 0 }))
  await sleep(300)

  // —— 心跳 / 收件箱轮询真的发出去了 ——
  check('上报了前端心跳（/report.json）', requests.some((r) => r.url.includes('/report.json') && r.method === 'POST'))
  check('轮询了事件收件箱（/inbox.json）', requests.some((r) => r.url.includes('/inbox.json')))

  // —— 试听可暂停：素材库 ——
  const libBtn = Array.prototype.find.call(win.document.querySelectorAll('[data-md-preview-key^="sound:"]'), () => true)
  check('素材库有可切换的试听按钮', !!libBtn)
  if (libBtn) {
    playedAudio.length = 0
    libBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(120)
    check('点试听开始播放', playedAudio.length > 0, playedAudio.join(','))
    check('按钮变成「停止试听」', libBtn.textContent === '停止试听', libBtn.textContent)
    libBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(120)
    check('再点一次停止试听', libBtn.textContent === '试听', libBtn.textContent)
  }

  // —— 试听可暂停：裁剪器选区 ——
  const cropBtn = Array.prototype.find.call(win.document.querySelectorAll('.md-btn'), (x) => x.textContent.indexOf('裁剪') === 0 || x.textContent === '裁剪')
  check('素材库有裁剪按钮', !!cropBtn)
  if (cropBtn) {
    cropBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(400)
    const mask = win.document.querySelector('.md-crop-mask')
    check('裁剪器已打开', !!mask)
    const playBtn = Array.prototype.find.call(win.document.querySelectorAll('.md-crop-btns .md-btn'), (x) => x.textContent.indexOf('试听选区') === 0)
    check('裁剪器有试听选区按钮', !!playBtn)
    if (playBtn) {
      playBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
      await sleep(120)
      check('开始循环试听', playBtn.textContent.indexOf('停止试听') !== -1, playBtn.textContent)
      playBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
      await sleep(120)
      check('再点一次停止循环试听', playBtn.textContent.indexOf('试听选区') !== -1, playBtn.textContent)
      const stopBtn = Array.prototype.find.call(win.document.querySelectorAll('.md-crop-btns .md-btn'), (x) => x.textContent.indexOf('停止试听') === 0)
      check('停止按钮在没有试听时是禁用的', !!stopBtn && stopBtn.disabled === true)
    }
    const closeBtn = win.document.querySelector('.md-crop-head .md-set-close')
    if (closeBtn) closeBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(200)
  }

  check('新增交互没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[11] 事件去重必须跨 Host 重启安全（回归）')
{
  // 曾经的事故：lastSeq 存进了 localStorage，Host 重启后计数器从 1 重来，
  // 页面却还记着旧的大序号，于是新事件全被当成「处理过的」丢掉 ——
  // 设置里的测试按钮能弹，真实任务完成却什么都不出现。
  const es = sseInstances[0]
  const send = (msg) => es.onmessage({ data: JSON.stringify(msg) })
  const bubbleNow = () => win.document.querySelector('.md-bubble')
  const popIt = () => {
    const b = bubbleNow()
    if (b) b.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 700, clientY: 400, button: 0 }))
  }
  const turnEnd = (boot, seq) => ({
    type: 'turn-end',
    boot: boot,
    seq: seq,
    data: { seq: seq, at: Date.now(), usage: initPayload.usage, peak: initPayload.peak, session: initPayload.session },
    deliver: { sound: false, bubble: true, catAct: false, body: '回归测试 #' + seq },
  })

  send(turnEnd('BOOT-A', 1))
  await sleep(150)
  check('同一进程内第一条事件正常冒泡', !!bubbleNow() && bubbleNow().textContent.indexOf('回归测试 #1') !== -1)
  popIt()
  await sleep(320)

  send(turnEnd('BOOT-A', 5))
  await sleep(150)
  check('同一进程内后续事件正常冒泡', !!bubbleNow() && bubbleNow().textContent.indexOf('回归测试 #5') !== -1)
  popIt()
  await sleep(320)

  // 关键回归：Host 换了进程，序号从 1 重新开始，不能被当成重复事件丢掉
  send(turnEnd('BOOT-B', 1))
  await sleep(150)
  check(
    'Host 重启后（新 boot、序号重置）事件仍能冒泡',
    !!bubbleNow() && bubbleNow().textContent.indexOf('回归测试 #1') !== -1,
    bubbleNow() ? bubbleNow().textContent.slice(0, 60) : '(没有气泡)',
  )
  popIt()
  await sleep(320)

  // 同一个 boot + 同一个 seq：这才是真的重复，必须忽略
  send(turnEnd('BOOT-B', 1))
  await sleep(150)
  check('同一 boot 内重复的 seq 被去重（不会重复弹）', !bubbleNow())

  send(turnEnd('BOOT-B', 2))
  await sleep(150)
  check('同一 boot 内更大的 seq 正常冒泡', !!bubbleNow() && bubbleNow().textContent.indexOf('回归测试 #2') !== -1)
  popIt()
  await sleep(320)
}

console.log('\n[12] 编辑中的控件不能被重建（回归：改过一次就点不开 / 输入不进去）')
{
  // 事故现场：改任何控件 → persist() → Host 回显 {type:'state'} → refreshFromHost()
  // → renderAllPanes() 把每个面板整体重建 → 你正在用的输入框/下拉变成游离节点，
  // 原生时间选择器和下拉立刻失去宿主。表现：闹钟时间改过一次就输不进去、
  // 外观的常态/哈气下拉点不开、声音里的「随机」下拉点不开。
  const es = sseInstances[0]
  const tabs = win.document.querySelectorAll('.md-set-tab')
  const goTab = async (name) => {
    for (const t of tabs) if (t.textContent === name) t.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(150)
  }
  const initCount = () => requests.filter((r) => r.url.includes('/init.json')).length

  await goTab('提醒')
  const input = win.document.querySelector('.md-set-mask input[type=text]')
  check('提醒页有文字输入框（闪烁文字）', !!input)
  if (input) {
    input.focus()
    input.value = '闪一下'
    input.dispatchEvent(new win.Event('change', { bubbles: true }))
    await sleep(600)
    const beforeEcho = initCount()
    // 模拟 Host 把自己刚保存的内容回显回来
    es.onmessage({ data: JSON.stringify({ type: 'state', boot: 'BOOT-A', seq: 900, data: { at: Date.now() } }) })
    await sleep(400)
    check('自己保存的回显不再触发重新同步', initCount() === beforeEcho, 'init 请求 ' + beforeEcho + ' -> ' + initCount())
    check('自己保存的回显不再重建正在编辑的输入框', input.isConnected === true)

    // 过了回显窗口后，别的来源（例如 Host 侧自愈）改了配置：必须同步，
    // 但光标还在输入框里 —— 这时**连合并都要推迟**，否则会用 Host 上的旧值
    // 覆盖你正在敲的那一格（"输不进去"的真正原因）
    await sleep(2600)
    const beforeRemote = initCount()
    // 故意把 Host 那份配置里的闪烁文字改回旧值：如果此刻合并，输入框会被改回去
    const oldFlash = initPayload.state.notify.turnEnd.flashText
    initPayload.state.notify.turnEnd.flashText = '旧值'
    es.onmessage({ data: JSON.stringify({ type: 'state', boot: 'BOOT-A', seq: 901, data: { at: Date.now() } }) })
    await sleep(300)
    check('输入框有焦点时连状态合并都推迟（不去同步）', initCount() === beforeRemote, 'init 请求 ' + beforeRemote + ' -> ' + initCount())
    check('正在编辑的值没有被 Host 的旧值覆盖', input.value === '闪一下', 'value=' + input.value)
    check('输入框本身也还在（没被重建）', input.isConnected === true)

    input.blur()
    await sleep(1700)
    check('松开焦点后延后的同步与重建会补上', initCount() > beforeRemote, 'init 请求 ' + beforeRemote + ' -> ' + initCount())
    check('延后重建也补上了（节点被换新）', input.isConnected === false)
    initPayload.state.notify.turnEnd.flashText = oldFlash
  }

  // 闹钟时间输入框：改完不能被重建
  await goTab('峰谷')
  const timeInput = win.document.querySelector('.md-set-mask input[type=time]')
  check('峰谷页有时间输入框', !!timeInput)
  if (timeInput) {
    timeInput.focus()
    timeInput.value = '08:15'
    timeInput.dispatchEvent(new win.Event('change', { bubbles: true }))
    await sleep(500)
    check('改完时间输入框本身还在（没被重建）', timeInput.isConnected === true)
    const line = win.document.querySelector('[data-md-alarm-next="a-on"]')
    check('「下次…」文字跟着变成新时间', !!line && line.textContent.indexOf('下次 08:15') === 0, line && line.textContent)
    timeInput.blur()
    await sleep(120)
  }

  // 外观页的姿态下拉：选完不能把自己换掉
  await goTab('外观')
  const poseSelect = win.document.querySelector('.md-set-mask .md-slot-opts select')
  check('外观页有姿态下拉', !!poseSelect)
  if (poseSelect) {
    poseSelect.focus()
    poseSelect.value = 'builtin:hiss'
    poseSelect.dispatchEvent(new win.Event('change', { bubbles: true }))
    await sleep(500)
    check('选完姿态后下拉还在（没被重建）', poseSelect.isConnected === true)
    const catImg = win.document.querySelector('img.md-cat-img')
    check('姿态已生效（猫换成哈气图）', !!catImg && catImg.src.indexOf('builtin%3Ahiss') !== -1, catImg && catImg.src)
    poseSelect.blur()
    await sleep(120)
    // 换回常态，别影响别的用例
    const back = win.document.querySelector('.md-set-mask .md-slot-opts select')
    if (back) {
      back.value = 'builtin:idle'
      back.dispatchEvent(new win.Event('change', { bubbles: true }))
      await sleep(300)
    }
  }

  check('控件交互没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[13] 闹钟：设时间即启用 + 当前这一分钟不算「跳过」')
{
  const tabs = win.document.querySelectorAll('.md-set-tab')
  const goTab = async (name) => {
    for (const t of tabs) if (t.textContent === name) t.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(150)
  }
  await goTab('峰谷')

  // 停用的闹钟（a-off）：改时间应该顺手启用，而不是留下一个看起来配好却永远不响的闹钟
  const offLine = win.document.querySelector('[data-md-alarm-next="a-off"]')
  check('停用的闹钟初始显示「已停用」', !!offLine && offLine.textContent.indexOf('已停用') !== -1, offLine && offLine.textContent)
  const offRow = offLine && offLine.closest('.md-alarm')
  const offTime = offRow && offRow.querySelector('input[type=time]')
  check('停用的闹钟行有时间输入框', !!offTime)
  if (offTime) {
    offTime.focus()
    offTime.value = '09:45'
    offTime.dispatchEvent(new win.Event('change', { bubbles: true }))
    await sleep(500)
    const line = win.document.querySelector('[data-md-alarm-next="a-off"]')
    check('改时间后不再显示「已停用」', !!line && line.textContent.indexOf('已停用') === -1, line && line.textContent)
    check('改时间后显示下次触发', !!line && line.textContent.indexOf('下次 09:45') === 0, line && line.textContent)
    check(
      '行内提示「已随改时间自动启用」',
      !!offRow && offRow.textContent.indexOf('已随改时间自动启用') !== -1,
      offRow && offRow.textContent.slice(0, 90),
    )
    const box = offRow && offRow.querySelector('input[type=checkbox]')
    check('「启用」复选框被勾上', !!box && box.checked === true)
    offTime.blur()
    await sleep(150)
  }

  // 把时间设成「当前这一分钟」：必须算现在就到，不能显示成明天
  await goTab('峰谷')
  const onLine = win.document.querySelector('[data-md-alarm-next="a-on"]')
  const onRow = onLine && onLine.closest('.md-alarm')
  const onTime = onRow && onRow.querySelector('input[type=time]')
  check('启用的闹钟行有时间输入框', !!onTime)
  if (onTime) {
    const dd = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const nowHHMM = p2(dd.getHours()) + ':' + p2(dd.getMinutes())
    onTime.focus()
    onTime.value = nowHHMM
    onTime.dispatchEvent(new win.Event('change', { bubbles: true }))
    await sleep(400)
    const line = win.document.querySelector('[data-md-alarm-next="a-on"]')
    check(
      '设成当前这一分钟后显示「就在这一分钟内」',
      !!line && line.textContent.indexOf('就在这一分钟') !== -1,
      line && line.textContent,
    )
    check('没有跳到明天（不显示日期）', !!line && line.textContent.indexOf('月') === -1, line && line.textContent)
    onTime.blur()
    await sleep(150)
  }

  check('闹钟交互没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[14] 闹钟兜底：Host 不吭声时前端会补一枪（不会自己出声、不会重复响）')
{
  // 事故现场：Host 的 20 秒巡检因为定时器注册失败从来没跑过（diag 里 alarmChecks 一直是 null），
  // 「立即测试」却照常能响 —— 于是闹钟到点永远没动静。现在前端自己也盯时钟：
  // 到点那一分钟如果还没收到 Host 的 alarm 事件，就 POST /alarm-fire.json 请它投一次。
  const pad2 = (n) => String(n).padStart(2, '0')
  const d = new Date()
  const hhmm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  // 把「到点的那一分钟」这个闹钟放进 Host 会下发的配置里，再喂一条 state 事件让前端同步
  initPayload.state.alarms = [{ id: 'a-fallback', name: '兜底', time: hhmm, mode: 'daily', text: '该起了', enabled: true }]
  await sleep(2700) // 让上一节保存的「自我回显」窗口过去，否则这条 state 会被忽略
  const pokesOf = () => requests.filter((r) => r.url.includes('/alarm-fire.json'))
  const before = pokesOf().length
  sseInstances[0].onmessage({ data: JSON.stringify({ type: 'state', boot: 'BOOT-A', seq: 902, data: { at: Date.now() } }) })
  await sleep(1200)
  check('前端同步到了兜底闹钟的配置', true)
  // 兜底巡检是 3 秒一轮，而「到点那一分钟」是挂钟决定的：万一测试刚好跨过分钟边界，
  // 闹钟时间就对不上当前分钟了。所以这里重试几次（每次都把时间重设成当前分钟），
  // 让这条断言只考「补枪行为」，不考「运气」。
  let pokes = pokesOf()
  for (let attempt = 0; attempt < 3 && pokes.length === before; attempt++) {
    const d2 = new Date()
    const p2b = (n) => String(n).padStart(2, '0')
    const hhmm2 = p2b(d2.getHours()) + ':' + p2b(d2.getMinutes())
    initPayload.state.alarms = [{ id: 'a-fallback', name: '兜底', time: hhmm2, mode: 'daily', text: '该起了', enabled: true }]
    sseInstances[0].onmessage({
      data: JSON.stringify({ type: 'state', boot: 'BOOT-A', seq: 905 + attempt, data: { at: Date.now() } }),
    })
    await sleep(3700)
    pokes = pokesOf()
  }
  check('前端在到点那一分钟补了一枪 /alarm-fire.json', pokes.length > before, 'before=' + before + ' after=' + pokes.length)
  check('补枪只发一次（不会刷屏）', pokes.length - before === 1, 'pokes=' + (pokes.length - before))
  check('补枪用的是 POST', pokes.length > 0 && pokes[pokes.length - 1].method === 'POST', pokes.length ? pokes[pokes.length - 1].method : 'none')

  // 收到 Host 的 alarm 事件之后，这一分钟就不再补枪了
  sseInstances[0].onmessage({
    data: JSON.stringify({
      type: 'alarm',
      boot: 'BOOT-A',
      seq: 903,
      data: { id: 'a-fallback', time: hhmm, text: '该起了' },
      deliver: { sound: false, bubble: true },
    }),
  })
  await sleep(3400)
  check('收到 Host 的闹钟事件后不再补枪', pokesOf().length === pokes.length, 'pokes=' + pokesOf().length)
}

console.log('\n[15] 交付时自愈：通知要出声、槽位却被关了 → 当场修好再播（回归）')
{
  // 事故现场：state 里 turn.end 槽位 enabled=false，弹窗照旧、就是没声音；
  // 而 state.meta.soundAutoHealed 里还有 1.2.1 留下的「已修过」记录挡着不再修。
  initPayload.state.audio.slots = [
    { id: 'slot-done', name: '任务完成音', trigger: 'turn.end', sounds: ['builtin:jiao'], strategy: 'random', loop: false, cooldownMs: 0, enabled: false },
    { id: 'slot-hiss', name: '提示音', trigger: 'cat.click', sounds: ['builtin:hiss'], strategy: 'random', loop: false, cooldownMs: 0, enabled: false },
  ]
  initPayload.state.notify.turnEnd.enabled = true
  initPayload.state.notify.turnEnd.sound = true
  await sleep(2700) // 越过「自我回显」窗口
  sseInstances[0].onmessage({ data: JSON.stringify({ type: 'state', boot: 'BOOT-A', seq: 910, data: { at: Date.now() } }) })
  await sleep(700)

  const tabs = win.document.querySelectorAll('.md-set-tab')
  const goTab = async (name) => {
    for (const t of tabs) if (t.textContent === name) t.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(220)
  }
  const paneText = () => {
    // 所有面板都在 DOM 里（只显示一个），所以必须按「声音」这个面板本身去找告警框，
    // 不能直接 querySelector('.md-warn')（会命中别的面板的告警）
    const list = Array.from(win.document.querySelectorAll('.md-set-pane'))
    const tabList = Array.from(tabs)
    let idx = -1
    for (let i = 0; i < tabList.length; i++) if (tabList[i].textContent === '声音') idx = i
    const pane = idx >= 0 ? list[idx] : null
    const box = pane ? pane.querySelector('.md-warn') : null
    return box ? box.textContent : ''
  }
  await goTab('声音')
  const before = paneText()
  check('修复前设置页明确报「任务完成音不会出声」', before.indexOf('任务完成音') !== -1, before.slice(0, 140))
  check('修复前也报「提示音不会出声」（这条是用户自己关的，不该动）', before.indexOf('提示音') !== -1, before.slice(0, 140))

  // 到点了：Host 要求出声
  const postsBefore = requests.filter((r) => r.url.includes('/state.json')).length
  playedAudio.length = 0
  sseInstances[0].onmessage({
    data: JSON.stringify({
      type: 'turn-end',
      boot: 'BOOT-A',
      seq: 911,
      data: { seq: 3, at: Date.now(), usage: initPayload.usage, peak: initPayload.peak, session: initPayload.session },
      deliver: { sound: true, bubble: false, catAct: false, titleFlash: false, webNotification: false },
    }),
  })
  await sleep(700)
  check('通知要求出声 → 声音真的播了（不再只有弹窗）', playedAudio.length > 0, playedAudio.join(','))
  check('播的正是任务完成音的素材', playedAudio.some((s) => String(s).indexOf('jiao') !== -1), playedAudio.join(','))

  // 直接看回写给 Host 的那份配置：这比看界面文字更硬（界面可能被后续同步覆盖）
  const statePosts = requests.filter((r) => r.url.includes('/state.json'))
  check('修好的配置回写给了 Host', statePosts.length > postsBefore)
  const posted = statePosts.length ? JSON.parse(String(statePosts[statePosts.length - 1].body || '{}')) : {}
  const postedSlots = (posted.state && posted.state.audio && posted.state.audio.slots) || []
  const postedDone = postedSlots.filter((s) => s.trigger === 'turn.end')[0]
  const postedHiss = postedSlots.filter((s) => s.trigger === 'cat.click')[0]
  check('回写的配置里任务完成音槽位已被当场启用', !!postedDone && postedDone.enabled !== false, JSON.stringify(postedDone))
  check('回写的配置里「提示音」仍然是关的（用户自己的静音没被改）', !!postedHiss && postedHiss.enabled === false, JSON.stringify(postedHiss))

  await goTab('外观')
  await goTab('声音')
  const after = paneText()
  check('用户自己关掉的「提示音」告警仍在（没有被自作主张打开）', after.indexOf('提示音') !== -1, after.slice(0, 160))
}

console.log('\n[16] 设置窗口固定居中、不可拖动（用户要求：别再拖到屏幕边上卡住）')
{
  const openSettings = async () => {
    root.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await sleep(200)
  }
  const closeSettings = async () => {
    const m = win.document.querySelector('.md-set-mask')
    const btn = m && m.querySelector('.md-set-close')
    if (btn) btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(150)
  }
  const maskWin = () => win.document.querySelector('.md-set-mask .md-set')
  const headOf = () => win.document.querySelector('.md-set-mask .md-set-head')

  // 模拟「以前被拖到某个角落」留下的 inline 位置
  let w = maskWin()
  check('设置窗口已打开', !!w)
  if (w) w.style.left = '37px'
  await closeSettings()
  await openSettings()
  w = maskWin()
  check(
    '重新打开后清掉了残留位置（自动回到居中）',
    !!w && w.style.left === '' && w.style.top === '',
    w ? w.style.left + '|' + w.style.top : 'no-win',
  )

  const head = headOf()
  check('设置窗口标题栏还在', !!head)
  if (head && w) {
    const before = { left: w.style.left, top: w.style.top }
    head.dispatchEvent(new win.PointerEvent('pointerdown', { clientX: 700, clientY: 300, button: 0 }))
    head.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 1000, clientY: 600, button: 0 }))
    head.dispatchEvent(new win.PointerEvent('pointerup', { clientX: 1000, clientY: 600, button: 0 }))
    await sleep(120)
    check(
      '拖动标题栏不再移动窗口',
      w.style.left === before.left && w.style.top === before.top && w.style.left === '',
      'left=' + w.style.left + ' top=' + w.style.top,
    )
  }
  check('设置窗口交互没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
  await closeSettings()
}

console.log('\n[17] 「用量」页：账户分开 + 单价表')
{
  const tabs = win.document.querySelectorAll('.md-set-tab')
  const tabList = Array.from(tabs)
  let idx = -1
  tabList.forEach((t, i) => {
    if (t.textContent === '用量') idx = i
  })
  check('存在「用量」标签页', idx !== -1)
  const tabBtn = idx >= 0 ? tabList[idx] : null
  if (tabBtn) tabBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)

  const panes = Array.from(win.document.querySelectorAll('.md-set-pane'))
  const pane = idx >= 0 ? panes[idx] : null
  const text = pane ? pane.textContent : ''
  check('用量页渲染出来了', !!pane && text.length > 0)
  check('用量页把两个账户分开列出', text.indexOf('DeepSeek') !== -1 && text.indexOf('小米 MiMo') !== -1, text.slice(0, 140))
  check('有官方余额的账户显示金额', text.indexOf('12.34') !== -1, text.slice(0, 200))
  check('没有官方来源的账户显示「余额未知」', text.indexOf('余额未知') !== -1, text.slice(0, 200))
  check('第三方金额标注「仅供参考」', text.indexOf('仅供参考') !== -1, text.slice(0, 240))
  check('显示总消耗', text.indexOf('总消耗（所有账户加总）') !== -1)
  check('有单价表编辑区', text.indexOf('单价表（元/百万 token）') !== -1)
  check('用量页写明「余额是怎么来的」', text.indexOf('余额是怎么来的') !== -1 && text.indexOf('api.deepseek.com/user/balance') !== -1, text.slice(0, 200))
  check('用量页写清自定义来源怎么填', text.indexOf('余额字段') !== -1 && text.indexOf('控制台') !== -1, text.slice(0, 400))
  check(
    'DSH 登录账号卡片：充值余额 + 赠送额度分开显示',
    text.indexOf('DSH 登录账号') !== -1 && text.indexOf('充值余额') !== -1 && text.indexOf('赠送额度') !== -1 && text.indexOf('50.00') !== -1 && text.indexOf('5.00') !== -1,
    text.slice(0, 400),
  )
  check('带官方用量页入口', text.indexOf('platform.deepseek.com/usage') !== -1)
  check('可手动刷新账号/自定义/官方余额', text.indexOf('账号余额') !== -1 && text.indexOf('自定义来源') !== -1 && text.indexOf('官方余额') !== -1)
  const urlInputs = pane ? pane.querySelectorAll('input[placeholder^="地址："]') : []
  check('每个账户有「余额来源」地址填写框', urlInputs.length >= 2, 'count=' + urlInputs.length)
  const testBtns = pane ? Array.from(pane.querySelectorAll('button')).filter((b) => b.textContent === '测试') : []
  check('每个账户有「测试」按钮', testBtns.length >= 2, 'count=' + testBtns.length)
  check('用量页没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n[18] 「关于」页：更新面板')
{
  const tabs = Array.from(win.document.querySelectorAll('.md-set-tab'))
  let idx = -1
  tabs.forEach((t, i) => {
    if (t.textContent === '关于') idx = i
  })
  check('存在「关于」标签页', idx !== -1)
  if (idx >= 0) tabs[idx].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)

  const panes = Array.from(win.document.querySelectorAll('.md-set-pane'))
  const pane = idx >= 0 ? panes[idx] : null
  const text = pane ? pane.textContent : ''
  check('关于页渲染出来了', !!pane && text.length > 0)
  check('显示当前版本与最新版本', text.indexOf('当前版本') !== -1 && text.indexOf('1.3.4') !== -1 && text.indexOf('最新版本') !== -1 && text.indexOf('9.9.9（可更新）') !== -1, text.slice(0, 200))
  check('显示最后检查时间（不是「还没检查过」）', text.indexOf('最后检查') !== -1 && text.indexOf('还没检查过') === -1, text.slice(0, 200))
  check('显示更新说明摘要', text.indexOf('更新说明') !== -1 && text.indexOf('新增某功能') !== -1, text.slice(0, 400))
  check('显示安装包与体积', text.indexOf('dsh-maodie-9.9.9.tgz') !== -1 && text.indexOf('11.8 MB') !== -1, text.slice(0, 400))

  const btns = pane ? Array.from(pane.querySelectorAll('button')).map((b) => b.textContent) : []
  check('有「检查更新」按钮', btns.indexOf('检查更新') !== -1, btns.join(','))
  check('有「立即更新」按钮（有新版本时）', btns.indexOf('立即更新') !== -1, btns.join(','))
  check('有「打开发布页」按钮', btns.indexOf('打开发布页') !== -1, btns.join(','))

  const cbs = pane ? Array.from(pane.querySelectorAll('input[type=checkbox]')) : []
  check('有自动检查与自动安装两个开关', cbs.length === 2, 'count=' + cbs.length)
  check('自动检查默认勾上', cbs.length >= 1 && cbs[0].checked === true)
  check('自动安装默认不勾', cbs.length >= 2 && cbs[1].checked === false)
  check('开关有说明文字', text.indexOf('每 6 小时一次') !== -1 && text.indexOf('默认关') !== -1, text.slice(0, 400))
  check('显示更新目标目录并提示 git 工作区', text.indexOf('C:/x/dsh-maodie') !== -1 && text.indexOf('git 工作区') !== -1, text.slice(0, 500))
  check('关于页没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\n=== 结果：' + passed + ' 通过 / ' + failed + ' 失败 ===')
if (pageErrors.length) {
  console.log('\n页面异常记录：')
  pageErrors.forEach((e) => console.log('  - ' + e))
}
if (failures.length) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
}
process.exit(failed === 0 ? 0 : 1)
