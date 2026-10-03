// ============================================================================
// 耄耋 (maodie) —— Host 半
// ============================================================================
// 职责：
//   1. 峰谷价判定（周末 + 法定节假日全天谷价；节假日联网拉取 + 本地缓存 + 手动覆盖）
//   2. DeepSeek 余额 / 今日已用（余额差记账 + 会话 usage 兜底，输出金额与 token）
//   3. 状态持久化（~/.dsh/maodie/state.json）+ 自定义素材库（音频）
//   4. 一批带信任栅栏的路由（状态读写 / 素材 / 事件流 / 原生提醒探针）
//   5. 监听 session/event：turn/end → 任务完成事件 + 原生窗口提醒
//   6. 闹钟（Host 侧定时器，DSH 开着就检查；到点推给前端循环播放）
//   7. 原生能力探针：可用则调用 Electron 的 flashFrame / show / Notification，
//      不可用则静默降级，绝不影响插件其余功能。
//
// 设计约束（照本机两个已验证插件的经验）：
//   - 模块顶层不读盘、不抛错（profile 启动安全第一）
//   - 所有自定义路由先过 connection.requestRejection（浏览器信任栅栏）
//   - 一切外部依赖（Electron / 凭据 / 网络）都 try/catch 并降级
//   - 本插件完全自包含，不引用、不依赖、不修改任何其它已装插件
//
// 前端怎么进页面（2026-10 桌面版迁移，见 README「桌面端注入」）：
//   唯一正确通道是 webServer 的**结构化 index 注入行**——监听
//   `webserver/index-inject` 事件，往收集表里 push 一行
//   `{ kind: 'script-src', placement: 'head', src: '/maodie/maodie.js?v=…' }`。
//   - 浏览器直连：frontend-static 渲染 index 时把行渲染成真正的 <script>
//   - 桌面端主窗口：页面跑在 dsh-app://app/ 下，Electron 壳不消费被改造过的
//     dist/index.html，而是启动时调 `ctx.webServer.collectIndexInjections()`
//     拿整张表，经 `dshDesktopBoot.ready()` 交给页面里的解释器逐行执行
//   - 相对路径 /maodie/… 在桌面端由 dsh-app:// 协议处理器转发给 Host（带会话
//     cookie），所以前端用相对路径即可，不需要知道 Host 端口
// ============================================================================

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire as createRequireFn } from 'node:module'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const STATE_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'maodie'),
  path.join(DSH_HOME, 'profiles', 'desktop', 'maodie'),
]
const STATE_FILE_NAME = 'state.json'
const HOLIDAY_FILE_NAME = 'holidays.json'

const ROUTE_BASE = '/maodie'

// 插件版本：既做前端脚本的缓存失效参数，也是「前端脚本 vs Host 模块」版本对齐的依据
const PLUGIN_VERSION = '1.2.9'
// 前端脚本的 URL 前缀；注入行与自检页都用它拼，保持单一事实来源
const SCRIPT_SRC = ROUTE_BASE + '/maodie.js'

// 前端该从哪个源取数据。桌面端主界面跑在 dsh-app://app/ 下：
//   - 相对路径会被 dsh-app:// 协议处理器转发给 Host（并带上会话 cookie），
//     这是首选，因此这里默认返回空串（= 同源相对路径）。
//   - 若部署方确实需要绝对 HTTP 基址（例如把页面嵌到别的源里），
//     可用环境变量 DSH_WEB_URL 覆盖。
function resolveWebBase() {
  const fromEnv = process.env.DSH_WEB_URL
  if (typeof fromEnv === 'string' && /^https?:\/\//.test(fromEnv)) return fromEnv.replace(/\/+$/, '')
  return ''
}

// 插件是 ESM，模块作用域没有 require。桌面主进程里需要它来探测 Electron 与取模块对象。
// 注意：用 createRequire 取到的 'node:fs/promises' 与顶部静态 import 是**同一个模块对象**，
// 所以补丁会打在同一份 readFile 上——这正是我们要的。
let cachedRequire = null
function resolveRequire() {
  if (cachedRequire) return cachedRequire
  try {
    if (typeof require === 'function') {
      cachedRequire = require
      return cachedRequire
    }
  } catch (err) {
    /* 忽略 */
  }
  try {
    const createRequire = createRequireFn
    if (typeof createRequire === 'function') {
      cachedRequire = createRequire(import.meta.url)
      return cachedRequire
    }
  } catch (err) {
    /* 忽略 */
  }
  return null
}

// ---------------------------------------------------------------- 峰谷定价
// 高峰：工作日 09:00–12:00、14:00–18:00（北京时间）
// 谷价：周六 / 周日 / 法定节假日 全天，以及工作日的其余时段
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
const BJ_OFFSET_MS = 8 * 3600 * 1000

// 内置年度节假日兜底表（联网不可用时使用；格式 'YYYY-MM-DD'）
// 数据来源：国务院办公厅节假日安排，2026 年（与中国大陆公开节假日接口一致）
const BUILTIN_HOLIDAYS = {
  '2026-01-01': '元旦',
  '2026-01-02': '元旦',
  '2026-01-03': '元旦',
  '2026-02-15': '春节',
  '2026-02-16': '除夕',
  '2026-02-17': '初一',
  '2026-02-18': '初二',
  '2026-02-19': '初三',
  '2026-02-20': '初四',
  '2026-02-21': '初五',
  '2026-02-22': '初六',
  '2026-02-23': '初七',
  '2026-04-04': '清明节',
  '2026-04-05': '清明节',
  '2026-04-06': '清明节',
  '2026-05-01': '劳动节',
  '2026-05-02': '劳动节',
  '2026-05-03': '劳动节',
  '2026-05-04': '劳动节',
  '2026-05-05': '劳动节',
  '2026-06-19': '端午节',
  '2026-06-20': '端午节',
  '2026-06-21': '端午节',
  '2026-09-25': '中秋节',
  '2026-09-26': '中秋节',
  '2026-09-27': '中秋节',
  '2026-10-01': '国庆节',
  '2026-10-02': '国庆节',
  '2026-10-03': '国庆节',
  '2026-10-04': '国庆节',
  '2026-10-05': '国庆节',
  '2026-10-06': '国庆节',
  '2026-10-07': '国庆节',
}

const HOLIDAY_SOURCES = [
  (year) => `https://timor.tech/api/holiday/year/${year}`,
]

// ---------------------------------------------------------------- 默认状态

// 内置素材清单：随包发布，id 固定；用户可上传更多
const BUILTIN_SOUNDS = [
  { id: 'builtin:hiss', name: '哈气', file: 'sound/hiss.m4a', mime: 'audio/mp4', builtin: true, note: '1 秒' },
  { id: 'builtin:jiao', name: '叫一叫', file: 'sound/jiao.mp3', mime: 'audio/mpeg', builtin: true, note: '55 秒' },
  { id: 'builtin:dahuoji', name: '打火基', file: 'sound/dahuoji.mp3', mime: 'audio/mpeg', builtin: true, note: '2 分 03 秒' },
  { id: 'builtin:qichuang', name: '起床哈', file: 'sound/qichuang.mp3', mime: 'audio/mpeg', builtin: true, note: '1 分 30 秒' },
  { id: 'builtin:lanlian', name: '蓝莲哈', file: 'sound/lanlian.mp3', mime: 'audio/mpeg', builtin: true, note: '4 分 33 秒' },
]

// 内置外观图。meta = 图片的 canvas 尺寸 + 不透明区域的 alpha 包围盒，
// 前端按它换算姿态切换时的缩放与对齐（两张图的 canvas 不同，必须按包围盒对）。
const BUILTIN_IMAGES = [
  {
    id: 'builtin:idle',
    name: '常态',
    file: 'cat-idle.png',
    mime: 'image/png',
    builtin: true,
    note: '1248x2048',
    meta: { canvasW: 1248, canvasH: 2048, bboxX: 169, bboxY: 147, bboxW: 1051, bboxH: 1853 },
  },
  {
    id: 'builtin:hiss',
    name: '哈气',
    file: 'cat-hiss.png',
    mime: 'image/png',
    builtin: true,
    note: '1280x1760',
    meta: { canvasW: 1280, canvasH: 1760, bboxX: 209, bboxY: 152, bboxW: 1015, bboxH: 1607 },
  },
]

// 触发器清单：槽位绑定到这些"插座"上
const TRIGGERS = [
  { id: 'cat.click', name: '猫·点击', desc: '点一下猫' },
  { id: 'cat.triple', name: '猫·连击', desc: '连点三下（打你一下 + 爆炸）' },
  { id: 'turn.end', name: '任务完成', desc: '一轮对话结束' },
  { id: 'alarm.fire', name: '闹钟到时', desc: '闹钟触发' },
  { id: 'balance.low', name: '余额预警', desc: '余额低于阈值' },
  { id: 'budget.over', name: '今日预算', desc: '今日已用超过阈值' },
  { id: 'cat.hover', name: '猫·悬浮', desc: '鼠标移到猫上' },
  { id: 'cat.rightclick', name: '猫·右键', desc: '右键点猫' },
]

function defaultState() {
  return {
    version: 1,
    // —— 外观 ——
    appearance: {
      // 归一化的屏幕坐标（0..1），左上角为原点；null 表示用默认右下角
      x: null,
      y: null,
      scale: 1, // 0.4 .. 3
      baseSize: 220, // 基准边长（px），实际尺寸 = baseSize * scale
      opacity: 1,
      // 两个姿态各自用哪张外观图（内置 builtin:idle / builtin:hiss，可换成自己上传的 user:xxx）
      poses: {
        idle: 'builtin:idle',
        hiss: 'builtin:hiss',
      },
      // 图片对齐参数（按两张图的 alpha 包围盒预先算好）
      align: {
        idle: { scale: 1, dx: 0, dy: 0 },
        hiss: { scale: 1, dx: 0, dy: 0 },
      },
      shadow: true,
      pet: true, // 按压时轻微挤压回弹
    },
    // —— 视觉表现 ——
    look: {
      flipAtLeft: true, // 贴左侧时水平镜像
      clickAnim: 'shake', // 点击动画：shake | pop | none
      tripleShake: true, // 三连击摇晃
      particles: true, // 粒子爆炸
      particleCount: 26,
      bubbleStyle: 'balloon', // balloon | card
      showSessionCost: true, // 气泡里显示「本次消耗」（当前会话）
    },
    // —— 声音 ——
    audio: {
      volume: 0.9,
      slots: [
        {
          id: 'slot-hiss',
          name: '提示音',
          trigger: 'cat.click',
          sounds: ['builtin:hiss'],
          strategy: 'random',
          loop: false,
          cooldownMs: 300,
          enabled: true,
        },
        {
          // 用户要求：特殊提示音（三连击）默认留空，自己去素材库里勾
          id: 'slot-triple',
          name: '特殊提示音',
          trigger: 'cat.triple',
          sounds: [],
          strategy: 'random',
          loop: false,
          cooldownMs: 800,
          enabled: true,
        },
        {
          // 用户要求：默认勾上全部 MP3（哈气是 m4a，不参与），随机抽一个
          id: 'slot-done',
          name: '任务完成音',
          trigger: 'turn.end',
          sounds: ['builtin:jiao', 'builtin:dahuoji', 'builtin:qichuang', 'builtin:lanlian'],
          strategy: 'random',
          loop: false,
          cooldownMs: 3000,
          enabled: true,
        },
        {
          // 用户要求：闹钟默认同样勾上全部 MP3，随机抽一个；循环到手动停
          id: 'slot-alarm',
          name: '闹钟音',
          trigger: 'alarm.fire',
          sounds: ['builtin:jiao', 'builtin:dahuoji', 'builtin:qichuang', 'builtin:lanlian'],
          strategy: 'random',
          loop: true,
          cooldownMs: 0,
          enabled: true,
        },
      ],
    },
    // —— 提示方式 ——
    notify: {
      turnEnd: {
        enabled: true,
        native: true, // 原生窗口闪烁 / 还原前台
        systemNotification: true, // 系统通知（未授权自动降级）
        titleFlash: true, // 标签页标题闪烁
        flashText: '🔔 任务完成！',
        sound: true,
        bubble: true, // 冒完成气泡
        catAct: true, // 猫表演一下
        body: '任务完成 · 今日已用 ¥{today} · 余额 ¥{balance}',
        autoCloseSec: 0, // 0 = 不自动关
      },
      balanceLow: { enabled: false, below: 5, sound: true, bubble: true },
      budget: { enabled: false, amount: 10, sound: true, bubble: true },
    },
    // —— 音频裁剪默认项 ——
    crop: {
      fadeEnabled: true,
      fadeMs: 15,
      normalize: false,
      trimSilence: false,
      keepOriginal: true,
    },
    // —— 峰谷 / 日历 ——
    peak: {
      online: true, // 联网自动拉取节假日
      lastFetchAt: 0,
      overrides: {}, // 'YYYY-MM-DD' -> 'valley' | 'peak'
    },
    // —— 闹钟 ——
    alarms: [],
    // —— 安全 ——
    // 服务器默认只绑回环（127.0.0.1）。要更严格就把 requireAuth 设为 true：
    // 数据路由会走 ctx.connection 的 Host/Origin + 会话 cookie 校验。
    security: {
      requireAuth: false,
      // 是否往 index 注入前端脚本行（webserver/index-inject）。
      // 关掉它 = 页面里不再出现猫；注入表是启动时收集的，改完需重新收集才生效
      injectMainWindow: true,
    },
    // —— 其它 ——
    meta: { installedAt: 0, updatedAt: 0 },
  }
}

// ---------------------------------------------------------------- 工具函数

function clamp(value, min, max) {
  const n = Number(value)
  if (!isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 深合并：只覆盖对象里出现的键，数组整体替换 */
function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base)
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDeep(out[key], value)
    else out[key] = value
  }
  return out
}

