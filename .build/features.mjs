// Host-side feature pass on the rebuilt lib/index.js:
//   - publishEvent + inbox (SSE fallback so alarms/turn-end always arrive)
//   - local-time alarms + deliverAlarm + alarm schedule diagnostics
//   - per-session cost ("本次消耗")
//   - custom appearance images (upload / list / delete / alpha-bbox meta)
//   - soundConfig warnings for /maodie/diag
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
function insAfter(name, anchor, add) {
  rep(name, anchor, anchor + add)
}
function insBefore(name, anchor, add) {
  rep(name, anchor, add + anchor)
}

// ---------------------------------------------------------------- F1 builtin images + meta
rep(
  'F1 builtin images',
  `const BUILTIN_IMAGES = [
  { id: 'builtin:idle', name: '常态', file: 'cat-idle.png' },
  { id: 'builtin:hiss', name: '哈气', file: 'cat-hiss.png' },
]`,
  `// 内置外观图。meta = 图片的 canvas 尺寸 + 不透明区域的 alpha 包围盒，
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
]`,
)

// ---------------------------------------------------------------- F2 runtime fields
rep(
  'F2 runtime fields',
  `    alarmFiredThisMinute: new Set(),
    lastSoundAt: {},
  }`,
  `    alarmFiredThisMinute: new Set(),
    lastSoundAt: {},
    lastAlarmCheck: null,
    // 前端启动回执 + 心跳（唯一能证明「脚本真的在页面里跑起来了」的 Host 侧证据）
    helloCount: 0,
    lastHello: null,
    report: null,
    reportAt: 0,
    // 事件双通道：SSE 即时送达 + 收件箱轮询兜底
    eventSeq: 0,
    inbox: [],
    // 本次消耗（当前会话）：以会话开始时的余额为基准做余额差
    session: null,
  }`,
)

// ---------------------------------------------------------------- F3/F4 default state
rep(
  'F3 appearance.poses',
  `      // 图片对齐参数（按两张图的 alpha 包围盒预先算好）
      align: {
        idle: { scale: 1, dx: 0, dy: 0 },
        hiss: { scale: 1, dx: 0, dy: 0 },
      },
      shadow: true,`,
  `      // 两个姿态各自用哪张外观图（内置 builtin:idle / builtin:hiss，可换成自己上传的 user:xxx）
      poses: {
        idle: 'builtin:idle',
        hiss: 'builtin:hiss',
      },
      // 图片对齐参数（按两张图的 alpha 包围盒预先算好）
      align: {
        idle: { scale: 1, dx: 0, dy: 0 },
        hiss: { scale: 1, dx: 0, dy: 0 },
      },
      shadow: true,`,
)
rep(
  'F4 look.showSessionCost',
  `      particles: true, // 粒子爆炸
      particleCount: 26,
      bubbleStyle: 'balloon', // balloon | card
    },`,
  `      particles: true, // 粒子爆炸
      particleCount: 26,
      bubbleStyle: 'balloon', // balloon | card
      showSessionCost: true, // 气泡里显示「本次消耗」（当前会话）
    },`,
)

// ---------------------------------------------------------------- F5 localParts (module scope)
insAfter(
  'F5 localParts',
  `function bjParts(ms) {
  const d = new Date(ms + BJ_OFFSET_MS)
  const pad = (n) => String(n).padStart(2, '0')
  const y = d.getUTCFullYear()
  const m = pad(d.getUTCMonth() + 1)
  const day = pad(d.getUTCDate())
  return {
    date: \`\${y}-\${m}-\${day}\`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0=周日 6=周六
    year: y,
  }
}`,
  `

// 本地时间（闹钟按**用户墙上的时钟**走：每天 9:00 就是他本地的 9:00）。
// 峰谷价仍然按北京时间算（那是计费口径），两者不要混。
function localParts(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    date: \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\`,
    hour: d.getHours(),
    minute: d.getMinutes(),
    weekday: d.getDay(), // 0=周日 6=周六
    hhmm: \`\${pad(d.getHours())}:\${pad(d.getMinutes())}\`,
    year: d.getFullYear(),
  }
}`,
)

