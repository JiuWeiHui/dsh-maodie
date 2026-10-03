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

// 插件版本：用作前端脚本的缓存失效参数（页面 HTML 可能被缓存）
const PLUGIN_VERSION = '1.0.0'
const SCRIPT_TAG_MARK = '<!--maodie-injected-->'

// 前端该从哪个源取数据：桌面端主界面可能跑在自定义协议（dsh-app://app/）下，
// 那时相对路径发出的 fetch 不带 HTTP 会话；这里把真实 HTTP 基址明确告诉前端。
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

const BUILTIN_IMAGES = [
  { id: 'builtin:idle', name: '常态', file: 'cat-idle.png' },
  { id: 'builtin:hiss', name: '哈气', file: 'cat-hiss.png' },
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
      // 是否向桌面端主窗口注入前端（tapIndex 对 dsh-app:// 主窗口无效，走运行时读取注入）
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

// ---------------------------------------------------------------- 模块级协议钩子
// 时机考虑：桌面主进程里 `host.start()`（加载本插件）在协议处理器注册之前，
// 但两者之间有 await，无法保证 apply() 一定先跑到。因此在**模块加载时**就抢先装钩子
// ——这是唯一能确保"先于壳注册 protocol.handle"的位置。钩子本身是幂等的。
const MODULE_LEVEL_HOOK = (() => {
  try {
    const req = resolveRequire()
    if (!req) return 'no-require'
    let electron = null
    try {
      electron = req('electron')
    } catch (err) {
      return 'not-electron'
    }
    const protocol = electron && electron.protocol
    if (!protocol || typeof protocol.handle !== 'function') return 'no-protocol-handle'
    if (protocol.handle.__maodieWrapped) return 'already'
    const originalHandle = protocol.handle
    const wrapped = function (scheme, handler) {
      if (scheme !== 'dsh-app' || typeof handler !== 'function') {
        return originalHandle.call(this, scheme, handler)
      }
      const wrappedHandler = function (request) {
        let result
        try {
          result = handler(request)
        } catch (err) {
          throw err
        }
        if (!result || typeof result.then !== 'function') return result
        return result.then((response) => moduleInjectResponse(response))
      }
      return originalHandle.call(this, scheme, wrappedHandler)
    }
    wrapped.__maodieWrapped = true
    protocol.handle = wrapped
    return 'installed'
  } catch (err) {
    return 'error:' + String((err && err.message) || err)
  }
})()

// 模块级最小注入器状态（协议钩子与 Host 半共用）
const INJECTION_STATE = { hits: 0, lastPath: '', lastError: '', markupProvider: null }
let protocolResponseMapper = null

function moduleInjectResponse(response) {
  try {
    if (!response || typeof response !== 'object') return response
    if (typeof protocolResponseMapper === 'function') return protocolResponseMapper(response)
    return response
  } catch (err) {
    INJECTION_STATE.lastError = String((err && err.message) || err)
    return response
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
        : { date: today, dayStartBalance: null, todayTokens: 0, models: {}, events: [] }
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

  // ---------------- 原生能力探针 ----------------
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
    const map = Object.assign(
      {
        today: usage.cost.toFixed(4),
        balance: usage.balance === null ? '--' : usage.balance.toFixed(2),
        tokens: String(usage.tokens),
        peak: peak.kind === 'peak' ? '高峰' : '谷价',
        currency: usage.currency,
      },
      extra,
    )
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) => (key in map ? String(map[key]) : m))
  }

  const fireTurnEnd = (sessionId) => {
    const cfg = state.notify.turnEnd
    runtime.turnSeq += 1
    const payload = {
      seq: runtime.turnSeq,
      sessionId: sessionId || null,
      at: Date.now(),
      usage: usageView(),
      peak: peakInfo(),
    }
    runtime.lastTurn = payload

    if (!cfg.enabled) {
      sseSend({ type: 'turn-end', data: payload, deliver: { native: false, system: false } })
      return
    }

    const body = renderTemplate(cfg.body || '', {})
    let native = { ok: false, reason: 'disabled' }
    let system = { ok: false, reason: 'disabled' }
    if (cfg.native) native = nativeFlash()
    if (cfg.systemNotification) system = nativeNotify('耄耋 · 任务完成', body)

    sseSend({
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
  const checkAlarms = () => {
    const alarms = Array.isArray(state.alarms) ? state.alarms : []
    if (alarms.length === 0) return
    const now = new Date()
    const parts = bjParts(Date.now())
    const hhmm = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
    const stamp = `${parts.date} ${hhmm}`
    for (const alarm of alarms) {
      if (!alarm || alarm.enabled === false) continue
      const time = String(alarm.time || '')
      if (time !== hhmm) continue
      // 同一分钟内只触发一次
      if (runtime.alarmFiredThisMinute.has(alarm.id + '@' + stamp)) continue
      // 一次性闹钟只在指定日期触发
      if (alarm.mode === 'once' && alarm.date && alarm.date !== parts.date) continue
      // 每天模式可限制星期
      if (alarm.mode === 'daily' && Array.isArray(alarm.weekdays) && alarm.weekdays.length > 0) {
        if (!alarm.weekdays.includes(parts.weekday)) continue
      }
      runtime.alarmFiredThisMinute.add(alarm.id + '@' + stamp)
      // 一次性闹钟触发后自动停用
      if (alarm.mode === 'once') alarm.enabled = false
      // 气泡上显示用户自定义的文字，默认「起床」
      const body = renderTemplate(alarm.text || '起床', { time: hhmm })
      let native = { ok: false, reason: 'disabled' }
      let system = { ok: false, reason: 'disabled' }
      if (state.notify.turnEnd.native) native = nativeFlash()
      system = nativeNotify('耄耋 · 闹钟', body)
      sseSend({
        type: 'alarm',
        data: { id: alarm.id, name: alarm.name || '闹钟', time: hhmm, text: body, at: Date.now() },
        deliver: {
          native,
          system,
          webNotification: !system.ok,
          sound: true,
          bubble: true,
          catAct: true,
        },
      })
    }
    saveState()
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

  // ---------------- 桌面端主窗口注入（关键） ----------------
  // 事实（读 app.asar 得到）：桌面壳的 dsh-app:// 协议处理器用 serveWebDocument()
  // **直接从磁盘读 `@deepseek-ai/dsh-web-frontend/dist/index.html`** 返回给主窗口，
  // 完全不经过 ctx.webServer.renderIndex()。所以 tapIndex 注入对主窗口无效——
  // 那是"猫不出现"的真正原因。
  //
  // 修法：在 Electron 主进程内包一层 node:fs 的读取，只对"那份 index.html"追加注入片段。
  // 保守设计：
  //   - 只在路径命中 dsh-web-frontend 且以 .html 结尾时生效
  //   - 只插一次（靠标记判断），已插过直接返回原内容
  //   - 任何异常都放行原内容，绝不影响应用启动与页面加载
  //   - 可用 state.security.injectMainWindow = false 关闭
  const INJECT_CACHE = { done: false, hits: 0, lastPath: '', lastError: '' }
  let uninstallInjector = null

  const injectionMarkup = () => {
    const base = resolveWebBase()
    const src = ROUTE_BASE + '/maodie.js?v=' + PLUGIN_VERSION
    const probe =
      '<!--maodie-injected--><script>(function(){' +
      'var id="md-probe";' +
      'function box(){var d=document.getElementById(id);if(!d){d=document.createElement("div");d.id=id;' +
      'd.style.cssText="position:fixed;left:8px;top:8px;z-index:2147483600;background:#203170;color:#fff;font:600 12px/1.6 system-ui,Microsoft YaHei;padding:6px 10px;border-radius:8px;max-width:70vw;word-break:break-all";' +
      '(document.body||document.documentElement).appendChild(d)}return d}' +
      'function say(t){try{box().textContent="耄耋探针: "+t}catch(e){}}' +
      'window.__maodieProbe=say;say("主窗口内联脚本已执行");' +
      'window.addEventListener("error",function(e){say("页面报错: "+String((e&&e.message)||"")+" @"+String((e&&e.filename)||"").split("/").pop()+":"+(e&&e.lineno))},true);' +
      'var t0=Date.now();' +
      'fetch("' + ROUTE_BASE + '/init.json",{credentials:"include",cache:"no-store"})' +
      '.then(function(r){say("init.json HTTP "+r.status+" ("+(Date.now()-t0)+"ms)");return r.text()})' +
      '.then(function(t){say("init.json "+t.length+" 字节: "+t.slice(0,50).replace(/\\s+/g," "))})' +
      '.catch(function(e){say("init.json 失败: "+String((e&&e.message)||e))});' +
      'setTimeout(function(){var el=document.getElementById(id);if(el&&el.textContent.indexOf("init.json")<0)say("3 秒仍未拿到 init.json")},3000);' +
      'setTimeout(function(){var el=document.getElementById(id);var mk=document.getElementById("md-root");' +
      'if(el)say(el.textContent+" | 猫: "+(mk?"已创建":"不存在"))},8000);' +
      '})()</script>'
    return (
      '<!--maodie-injected-->' +
      (base ? '<script>window.__MAODIE_BASE__=' + JSON.stringify(base) + ';</script>' : '') +
      probe +
      '<script defer src="' + src + '"></script>'
    )
  }

  const looksLikeMainDocument = (filePath) => {
    const p = String(filePath || '')
    if (!/\.html?$/i.test(p)) return false
    return p.indexOf('dsh-web-frontend') !== -1 || /[\\/]dist[\\/]index\.html?$/i.test(p)
  }

  const rewriteMainDocument = (value) => {
    try {
      if (state && state.security && state.security.injectMainWindow === false) return value
      let text = null
      let isBuffer = false
      if (typeof value === 'string') text = value
      else if (Buffer.isBuffer(value)) {
        text = value.toString('utf8')
        isBuffer = true
      } else return value
      if (!text || text.indexOf('</html>') === -1) return value
      if (text.indexOf('<!--maodie-injected-->') !== -1) return value
      INJECT_CACHE.hits += 1
      const out = text.replace(/<\/body>/i, injectionMarkup() + '</body>')
      const finalText = out === text ? text + injectionMarkup() : out
      return isBuffer ? Buffer.from(finalText, 'utf8') : finalText
    } catch (err) {
      INJECT_CACHE.lastError = String((err && err.message) || err)
      return value
    }
  }


  // 把 HTML 响应体改写成注入了脚本的版本；其它响应原样透传
  const wrapProtocolResponse = (response) => {
    try {
      if (!response || typeof response !== 'object') return response
      const type = String((response.headers && response.headers.get && response.headers.get('content-type')) || '')
      const url = String(response.url || '')
      const isHtml = type.indexOf('text/html') !== -1 || /\/index\.html?$/.test(url)
      if (!isHtml) return response
      const wrapText = (originalText) =>
        Promise.resolve()
          .then(() => originalText())
          .then((text) => {
            if (typeof text !== 'string' || text.indexOf('</html>') === -1) return text
            if (text.indexOf('<!--maodie-injected-->') !== -1) return text
            INJECT_CACHE.hits += 1
            INJECT_CACHE.lastPath = url || 'protocol:dsh-app://app/'
            const out = text.replace(/<\/body>/i, injectionMarkup() + '</body>')
            return out === text ? text + injectionMarkup() : out
          })
      let patched = null
      try {
        patched = new Proxy(response, {
          get(target, prop, receiver) {
            if (prop === 'text') {
              const originalText = target.text
              if (typeof originalText !== 'function') return originalText
              return function () {
                return wrapText(originalText.bind(target))
              }
            }
            if (prop === 'json') {
              // HTML 不该走 json；保持原样
              return Reflect.get(target, prop, receiver)
            }
            const value = Reflect.get(target, prop, target)
            if (typeof value === 'function') return value.bind(target)
            return value
          },
        })
      } catch (err) {
        INJECT_CACHE.protocolError = 'proxy failed: ' + String((err && err.message) || err)
        return response
      }
      return patched
    } catch (err) {
      INJECT_CACHE.protocolError = String((err && err.message) || err)
      return response
    }
  }

  const installMainWindowInjector = (ctx2) => {
    // 说明：插件是 ESM，模块作用域里**没有** require（第一版就栽在这里：
    // 我用 require('electron') 探测，结果 "require unavailable" 直接放弃）。
    // 现在改成：
    //   1) 用 createRequire(import.meta.url) 拿 require
    //   2) 无论是否探测到 Electron，**都尝试打补丁** —— 安全性由"只改那份 index.html"
    //      的路径过滤保证，其它文件一律原样返回，所以打在普通 Node 上也无害。
    const req = resolveRequire()
    let electronDetected = false
    try {
      const electron = req ? req('electron') : null
      electronDetected = !!(electron && typeof electron === 'object')
    } catch (err) {
      electronDetected = false
    }
    INJECT_CACHE.electron = electronDetected
    INJECT_CACHE.requireSource = req ? (typeof require === 'function' ? 'global' : 'createRequire') : 'none'
    INJECT_CACHE.moduleHook = MODULE_LEVEL_HOOK

    // 首选：协议层拦截（模块加载时已装钩子，这里把"响应映射器"接上）
    try {
      protocolResponseMapper = wrapProtocolResponse
      INJECT_CACHE.protocolPatched = MODULE_LEVEL_HOOK === 'installed' || MODULE_LEVEL_HOOK === 'already'
    } catch (err) {
      INJECT_CACHE.protocolError = String((err && err.message) || err)
    }

    // 兜底：fs 层补丁（覆盖用 fs.promises.readFile 的读取路径）
    const targets = []
    const addTarget = (obj, label) => {
      if (!obj || typeof obj.readFile !== 'function') return
      if (obj.readFile.__maodiePatched) return
      targets.push({ obj, label, original: obj.readFile })
    }
    addTarget(fsp, 'node:fs/promises (静态导入)')
    addTarget(fs.promises, 'fs.promises')
    if (req) {
      try {
        addTarget(req('node:fs/promises'), 'node:fs/promises (require)')
      } catch (err) {
        /* 忽略 */
      }
      try {
        addTarget(req('node:fs').promises, 'fs.promises (require)')
      } catch (err) {
        /* 忽略 */
      }
    }
    if (targets.length === 0) {
      INJECT_CACHE.lastError = 'no readFile target'
      return null
    }

    const makePatched = (original) => {
      const patched = function (file, options, ...rest) {
        const result = original.call(this, file, options, ...rest)
        try {
          if (!looksLikeMainDocument(file)) return result
          INJECT_CACHE.lastPath = String(file)
          return Promise.resolve(result).then((value) => rewriteMainDocument(value))
        } catch (err) {
          INJECT_CACHE.lastError = String((err && err.message) || err)
          return result
        }
      }
      patched.__maodiePatched = true
      return patched
    }

    for (const target of targets) {
      try {
        target.obj.readFile = makePatched(target.original)
      } catch (err) {
        INJECT_CACHE.lastError = 'assign failed on ' + target.label
      }
    }
    INJECT_CACHE.patchedTargets = targets.map((t) => t.label)
    INJECT_CACHE.done = true
    return () => {
      for (const target of targets) {
        try {
          target.obj.readFile = target.original
        } catch (err) {
          /* 忽略 */
        }
      }
      INJECT_CACHE.done = false
    }
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
    stateDir = pickStateDir()
    stateFile = path.join(stateDir, STATE_FILE_NAME)
    holidayFile = path.join(stateDir, HOLIDAY_FILE_NAME)
    loadState()
    loadHolidayCache()
    loadLedger()
    probeNative()

    // 桌面端主窗口注入（tapIndex 对 dsh-app:// 主窗口无效，必须走这条路）
    uninstallInjector = installMainWindowInjector(ctx)
    if (uninstallInjector) disposers.push(uninstallInjector)

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
          images: BUILTIN_IMAGES,
          triggers: TRIGGERS,
          peak: peakInfo(),
          usage: usageView(),
          native: probeNative(),
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
          lastTurn: runtime.lastTurn,
          turnSeq: runtime.turnSeq,
          native: runtime.native,
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
        sseSend({ type: 'state', data: { at: Date.now() } })
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
        let file = null
        if (id.startsWith('builtin:')) {
          const def = BUILTIN_IMAGES.find((x) => x.id === id)
          if (def) file = path.join(ASSETS_DIR, def.file)
        } else {
          const safe = id.replace(/[^a-zA-Z0-9._-]/g, '')
          file = path.join(stateDir, 'images', safe)
        }
        if (!file) {
          sendJson(res, 404, { ok: false, error: 'not-found', id })
          return
        }
        try {
          const bytes = fs.readFileSync(file)
          const mime = /\.png$/i.test(file)
            ? 'image/png'
            : /\.(jpe?g)$/i.test(file)
              ? 'image/jpeg'
              : /\.gif$/i.test(file)
                ? 'image/gif'
                : 'image/webp'
          sendBytes(res, 200, bytes, mime)
        } catch (err) {
          sendJson(res, 404, { ok: false, error: 'read-failed', id })
        }
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

    // —— index 注入 ——
    // 标记注释用于自检：取一次页面 HTML 就能判断注入是否生效
    // 注入 window.__MAODIE_BASE__：桌面端主界面可能跑在 dsh-app:// 下，
    // 那时相对路径 fetch 不带 HTTP 会话 cookie，必须用绝对 HTTP 基址 + credentials。
    disposers.push(
      ctx.webServer.tapIndex((html) => {
        const base = resolveWebBase()
        const src = ROUTE_BASE + '/maodie.js?v=' + PLUGIN_VERSION
        if (html.indexOf('id="md-probe"') !== -1) return html

        // 活体探针：一段内联脚本（不依赖外部请求），在页面左上角直接显示进度。
        // 用来一眼分清：JS 根本没跑 / 跑了但取数失败 / 正常启动。
        const probe =
          '<!--maodie-injected--><script>(function(){' +
          'var id="md-probe";' +
          'function box(){var d=document.getElementById(id);if(!d){d=document.createElement("div");d.id=id;' +
          'd.style.cssText="position:fixed;left:8px;top:8px;z-index:2147483600;background:#203170;color:#fff;font:600 12px/1.6 system-ui,Microsoft YaHei;padding:6px 10px;border-radius:8px;max-width:70vw;word-break:break-all";' +
          '(document.body||document.documentElement).appendChild(d)}return d}' +
          'function say(t){try{box().textContent="耄耋探针: "+t}catch(e){}}' +
          'window.__maodieProbe=say;' +
          'say("内联脚本已执行");' +
          'window.addEventListener("error",function(e){say("页面报错: "+String((e&&e.message)||"")+" @"+String((e&&e.filename)||"").split("/").pop()+":"+(e&&e.lineno))},true);' +
          'var t0=Date.now();' +
          'fetch("' + ROUTE_BASE + '/init.json",{credentials:"include",cache:"no-store"})' +
          '.then(function(r){say("init.json HTTP "+r.status+" ("+(Date.now()-t0)+"ms)");return r.text()})' +
          '.then(function(t){say("init.json "+t.length+" 字节: "+t.slice(0,50).replace(/\\s+/g," "))})' +
          '.catch(function(e){say("init.json 失败: "+String((e&&e.message)||e))});' +
          'setTimeout(function(){var el=document.getElementById(id);if(el&&el.textContent.indexOf("init.json")<0)say("3 秒仍未拿到 init.json")},3000);' +
          'setTimeout(function(){var el=document.getElementById(id);var mk=document.getElementById("md-root");' +
          'if(el)say(el.textContent+" | 猫: "+(mk?"已创建":"不存在"))},8000);' +
          '})()</script>'

        const injected =
          probe +
          (base ? '<script>window.__MAODIE_BASE__=' + JSON.stringify(base) + ';</script>' : '') +
          '<script defer src="' + src + '"></script>'
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', injected + '</body>')
        return html + injected
      }),
    )

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
          'L.push("回到 DeepSeek Harness 主窗口，按 Ctrl+Shift+R 硬刷新；若还是不出现，按 F12 把 Console 里的红色报错发我。");',
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

    // —— 无认证诊断：看真实渲染后的 index HTML，确认脚本标签进去了没有 ——
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/diag',
      handler: (req, res) => {
        const renderIndex =
          ctx.webServer && typeof ctx.webServer.renderIndex === 'function'
            ? ctx.webServer.renderIndex.bind(ctx.webServer)
            : null
        let injected = false
        let snippet = ''
        let htmlError = ''
        let htmlLength = 0
        if (renderIndex) {
          try {
            const html = renderIndex('<!doctype html><html><head></head><body><div id="root"></div></body></html>')
            htmlLength = html.length
            injected = html.indexOf(SCRIPT_TAG_MARK) !== -1
            const at = html.indexOf(ROUTE_BASE + '/maodie.js')
            snippet = at === -1 ? html.slice(-320) : html.slice(Math.max(0, at - 160), at + 120)
          } catch (err) {
            htmlError = String((err && err.message) || err)
          }
        }
        const base = resolveWebBase()
        const out = {
          ok: true,
          plugin: PLUGIN_VERSION,
          injection: {
            renderIndexAvailable: !!renderIndex,
            tapWorks: injected,
            htmlLength,
            error: htmlError,
            snippet,
          },
          // 桌面端主窗口注入器的状态（tapIndex 对 dsh-app:// 主窗口无效，靠这个）
          mainWindowInjector: {
            active: INJECT_CACHE.done || INJECT_CACHE.protocolPatched,
            moduleHook: INJECT_CACHE.moduleHook || MODULE_LEVEL_HOOK,
            protocolPatched: !!INJECT_CACHE.protocolPatched,
            protocolSeen: !!INJECT_CACHE.protocolSeen,
            protocolError: INJECT_CACHE.protocolError || '',
            electron: !!INJECT_CACHE.electron,
            requireSource: INJECT_CACHE.requireSource || '',
            patchedTargets: INJECT_CACHE.patchedTargets || [],
            rewrites: INJECT_CACHE.hits,
            lastDocumentPath: INJECT_CACHE.lastPath,
            lastError: INJECT_CACHE.lastError,
          },
          origin: base || '(未设置 DSH_WEB_URL)',
          scriptTag: base ? base + ROUTE_BASE + '/maodie.js' : ROUTE_BASE + '/maodie.js',
          publicRoutes: [ROUTE_BASE + '/maodie.js', ROUTE_BASE + '/image', ROUTE_BASE + '/sound', ROUTE_BASE + '/doctor', ROUTE_BASE + '/diag'],
          fencedRoutes: [ROUTE_BASE + '/init.json', ROUTE_BASE + '/status.json', ROUTE_BASE + '/state.json', ROUTE_BASE + '/events'],
          note: '桌面壳用 serveWebDocument 直接从磁盘读 dist/index.html 给主窗口，不经过 renderIndex；主窗口注入依赖 mainWindowInjector。',
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
          if (ev.type === 'assistant/message') {
            const model =
              data.message && data.message.source && data.message.source.model
                ? data.message.source.model
                : ''
            accumulateUsage(data.usage, model)
            return
          }
          if (ev.type === 'turn/end') {
            fireTurnEnd(sess && sess.id ? String(sess.id) : null)
          }
        } catch (err) {
          /* 观察者失败不影响会话 */
        }
      }),
    )

    // —— 定时器：闹钟检查 + 余额刷新 ——
    const tick = () => {
      try {
        checkAlarms()
      } catch (err) {
        /* 忽略 */
      }
    }
    try {
      if (typeof ctx.setInterval === 'function') disposers.push(ctx.setInterval(tick, 20000))
      else {
        const t = setInterval(tick, 20000)
        disposers.push(() => clearInterval(t))
      }
    } catch (err) {
      /* 忽略 */
    }

    const balanceTick = () => {
      fetchBalance().catch(() => {})
    }
    try {
      if (typeof ctx.setInterval === 'function') disposers.push(ctx.setInterval(balanceTick, 60000))
      else {
        const t = setInterval(balanceTick, 60000)
        disposers.push(() => clearInterval(t))
      }
    } catch (err) {
      /* 忽略 */
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