function bjParts(ms) {
  const d = new Date(ms + BJ_OFFSET_MS)
  const pad = (n) => String(n).padStart(2, '0')
  const y = d.getUTCFullYear()
  const m = pad(d.getUTCMonth() + 1)
  const day = pad(d.getUTCDate())
  return {
    date: `${y}-${m}-${day}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0=周日 6=周六
    year: y,
  }
}

// 本地时间（闹钟按**用户墙上的时钟**走：每天 9:00 就是他本地的 9:00）。
// 峰谷价仍然按北京时间算（那是计费口径），两者不要混。
function localParts(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: d.getHours(),
    minute: d.getMinutes(),
    weekday: d.getDay(), // 0=周日 6=周六
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    year: d.getFullYear(),
  }
}

// ---------------------------------------------------------------- 插件本体

export default {
  name: 'maodie',
  inject: ['webServer'],
  apply(ctx) {
    const disposers = []
    const app = createHost(ctx, disposers)
    app.start()
    ctx.effect(() => () => app.dispose())
  },
}

function createHost(ctx, disposers) {
  // ---------------- 状态 ----------------
  let state = defaultState()
  let stateDir = STATE_DIR_CANDIDATES[0]
  let stateFile = path.join(stateDir, STATE_FILE_NAME)
  let holidayFile = path.join(stateDir, HOLIDAY_FILE_NAME)

  // 运行时缓存
  const runtime = {
    holidays: Object.assign({}, BUILTIN_HOLIDAYS),
    holidaySource: 'builtin',
    holidayFetchedAt: 0,
    balance: null, // { totalBalance, currency, updatedAt }
    balanceError: null,
    balanceInFlight: null,
    ledger: null, // { date, dayStart, todayTokens, todayCost, events: [] }
    lastTurn: null,
    turnSeq: 0,
    sseClients: new Set(),
    native: { probed: false, electron: false, window: false, notify: false, reason: '' },
    alarmFiredThisMinute: new Set(),
    lastSoundAt: {},
    lastAlarmCheck: null,
    // 前端启动回执 + 心跳（唯一能证明「脚本真的在页面里跑起来了」的 Host 侧证据）
    helloCount: 0,
    lastHello: null,
    soundHeal: null,
    report: null,
    reportAt: 0,
    // 定时器登记与心跳：闹钟巡检「到底跑没跑」必须能在 diag 里直接看到
    timers: [],
    timerTicks: {},
    timerErrors: {},
    // 事件双通道：SSE 即时送达 + 收件箱轮询兜底。
    // bootId = 本次 Host 进程的启动标识：seq 只在同一个 bootId 内可比，
    // 进程重启后 seq 会从头开始，前端必须能分辨这件事（否则会把新事件当旧的丢掉）。
    eventSeq: 0,
    bootId: '',
    inbox: [],
    // 本次消耗（当前会话）：以会话开始时的余额为基准做余额差
    session: null,
  }

  const readJson = (file) => {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(text)
      return isPlainObject(parsed) ? parsed : null
    } catch (err) {
      return null
    }
  }

  const writeJson = (file, value) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch (err) {
      return false
    }
  }

  const pickStateDir = () => {
    for (const dir of STATE_DIR_CANDIDATES) {
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.accessSync(dir, fs.constants.W_OK)
        return dir
      } catch (err) {
        /* 试下一个 */
      }
    }
    return STATE_DIR_CANDIDATES[0]
  }

  const loadState = () => {
    const parsed = readJson(stateFile)
    if (parsed) state = mergeDeep(defaultState(), parsed)
    if (!state.meta.installedAt) state.meta.installedAt = Date.now()
    state.meta.updatedAt = Date.now()
  }

  const saveState = () => {
    state.meta.updatedAt = Date.now()
    return writeJson(stateFile, state)
  }

  // ---------------- 账本（今日已用） ----------------
  const loadLedger = () => {
    if (runtime.ledger) return runtime.ledger
    const today = bjParts(Date.now()).date
    const saved = readJson(path.join(stateDir, 'ledger.json'))
    runtime.ledger =
      saved && saved.date === today
        ? saved
        : {
            date: today,
            dayStartBalance: null,
            todayTokens: 0,
            models: {},
            events: [],
            // 会话花费跨天也要保留（否则半夜过后「本次消耗」会从 0 重新算）
            session: (saved && saved.session) || null,
          }
    if (!runtime.ledger.session && saved && saved.session) runtime.ledger.session = saved.session
    return runtime.ledger
  }

  const saveLedger = () => {
    if (!runtime.ledger) return false
    // 只保留最近 500 条事件，避免无限膨胀
    if (Array.isArray(runtime.ledger.events) && runtime.ledger.events.length > 500) {
      runtime.ledger.events = runtime.ledger.events.slice(-500)
    }
    return writeJson(path.join(stateDir, 'ledger.json'), runtime.ledger)
  }

  // ---------------- SSE ----------------
  const sseSend = (payload) => {
    const text = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of runtime.sseClients) {
      try {
        res.write(text)
      } catch (err) {
        runtime.sseClients.delete(res)
      }
    }
  }

  // 事件发布：SSE 即时送达 + 写进收件箱。
  // 为什么要有收件箱：桌面端主窗口跑在 dsh-app:// 下，EventSource 不一定连得上，
  // 而「闹钟到点」「任务完成」这两类事件丢了就没法补救。前端按 seq 去重，
  // 所以 SSE 与轮询同时开着也不会重复触发。
  const publishEvent = (payload, keepInInbox = true) => {
    runtime.eventSeq += 1
    const item = Object.assign({ seq: runtime.eventSeq, boot: runtime.bootId, at: Date.now() }, payload)
    if (keepInInbox) {
      runtime.inbox.push(item)
      if (runtime.inbox.length > 80) runtime.inbox = runtime.inbox.slice(-80)
    }
    sseSend(item)
    return item
  }

  // 配置变了 / 会话花费更新了：让连着的页面重新拉一次 init.json
  const broadcastState = () => {
    publishEvent({ type: 'state', data: { at: Date.now() } }, false)
  }

  // ---------------- 峰谷判定 ----------------
  const holidayName = (date) => {
    const custom = state.peak.overrides[date]
    if (custom === 'valley') return '自定义·谷价'
    if (custom === 'peak') return null
    return runtime.holidays[date] || null
  }

  const peakInfo = (ms = Date.now()) => {
    const parts = bjParts(ms)
    const override = state.peak.overrides[parts.date]
    const isWeekend = parts.weekday === 0 || parts.weekday === 6
    const holiday = holidayName(parts.date)

    let kind = 'valley'
    let reason = '非高峰时段'
    if (override === 'peak') {
      kind = 'peak'
      reason = '自定义·高峰'
    } else if (isWeekend) {
      kind = 'valley'
      reason = '周末全天谷价'
    } else if (holiday) {
      kind = 'valley'
      reason = `节假日全天谷价（${holiday}）`
    } else if (override === 'valley') {
      kind = 'valley'
      reason = '自定义·谷价'
    } else {
      for (const [start, end] of PEAK_HOURS) {
        if (parts.hour >= start && parts.hour < end) {
          kind = 'peak'
          reason = `高峰时段 ${start}:00–${end}:00`
          break
        }
      }
    }

    // 计算下一个切换点（下一个整点边界里最近的一次状态变化，最多往后 8 天）
    let nextAt = null
    for (let step = 0; step <= 8 * 24 * 60; step += 15) {
      const probe = ms + step * 60000
      const p = bjParts(probe)
      let k = 'valley'
      const ov = state.peak.overrides[p.date]
      const weekend = p.weekday === 0 || p.weekday === 6
      const hol = holidayName(p.date)
      if (ov === 'peak') k = 'peak'
      else if (weekend || hol || ov === 'valley') k = 'valley'
      else {
        for (const [start, end] of PEAK_HOURS) {
          if (p.hour >= start && p.hour < end) {
            k = 'peak'
            break
          }
        }
      }
      if (k !== kind) {
        nextAt = probe
        break
      }
    }

    return {
      kind,
      reason,
      date: parts.date,
      hour: parts.hour,
      minute: parts.minute,
      weekday: parts.weekday,
      isWeekend,
      holiday,
      nextAt,
      nextKind: kind === 'peak' ? 'valley' : 'peak',
      peakHours: PEAK_HOURS,
      holidaySource: runtime.holidaySource,
      holidayFetchedAt: runtime.holidayFetchedAt,
    }
  }

  // ---------------- 节假日拉取 ----------------
  const loadHolidayCache = () => {
    const cached = readJson(holidayFile)
    if (cached && isPlainObject(cached.days)) {
      runtime.holidays = Object.assign({}, BUILTIN_HOLIDAYS, cached.days)
      runtime.holidaySource = cached.source || 'cache'
      runtime.holidayFetchedAt = Number(cached.fetchedAt) || 0
    }
  }

  const refreshHolidays = async (force = false) => {
    const now = Date.now()
    if (!force && now - runtime.holidayFetchedAt < 12 * 3600 * 1000) {
      return { ok: true, skipped: true, source: runtime.holidaySource }
    }
    if (!state.peak.online && !force) return { ok: false, skipped: true, reason: 'offline-disabled' }

    const year = bjParts(now).year
    const days = {}
    let source = ''
    for (const build of HOLIDAY_SOURCES) {
      for (const y of [year, year + 1]) {
        const url = build(y)
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
          if (!res.ok) continue
          const data = await res.json()
          const table = data && (data.holiday || data.days)
          if (!isPlainObject(table)) continue
          for (const key of Object.keys(table)) {
            const entry = table[key]
            if (!isPlainObject(entry)) continue
            if (entry.holiday === true && typeof entry.date === 'string') {
              days[entry.date] = entry.name || '节假日'
            }
          }
          source = url
        } catch (err) {
          /* 换下一个源 */
        }
      }
      if (Object.keys(days).length > 0) break
    }

    if (Object.keys(days).length === 0) {
      return { ok: false, reason: 'all-sources-failed', source: runtime.holidaySource }
    }

    runtime.holidays = Object.assign({}, BUILTIN_HOLIDAYS, days)
    runtime.holidaySource = source
    runtime.holidayFetchedAt = now
    state.peak.lastFetchAt = now
    writeJson(holidayFile, { source, fetchedAt: now, days })
    saveState()
    return { ok: true, count: Object.keys(days).length, source }
  }

  // ---------------- 余额 / 已用 ----------------
  const fetchBalance = async () => {
    if (runtime.balanceInFlight) return runtime.balanceInFlight
    runtime.balanceInFlight = (async () => {
      const tryKeys = ['DEEPSEEK_API_KEY']
      let lastError = null
      for (const key of tryKeys) {
        let cred = null
        try {
          const credentials = ctx.get('credentials')
          if (credentials && typeof credentials.resolve === 'function') {
            cred = await credentials.resolve(key)
          }
        } catch (err) {
          lastError = '凭据读取失败: ' + String(err && err.message ? err.message : err)
          continue
        }
        const token = cred && (cred.value || cred.secret)
        if (!token) {
          lastError = lastError || '未配置 ' + key
          continue
        }
        try {
          const res = await fetch('https://api.deepseek.com/user/balance', {
            headers: { Authorization: 'Bearer ' + token },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) {
            lastError = 'HTTP ' + res.status
            continue
          }
          const data = await res.json()
          const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
          if (infos.length === 0) {
            lastError = '余额接口返回结构异常'
            continue
          }
          const pick =
            infos.find((x) => x && x.currency === 'CNY' && Number(x.total_balance) > 0) ||
            infos.find((x) => x && Number(x.total_balance) > 0) ||
            infos[0]
          const total = Number(pick && pick.total_balance)
          if (!isFinite(total)) {
            lastError = '余额字段无法解析'
            continue
          }
          const ledger = loadLedger()
          if (ledger.dayStartBalance === null) {
            ledger.dayStartBalance = total
            saveLedger()
          }
          runtime.balance = {
            totalBalance: total,
            currency: String((pick && pick.currency) || 'CNY'),
            updatedAt: Date.now(),
            isAvailable: pick && pick.is_available !== false,
          }
          runtime.balanceError = null
          if (runtime.session) {
            if (runtime.session.baseBalance === null) runtime.session.baseBalance = total
            if (runtime.session.turnBaseBalance === null) runtime.session.turnBaseBalance = total
          }
          return runtime.balance
        } catch (err) {
          lastError = String(err && err.message ? err.message : err)
        }
      }
      runtime.balanceError = lastError || '未知错误'
      return null
    })()
    try {
      return await runtime.balanceInFlight
    } finally {
      runtime.balanceInFlight = null
    }
  }

  const usageView = () => {
    const ledger = loadLedger()
    let cost = 0
    let costBasis = '等待首次余额观测'
    let costAvailable = false
    // 只用余额差记账（与官方扣款口径最接近）；不做 token 估算，避免编造金额
    if (
      ledger.dayStartBalance !== null &&
      runtime.balance &&
      isFinite(runtime.balance.totalBalance)
    ) {
      const delta = ledger.dayStartBalance - runtime.balance.totalBalance
      if (delta >= 0) {
        cost = delta
        costBasis = '余额差'
        costAvailable = true
      } else {
        // 充值/退款：重置基准，避免负数
        ledger.dayStartBalance = runtime.balance.totalBalance
        saveLedger()
        cost = 0
        costBasis = '余额差（已重置基准）'
        costAvailable = true
      }
    }
    return {
      date: ledger.date,
      cost: Math.round(cost * 10000) / 10000,
      costBasis,
      costAvailable,
      tokens: Math.round(ledger.todayTokens || 0),
      models: ledger.models || {},
      balance: runtime.balance ? runtime.balance.totalBalance : null,
      currency: runtime.balance ? runtime.balance.currency : 'CNY',
      balanceUpdatedAt: runtime.balance ? runtime.balance.updatedAt : null,
      balanceError: runtime.balanceError,
    }
  }

  // 会话 usage 累计（token 维度）
  const accumulateUsage = (usage, model) => {
    if (!usage || typeof usage !== 'object') return
    const input = Number(usage.inputTokens) || 0
    const cache = Number(usage.cacheReadTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const reasoning = Number(usage.reasoningTokens) || 0
    const billedOutput = reasoning > output ? output + reasoning : output
    const tokens = input + cache + billedOutput
    if (tokens <= 0) return
    const ledger = loadLedger()
    ledger.todayTokens = (ledger.todayTokens || 0) + tokens
    if (model) {
      ledger.models = ledger.models || {}
      ledger.models[model] = (ledger.models[model] || 0) + tokens
    }
    if (!Array.isArray(ledger.events)) ledger.events = []
    ledger.events.push({ ts: Date.now(), tokens, model: model || '未知' })
    saveLedger()
  }

  // 本次消耗（当前会话）：余额差 + 真实 usage 双口径
  const ensureSession = (sessionId) => {
    const id = sessionId ? String(sessionId) : null
    const cur = runtime.session
    if (cur && (id === null || cur.id === id)) return cur
    const base =
      runtime.balance && isFinite(runtime.balance.totalBalance) ? runtime.balance.totalBalance : null
    runtime.session = {
      id,
      startedAt: Date.now(),
      baseBalance: base,
      turnBaseBalance: base,
      tokens: 0,
      input: 0,
      cacheRead: 0,
      output: 0,
      turns: 0,
      turnTokensMark: 0,
      lastTurnTokens: 0,
      lastTurnCost: null,
    }
    const ledger = loadLedger()
    ledger.session = runtime.session
    saveLedger()
    return runtime.session
  }

  const accumulateSession = (usage, sessionId) => {
    if (!usage || typeof usage !== 'object') return null
    const s = ensureSession(sessionId)
    if (!s) return null
    const input = Number(usage.inputTokens) || 0
    const cache = Number(usage.cacheReadTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const reasoning = Number(usage.reasoningTokens) || 0
    const billedOutput = output > reasoning ? output : reasoning
    s.input += input
    s.cacheRead += cache
    s.output += billedOutput
    s.tokens += input + cache + billedOutput
    return s
  }

  // 一轮结束：记轮次 / token 增量，并异步刷一次余额算出本轮花费
  const noteTurnEnd = (sessionId) => {
    const s = ensureSession(sessionId)
    if (!s) return null
    s.turns += 1
    s.lastTurnTokens = Math.max(0, s.tokens - (s.turnTokensMark || 0))
    s.turnTokensMark = s.tokens
    const before =
      runtime.balance && isFinite(runtime.balance.totalBalance) ? runtime.balance.totalBalance : null
    if (s.baseBalance === null && before !== null) s.baseBalance = before
    if (before !== null) s.turnBaseBalance = before
    fetchBalance()
      .then(() => {
        const after =
          runtime.balance && isFinite(runtime.balance.totalBalance) ? runtime.balance.totalBalance : null
        if (after === null) return
        if (s.baseBalance === null) s.baseBalance = after
        if (s.turnBaseBalance !== null && s.turnBaseBalance !== undefined) {
          const d = s.turnBaseBalance - after
          if (d >= 0) s.lastTurnCost = Math.round(d * 10000) / 10000
        }
        const ledger = loadLedger()
        ledger.session = s
        saveLedger()
        broadcastState()
      })
      .catch(() => {})
    return s
  }

  // 本次消耗视图：没有基准就如实说「等待余额观测」，绝不编数字
  const sessionView = () => {
    const s = runtime.session
    if (!s) return null
    let cost = null
    let costBasis = '等待首次余额观测'
    if (s.baseBalance !== null && runtime.balance && isFinite(runtime.balance.totalBalance)) {
      const delta = s.baseBalance - runtime.balance.totalBalance
      if (delta >= 0) {
        cost = Math.round(delta * 10000) / 10000
        costBasis = '余额差（自本次会话开始）'
      } else {
        s.baseBalance = runtime.balance.totalBalance
        cost = 0
        costBasis = '余额差（已重置基准）'
      }
    }
    return {
      id: s.id,
      startedAt: s.startedAt,
      cost,
      costBasis,
      tokens: s.tokens,
      input: s.input,
      cacheRead: s.cacheRead,
      output: s.output,
      turns: s.turns,
      lastTurnCost: s.lastTurnCost,
      lastTurnTokens: s.lastTurnTokens,
      balance: runtime.balance ? runtime.balance.totalBalance : null,
      currency: runtime.balance ? runtime.balance.currency : 'CNY',
    }
  }

  // ---------------- 原生能力探针 ----------------
  // 事实：桌面版把 Host 跑在**独立的 Node 子进程**里（process.execPath + ELECTRON_RUN_AS_NODE），
  // 所以 `require('electron')` 永远拿不到 BrowserWindow / Notification —— 原生
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
  }

  const mainWindow = () => {
    try {
      if (!electronMod || typeof electronMod.BrowserWindow !== 'function') return null
      const all = electronMod.BrowserWindow.getAllWindows()
      if (Array.isArray(all) && all.length > 0) {
        // 优先取可见、非销毁的窗口
        const alive = all.filter((w) => w && typeof w.isDestroyed === 'function' && !w.isDestroyed())
        return alive[0] || all[0]
      }
    } catch (err) {
      /* 忽略 */
    }
    return null
  }

  const nativeFlash = () => {
    const native = probeNative()
    if (!native.electron) return { ok: false, reason: native.reason }
    const win = mainWindow()
    if (!win) return { ok: false, reason: 'no-window' }
    let flashed = false
    let focused = false
    try {
      if (typeof win.isMinimized === 'function' && win.isMinimized()) {
        win.restore()
      }
      if (typeof win.flashFrame === 'function') {
        win.flashFrame(true)
        flashed = true
      }
      if (typeof win.show === 'function') win.show()
      if (typeof win.focus === 'function') {
        win.focus()
        focused = true
      }
      // Windows 上任务栏闪烁要手动停：5 秒后停一次
      if (flashed && typeof win.flashFrame === 'function') {
        const t = setTimeout(() => {
          try {
            win.flashFrame(false)
          } catch (err) {
            /* 忽略 */
          }
        }, 5000)
        if (t && typeof t.unref === 'function') t.unref()
      }
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) }
    }
    return { ok: true, flashed, focused }
  }

  const nativeNotify = (title, body) => {
    const native = probeNative()
    if (!native.electron || !native.notify) return { ok: false, reason: native.reason || 'no-notification' }
    try {
      const n = new electronMod.Notification({ title: String(title || '耄耋'), body: String(body || '') })
      n.on('click', () => {
        try {
          const win = mainWindow()
          if (win && typeof win.show === 'function') {
            win.show()
            if (typeof win.focus === 'function') win.focus()
          }
        } catch (err) {
          /* 忽略 */
        }
      })
      n.show()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) }
    }
  }

  // ---------------- 提醒 ----------------
  const renderTemplate = (tpl, extra = {}) => {
    const usage = usageView()
    const peak = peakInfo()
    const session = sessionView()
    const map = Object.assign(
      {
        today: usage.cost.toFixed(4),
        balance: usage.balance === null ? '--' : usage.balance.toFixed(2),
        tokens: String(usage.tokens),
        peak: peak.kind === 'peak' ? '高峰' : '谷价',
        currency: usage.currency,
        // 本次消耗（当前会话）
        session: session && session.cost !== null ? session.cost.toFixed(4) : '--',
        sessionTokens: session ? String(session.tokens) : '0',
        turns: session ? String(session.turns) : '0',
      },
      extra,
    )
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) => (key in map ? String(map[key]) : m))
  }

  const fireTurnEnd = (sessionId) => {
    const cfg = state.notify.turnEnd
    runtime.turnSeq += 1
    noteTurnEnd(sessionId)
    const payload = {
      seq: runtime.turnSeq,
      sessionId: sessionId || null,
      at: Date.now(),
      usage: usageView(),
      session: sessionView(),
      peak: peakInfo(),
    }
    runtime.lastTurn = payload

    if (!cfg.enabled) {
      publishEvent({ type: 'turn-end', data: payload, deliver: { native: false, system: false } })
      return
    }

    const body = renderTemplate(cfg.body || '', {})
    let native = { ok: false, reason: 'disabled' }
    let system = { ok: false, reason: 'disabled' }
    if (cfg.native) native = nativeFlash()
    if (cfg.systemNotification) system = nativeNotify('耄耋 · 任务完成', body)

    publishEvent({
      type: 'turn-end',
      data: payload,
      deliver: {
        native,
        system,
        // 前端是否需要自己再发网页通知（原生不可用时兜底）
        webNotification: cfg.systemNotification && !system.ok,
        titleFlash: cfg.titleFlash,
        flashText: cfg.flashText,
        sound: cfg.sound,
        bubble: cfg.bubble,
        catAct: cfg.catAct,
        body,
        autoCloseSec: Number(cfg.autoCloseSec) || 0,
      },
    })
  }

  // ---------------- 闹钟 ----------------
  // 闹钟按**本地时间**判定（用户墙上的 9:00 就是 9:00）；峰谷价仍按北京时间。
  // 投递走 publishEvent（SSE + 收件箱），所以即使 EventSource 连不上也不会丢。
  const deliverAlarm = (alarm, isTest) => {
    const parts = localParts(Date.now())
    const hhmm = parts.hhmm
    const body = renderTemplate(alarm.text || '起床', { time: hhmm })
    let native = { ok: false, reason: 'disabled' }
    let system = { ok: false, reason: 'disabled' }
    if (state.notify.turnEnd.native) native = nativeFlash()
    system = nativeNotify('耄耋 · 闹钟', body)
    const item = publishEvent({
      type: 'alarm',
      data: {
        id: alarm.id,
        name: alarm.name || '闹钟',
        time: hhmm,
        text: body,
        test: isTest === true,
        at: Date.now(),
      },
      deliver: {
        native,
        system,
        webNotification: !system.ok,
        sound: true,
        bubble: true,
        catAct: true,
      },
    })
    return {
      seq: item.seq,
      time: hhmm,
      text: body,
      sseClients: runtime.sseClients.size,
      webNotification: !system.ok,
    }
  }

  // 闹钟投递的**唯一入口**（定时巡检、前端兜底、诊断手动跑都走它）：
  // 同一分钟内同一个闹钟只会投一次，所以「巡检」和「前端补一枪」同时发生也不会重复响。
  const fireAlarmOnce = (alarm, isTest) => {
    if (!alarm) return { ok: false, reason: 'no-alarm' }
    const parts = localParts(Date.now())
    const hhmm = parts.hhmm
    const stamp = `${parts.date} ${hhmm}`
    const key = String(alarm.id) + '@' + stamp
    if (runtime.alarmFiredThisMinute.has(key)) {
      return { ok: true, alreadyFired: true, time: hhmm }
    }
    // 一次性闹钟只在指定日期触发
    if (alarm.mode === 'once' && alarm.date && alarm.date !== parts.date) {
      return { ok: false, reason: 'not-today', time: hhmm }
    }
    // 每天模式可限制星期
    if (alarm.mode === 'daily' && Array.isArray(alarm.weekdays) && alarm.weekdays.length > 0) {
      if (!alarm.weekdays.includes(parts.weekday)) {
        return { ok: false, reason: 'not-this-weekday', time: hhmm }
      }
    }
    runtime.alarmFiredThisMinute.add(key)
    // 一次性闹钟触发后自动停用
    if (alarm.mode === 'once') alarm.enabled = false
    const delivered = deliverAlarm(alarm, isTest === true)
    return { ok: true, delivered, time: hhmm }
  }

  const checkAlarms = () => {
    const alarms = Array.isArray(state.alarms) ? state.alarms : []
    if (alarms.length === 0) return
    const parts = localParts(Date.now())
    const hhmm = parts.hhmm
    runtime.lastAlarmCheck = { at: Date.now(), hhmm, date: parts.date, checked: alarms.length, fired: [] }
    for (const alarm of alarms) {
      if (!alarm || alarm.enabled === false) continue
      const time = alarmTimeKey(alarm.time)
      if (time === '' || time !== hhmm) continue
      const out = fireAlarmOnce(alarm, false)
      if (out && out.delivered) runtime.lastAlarmCheck.fired.push(out.delivered)
    }
    saveState()
  }

  // 闹钟时间统一成 "HH:MM"：不管存进来的是 "8:15"、"08:15" 还是 "08:15:00"，
  // 都能对上 —— 之前用字符串全等比较，一个格式差异就会让它**永远不响**。
  const alarmTimeKey = (value) => {
    const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(value === undefined || value === null ? '' : value))
    if (!m) return ''
    return String(Number(m[1])).padStart(2, '0') + ':' + m[2]
  }

  // 闹钟排程（本地时间）：到点没响时能一眼看出排程对不对
  const alarmSchedule = () => {
    const out = []
    const list = Array.isArray(state.alarms) ? state.alarms : []
    const now = Date.now()
    for (const a of list) {
      if (!a) continue
      const key = alarmTimeKey(a.time)
      const m = key === '' ? null : [key, key.slice(0, 2), key.slice(3)]
      const entry = {
        id: a.id,
        name: a.name,
        time: a.time,
        mode: a.mode,
        date: a.date || '',
        weekdays: Array.isArray(a.weekdays) ? a.weekdays : [],
        text: a.text,
        enabled: a.enabled !== false,
        nextAt: null,
        nextIn: null,
      }
      if (m && entry.enabled) {
        const hh = Number(m[1])
        const mm = Number(m[2])
        // 「就在这一分钟」也算还没到：否则刚设好、秒数已经走了一点，
        // 就会显示成明天，看着像被跳过去了。
        const nowMinute = new Date(now)
        nowMinute.setSeconds(0, 0)
        const nowMinuteMs = nowMinute.getTime()
        for (let d = 0; d <= 8; d++) {
          const t = new Date(now + d * 86400000)
          t.setHours(hh, mm, 0, 0)
          const ms = t.getTime()
          if (ms < nowMinuteMs) continue
          if (a.mode === 'once' && a.date) {
            if (localParts(ms).date !== a.date) continue
          }
          if (a.mode === 'daily' && entry.weekdays.length > 0) {
            if (entry.weekdays.indexOf(t.getDay()) === -1) continue
          }
          entry.nextAt = ms
          // 「就在这一分钟」时 nextAt 可能已经比 now 早几十秒，别显示负数
          entry.nextIn = Math.max(0, ms - now)
          break
        }
      }
      out.push(entry)
    }
    return out
  }

  // 「为什么不出声」的配置层检查（diag / 设置页提示都用它）
  const soundWarnings = () => {
    const out = []
    try {
      const slots = (state.audio && state.audio.slots) || []
      for (const s of slots) {
        if (!s) continue
        const label = s.name || s.id || '(未命名槽位)'
        if (s.enabled === false) {
          out.push('槽位「' + label + '」未勾选启用 → 触发器 ' + s.trigger + ' 不会出声')
        } else if (!Array.isArray(s.sounds) || s.sounds.length === 0) {
          out.push('槽位「' + label + '」没有勾选任何素材 → 触发器 ' + s.trigger + ' 不会出声')
        }
      }
      const te = state.notify && state.notify.turnEnd
      if (te && te.enabled === false) out.push('「任务完成提醒」总开关是关的 → 不会有任何提醒')
      if (te && te.sound === false) out.push('「任务完成提醒」里的声音开关是关的')
      const hasTurnEnd = slots.some((s) => s && s.enabled !== false && s.trigger === 'turn.end' && Array.isArray(s.sounds) && s.sounds.length > 0)
      if (!hasTurnEnd) out.push('没有任何可用槽位绑定 turn.end → 任务完成不会有声音')
      const hasAlarm = slots.some((s) => s && s.enabled !== false && s.trigger === 'alarm.fire' && Array.isArray(s.sounds) && s.sounds.length > 0)
      if (!hasAlarm) out.push('没有任何可用槽位绑定 alarm.fire → 闹钟不会有声音')
    } catch (err) {
      /* 忽略 */
    }
    return out
  }

  // 声音自愈（**可重复**，流水记在 state.meta.soundHealLog 里）。
  // 触发条件是一个**内部矛盾的配置**：「提醒」里声音是开着的，但没有任何
  // 「已启用且勾了素材」的槽位绑在 turn.end / alarm.fire 上 —— 用户看到的现象
  // 就是「通知弹出来了，可是没声音」。这里把那个「配了素材但没勾启用」的槽位打开；
  // 如果连槽位都没有（或素材池是空的），就补上内置默认素材。
  // 血坑：1.2.1 用 state.meta.soundAutoHealed 记「这个触发器修过了、以后不再碰」，
  // 结果用户在自愈之后又把槽位关掉，那条记录反而**挡住了后续所有修复** ——
  // 弹窗照旧、声音永远没有，而且看起来「我已经修过了」。
  // 现在：只要「意图」是要声音（提醒里开着 / 有启用的闹钟）就修；靠**关掉提醒里的声音开关**
  // 来表达「我不要声音」，而不是靠静默地不修。
  const healSilentTriggers = () => {
    const result = { healed: [], at: Date.now() }
    try {
      const audioCfg = state.audio || (state.audio = {})
      const slots = audioCfg.slots || (audioCfg.slots = [])
      const meta = state.meta || (state.meta = {})
      const defaultPool = BUILTIN_SOUNDS.filter((s) => /mp3$/i.test(String(s.file || ''))).map((s) => s.id)
      const pool = defaultPool.length > 0 ? defaultPool : ['builtin:hiss']

      const wants = []
      // 缺省即「要声音」：投递那边也是这么默认的（没有 notify.turnEnd 就当成开着），
      // 否则一个没写这一段的状态文件会让自愈误判成「用户不要声音」。
      const te = (state.notify && state.notify.turnEnd) || {}
      if (te.enabled !== false && te.sound !== false) wants.push('turn.end')
      const hasEnabledAlarm = (Array.isArray(state.alarms) ? state.alarms : []).some((a) => a && a.enabled !== false)
      if (hasEnabledAlarm) wants.push('alarm.fire')

      for (const trigger of wants) {
        const usable = slots.some(
          (s) => s && s.enabled !== false && s.trigger === trigger && Array.isArray(s.sounds) && s.sounds.length > 0,
        )
        if (usable) continue
        const candidates = slots.filter((s) => s && s.trigger === trigger)
        if (candidates.length > 0) {
          for (const s of candidates) {
            let fixed = false
            if (!Array.isArray(s.sounds) || s.sounds.length === 0) {
              s.sounds = pool.slice()
              fixed = true
            }
            if (s.enabled === false) {
              s.enabled = true
              fixed = true
            }
            if (fixed) {
              result.healed.push({ trigger, slot: s.id, name: s.name, pool: (s.sounds || []).length, filledPool: true })
              break
            }
          }
        } else {
          const id = 'slot-auto-' + String(trigger).replace(/[^a-z0-9]/gi, '-')
          slots.push({
            id,
            name: trigger === 'turn.end' ? '任务完成音（自动补）' : '闹钟音（自动补）',
            trigger,
            sounds: pool.slice(),
            strategy: 'random',
            loop: trigger === 'alarm.fire',
            cooldownMs: trigger === 'turn.end' ? 3000 : 0,
            enabled: true,
          })
          result.healed.push({ trigger, slot: id, name: '自动补的默认槽位', pool: pool.length, created: true })
        }
      }

      if (result.healed.length > 0) {
        meta.updatedAt = Date.now()
        // 保留最近 10 条自愈流水（谁在什么时候被修好了），diag 直接可查
        const log = Array.isArray(meta.soundHealLog) ? meta.soundHealLog : (meta.soundHealLog = [])
        for (const h of result.healed) log.push(Object.assign({ at: Date.now() }, h))
        if (log.length > 10) meta.soundHealLog = log.slice(-10)
        saveState()
        try {
          console.log('[maodie] 声音配置自愈：' + JSON.stringify(result.healed))
        } catch (err) {
          /* 忽略 */
        }
      }
    } catch (err) {
      result.error = String((err && err.message) || err)
    }
    return result
  }

  // ---------------- HTTP 辅助 ----------------
  const sendJson = (res, code, value) => {
    let body
    try {
      body = Buffer.from(JSON.stringify(value), 'utf8')
    } catch (err) {
      body = Buffer.from('{"ok":false,"error":"serialize"}', 'utf8')
    }
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
    })
    res.end(body)
  }

  const sendBytes = (res, code, bytes, mime) => {
    res.writeHead(code, {
      'Content-Type': mime || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': String(bytes.length),
    })
    res.end(bytes)
  }

  const readBody = (req, limit) => {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        resolve(value)
      }
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          finish(null)
          try {
            req.destroy()
          } catch (err) {
            /* 忽略 */
          }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (err) {
          finish(null)
        }
      })
      req.on('error', () => finish(null))
    })
  }

  // 浏览器信任栅栏（可选）
  // 背景（读官方文档得到的事实）：dsh-host-webserver「不提供服务器级 TLS、认证或来源策略」，
  // 认证由各 route owner 自己决定；官方插件的静态资源本就是公开的。服务器默认只绑
  // 127.0.0.1（回环），因此本插件默认**不设栅栏**，避免桌面端主界面不带会话 cookie 时
  // 数据全取不到（那正是"看不到猫"的直接原因）。
  // 想更严格：把 state.security.requireAuth 设为 true，数据路由就会走 ctx.connection 的
  // Host/Origin + 会话 cookie 校验（此时需要浏览器带上签名 cookie）。
  let fenceWarned = false
  const authRequired = () => {
    try {
      return !!(state && state.security && state.security.requireAuth)
    } catch (err) {
      return false
    }
  }
  const rejected = (req, res) => {
    if (!authRequired()) return false
    try {
      const conn = ctx.get('connection')
      if (!conn || typeof conn.requestRejection !== 'function') {
        if (!fenceWarned) {
          fenceWarned = true
          try {
            console.warn('[maodie] 已要求认证，但 connection 服务不可用，路由将放行')
          } catch (err) {
            /* 忽略 */
          }
        }
        return false
      }
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch (err) {
      return false
    }
  }

  const registerRoute = (route) => {
    const inner = route.handler
    const disposer = ctx.webServer.register(
      Object.assign({}, route, {
        handler: (req, res) => {
          if (rejected(req, res)) return
          return inner(req, res)
        },
      }),
    )
    disposers.push(disposer)
    return disposer
  }

  // 不套信任栅栏的路由：只给只读自检页用，方便排查"看不到猫"
  const registerRawRoute = (route) => {
    const disposer = ctx.webServer.register(route)
    disposers.push(disposer)
    return disposer
  }

  // ---------------- index 注入（唯一正确的入页通道） ----------------
  // 结构化注入行由 webServer 在**每次渲染 index 时**收集一遍：
  //   - 浏览器直连：frontend-static 的 fallback 渲染 index.html 时调 renderIndex()，
  //     把行渲染成真正的 <script>（head 行 = parser-blocking）
  //   - 桌面端：Electron 壳启动 Host 之后调 collectIndexInjections() 拿整张表，
  //     经 dshDesktopBoot.ready() 交回页面，由页面里的解释器逐行执行
  //     （script-src 行 = 建 <script src=…> 并 await load）
  // 行里只放 URL，脚本本体仍由 /maodie/maodie.js 路由下发：改前端不用重装插件。
  // 注意：这张表在桌面端只在 Host 启动时收集一次 → 新增/删除行要重启桌面端，
  //       但只改 scripts/前端脚本不需要（路由每次请求都重新读盘）。
  const INJECT_CACHE = {
    src: SCRIPT_SRC + '?v=' + PLUGIN_VERSION,
    enabled: true,
    rows: 0,
    lastEmitAt: 0,
    lastError: '',
  }

  const injectEnabled = () => {
    try {
      return !(state && state.security && state.security.injectMainWindow === false)
    } catch (err) {
      return true
    }
  }

  const installIndexInjector = () => {
    const src = INJECT_CACHE.src
    const handler = (table) => {
      try {
        if (!Array.isArray(table)) return
        INJECT_CACHE.enabled = injectEnabled()
        if (!INJECT_CACHE.enabled) return
        // 幂等：同一张表被重复收集时不要重复 push
        if (table.some((row) => row && row.kind === 'script-src' && row.src === src)) return
        const base = resolveWebBase()
        if (base) table.push({ kind: 'global', name: '__MAODIE_BASE__', value: base })
        // 提示性 preload：浏览器侧能提前开始下载；桌面端解释器会忽略这一行
        table.push({ kind: 'script-preload', src })
        table.push({ kind: 'script-src', placement: 'head', src })
        INJECT_CACHE.rows = table.length
        INJECT_CACHE.lastEmitAt = Date.now()
      } catch (err) {
        INJECT_CACHE.lastError = String((err && err.message) || err)
      }
    }
    const dispose = ctx.on('webserver/index-inject', handler)
    return typeof dispose === 'function' ? dispose : () => {}
  }

  // 诊断用：当前这张注入表里有没有我们那一行（Host 侧事实，与页面无关）
  const collectOurRows = () => {
    const rows = []
    try {
      if (ctx.webServer && typeof ctx.webServer.collectIndexInjections === 'function') {
        for (const row of ctx.webServer.collectIndexInjections()) {
          if (!row || typeof row !== 'object') continue
          if (row.kind === 'script-src' || row.kind === 'script-preload') {
            if (String(row.src || '').indexOf(SCRIPT_SRC) === 0) rows.push(row)
          } else if (row.kind === 'global' && row.name === '__MAODIE_BASE__') {
            rows.push(row)
          }
        }
      }
    } catch (err) {
      INJECT_CACHE.lastError = String((err && err.message) || err)
    }
    return rows
  }

  // ---------------- 自定义素材（用户上传） ----------------
  const customDir = () => path.join(stateDir, 'sounds')

  const listCustomSounds = () => {
    const meta = readJson(path.join(customDir(), 'index.json'))
    if (!meta || !Array.isArray(meta.items)) return []
    return meta.items.filter((x) => isPlainObject(x) && typeof x.id === 'string')
  }

  const saveCustomSoundIndex = (items) => writeJson(path.join(customDir(), 'index.json'), { items })

  const allSounds = () => {
    return BUILTIN_SOUNDS.concat(listCustomSounds()).map((s) => ({
      id: s.id,
      name: s.name || s.id,
      builtin: !!s.builtin,
      mime: s.mime || 'audio/mpeg',
      note: s.note || '',
      bytes: Number(s.bytes) || 0,
    }))
  }

  // ---------------- 自定义外观（用户上传的图片） ----------------
  const customImageDir = () => path.join(stateDir, 'images')

  const listCustomImages = () => {
    const meta = readJson(path.join(customImageDir(), 'index.json'))
    if (!meta || !Array.isArray(meta.items)) return []
    return meta.items.filter((x) => isPlainObject(x) && typeof x.id === 'string')
  }

  const saveCustomImageIndex = (items) => writeJson(path.join(customImageDir(), 'index.json'), { items })

  const allImages = () => {
    const builtin = BUILTIN_IMAGES.map((x) => ({
      id: x.id,
      name: x.name || x.id,
      builtin: true,
      mime: x.mime || 'image/png',
      note: x.note || '',
      bytes: 0,
      meta: x.meta || null,
    }))
    const custom = listCustomImages().map((x) => ({
      id: x.id,
      name: x.name || x.id,
      builtin: false,
      mime: x.mime || 'image/png',
      note: x.note || '',
      bytes: Number(x.bytes) || 0,
      createdAt: Number(x.createdAt) || 0,
      meta: isPlainObject(x.meta) ? x.meta : null,
    }))
    return builtin.concat(custom)
  }

  const imageFile = (id) => {
    const builtin = BUILTIN_IMAGES.find((x) => x.id === id)
    if (builtin) {
      return { file: path.join(ASSETS_DIR, builtin.file), mime: builtin.mime || 'image/png' }
    }
    const custom = listCustomImages().find((x) => x.id === id)
    if (!custom || typeof custom.file !== 'string') return null
    return {
      file: path.join(customImageDir(), custom.file),
      mime: custom.mime || 'image/png',
    }
  }

  const IMAGE_MIME_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  }

  const resetPosesToBuiltin = (ids) => {
    const drop = Array.isArray(ids) ? ids : [ids]
    const poses = state.appearance.poses || (state.appearance.poses = {})
    for (const key of ['idle', 'hiss']) {
      if (drop.indexOf(poses[key]) !== -1) poses[key] = 'builtin:' + key
    }
  }

  const soundBytes = (id) => {
    const builtin = BUILTIN_SOUNDS.find((s) => s.id === id)
    if (builtin) {
      const file = path.join(ASSETS_DIR, builtin.file)
      try {
        return { bytes: fs.readFileSync(file), mime: builtin.mime }
      } catch (err) {
        return null
      }
    }
    const custom = listCustomSounds().find((s) => s.id === id)
    if (!custom) return null
    try {
      return { bytes: fs.readFileSync(path.join(customDir(), custom.file)), mime: custom.mime || 'audio/wav' }
    } catch (err) {
      return null
    }
  }

  // ---------------- 启动 ----------------
  const start = () => {
    // 每次 Host 启动一个新的 bootId：前端靠它区分「序号从头开始」和「重复事件」
    runtime.bootId = 'b' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    stateDir = pickStateDir()
    stateFile = path.join(stateDir, STATE_FILE_NAME)
    holidayFile = path.join(stateDir, HOLIDAY_FILE_NAME)
    loadState()
    loadHolidayCache()
    loadLedger()
    // 会话花费跨 Host 重启保留（同一个会话接着算），换会话时自动重置
    runtime.session = (runtime.ledger && runtime.ledger.session) || null
    probeNative()
    // 「提醒里开了声音但没有任何槽位能出声」这种矛盾配置，修一次并记下来
    runtime.soundHeal = healSilentTriggers()

    // 前端入页：结构化 index 注入行（浏览器直连与桌面端主窗口共用同一张表）
    disposers.push(installIndexInjector())

    // —— 路由：初始化数据 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/init.json',
      handler: (req, res) => {
        const webBase = resolveWebBase()
        // 直接报告本次请求看到的信任判定，便于前端区分"没权限"和"没网络"
        let rejection = undefined
        try {
          const conn = ctx.get('connection')
          if (conn && typeof conn.requestRejection === 'function') rejection = conn.requestRejection(req)
        } catch (err) {
          rejection = 'probe-failed'
        }
        sendJson(res, 200, {
          ok: true,
          version: PLUGIN_VERSION,
          webBase,
          /** 前端要用它拼所有请求：桌面端主界面在 dsh-app:// 下时相对路径不带 cookie */
          apiBase: webBase ? webBase + ROUTE_BASE : ROUTE_BASE,
          state,
          sounds: allSounds(),
          images: allImages(),
          poses: state.appearance.poses || {},
          triggers: TRIGGERS,
          peak: peakInfo(),
          usage: usageView(),
          session: sessionView(),
          native: probeNative(),
          boot: runtime.bootId,
          localNow: localParts(Date.now()).hhmm,
          paths: { stateDir, assets: ASSETS_DIR },
          request: { rejection, url: req.url, host: (req.headers && req.headers.host) || null },
          serverTime: Date.now(),
        })
      },
    })

    // —— 路由：实时状态 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/status.json',
      handler: async (req, res) => {
        const refresh = /[?&]refresh=1/.test(req.url || '')
        if (refresh || !runtime.balance) {
          try {
            await fetchBalance()
          } catch (err) {
            /* 降级 */
          }
        }
        sendJson(res, 200, {
          ok: true,
          peak: peakInfo(),
          usage: usageView(),
          session: sessionView(),
          lastTurn: runtime.lastTurn,
          turnSeq: runtime.turnSeq,
          images: allImages(),
          poses: state.appearance.poses || {},
          alarms: alarmSchedule(),
          native: runtime.native,
          boot: runtime.bootId,
          localNow: localParts(Date.now()).hhmm,
          serverTime: Date.now(),
        })
      },
    })

    // —— 路由：状态写入（局部合并） ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/state.json',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 200, { ok: true, state })
          return
        }
        const body = await readBody(req, 4 << 20)
        if (!isPlainObject(body)) {
          sendJson(res, 400, { ok: false, error: 'bad-body' })
          return
        }
        state = mergeDeep(state, body.state && isPlainObject(body.state) ? body.state : body)
        const saved = saveState()
        sendJson(res, 200, { ok: true, saved, state })
        broadcastState()
      },
    })

    // —— 路由：余额 / 今日已用 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/usage.json',
      handler: async (req, res) => {
        try {
          await fetchBalance()
        } catch (err) {
          /* 降级 */
        }
        sendJson(res, 200, { ok: true, usage: usageView(), peak: peakInfo() })
      },
    })

    // —— 路由：节假日 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/holidays.json',
      handler: async (req, res) => {
        const force = /[?&]force=1/.test(req.url || '')
        const result = await refreshHolidays(force)
        sendJson(res, 200, {
          ok: true,
          refresh: result,
          source: runtime.holidaySource,
          fetchedAt: runtime.holidayFetchedAt,
          count: Object.keys(runtime.holidays).length,
          overrides: state.peak.overrides,
        })
      },
    })

    // —— 路由：素材列表 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/sounds.json',
      handler: (req, res) => {
        sendJson(res, 200, { ok: true, sounds: allSounds() })
      },
    })

    // —— 路由：素材音频字节 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/sound',
      handler: (req, res) => {
        const url = new URL(req.url || '/', 'http://x')
        const id = url.searchParams.get('id') || ''
        const found = soundBytes(id)
        if (!found) {
          sendJson(res, 404, { ok: false, error: 'not-found', id })
          return
        }
        sendBytes(res, 200, found.bytes, found.mime)
      },
    })

    // —— 路由：素材图片字节 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/image',
      handler: (req, res) => {
        const url = new URL(req.url || '/', 'http://x')
        const id = url.searchParams.get('id') || 'builtin:idle'
        const found = imageFile(id)
        if (!found) {
          sendJson(res, 404, { ok: false, error: 'not-found', id })
          return
        }
        try {
          const bytes = fs.readFileSync(found.file)
          sendBytes(res, 200, bytes, found.mime)
        } catch (err) {
          sendJson(res, 404, { ok: false, error: 'read-failed', id })
        }
      },
    })

    // —— 路由：外观图清单 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/images.json',
      handler: (req, res) => {
        sendJson(res, 200, { ok: true, images: allImages(), poses: state.appearance.poses || {} })
      },
    })

    // —— 路由：上传外观图（前端已在 canvas 里算好 alpha 包围盒，随 meta 一起送上来）——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/upload-image.json',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method' })
          return
        }
        const body = await readBody(req, 96 << 20)
        if (!isPlainObject(body) || typeof body.dataUrl !== 'string') {
          sendJson(res, 400, { ok: false, error: 'bad-body' })
          return
        }
        const match = /^data:([^;]+);base64,(.*)$/s.exec(body.dataUrl)
        if (!match) {
          sendJson(res, 400, { ok: false, error: 'bad-dataurl' })
          return
        }
        const mime = match[1]
        const ext = IMAGE_MIME_EXT[mime]
        if (!ext) {
          sendJson(res, 400, { ok: false, error: 'bad-mime', mime })
          return
        }
        let bytes
        try {
          bytes = Buffer.from(match[2], 'base64')
        } catch (err) {
          sendJson(res, 400, { ok: false, error: 'bad-base64' })
          return
        }
        if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) {
          sendJson(res, 400, { ok: false, error: 'size', bytes: bytes.length })
          return
        }
        const id = 'user:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const fileName = id.replace(':', '_') + '.' + ext
        try {
          fs.mkdirSync(customImageDir(), { recursive: true })
          fs.writeFileSync(path.join(customImageDir(), fileName), bytes)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: 'write-failed' })
          return
        }
        const meta = isPlainObject(body.meta) ? body.meta : null
        const items = listCustomImages()
        items.push({
          id,
          name: String(body.name || '自定义外观').slice(0, 60),
          file: fileName,
          mime,
          bytes: bytes.length,
          createdAt: Date.now(),
          meta,
        })
        saveCustomImageIndex(items)
        // 上传时可以顺手指定它当常态/哈气
        const pose = body.pose === 'idle' || body.pose === 'hiss' ? body.pose : null
        if (pose) {
          state.appearance.poses = state.appearance.poses || {}
          state.appearance.poses[pose] = id
          state.meta.updatedAt = Date.now()
          saveState()
        }
        sendJson(res, 200, { ok: true, id, pose, images: allImages(), poses: state.appearance.poses || {}, state })
      },
    })

    // —— 路由：补写外观图的 alpha 包围盒（前端加载后算出来的）——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/image-meta.json',
      handler: async (req, res) => {
        const body = await readBody(req, 1 << 20)
        const id = isPlainObject(body) ? String(body.id || '') : ''
        if (!id.startsWith('user:') || !isPlainObject(body) || !isPlainObject(body.meta)) {
          sendJson(res, 400, { ok: false, error: 'bad-request' })
          return
        }
        const items = listCustomImages()
        const target = items.find((x) => x.id === id)
        if (!target) {
          sendJson(res, 404, { ok: false, error: 'not-found', id })
          return
        }
        target.meta = body.meta
        saveCustomImageIndex(items)
        sendJson(res, 200, { ok: true, id, meta: target.meta })
      },
    })

    // —— 路由：删除自定义外观图 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/delete-image.json',
      handler: async (req, res) => {
        const body = await readBody(req, 1 << 20)
        const id = isPlainObject(body) ? String(body.id || '') : ''
        if (!id.startsWith('user:')) {
          sendJson(res, 400, { ok: false, error: 'builtin-or-invalid' })
          return
        }
        const items = listCustomImages()
        const target = items.find((x) => x.id === id)
        const rest = items.filter((x) => x.id !== id)
        if (target && typeof target.file === 'string') {
          try {
            fs.unlinkSync(path.join(customImageDir(), target.file))
          } catch (err) {
            /* 忽略 */
          }
        }
        saveCustomImageIndex(rest)
        // 用着它的姿态回到内置图，避免出现空白猫
        resetPosesToBuiltin(id)
        state.meta.updatedAt = Date.now()
        saveState()
        sendJson(res, 200, { ok: true, images: allImages(), poses: state.appearance.poses || {}, state })
      },
    })

    // —— 路由：上传裁剪后的音频 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/upload-sound.json',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method' })
          return
        }
        const body = await readBody(req, 64 << 20)
        if (!isPlainObject(body) || typeof body.dataUrl !== 'string') {
          sendJson(res, 400, { ok: false, error: 'bad-body' })
          return
        }
        const match = /^data:([^;]+);base64,(.*)$/s.exec(body.dataUrl)
        if (!match) {
          sendJson(res, 400, { ok: false, error: 'bad-dataurl' })
          return
        }
        const mime = match[1]
        let bytes
        try {
          bytes = Buffer.from(match[2], 'base64')
        } catch (err) {
          sendJson(res, 400, { ok: false, error: 'bad-base64' })
          return
        }
        if (bytes.length === 0 || bytes.length > 48 * 1024 * 1024) {
          sendJson(res, 400, { ok: false, error: 'size', bytes: bytes.length })
          return
        }
        const id = 'user:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const ext = mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : 'bin'
        const fileName = id.replace(':', '_') + '.' + ext
        try {
          fs.mkdirSync(customDir(), { recursive: true })
          fs.writeFileSync(path.join(customDir(), fileName), bytes)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: 'write-failed' })
          return
        }
        const items = listCustomSounds()
        items.push({
          id,
          name: String(body.name || '自定义片段').slice(0, 60),
          file: fileName,
          mime,
          bytes: bytes.length,
          createdAt: Date.now(),
          cropped: body.cropped === true,
          crop: isPlainObject(body.crop) ? body.crop : null,
        })
        saveCustomSoundIndex(items)
        sendJson(res, 200, { ok: true, id, sounds: allSounds() })
      },
    })

    // —— 路由：删除自定义素材 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/delete-sound.json',
      handler: async (req, res) => {
        const body = await readBody(req, 1 << 20)
        const id = isPlainObject(body) ? String(body.id || '') : ''
        if (!id.startsWith('user:')) {
          sendJson(res, 400, { ok: false, error: 'builtin-or-invalid' })
          return
        }
        const items = listCustomSounds()
        const target = items.find((x) => x.id === id)
        const rest = items.filter((x) => x.id !== id)
        if (target) {
          try {
            fs.unlinkSync(path.join(customDir(), target.file))
          } catch (err) {
            /* 忽略 */
          }
        }
        saveCustomSoundIndex(rest)
        sendJson(res, 200, { ok: true, sounds: allSounds() })
      },
    })

    // —— 路由：原生探针（设置页用） ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/native.json',
      handler: async (req, res) => {
        const flash = /[?&]flash=1/.test(req.url || '')
        const notify = /[?&]notify=1/.test(req.url || '')
        const out = { ok: true, native: probeNative() }
        if (flash) out.flash = nativeFlash()
        if (notify) out.notify = nativeNotify('耄耋 · 测试通知', '如果你看到这条，说明原生通知可用。')
        sendJson(res, 200, out)
      },
    })

    // —— 路由：事件流（SSE） ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/events',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write('retry: 3000\n\n')
        res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`)
        runtime.sseClients.add(res)
        // 新连上来的页面立刻对一次状态：Host 模块热重载（版本变了）时，
        // 老前端会因此重新拉 init.json、发现版本不一致、自动刷新页面。
        publishEvent({ type: 'state', data: { at: Date.now() } }, false)
        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch (err) {
            /* 忽略 */
          }
        }, 25000)
        const cleanup = () => {
          clearInterval(heartbeat)
          runtime.sseClients.delete(res)
        }
        req.on('close', cleanup)
        req.on('error', cleanup)
      },
    })

    // —— 前端脚本 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/maodie.js',
      handler: (req, res) => {
        try {
          const bytes = fs.readFileSync(path.join(ASSETS_DIR, 'maodie.js'))
          sendBytes(res, 200, bytes, 'application/javascript; charset=utf-8')
        } catch (err) {
          sendJson(res, 500, { ok: false, error: 'frontend-missing' })
        }
      },
    })

    // —— 前端启动回执 + 心跳（诊断用，不设信任栅栏）——
    // 前端脚本 bootUp() 起来后立刻 POST 一次 /maodie/hello，之后每 15s 把健康度
    // POST 到 /maodie/report.json（SSE 状态、收件箱进度、声音播放结果、姿态、槽位…）。
    // 这是唯一能区分「注入没生效 / 注入了但前端报错 / 声音被浏览器或槽位配置掐了」
    // 的 Host 侧证据：全部汇总在 /maodie/diag 里。
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/hello',
      handler: async (req, res) => {
        let payload = null
        try {
          payload = await readBody(req, 4096)
        } catch (err) {
          payload = null
        }
        if (!isPlainObject(payload)) {
          payload = {}
          try {
            const u = new URL(req.url || '/', 'http://127.0.0.1')
            payload.href = u.searchParams.get('href') || ''
            payload.apiBase = u.searchParams.get('apiBase') || ''
            payload.version = u.searchParams.get('version') || ''
          } catch (err) {
            /* 忽略 */
          }
        }
        const clip = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n)
        runtime.helloCount += 1
        runtime.lastHello = {
          at: Date.now(),
          version: clip(payload.version, 40),
          href: clip(payload.href, 300),
          protocol: clip(payload.protocol, 40),
          apiBase: clip(payload.apiBase, 200),
          ua: clip(payload.ua, 240),
          error: clip(payload.error, 300),
        }
        sendJson(res, 200, { ok: true, at: runtime.lastHello.at, count: runtime.helloCount })
      },
    })

    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/report.json',
      handler: async (req, res) => {
        let body = null
        try {
          body = await readBody(req, 256 << 10)
        } catch (err) {
          body = null
        }
        if (!isPlainObject(body)) {
          sendJson(res, 400, { ok: false, error: 'bad-body' })
          return
        }
        const clip = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n)
        const num = (v) => (isFinite(Number(v)) ? Number(v) : 0)
        const sse = isPlainObject(body.sse) ? body.sse : {}
        const inbox = isPlainObject(body.inbox) ? body.inbox : {}
        const audioReport = isPlainObject(body.audio) ? body.audio : {}
        const lastAudio = isPlainObject(audioReport.last) ? audioReport.last : {}
        runtime.reportAt = Date.now()
        runtime.report = {
          at: runtime.reportAt,
          version: clip(body.version, 40),
          href: clip(body.href, 300),
          protocol: clip(body.protocol, 40),
          apiBase: clip(body.apiBase, 200),
          pose: clip(body.pose, 40),
          images: isPlainObject(body.images) ? body.images : null,
          sse: {
            state: clip(sse.state, 40),
            helloAt: num(sse.helloAt),
            lastAt: num(sse.lastAt),
            errors: num(sse.errors),
          },
          inbox: {
            lastSeq: num(inbox.lastSeq),
            lastPollAt: num(inbox.lastPollAt),
            polls: num(inbox.polls),
            errors: num(inbox.errors),
          },
          audio: {
            unlocked: audioReport.unlocked === true,
            contextState: clip(audioReport.contextState, 40),
            volume: num(audioReport.volume),
            last: {
              at: num(lastAudio.at),
              id: clip(lastAudio.id, 80),
              trigger: clip(lastAudio.trigger, 60),
              ok: lastAudio.ok === true,
              error: clip(lastAudio.error, 300),
            },
          },
          slots: Array.isArray(body.slots)
            ? body.slots.slice(0, 20).map((s) => ({
                id: clip(s && s.id, 60),
                name: clip(s && s.name, 60),
                trigger: clip(s && s.trigger, 60),
                enabled: !(s && s.enabled === false),
                pool: num(s && s.pool),
                loop: !!(s && s.loop),
              }))
            : [],
          errors: Array.isArray(body.errors) ? body.errors.slice(0, 10).map((e) => clip(e, 300)) : [],
          // 前端的输入诊断时间线：焦点/按键/值变化/面板重建（排查「输不进去」）
          inputDiag: Array.isArray(body.inputDiag)
            ? body.inputDiag.slice(-20).map((x) => ({
                at: num(x && x.at),
                kind: clip(x && x.kind, 40),
                detail: clip(x && x.detail, 120),
                active: clip(x && x.active, 40),
                focused: x && x.focused === true,
              }))
            : [],
          // 前端「交付时自愈」的流水：非空说明「通知弹了却没声音」的配置被前端当场修好了
          soundRepair: Array.isArray(body.soundRepair)
            ? body.soundRepair.slice(0, 5).map((x) => ({
                at: num(x && x.at),
                trigger: clip(x && x.trigger, 60),
                slot: clip(x && x.slot, 60),
                action: clip(x && x.action, 60),
              }))
            : [],
          // 前端闹钟兜底的状态（它有没有替 Host 补过枪、最后一次检查是什么时候）
          alarmWatch: isPlainObject(body.alarmWatch)
            ? {
                lastCheck: num(body.alarmWatch.lastCheck),
                pokes: Array.isArray(body.alarmWatch.pokes)
                  ? body.alarmWatch.pokes.slice(0, 5).map((x) => ({
                      id: clip(x && x.id, 60),
                      time: clip(x && x.time, 10),
                      at: num(x && x.at),
                    }))
                  : [],
              }
            : { lastCheck: 0, pokes: [] },
        }
        sendJson(res, 200, {
          ok: true,
          at: runtime.reportAt,
          version: PLUGIN_VERSION,
          eventSeq: runtime.eventSeq,
          // 顺手把「Host 认为哪些槽位不会出声」回给前端，设置页可以原样显示
          notes: soundWarnings(),
        })
      },
    })

    // —— 事件收件箱：SSE 掉线时前端靠轮询它，保证闹钟/任务完成一定送达 ——
    // 语义：不带 since = 只取当前序号（前端用来「对齐基线」，不会补发历史事件）；
    //       带 since=N = 补发 seq > N 的事件。前端用 seq 去重，SSE 与轮询可以并存。
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/inbox.json',
      handler: (req, res) => {
        const now = Date.now()
        // 只保留最近 2 分钟、最多 60 条，避免刷新页面时把很早的闹钟补发出来
        runtime.inbox = runtime.inbox.filter((x) => x && now - x.at < 120000).slice(-60)
        let since = null
        try {
          const u = new URL(req.url || '/', 'http://x')
          const raw = u.searchParams.get('since')
          if (raw !== null && raw !== '' && isFinite(Number(raw))) since = Number(raw)
        } catch (err) {
          since = null
        }
        const items = since === null ? [] : runtime.inbox.filter((x) => x.seq > since)
        sendJson(res, 200, { ok: true, boot: runtime.bootId, seq: runtime.eventSeq, items, serverTime: now })
      },
    })

    // —— 路由：投递某个闹钟（前端兜底用；同一分钟只投一次，不会重复响）——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/alarm-fire.json',
      handler: async (req, res) => {
        const body = await readBody(req, 1 << 20)
        const id = isPlainObject(body) ? String(body.id || '') : ''
        const alarms = Array.isArray(state.alarms) ? state.alarms : []
        const alarm = alarms.find((a) => a && String(a.id) === id)
        if (!alarm) {
          sendJson(res, 404, { ok: false, error: 'not-found', id })
          return
        }
        if (alarm.enabled === false) {
          sendJson(res, 200, { ok: false, error: 'disabled', id })
          return
        }
        const out = fireAlarmOnce(alarm, false)
        sendJson(
          res,
          200,
          Object.assign({ id, sseClients: runtime.sseClients.size, eventSeq: runtime.eventSeq }, out),
        )
      },
    })

    // —— 闹钟自测：立刻走一遍完整的闹钟投递链路（设置页用，不用等到点）——
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/alarm-test.json',
      handler: (req, res) => {
        const first = Array.isArray(state.alarms) && state.alarms.length > 0 ? state.alarms[0] : null
        const delivered = deliverAlarm({
          id: 'test',
          name: '测试闹钟',
          text: (first && first.text) || '起床',
        })
        sendJson(res, 200, { ok: true, delivered, sseClients: runtime.sseClients.size, eventSeq: runtime.eventSeq })
      },
    })

    // —— 自检页（不设信任栅栏：只读诊断，便于排查"看不到猫"）——
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/doctor',
      handler: (req, res) => {
        const html = [
          '<!doctype html><html><head><meta charset="utf-8"><title>耄耋 · 自检</title>',
          '<style>',
          'body{font:14px/1.7 system-ui,"Microsoft YaHei";margin:0;padding:24px;background:#f6f8fd;color:#203170}',
          'h1{font-size:18px;margin:0 0 8px}',
          'pre{background:#fff;border:1px solid rgba(32,49,112,.2);border-radius:10px;padding:12px;white-space:pre-wrap;word-break:break-all;font:12px/1.7 Consolas,monospace}',
          '</style></head><body>',
          '<h1>耄耋 · 自检</h1>',
          '<p>这一页由插件的 Host 半直接返回，用来判断前端为什么没出现。把它截图发我即可。</p>',
          '<pre id="out">检测中…</pre>',
          '<script>(async function(){',
          'var out=document.getElementById("out");var L=[];',
          'function add(n,ok,x){L.push((ok?"[OK]   ":"[FAIL] ")+n+(x?"   -> "+x:""))}',
          'var BASE=(typeof window.__MAODIE_BASE__==="string")?window.__MAODIE_BASE__:location.origin;',
          'try{',
          '  var r=await fetch(BASE+"' + ROUTE_BASE + '/init.json",{cache:"no-store",credentials:"include"});',
          '  add("Host 路由可达",r.ok,"HTTP "+r.status+"  base="+BASE);',
          '  var j=await r.json();',
          '  add("init.json 合法",!!(j&&j.ok),"version="+(j&&j.version));',
          '  add("Host 报的 apiBase",!!(j&&j.apiBase),String(j&&j.apiBase));',
          '  add("本次请求被栅栏判定",!(j&&j.request&&j.request.rejection),"rejection="+String(j&&j.request&&j.request.rejection));',
          '  var sl=j&&j.state&&j.state.audio?j.state.audio.slots.length:"?";',
          '  add("声音槽位",typeof sl==="number","slots="+sl);',
          '  var im=await fetch("' + ROUTE_BASE + '/image?id=builtin%3Aidle",{cache:"no-store"});',
          '  add("常态猫图可下发",im.ok,"HTTP "+im.status+"  bytes="+(im.headers.get("content-length")||"?"));',
          '  var hs=await fetch("' + ROUTE_BASE + '/image?id=builtin%3Ahiss",{cache:"no-store"});',
          '  add("哈气图可下发",hs.ok,"HTTP "+hs.status);',
          '  var s=await fetch("' + ROUTE_BASE + '/maodie.js",{cache:"no-store"});',
          '  add("前端脚本可下发",s.ok,"HTTP "+s.status);',
          '  var t=await s.text();',
          '  add("前端脚本内容完整",t.indexOf("function bootUp")!==-1,"bytes="+t.length);',
          '  add("猫元素在当前页?",!!document.getElementById("md-root"),"自检页本来就没有，属正常");',
          '}catch(e){add("请求异常",false,String(e&&e.message||e))}',
          'L.push("");',
          'L.push("--- 环境 ---");',
          'L.push("href: "+location.href);',
          'L.push("userAgent: "+navigator.userAgent);',
          'L.push("Notification: "+(typeof Notification!=="undefined"?Notification.permission:"不支持"));',
          'L.push("localStorage 可用: "+(function(){try{localStorage.setItem("t","1");localStorage.removeItem("t");return true}catch(e){return false}})());',
          'L.push("");',
          'L.push("--- 下一步 ---");',
          'L.push("回到 DeepSeek Harness 主窗口刷新页面；刚装好/刚改过 Host 代码的话桌面端需要重启一次。");',
          'L.push("还不出现就打开 /maodie/diag 看 frontend.booted 与 indexInjection，再按 F12 看 Console 红色报错。");',
          'out.textContent=L.join("\\n");',
          '})()</script></body></html>',
        ].join('\n')
        const body = Buffer.from(html, 'utf8')
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(body.length),
        })
        res.end(body)
      },
    })

    // —— 无认证诊断：注入行 / 前端心跳 / 声音配置 / 闹钟排程 一把看全 ——
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/diag',
      handler: (req, res) => {
        // ?runAlarmSweep=1 手动跑一次闹钟巡检（诊断 / 测试用，不改任何配置）
        try {
          if (/[?&]runAlarmSweep=1/.test(req.url || '')) checkAlarms()
        } catch (err) {
          runtime.timerErrors.manualSweep = String((err && err.message) || err)
        }
        const renderIndex =
          ctx.webServer && typeof ctx.webServer.renderIndex === 'function'
            ? ctx.webServer.renderIndex.bind(ctx.webServer)
            : null
        let rendered = false
        let snippet = ''
        let htmlError = ''
        let htmlLength = 0
        if (renderIndex) {
          try {
            const html = renderIndex('<!doctype html><html><head></head><body><div id="root"></div></body></html>')
            htmlLength = html.length
            rendered = html.indexOf(SCRIPT_SRC) !== -1
            const at = html.indexOf(SCRIPT_SRC)
            snippet = at === -1 ? html.slice(-320) : html.slice(Math.max(0, at - 160), at + 160)
          } catch (err) {
            htmlError = String((err && err.message) || err)
          }
        }
        const ourRows = collectOurRows()
        const base = resolveWebBase()
        const lp = localParts(Date.now())
        const bp = bjParts(Date.now())
        const out = {
          ok: true,
          plugin: PLUGIN_VERSION,
          // ① Host 侧事实：这张表里有没有我们那一行（浏览器直连与桌面端共用）
          indexInjection: {
            listenerEnabled: INJECT_CACHE.enabled,
            src: INJECT_CACHE.src,
            rowsInTable: ourRows.length,
            rows: ourRows,
            lastEmitAt: INJECT_CACHE.lastEmitAt,
            lastError: INJECT_CACHE.lastError,
            renderIndexAvailable: !!renderIndex,
            renderedIntoIndexHtml: rendered,
            htmlLength,
            renderError: htmlError,
            snippet,
          },
          // ② 页面侧事实：前端脚本的回执与心跳
          frontend: {
            helloCount: runtime.helloCount,
            lastHello: runtime.lastHello,
            booted: runtime.helloCount > 0,
            reportAt: runtime.reportAt,
            report: runtime.report,
          },
          // ③ 定时器：闹钟巡检到底有没有在跑（曾经这里是「从来没跑过」的现场）
          timers: runtime.timers,
          timerTicks: runtime.timerTicks,
          timerErrors: runtime.timerErrors,
          // ③b 事件通道：SSE 客户端数 / 收件箱序号（闹钟与任务完成走这两条通道）
          events: {
            boot: runtime.bootId,
            sseClients: runtime.sseClients.size,
            eventSeq: runtime.eventSeq,
            inboxSize: runtime.inbox.length,
            lastInbox: runtime.inbox.slice(-3),
          },
          // ④ 配置层面的「为什么不出声」
          soundWarnings: soundWarnings(),
          // 启动时自动修过的声音配置（每个触发器最多一次）
          soundHeal: runtime.soundHeal,
          // ⑤ 闹钟排程（本地时间）+ 最近一次 20s 巡检 —— 到点没响时一眼看出卡在哪
          alarms: alarmSchedule(),
          alarmChecks: runtime.lastAlarmCheck,
          // ⑥ 本次消耗（当前会话）
          session: sessionView(),
          usage: usageView(),
          time: {
            localNow: lp.date + ' ' + lp.hhmm,
            localDate: lp.date,
            localWeekday: lp.weekday,
            beijingNow: bp.date + ' ' + String(bp.hour).padStart(2, '0') + ':' + String(bp.minute).padStart(2, '0'),
            timezoneOffsetMin: new Date().getTimezoneOffset(),
          },
          images: {
            total: allImages().length,
            custom: listCustomImages().length,
            poses: state.appearance.poses || {},
          },
          origin: base || '(相对路径 / 同源)',
          scriptTag: (base || '') + INJECT_CACHE.src,
          paths: { stateDir, assets: ASSETS_DIR },
          publicRoutes: [
            ROUTE_BASE + '/maodie.js',
            ROUTE_BASE + '/image',
            ROUTE_BASE + '/images.json',
            ROUTE_BASE + '/sound',
            ROUTE_BASE + '/doctor',
            ROUTE_BASE + '/diag',
            ROUTE_BASE + '/hello',
            ROUTE_BASE + '/report.json',
            ROUTE_BASE + '/inbox.json',
            ROUTE_BASE + '/alarm-test.json',
          ],
          note:
            '桌面端主窗口由 Electron 壳在 Host 启动时调 collectIndexInjections() 拿整张表，' +
            '再经 dshDesktopBoot.ready() 交给页面执行；因此「新增/删除注入行」必须先重启一次桌面端，' +
            '而改 assets/maodie.js 只要刷新页面。frontend.booted=true 表示前端确实在页面里跑起来了。',
          serverTime: Date.now(),
        }
        const body = Buffer.from(JSON.stringify(out, null, 2), 'utf8')
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(body.length),
        })
        res.end(body)
      },
    })
    // —— 会话事件：任务完成 + usage ——
    disposers.push(
      ctx.on('session/event', (session, event) => {
        try {
          const ev = event && event.type ? event : session
          const sess = event && event.type ? session : null
          if (!ev || typeof ev.type !== 'string') return
          const data = ev.data || {}
          const sessId = sess && sess.id ? String(sess.id) : null
          if (ev.type === 'assistant/message') {
            const model =
              data.message && data.message.source && data.message.source.model
                ? data.message.source.model
                : ''
            accumulateUsage(data.usage, model)
            accumulateSession(data.usage, sessId)
            return
          }
          if (ev.type === 'turn/end') {
            fireTurnEnd(sessId)
          }
        } catch (err) {
          /* 观察者失败不影响会话 */
        }
      }),
    )

    // —— 定时器：闹钟巡检 + 余额刷新 ——
    // 血坑：原来这里用 `ctx.setInterval(...)` 注册，而且外面套了 try/catch、
    // catch 里什么都不做。结果定时器**从来没跑过**（diag 里 alarmChecks 一直是 null），
    // 而「立即测试」走的是直接投递，所以看起来一切正常 —— 闹钟到点永远不响。
    // 现在：直接用 Host 进程的全局 setInterval（语义最确定），并且把「注册结果 + 跑了几次
    // + 报错」全部记进 diag，让「没在跑」无处可藏。
    const every = (label, ms, fn) => {
      try {
        const timer = setInterval(() => {
          runtime.timerTicks[label] = (runtime.timerTicks[label] || 0) + 1
          try {
            fn()
          } catch (err) {
            runtime.timerErrors[label] = String((err && err.message) || err)
          }
        }, ms)
        disposers.push(() => {
          try {
            clearInterval(timer)
          } catch (err) {
            /* 忽略 */
          }
        })
        runtime.timers.push({ label, ms, mode: 'global', startedAt: Date.now() })
        return true
      } catch (err) {
        runtime.timers.push({ label, ms, mode: 'global', error: String((err && err.message) || err) })
        return false
      }
    }
    every('alarm', 20000, checkAlarms)
    every('balance', 60000, () => {
      fetchBalance().catch(() => {})
    })
    const balanceTick = () => {
      fetchBalance().catch(() => {})
    }

    // 启动后异步预热（不阻塞启动）
    Promise.resolve()
      .then(() => refreshHolidays(false))
      .catch(() => {})
    balanceTick()

    try {
      const native = probeNative()
      console.log(
        '[maodie] mounted; state dir: ' +
          stateDir +
          '; native window: ' +
          (native.window ? 'yes' : 'no(' + native.reason + ')'),
      )
    } catch (err) {
      /* 忽略 */
    }
  }

  const dispose = () => {
    for (const d of disposers.splice(0)) {
      try {
        if (typeof d === 'function') d()
      } catch (err) {
        /* 忽略 */
      }
    }
    for (const res of runtime.sseClients) {
      try {
        res.end()
      } catch (err) {
        /* 忽略 */
      }
    }
    runtime.sseClients.clear()
  }

  return { start, dispose, state: () => state, peakInfo }
}

// hmr-nudge 1790974286866

// hmr-probe-2 1790975040508