// ---------------------------------------------------------------- F6 publishEvent / broadcastState
insAfter(
  'F6 publishEvent',
  `  // ---------------- SSE ----------------
  const sseSend = (payload) => {
    const text = \`data: \${JSON.stringify(payload)}\\n\\n\`
    for (const res of runtime.sseClients) {
      try {
        res.write(text)
      } catch (err) {
        runtime.sseClients.delete(res)
      }
    }
  }`,
  `

  // 事件发布：SSE 即时送达 + 写进收件箱。
  // 为什么要有收件箱：桌面端主窗口跑在 dsh-app:// 下，EventSource 不一定连得上，
  // 而「闹钟到点」「任务完成」这两类事件丢了就没法补救。前端按 seq 去重，
  // 所以 SSE 与轮询同时开着也不会重复触发。
  const publishEvent = (payload, keepInInbox = true) => {
    runtime.eventSeq += 1
    const item = Object.assign({ seq: runtime.eventSeq, at: Date.now() }, payload)
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
  }`,
)

// ---------------------------------------------------------------- F7 session accounting
insAfter(
  'F7 session accounting',
  `    ledger.events.push({ ts: Date.now(), tokens, model: model || '未知' })
    saveLedger()
  }`,
  `

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
  }`,
)

// ---------------------------------------------------------------- F8 template placeholders
rep(
  'F8 template placeholders',
  `  const renderTemplate = (tpl, extra = {}) => {
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
    )`,
  `  const renderTemplate = (tpl, extra = {}) => {
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
    )`,
)

// ---------------------------------------------------------------- F9 fireTurnEnd
rep(
  'F9 fireTurnEnd payload',
  `    runtime.turnSeq += 1
    const payload = {
      seq: runtime.turnSeq,
      sessionId: sessionId || null,
      at: Date.now(),
      usage: usageView(),
      peak: peakInfo(),
    }`,
  `    runtime.turnSeq += 1
    noteTurnEnd(sessionId)
    const payload = {
      seq: runtime.turnSeq,
      sessionId: sessionId || null,
      at: Date.now(),
      usage: usageView(),
      session: sessionView(),
      peak: peakInfo(),
    }`,
)
rep(
  'F9b fireTurnEnd publish',
  `    if (!cfg.enabled) {
      sseSend({ type: 'turn-end', data: payload, deliver: { native: false, system: false } })
      return
    }`,
  `    if (!cfg.enabled) {
      publishEvent({ type: 'turn-end', data: payload, deliver: { native: false, system: false } })
      return
    }`,
)
rep(
  'F9c fireTurnEnd sseSend',
  `    if (cfg.systemNotification) system = nativeNotify('耄耋 · 任务完成', body)

    sseSend({`,
  `    if (cfg.systemNotification) system = nativeNotify('耄耋 · 任务完成', body)

    publishEvent({`,
)

// ---------------------------------------------------------------- F10 alarms (local time + deliverAlarm + schedule)
rep(
  'F10 alarms',
  `  // ---------------- 闹钟 ----------------
  const checkAlarms = () => {
    const alarms = Array.isArray(state.alarms) ? state.alarms : []
    if (alarms.length === 0) return
    const now = new Date()
    const parts = bjParts(Date.now())
    const hhmm = \`\${String(parts.hour).padStart(2, '0')}:\${String(parts.minute).padStart(2, '0')}\`
    const stamp = \`\${parts.date} \${hhmm}\`
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
  }`,
  `  // ---------------- 闹钟 ----------------
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

  const checkAlarms = () => {
    const alarms = Array.isArray(state.alarms) ? state.alarms : []
    if (alarms.length === 0) return
    const parts = localParts(Date.now())
    const hhmm = parts.hhmm
    const stamp = \`\${parts.date} \${hhmm}\`
    runtime.lastAlarmCheck = { at: Date.now(), hhmm, date: parts.date, fired: [] }
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
      runtime.lastAlarmCheck.fired.push(deliverAlarm(alarm, false))
    }
    saveState()
  }

  // 闹钟排程（本地时间）：到点没响时能一眼看出排程对不对
  const alarmSchedule = () => {
    const out = []
    const list = Array.isArray(state.alarms) ? state.alarms : []
    const now = Date.now()
    for (const a of list) {
      if (!a) continue
      const m = /^(\\d{1,2}):(\\d{2})$/.exec(String(a.time || ''))
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
        for (let d = 0; d <= 8; d++) {
          const t = new Date(now + d * 86400000)
          t.setHours(hh, mm, 0, 0)
          const ms = t.getTime()
          if (ms <= now) continue
          if (a.mode === 'once' && a.date) {
            if (localParts(ms).date !== a.date) continue
          }
          if (a.mode === 'daily' && entry.weekdays.length > 0) {
            if (entry.weekdays.indexOf(t.getDay()) === -1) continue
          }
          entry.nextAt = ms
          entry.nextIn = ms - now
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
  }`,
)

// ---------------------------------------------------------------- F11 custom image helpers
insAfter(
  'F11 image helpers',
  `  const allSounds = () => {
    return BUILTIN_SOUNDS.concat(listCustomSounds()).map((s) => ({
      id: s.id,
      name: s.name || s.id,
      builtin: !!s.builtin,
      mime: s.mime || 'audio/mpeg',
      note: s.note || '',
      bytes: Number(s.bytes) || 0,
    }))
  }`,
  `

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
  }`,
)

// ---------------------------------------------------------------- F12 image route rewrite
rep(
  'F12 image route',
  `        const url = new URL(req.url || '/', 'http://x')
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
          const mime = /\\.png$/i.test(file)
            ? 'image/png'
            : /\\.(jpe?g)$/i.test(file)
              ? 'image/jpeg'
              : /\\.gif$/i.test(file)
                ? 'image/gif'
                : 'image/webp'
          sendBytes(res, 200, bytes, mime)
        } catch (err) {
          sendJson(res, 404, { ok: false, error: 'read-failed', id })
        }`,
  `        const url = new URL(req.url || '/', 'http://x')
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
        }`,
)

// ---------------------------------------------------------------- F13 new image routes
insBefore(
  'F13 image routes',
  `    // —— 路由：上传裁剪后的音频 ——`,
  `    // —— 路由：外观图清单 ——
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

`,
)

// ---------------------------------------------------------------- F14 init.json payload
rep(
  'F14 init payload',
  `          state,
          sounds: allSounds(),
          images: BUILTIN_IMAGES,
          triggers: TRIGGERS,
          peak: peakInfo(),
          usage: usageView(),
          native: probeNative(),
          paths: { stateDir, assets: ASSETS_DIR },`,
  `          state,
          sounds: allSounds(),
          images: allImages(),
          poses: state.appearance.poses || {},
          triggers: TRIGGERS,
          peak: peakInfo(),
          usage: usageView(),
          session: sessionView(),
          native: probeNative(),
          localNow: localParts(Date.now()).hhmm,
          paths: { stateDir, assets: ASSETS_DIR },`,
)

// ---------------------------------------------------------------- F15 status.json payload
rep(
  'F15 status payload',
  `        sendJson(res, 200, {
          ok: true,
          peak: peakInfo(),
          usage: usageView(),
          lastTurn: runtime.lastTurn,
          turnSeq: runtime.turnSeq,
          native: runtime.native,
          serverTime: Date.now(),
        })`,
  `        sendJson(res, 200, {
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
          localNow: localParts(Date.now()).hhmm,
          serverTime: Date.now(),
        })`,
)

// ---------------------------------------------------------------- F16 state.json -> broadcastState
rep(
  'F16 state broadcast',
  `        sendJson(res, 200, { ok: true, saved, state })
        sseSend({ type: 'state', data: { at: Date.now() } })`,
  `        sendJson(res, 200, { ok: true, saved, state })
        broadcastState()`,
)

// ---------------------------------------------------------------- F17 session/event handler
rep(
  'F17 session/event',
  `          if (ev.type === 'assistant/message') {
            const model =
              data.message && data.message.source && data.message.source.model
                ? data.message.source.model
                : ''
            accumulateUsage(data.usage, model)
            return
          }
          if (ev.type === 'turn/end') {
            fireTurnEnd(sess && sess.id ? String(sess.id) : null)
          }`,
  `          const sessId = sess && sess.id ? String(sess.id) : null
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
          }`,
)

// ---------------------------------------------------------------- F18 balance observation -> session baseline
rep(
  'F18 balance baseline',
  `          runtime.balanceError = null
          return runtime.balance`,
  `          runtime.balanceError = null
          if (runtime.session) {
            if (runtime.session.baseBalance === null) runtime.session.baseBalance = total
            if (runtime.session.turnBaseBalance === null) runtime.session.turnBaseBalance = total
          }
          return runtime.balance`,
)

// ---------------------------------------------------------------- F19 start(): restore persisted session
rep(
  'F19 restore session',
  `    loadState()
    loadHolidayCache()
    loadLedger()
    probeNative()`,
  `    loadState()
    loadHolidayCache()
    loadLedger()
    // 会话花费跨 Host 重启保留（同一个会话接着算），换会话时自动重置
    runtime.session = (runtime.ledger && runtime.ledger.session) || null
    probeNative()`,
)

// ---------------------------------------------------------------- F20 ledger keeps the session block
rep(
  'F20 ledger session',
  `    runtime.ledger =
      saved && saved.date === today
        ? saved
        : { date: today, dayStartBalance: null, todayTokens: 0, models: {}, events: [] }
    return runtime.ledger`,
  `    runtime.ledger =
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
    return runtime.ledger`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
