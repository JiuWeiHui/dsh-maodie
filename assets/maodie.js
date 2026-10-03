/* ============================================================================
 * 耄耋 (maodie) —— 前端半（纯 DOM，无框架、无构建）
 * ============================================================================
 * 内容：
 *   1. 猫：可拖动、可缩放、可放屏幕任意位置；点击哈气、连点三下摇晃 + 粒子爆炸
 *   2. 峰谷气泡：峰价/谷价 + 倒计时 + 余额 + 今日已用；点破气泡立刻掐断音效
 *   3. 声音：槽位 / 触发器 / 素材池随机 / 冷却 / 循环；播放句柄可被外部停止
 *   4. 设置窗：右键猫打开，独立窗口，标签页（外观 / 声音 / 提醒 / 峰谷 / 关于）
 *   5. 音频裁剪器：波形 + 缩放 + 双边界 + 循环试听 + 淡入淡出 + 归一化 +
 *      自动去首尾静音 + 导出 WAV（16-bit PCM，手写 RIFF，无第三方库）
 *
 * 图片对齐：两张图的 alpha 包围盒不同，按下表换算保证切换不跳。
 *   idle: 画布 1248x2048, bbox 169,147 -> 1051x1853（即规范画布）
 *   hiss: 画布 1280x1760, bbox 209,152 -> 1015x1607
 *   规范画布 = idle 的 bbox。元素尺寸直接由 img 撑开，避免 DOM 与几何脱节。
 * ==========================================================================*/
(function () {
  'use strict'

  var API = '/maodie'
  // 前端脚本自己的版本：与 Host 的 /maodie/init.json.version 对不上就自动刷新页面。
  // 这样以后升级插件只要 Host 模块热重载 + 一次自动刷新，不用手动重启桌面端。
  var MAODIE_VERSION = '1.3.1'
  // 页面里的异常留一份，随心跳上报给 Host（/maodie/diag 能看到）
  var pageErrors = []
  // 「用户正在操作」的判定：重建设置面板必须避开这个窗口，
  // 否则正在用的输入框/下拉会被换成新节点（时间选择器和下拉会立刻失去宿主，
  // 表现就是「改过一次之后就点不开、输入不进去」）。
  // 输入诊断：把「焦点有没有落到输入框 / 按键有没有到 / 值有没有变 / 面板有没有被重建」
  // 全部记下来，随心跳上报（diag 的 frontend.report.inputDiag）。踩过两次「输不进去」
  // 但只能靠猜的坑，所以这一次让它可测。
  var inputDiag = []
  function noteInputDiag(kind, detail) {
    try {
      if (inputDiag.length > 40) inputDiag = inputDiag.slice(-40)
      var active = document.activeElement
      inputDiag.push({
        at: Date.now(),
        kind: String(kind),
        detail: String(detail === undefined || detail === null ? '' : detail).slice(0, 80),
        active: active ? String(active.tagName || '') + (active.type ? ':' + active.type : '') : '',
        focused: isInteracting(),
      })
    } catch (err) {
      /* 忽略 */
    }
  }

  function targetLabel(t) {
    if (!t) return ''
    var tag = String(t.tagName || '')
    var id = t.id || t.getAttribute && (t.getAttribute('data-md-alarm-next') || '')
    return tag.toLowerCase() + (t.type ? '[' + t.type + ']' : '') + (id ? '#' + id : '')
  }

  var lastInteractAt = 0
  function markInteract() {
    lastInteractAt = Date.now()
  }
  function isInteracting() {
    try {
      if (Date.now() - lastInteractAt < 900) return true
      var active = document.activeElement
      if (!active) return false
      var tag = String(active.tagName || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true
      return active.isContentEditable === true
    } catch (err) {
      return false
    }
  }
  try {
    window.addEventListener('error', function (e) {
      pageErrors.push(String((e && e.message) || '') + ' @' + String((e && e.filename) || '').split('/').pop() + ':' + String((e && e.lineno) || ''))
      if (pageErrors.length > 30) pageErrors = pageErrors.slice(-30)
    }, true)
    window.addEventListener('unhandledrejection', function (e) {
      pageErrors.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || ''))
      if (pageErrors.length > 30) pageErrors = pageErrors.slice(-30)
    })
    document.addEventListener('pointerdown', markInteract, true)
    document.addEventListener('keydown', markInteract, true)
    document.addEventListener('input', markInteract, true)
    document.addEventListener('change', markInteract, true)
    // —— 输入诊断（只记录，不干预）——
    document.addEventListener(
      'keydown',
      function (e) {
        noteInputDiag('keydown', String((e && e.key) || '') + ' → ' + targetLabel(e && e.target))
      },
      true,
    )
    document.addEventListener(
      'input',
      function (e) {
        var t = e && e.target
        noteInputDiag('input', targetLabel(t) + ' len=' + String((t && t.value && t.value.length) || 0))
      },
      true,
    )
    document.addEventListener(
      'change',
      function (e) {
        var t = e && e.target
        noteInputDiag('change', targetLabel(t) + ' = ' + String((t && t.value) || '').slice(0, 24))
      },
      true,
    )
    document.addEventListener(
      'focusin',
      function (e) {
        noteInputDiag('focusin', targetLabel(e && e.target))
      },
      true,
    )
    document.addEventListener(
      'focusout',
      function (e) {
        noteInputDiag('focusout', targetLabel(e && e.target))
      },
      true,
    )
  } catch (err) {
    /* 忽略 */
  }
  var Z = 9000

  // ------------------------------------------------------------ 出错要看得见
  // 教训：前端一旦静默抛错，用户只会看到"猫没出现"，无从排查。
  // 把插件自身的错误显示成一条页面横幅，并在控制台打红字。
  function showErrorBanner(message) {
    try {
      var id = 'md-error-banner'
      var old = document.getElementById(id)
      if (old) old.remove()
      var bar = document.createElement('div')
      bar.id = id
      bar.textContent = '耄耋出错：' + String(message) + '（点这里关闭）'
      bar.style.cssText =
        'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;' +
        'background:#c0392b;color:#fff;padding:10px 14px;border-radius:10px;' +
        'font:600 13px/1.6 system-ui,"Microsoft YaHei";box-shadow:0 10px 30px rgba(0,0,0,.35);' +
        'cursor:pointer;word-break:break-all'
      bar.addEventListener('click', function () {
        bar.remove()
      })
      ;(document.body || document.documentElement).appendChild(bar)
    } catch (err) {
      /* 连横幅都画不出来就只能算了 */
    }
  }
  try {
    window.__maodieError = showErrorBanner
  } catch (err) {
    /* 忽略 */
  }

  try {
    window.addEventListener('error', function (event) {
      var src = String((event && event.filename) || '')
      var msg = String((event && event.message) || '')
      if (src.indexOf('maodie') !== -1 || msg.indexOf('maodie') !== -1) {
        try {
          console.error('[耄耋] 未捕获错误', (event && event.error) || msg)
        } catch (err) {
          /* 忽略 */
        }
        showErrorBanner(msg || src)
      }
    })
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason
      var text = String((reason && (reason.stack || reason.message)) || reason || '')
      if (text.indexOf('maodie') !== -1) {
        try {
          console.error('[耄耋] 未处理的 Promise 拒绝', reason)
        } catch (err) {
          /* 忽略 */
        }
        showErrorBanner(String((reason && reason.message) || reason))
      }
    })
  } catch (err) {
    /* 忽略 */
  }

  // ------------------------------------------------------------ 小工具
  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }
  function css(node, obj) {
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) node.style[k] = obj[k]
    return node
  }
  function clamp(v, a, b) {
    v = Number(v)
    if (!isFinite(v)) v = a
    return Math.min(b, Math.max(a, v))
  }
  function json(url, options) {
    // credentials: 'include' —— 数据路由需要浏览器会话 cookie
    var opts = Object.assign({ credentials: 'include' }, options || {})
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () {
        return null
      })
    })
  }

  // 请求基址。顺序即优先级：
  //   1) ''（相对路径 / 同源）—— 永远第一个，也是唯一正常情况下会用到的
  //      · 浏览器直连 DSH：页面本身就在 http://127.0.0.1:<port>，同源且自带 cookie
  //      · 桌面端：页面在 dsh-app://app/，dsh-app:// 协议处理器会把
  //        「非 /、/index.html、/assets/*」的请求转发给 Host 并附上会话 cookie，
  //        相对路径同样正确 —— 不用猜端口，也不会产生跨域请求
  //   2) window.__DSH_TRANSPORT__.streamBaseUrl（桌面壳注入的 Host 源）
  //   3) window.__MAODIE_BASE__（Host 通过注入行下发的绝对 HTTP 基址，仅当显式配置）
  //   4) location.origin（http/https 下的兜底）
  var API_BASE = ''
  var BASE_CANDIDATES = []
  function computeBaseCandidates() {
    var list = ['']
    try {
      var t = window.__DSH_TRANSPORT__
      if (t && typeof t.streamBaseUrl === 'string' && /^https?:\/\//.test(t.streamBaseUrl)) {
        list.push(t.streamBaseUrl.replace(/\/+$/, ''))
      }
    } catch (err) {
      /* 忽略 */
    }
    try {
      if (typeof window.__MAODIE_BASE__ === 'string' && /^https?:\/\//.test(window.__MAODIE_BASE__)) {
        list.push(window.__MAODIE_BASE__.replace(/\/+$/, ''))
      }
    } catch (err) {
      /* 忽略 */
    }
    try {
      if (/^https?:$/.test(location.protocol)) list.push(location.origin)
    } catch (err) {
      /* 忽略 */
    }
    var seen = {}
    BASE_CANDIDATES = list.filter(function (x) {
      if (seen[x]) return false
      seen[x] = 1
      return true
    })
    return BASE_CANDIDATES
  }
  function api(path) {
    return (API_BASE || '') + path
  }
  function deepMerge(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base)
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue
      var v = patch[k]
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = deepMerge(out[k], v)
      } else {
        out[k] = v
      }
    }
    return out
  }
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  }
  function fmtMoney(n) {
    var v = Number(n)
    if (!isFinite(v)) return '--'
    return v.toFixed(v >= 100 ? 2 : 4)
  }
  function fmtTokens(n) {
    var v = Number(n) || 0
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(Math.round(v))
  }
  function fmtDuration(ms) {
    if (!isFinite(ms) || ms <= 0) return '--'
    var total = Math.round(ms / 1000)
    var h = Math.floor(total / 3600)
    var m = Math.floor((total % 3600) / 60)
    if (h > 0) return h + ' 小时 ' + m + ' 分'
    if (m > 0) return m + ' 分'
    return '不到 1 分'
  }

  // ------------------------------------------------------------ 全局状态
  var boot = null // init.json 的返回
  var state = null // state 引用（boot.state）
  var status = null // status.json 的返回
  var sounds = []
  var triggers = []
  var images = []
  var nativeInfo = { probed: false, electron: false, window: false, notify: false, reason: '' }
  var settingsWin = null
  var activeCrop = null

  // ------------------------------------------------------------ 音频播放管理
  // 关键：活动音频句柄集中管理，气泡被戳破 / 闹钟关闭时要能立刻掐断
  // 约定：任务完成音、闹钟音、特殊提示音统一用 'notify' 标签，
  //      猫点击/悬浮等交互音用 'click'；popBubble 一次把这两类全停掉。
  var TAG = { notify: 'notify', click: 'click' }
  var audio = {
    active: [], // { node, gain, stop, tag }
    volume: 0.9,
    cooldowns: {},
    // 声音为什么没响：最后一次播放的结果（随心跳上报到 Host）
    lastResult: null,
    // 有没有用户手势解锁过音频（没手势时浏览器可能拦掉自动播放）
    unlocked: false,
    // 被拦掉的那一条，下次用户一点页面就补播
    pendingRetry: null,
  }

  function noteAudioResult(info) {
    var item = Object.assign({ at: Date.now() }, info || {})
    audio.lastResult = item
    if (item.ok === false && item.trigger) audio.pendingRetry = { id: item.id, trigger: item.trigger }
  }

  function unlockAudio() {
    audio.unlocked = true
    try {
      var ctx = audioContext()
      if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume()
    } catch (err) {
      /* 忽略 */
    }
  }

  function retryPendingAudio() {
    var pending = audio.pendingRetry
    if (!pending) return
    audio.pendingRetry = null
    var slot = slotFor(pending.trigger)
    if (!slot) return
    playSound(pending.id, {
      tag: pending.trigger === 'turn.end' || pending.trigger === 'alarm.fire' ? TAG.notify : TAG.click,
      loop: slot.loop === true,
      cooldownMs: 0,
      trigger: pending.trigger,
    })
  }

  // ------------------------------------------------------------ 试听（可暂停）
  // 素材库 / 槽位 / 裁剪器选区三处试听共用一份「当前试听」状态：
  // 同一个来源再点一次 = 停止；换一个来源 = 停掉上一个再放新的。
  var preview = { key: null, stop: null, startedAt: 0 }

  function previewIs(key) {
    return preview.key === key && !!preview.stop
  }

  function stopPreview(quiet) {
    var cur = preview
    preview = { key: null, stop: null, startedAt: 0 }
    if (cur.stop) {
      try {
        cur.stop()
      } catch (err) {
        /* 忽略 */
      }
    }
    if (!quiet) refreshPreviewButtons()
  }

  function togglePreview(key, startFn) {
    if (previewIs(key)) {
      stopPreview()
      return false
    }
    stopPreview(true)
    var stop = null
    try {
      stop = startFn()
    } catch (err) {
      stop = null
    }
    preview = { key: key, stop: typeof stop === 'function' ? stop : function () {}, startedAt: Date.now() }
    refreshPreviewButtons()
    return true
  }

  function refreshPreviewButtons() {
    try {
      var nodes = document.querySelectorAll('[data-md-preview-key]')
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var on = previewIs(node.getAttribute('data-md-preview-key'))
        node.textContent = on
          ? node.getAttribute('data-md-preview-on') || '停止试听'
          : node.getAttribute('data-md-preview-off') || '试听'
        if (on) node.classList.add('md-btn-danger')
        else node.classList.remove('md-btn-danger')
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  function previewButton(key, offLabel, onLabel) {
    var b = button(offLabel || '试听', 'md-btn-mini', function () {})
    b.setAttribute('data-md-preview-key', key)
    b.setAttribute('data-md-preview-off', offLabel || '试听')
    b.setAttribute('data-md-preview-on', onLabel || '停止试听')
    return b
  }

  function stopAllAudio(tag) {
    var kept = []
    for (var i = 0; i < audio.active.length; i++) {
      var item = audio.active[i]
      if (tag && item.tag !== tag) {
        kept.push(item)
        continue
      }
      try {
        item.stop()
      } catch (err) {
        /* 忽略 */
      }
    }
    audio.active = kept
  }

  var sharedCtx = null
  function audioContext() {
    if (sharedCtx) return sharedCtx
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return null
      sharedCtx = new Ctx()
    } catch (err) {
      sharedCtx = null
    }
    return sharedCtx
  }

  function soundUrl(id) {
    return api('/sound?id=') + encodeURIComponent(id)
  }

  // 用 <audio> 播放：对 m4a/mp3 兼容性最好，且天然支持大文件流式
  function playSound(id, opts) {
    opts = opts || {}
    var tag = opts.tag || 'default'
    var loop = opts.loop === true
    var cooldownKey = tag + '|' + id

    if (!loop && opts.cooldownMs > 0) {
      var last = audio.cooldowns[cooldownKey] || 0
      if (Date.now() - last < opts.cooldownMs) return null
    }
    audio.cooldowns[cooldownKey] = Date.now()

    if (!loop) stopAllAudio(TAG.notify)

    var node
    try {
      node = new Audio(soundUrl(id))
    } catch (err) {
      return null
    }
    node.loop = loop
    node.preload = 'auto'
    try {
      node.volume = clamp(opts.volume === undefined ? audio.volume : opts.volume, 0, 1)
    } catch (err) {
      /* 忽略 */
    }

    var entry = {
      node: node,
      tag: tag,
      stop: function () {
        try {
          node.pause()
          node.currentTime = 0
        } catch (err) {
          /* 忽略 */
        }
      },
    }
    audio.active.push(entry)
    node.addEventListener('ended', function () {
      if (loop) return
      audio.active = audio.active.filter(function (x) {
        return x !== entry
      })
    })

    var p = node.play()
    if (p && typeof p.then === 'function') {
      p.then(function () {
        noteAudioResult({ id: id, trigger: opts.trigger || '', ok: true, error: '' })
      }).catch(function (err) {
        // 自动播放被拦（没有用户手势）/ 解码失败 —— 记下来，别静默
        audio.active = audio.active.filter(function (x) {
          return x !== entry
        })
        noteAudioResult({
          id: id,
          trigger: opts.trigger || '',
          ok: false,
          error: String((err && err.name) || '') + ': ' + String((err && err.message) || err),
        })
      })
    } else {
      noteAudioResult({ id: id, trigger: opts.trigger || '', ok: true, error: '' })
    }
    return entry
  }

  function slotFor(trigger) {
    if (!state || !state.audio) return null
    var slots = state.audio.slots || []
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i]
      if (s && s.enabled !== false && s.trigger === trigger) return s
    }
    return null
  }

  function pickSound(slot) {
    var pool = (slot && slot.sounds) || []
    if (pool.length === 0) return null
    if (pool.length === 1) return pool[0]
    if (slot.strategy === 'sequence') {
      slot._cursor = ((slot._cursor || 0) + 1) % pool.length
      return pool[slot._cursor]
    }
    if (slot.strategy === 'all') return pool
    return pool[Math.floor(Math.random() * pool.length)]
  }

  // 交付时自愈的流水账（随心跳上报，diag 里能看出「前端替谁补过配置」）
  var soundRepairs = []

  // 默认素材池：内置 MP3（和 Host 侧自愈用的是同一批口径）
  function soundPoolForTrigger() {
    try {
      var pool = []
      var list = Array.isArray(sounds) ? sounds : []
      for (var i = 0; i < list.length; i++) {
        var one = list[i]
        if (!one || !one.id || one.builtin !== true) continue
        if (!/\.mp3$|audio\/mpeg/.test(String(one.file || '') + String(one.mime || ''))) continue
        pool.push(one.id)
      }
      if (pool.length === 0) pool = ['builtin:hiss']
      return pool
    } catch (err) {
      return ['builtin:hiss']
    }
  }

  // 「通知弹出来了、可是没声音」的现场：`提醒` 里声音是开着的，却没有任何
  // 「已启用且勾了素材」的槽位绑在这个触发器上（槽位被关掉 / 素材池空了）。
  // 这里当场修好再播 —— 不修的话就只有弹窗、永远没声音。
  function ensureSoundSlot(trigger) {
    try {
      var audioCfg = state.audio || (state.audio = {})
      var slots = audioCfg.slots || (audioCfg.slots = [])
      var pool = soundPoolForTrigger()
      var candidates = []
      var i
      for (i = 0; i < slots.length; i++) {
        var s0 = slots[i]
        if (s0 && String(s0.trigger || '') === String(trigger)) candidates.push(s0)
      }
      var action = ''
      var target = null
      if (candidates.length > 0) {
        // 优先挑「已经配了素材」的那个（通常是用户自己配的那条），把它启用
        for (i = 0; i < candidates.length; i++) {
          var c = candidates[i]
          if (Array.isArray(c.sounds) && c.sounds.length > 0) {
            target = c
            break
          }
        }
        if (!target) target = candidates[0]
        if (!Array.isArray(target.sounds) || target.sounds.length === 0) {
          target.sounds = pool.slice()
          action = '补默认素材'
        }
        if (target.enabled === false) {
          target.enabled = true
          action = action ? action + '并启用' : '启用槽位'
        }
      } else {
        var id = 'slot-heal-' + String(trigger).replace(/[^a-z0-9]/gi, '-')
        target = {
          id: id,
          name: trigger === 'turn.end' ? '任务完成音（自动补）' : trigger === 'alarm.fire' ? '闹钟音（自动补）' : String(trigger) + '（自动补）',
          trigger: trigger,
          sounds: pool.slice(),
          strategy: 'random',
          loop: trigger === 'alarm.fire',
          cooldownMs: Number(audioCfg.cooldownMs) || 0,
          enabled: true,
        }
        slots.push(target)
        action = '新建默认槽位'
      }
      if (!action) return slotFor(trigger)
      soundRepairs.push({ at: Date.now(), trigger: String(trigger), slot: String(target.id || ''), action: action })
      if (soundRepairs.length > 10) soundRepairs = soundRepairs.slice(-10)
      // 立刻告诉 Host，别让它下一次广播把旧配置推回来
      persist()
      return slotFor(trigger)
    } catch (err) {
      return null
    }
  }

  function fireTrigger(trigger, opts) {
    opts = opts || {}
    var slot = slotFor(trigger)
    // 交付方明确要求「该有声音」（提醒里声音是开着的），却没有可用槽位 → 当场自愈
    if (!slot && opts.intent === true) slot = ensureSoundSlot(trigger)
    if (!slot) return false
    var picked = pickSound(slot)
    if (!picked) return false
    var list = Array.isArray(picked) ? picked : [picked]
    for (var i = 0; i < list.length; i++) {
      playSound(list[i], {
        tag: trigger === 'turn.end' || trigger === 'alarm.fire' ? TAG.notify : TAG.click,
        loop: slot.loop === true,
        cooldownMs: Number(slot.cooldownMs) || 0,
        trigger: trigger,
        volume: clamp((state.audio && state.audio.volume !== undefined ? state.audio.volume : 0.9) * (opts.gain || 1), 0, 1),
      })
    }
    return true
  }

  // 槽位试听：可暂停（同一个槽位再点一次就是停）
  function startSlotPreview(slot) {
    var trigger = slot.trigger
    return togglePreview('slot:' + (slot.id || trigger), function () {
      fireTrigger(trigger, {})
      return function () {
        try {
          stopAllAudio(TAG.notify)
          stopAllAudio(TAG.click)
        } catch (err) {
          /* 忽略 */
        }
      }
    })
  }

  // 素材试听：可暂停（用 <audio> 句柄，单条停止）
  function startSoundPreview(sound) {
    return togglePreview('sound:' + sound.id, function () {
      var entry = playSound(sound.id, { tag: 'preview', trigger: 'preview', volume: sound ? (state.audio && state.audio.volume) : 0.9 })
      if (!entry) {
        return function () {}
      }
      // 播完自动收尾，避免按钮停在「停止试听」
      try {
        entry.node.addEventListener('ended', function () {
          if (previewIs('sound:' + sound.id)) stopPreview()
        })
      } catch (err) {
        /* 忽略 */
      }
      return function () {
        try {
          entry.stop()
          audio.active = audio.active.filter(function (x) {
            return x !== entry
          })
        } catch (err) {
          /* 忽略 */
        }
      }
    })
  }

  // ------------------------------------------------------------ 粒子爆炸
  var fxCanvas = null
  var fxCtx = null
  var fxParticles = []
  var fxRaf = 0

  function ensureFx() {
    if (fxCanvas) return
    fxCanvas = el('canvas', 'md-fx')
    css(fxCanvas, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: String(Z + 40),
    })
    document.body.appendChild(fxCanvas)
    fxCtx = fxCanvas.getContext('2d')
    resizeFx()
    window.addEventListener('resize', resizeFx)
  }
  function resizeFx() {
    if (!fxCanvas) return
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    fxCanvas.width = Math.floor(window.innerWidth * dpr)
    fxCanvas.height = Math.floor(window.innerHeight * dpr)
    if (fxCtx) fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  function explode(x, y, count) {
    var cfg = (state && state.look) || {}
    if (cfg.particles === false) return
    ensureFx()
    var n = clamp(count || cfg.particleCount || 26, 4, 120)
    for (var i = 0; i < n; i++) {
      var angle = (Math.PI * 2 * i) / n + Math.random() * 0.5
      var speed = 2 + Math.random() * 5
      fxParticles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.2,
        life: 1,
        decay: 0.014 + Math.random() * 0.02,
        size: 2 + Math.random() * 4,
        hue: 18 + Math.random() * 32,
      })
    }
    // 星芒
    fxParticles.push({ x: x, y: y, vx: 0, vy: 0, life: 1, decay: 0.05, size: 26, hue: 40, star: true })
    if (!fxRaf) fxRaf = requestAnimationFrame(fxTick)
  }
  function fxTick() {
    fxRaf = 0
    if (!fxCtx || !fxCanvas) return
    fxCtx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    var alive = []
    for (var i = 0; i < fxParticles.length; i++) {
      var p = fxParticles[i]
      p.life -= p.decay
      if (p.life <= 0) continue
      p.x += p.vx
      p.y += p.vy
      p.vy += 0.14
      p.vx *= 0.985
      fxCtx.globalAlpha = Math.max(0, p.life)
      if (p.star) {
        var r = p.size * (1.2 - p.life)
        var g = fxCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, r))
        g.addColorStop(0, 'rgba(255,240,200,.95)')
        g.addColorStop(0.4, 'rgba(255,190,90,.55)')
        g.addColorStop(1, 'rgba(255,150,40,0)')
        fxCtx.fillStyle = g
        fxCtx.beginPath()
        fxCtx.arc(p.x, p.y, Math.max(1, r), 0, Math.PI * 2)
        fxCtx.fill()
      } else {
        fxCtx.fillStyle = 'hsl(' + p.hue + ',95%,' + (55 + 20 * p.life) + '%)'
        fxCtx.beginPath()
        fxCtx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2)
        fxCtx.fill()
      }
      alive.push(p)
    }
    fxCtx.globalAlpha = 1
    fxParticles = alive
    if (fxParticles.length > 0) fxRaf = requestAnimationFrame(fxTick)
    else if (fxCtx) fxCtx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  }

  // ------------------------------------------------------------ 猫
  var cat = {
    root: null,
    img: null,
    bubble: null,
    handle: null,
    dragging: false,
    resizing: false,
    dragMoved: false,
    downAt: 0,
    downPos: null,
    pose: 'idle',
    poseTimer: 0,
    clicks: 0,
    clickTimer: 0,
    shakeTimer: 0,
  }

  // 预计算的图片对齐参数（按 alpha 包围盒）
  // 说明：idle 的 bbox 就是规范画布；hiss 缩放并平移，使其 bbox 的底边中点与 idle 重合
  // 规范画布 = idle 的 alpha 包围盒（1051 x 1853），场景蓝本。
  // 容器宽度 = 220 * scale（= idle 图的画布宽 1248 的等效缩放）。
  // 每张图按同一个"每像素容器宽"渲染：
  //   wPx = catW * bboxW / 1248
  //   水平：包围盒中心对准容器中心
  //   垂直：包围盒底边对准蓝本底边，bbox 高度差的一半作为补偿
  // 两张图的宽高比不同（0.567 vs 0.632），所以按宽度贴合、高度差补偿，
  // 切换姿态时既不会缩放跳变，也不会上下错位。
  var CANVAS_W = 1248
  var CANVAS_H = 2048
  var MODEL_W = 1051
  var MODEL_H = 1853
  var POSE_SRC = {
    idle: { file: 'builtin:idle', bboxW: 1051, bboxH: 1853 },
    hiss: { file: 'builtin:hiss', bboxW: 1015, bboxH: 1607 },
  }
  // POSE_GEOM 的像素值在 applyAppearance 里按当前 catW 计算（避免 CSS calc 里单位混算）
  var POSE_GEOM = {
    idle: { file: 'builtin:idle', cls: 'md-cat-img', s: 1, wpx: 0, dy: 0 },
    hiss: { file: 'builtin:hiss', cls: 'md-cat-img', s: 1, wpx: 0, dy: 0 },
  }
  function recomputeGeom(catW) {
    for (var key in POSE_SRC) {
      var src = POSE_SRC[key]
      var s = MODEL_W / src.bboxW
      var wpx = (catW * src.bboxW) / CANVAS_W
      // 容器基准高度 = 画布高宽比 * 容器宽；补偿 = (图高*s - 蓝本高) / 2，换算到容器像素
      var dy = ((src.bboxH * s - MODEL_H) / 2) * (catW / CANVAS_W)
      POSE_GEOM[key] = { file: src.file, cls: 'md-cat-img', s: s, wpx: wpx, dy: dy }
    }
  }

  // ------------------------------------------------------------ 外观图（内置 + 自己上传）
  // 场景蓝本 = 「常态」那张图的 canvas 宽 + alpha 包围盒；每张姿态图按同一个
  // "每像素容器宽" 渲染，包围盒水平居中、底边对齐 —— 换图不会跳。
  // 自己上传的图用 canvas 现场算一次 alpha 包围盒，并回写给 Host 缓存。
  var IMAGE_FALLBACK_META = { canvasW: 1248, canvasH: 2048, bboxX: 0, bboxY: 0, bboxW: 1248, bboxH: 2048 }

  function imageById(id) {
    for (var i = 0; i < images.length; i++) {
      if (images[i] && images[i].id === id) return images[i]
    }
    return null
  }

  function imageMeta(id) {
    var im = imageById(id)
    var m = im && im.meta
    if (m && m.canvasW > 0 && m.canvasH > 0 && m.bboxW > 0 && m.bboxH > 0) return m
    return IMAGE_FALLBACK_META
  }

  function poseImageId(pose) {
    var poses = (state && state.appearance && state.appearance.poses) || {}
    var id = poses[pose]
    if (id && imageById(id)) return id
    return pose === 'hiss' ? 'builtin:hiss' : 'builtin:idle'
  }

  function applyPoseConfig() {
    var idleMeta = imageMeta(poseImageId('idle'))
    CANVAS_W = idleMeta.canvasW || 1248
    MODEL_W = idleMeta.bboxW || 1248
    MODEL_H = idleMeta.bboxH || 2048
    var keys = ['idle', 'hiss']
    for (var i = 0; i < keys.length; i++) {
      var p = keys[i]
      var id = poseImageId(p)
      var m = imageMeta(id)
      POSE_SRC[p] = { file: id, bboxW: m.bboxW || CANVAS_W, bboxH: m.bboxH || CANVAS_W }
    }
  }

  // 现场算 alpha 包围盒（同一源可以用 canvas 读像素，算不出来就退回整张画布）
  function computeAlphaMeta(imgEl, cb) {
    try {
      var w = imgEl.naturalWidth || imgEl.width
      var h = imgEl.naturalHeight || imgEl.height
      if (!w || !h) {
        cb(null)
        return
      }
      var c = document.createElement('canvas')
      c.width = w
      c.height = h
      var g = c.getContext('2d')
      if (!g) {
        cb({ canvasW: w, canvasH: h, bboxX: 0, bboxY: 0, bboxW: w, bboxH: h })
        return
      }
      g.clearRect(0, 0, w, h)
      g.drawImage(imgEl, 0, 0)
      var data = g.getImageData(0, 0, w, h).data
      var minX = w
      var minY = h
      var maxX = -1
      var maxY = -1
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX < 0) {
        cb({ canvasW: w, canvasH: h, bboxX: 0, bboxY: 0, bboxW: w, bboxH: h })
        return
      }
      cb({ canvasW: w, canvasH: h, bboxX: minX, bboxY: minY, bboxW: maxX - minX + 1, bboxH: maxY - minY + 1 })
    } catch (err) {
      cb(null)
    }
  }

  // 给还没算过包围盒的自定义图补一遍（打开设置页时跑）
  function ensureAllImageMeta(after) {
    var pending = images.filter(function (im) {
      return im && !im.builtin && !(im.meta && im.meta.bboxW > 0)
    })
    if (pending.length === 0) {
      if (after) after(false)
      return
    }
    var changed = false
    var left = pending.length
    pending.forEach(function (im) {
      var probe = new Image()
      probe.onload = function () {
        computeAlphaMeta(probe, function (meta) {
          if (meta) {
            im.meta = meta
            changed = true
            json(api('/image-meta.json'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: im.id, meta: meta }),
            }).catch(function () {})
          }
          left -= 1
          if (left === 0 && after) after(changed)
        })
      }
      probe.onerror = function () {
        left -= 1
        if (left === 0 && after) after(changed)
      }
      probe.src = api('/image?id=') + encodeURIComponent(im.id)
    })
  }

  function refreshPoseImage() {
    if (!cat.img || !cat.root) return
    var name = cat.pose || 'idle'
    var geom = POSE_GEOM[name] || POSE_GEOM.idle
    var id = geom.file
    if (cat.imgPoseId !== id) {
      cat.imgPoseId = id
      cat.img.src = api('/image?id=') + encodeURIComponent(id)
    }
    positionCatImg()
  }

  function sessionOf() {
    return (status && status.session) || (boot && boot.session) || null
  }

  function fmtSessionLine(s) {
    if (!s) return '等待会话数据'
    if (s.cost === null || s.cost === undefined) return '等待首次余额观测（' + fmtTokens(s.tokens) + ' tokens）'
    return '¥ ' + fmtMoney(s.cost) + ' · ' + fmtTokens(s.tokens) + ' tokens · ' + s.turns + ' 轮'
  }

  function soundWarningsLocal() {
    var out = []
    var slots = (state && state.audio && state.audio.slots) || []
    for (var i = 0; i < slots.length; i++) {
      var sl = slots[i]
      if (!sl) continue
      var label = sl.name || sl.id || '(未命名槽位)'
      if (sl.enabled === false) out.push('槽位「' + label + '」没勾「启用」→ 触发器 ' + sl.trigger + ' 不会出声')
      else if (!sl.sounds || sl.sounds.length === 0) out.push('槽位「' + label + '」一个素材都没勾 → 触发器 ' + sl.trigger + ' 不会出声')
    }
    var te = state && state.notify && state.notify.turnEnd
    if (te && te.enabled === false) out.push('「任务完成提醒」总开关关着 → 不会有任何提醒')
    if (te && te.sound === false) out.push('「任务完成提醒」里的声音开关关着')
    var hasPool = function (t) {
      return slots.some(function (x) {
        return x && x.enabled !== false && x.trigger === t && x.sounds && x.sounds.length > 0
      })
    }
    if (!hasPool('turn.end')) out.push('没有任何可用槽位绑定 turn.end → 任务完成不会出声（点下面的按钮一键修好）')
    if (!hasPool('alarm.fire')) out.push('没有任何可用槽位绑定 alarm.fire → 闹钟不会出声（点下面的按钮一键修好）')
    if (audio.lastResult && audio.lastResult.ok === false && audio.lastResult.trigger) {
      out.push('上次播放「' + audio.lastResult.id + '」失败：' + audio.lastResult.error)
    }
    return out
  }

  // ------------------------------------------------------------ 闹钟排程（本地时间，前端自己算）
  // 为什么在前端算：改完时间要**立刻**反映，不能等 Host 的 30s 状态轮询；
  // 而且「下次 xx 小时 yy 分后」要每秒自己走。口径与 Host 的 alarmSchedule 一致：
  // 本地时间、每天/一次性、可选星期，最多往后看 8 天。
  function fmtCountdown(ms) {
    var total = Math.max(0, Math.floor(ms / 1000))
    var d = Math.floor(total / 86400)
    var h = Math.floor((total % 86400) / 3600)
    var mi = Math.floor((total % 3600) / 60)
    var se = total % 60
    if (d > 0) return d + ' 天 ' + h + ' 小时 ' + mi + ' 分'
    if (h > 0) return h + ' 小时 ' + mi + ' 分 ' + se + ' 秒'
    if (mi > 0) return mi + ' 分 ' + se + ' 秒'
    return se + ' 秒'
  }

  function localNextFire(al, nowMs) {
    if (!al || al.enabled === false) return null
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(al.time || ''))
    if (!m) return null
    var hh = Number(m[1])
    var mm = Number(m[2])
    var now = nowMs || Date.now()
    // 「就在这一分钟」也算还没到：闹钟是按分钟匹配的（Host 每 20s 巡检一次），
    // 刚设好时间时秒数已经走了一点，若按毫秒比较就会显示成明天 ——
    // 看起来就像「设了个时间它直接跨过去了」。
    var nowMinute = new Date(now)
    nowMinute.setSeconds(0, 0)
    var nowMinuteMs = nowMinute.getTime()
    for (var d = 0; d <= 8; d++) {
      var t = new Date(now + d * 86400000)
      t.setHours(hh, mm, 0, 0)
      var ms = t.getTime()
      if (ms < nowMinuteMs) continue
      if (al.mode === 'once' && al.date) {
        var pad = function (n) {
          return String(n).padStart(2, '0')
        }
        if (t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) !== al.date) continue
      }
      if (al.mode === 'daily' && Array.isArray(al.weekdays) && al.weekdays.length > 0) {
        if (al.weekdays.indexOf(t.getDay()) === -1) continue
      }
      return ms
    }
    return null
  }

  function alarmNextText(al, nowMs) {
    var now = nowMs || Date.now()
    if (!al) return ''
    if (al.enabled === false) return '⏸ 已停用：勾上「启用」才会响'
    var next = localNextFire(al, now)
    if (next === null) return '8 天内不会触发（检查时间 / 日期 / 星期）'
    var at = new Date(next)
    var hhmm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
    if (next - now <= 60000) return '下次 ' + hhmm + '（就在这一分钟内，Host 每 20 秒巡检一次）'
    return '下次 ' + hhmm + '（' + (at.getMonth() + 1) + '月' + at.getDate() + '日）· 还有 ' + fmtCountdown(next - now)
  }

  // 每秒刷一次所有闹钟的「下次…」文本：只改文字，不重建 DOM，改完时间立刻能看到
  function refreshAlarmTicks() {
    try {
      var nodes = document.querySelectorAll('[data-md-alarm-next]')
      if (nodes.length === 0) return
      var now = Date.now()
      var alarms = state.alarms || []
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var id = node.getAttribute('data-md-alarm-next')
        var found = null
        for (var j = 0; j < alarms.length; j++) {
          if (alarms[j] && String(alarms[j].id) === id) {
            found = alarms[j]
            break
          }
        }
        node.textContent = found ? alarmNextText(found, now) : '闹钟已删除'
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  // ------------------------------------------------------------ 闹钟兜底（前端补一枪）
  // 血坑：Host 侧的 20 秒巡检因为定时器注册失败**从来没跑过**（diag 里 alarmChecks 一直是
  // null），而「立即测试」是直接投递，所以一切看起来正常 —— 到点就是不响。
  // 现在前端自己也盯时钟：到点那一分钟如果还没收到 Host 的 alarm 事件，就请 Host 投一次
  // （POST /maodie/alarm-fire.json）。Host 按「闹钟+分钟」幂等去重，所以两边同时动作也不会重复响。
  // 前端**不自己出声**，只负责把 Host 叫醒，保证只有一条投递链路。
  var MD_ALARM_GRACE_MS =
    typeof window.__MD_ALARM_GRACE_MS === 'number' ? window.__MD_ALARM_GRACE_MS : 25000
  var alarmWatch = { lastCheck: 0, pokes: [], fired: {} }

  function mdPad2(n) {
    return String(n).padStart(2, '0')
  }

  function mdMinuteKey(id, d) {
    return String(id) + '@' + mdPad2(d.getHours()) + ':' + mdPad2(d.getMinutes())
  }

  // Host 的闹钟事件到了 → 这一分钟就不需要兜底了
  function noteAlarmFired(data) {
    try {
      if (!data || data.id === undefined || data.id === null) return
      alarmWatch.fired[mdMinuteKey(data.id, new Date())] = Date.now()
    } catch (err) {
      /* 忽略 */
    }
  }

  function alarmWatchdog() {
    try {
      var alarms = (state && state.alarms) || []
      var d = new Date()
      var hhmm = mdPad2(d.getHours()) + ':' + mdPad2(d.getMinutes())
      // 只保留当前这一分钟的记录，别让它无限增长
      for (var k in alarmWatch.fired) {
        if (k.slice(-5) !== hhmm) delete alarmWatch.fired[k]
      }
      alarmWatch.lastCheck = Date.now()
      if (alarms.length === 0) return
      var elapsed = d.getSeconds() * 1000 + d.getMilliseconds()
      if (elapsed < MD_ALARM_GRACE_MS) return
      for (var i = 0; i < alarms.length; i++) {
        var al = alarms[i]
        if (!al || al.enabled === false) continue
        if (String(al.time || '') !== hhmm) continue
        var key = mdMinuteKey(al.id, d)
        if (alarmWatch.fired[key]) continue
        alarmWatch.fired[key] = Date.now()
        alarmWatch.pokes.push({ id: String(al.id), time: hhmm, at: Date.now() })
        if (alarmWatch.pokes.length > 20) alarmWatch.pokes = alarmWatch.pokes.slice(-20)
        json(api('/alarm-fire.json'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: String(al.id) }),
        }).catch(function () {})
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  // 上传自己的外观图：先在本地算好包围盒，再一次性交给 Host
  function pickImageFile() {
    var input = el('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.addEventListener('change', function () {
      var file = input.files && input.files[0]
      if (!file) return
      var reader = new FileReader()
      reader.onload = function () {
        var dataUrl = String(reader.result || '')
        var probe = new Image()
        probe.onload = function () {
          computeAlphaMeta(probe, function (meta) {
            json(api('/upload-image.json'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                dataUrl: dataUrl,
                name: String(file.name || '自定义外观').replace(/.[^.]+$/, ''),
                pose: 'idle',
                meta: meta,
              }),
            })
              .then(function (r) {
                if (r && r.ok) {
                  if (r.images) images = r.images
                  if (r.state && r.state.appearance) state = deepMerge(state, r.state)
                  applyPoseConfig()
                  applyAppearance()
                  refreshPoseImage()
                  // 异步回调里重建面板也要看用户在不在打字（否则会打断输入）
                  if (isInteracting()) noteInputDiag('look-rebuild-deferred', '上传回调')
                  else renderLookPane()
                } else {
                  alert('上传失败：' + ((r && r.error) || '未知错误'))
                }
              })
              .catch(function (err) {
                alert('上传失败：' + String((err && err.message) || err))
              })
          })
        }
        probe.onerror = function () {
          alert('这张图片读不出来，换一张试试')
        }
        probe.src = dataUrl
      }
      reader.readAsDataURL(file)
    })
    input.click()
  }

  function renderAppearanceSection(pane) {
    pane.appendChild(el('div', 'md-sub-title', '外观图（内置 + 自己上传的）'))
    var poseRow = el('div', 'md-slot-opts')
    var poses = [
      ['idle', '常态'],
      ['hiss', '哈气'],
    ]
    poses.forEach(function (pair) {
      var p = pair[0]
      poseRow.appendChild(el('span', 'md-dim', pair[1]))
      var sel = el('select', 'md-select')
      images.forEach(function (im) {
        var o = el('option', null, (im.name || im.id) + (im.builtin ? '（内置）' : '（我的）'))
        o.value = im.id
        if (poseImageId(p) === im.id) o.selected = true
        sel.appendChild(o)
      })
      sel.addEventListener('change', function () {
        state.appearance.poses = state.appearance.poses || {}
        state.appearance.poses[p] = sel.value
        applyPoseConfig()
        // 只换猫身上的图，不重建面板：下面那张「设为常态/设为哈气」的按钮
        // 不依赖当前选中值，重建反而会把刚选完的下拉换掉
        ensureAllImageMeta(function () {
          applyPoseConfig()
          applyAppearance()
          refreshPoseImage()
        })
        applyAppearance()
        refreshPoseImage()
        persist()
      })
      poseRow.appendChild(sel)
    })
    pane.appendChild(poseRow)
    pane.appendChild(
      row(
        '上传外观图',
        button('＋ 选择图片', 'md-btn-primary', function () {
          pickImageFile()
        }),
        '透明底 PNG 最好；上传后先当作「常态」，可在上面的下拉里改成哈气。插件会按不透明区域的包围盒自动对齐。',
      ),
    )

    var grid = el('div', 'md-img-grid')
    images.forEach(function (im) {
      var card = el('div', 'md-img-card')
      var thumb = el('img', 'md-img-thumb')
      thumb.src = api('/image?id=') + encodeURIComponent(im.id)
      thumb.alt = im.name || im.id
      card.appendChild(thumb)
      card.appendChild(el('div', 'md-img-name', im.name || im.id))
      var m = im.meta
      card.appendChild(el('div', 'md-dim', m ? m.bboxW + '×' + m.bboxH : '尺寸待测量'))
      var btns = el('div', 'md-img-btns')
      btns.appendChild(
        button('设为常态', 'md-btn-mini', function () {
          state.appearance.poses = state.appearance.poses || {}
          state.appearance.poses.idle = im.id
          applyPoseConfig()
          applyAppearance()
          refreshPoseImage()
          persist()
          renderLookPane()
        }),
      )
      btns.appendChild(
        button('设为哈气', 'md-btn-mini', function () {
          state.appearance.poses = state.appearance.poses || {}
          state.appearance.poses.hiss = im.id
          applyPoseConfig()
          applyAppearance()
          refreshPoseImage()
          persist()
          renderLookPane()
        }),
      )
      if (!im.builtin) {
        btns.appendChild(
          button('删除', 'md-btn-mini md-btn-danger', function () {
            json(api('/delete-image.json'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: im.id }),
            })
              .then(function (r) {
                if (r && r.ok) {
                  if (r.images) images = r.images
                  if (r.state && r.state.appearance) state = deepMerge(state, r.state)
                  applyPoseConfig()
                  applyAppearance()
                  refreshPoseImage()
                  renderLookPane()
                }
              })
              .catch(function () {})
          }),
        )
      }
      card.appendChild(btns)
      grid.appendChild(card)
    })
    pane.appendChild(grid)
  }

  function buildCat() {
    var root = el('div', 'md-root')
    root.id = 'md-root'

    var img = el('img', 'md-cat-img')
    img.alt = '耄耋'
    img.draggable = false
    img.src = api('/image?id=') + encodeURIComponent(POSE_GEOM.idle.file)

    var wrap = el('div', 'md-cat')
    wrap.appendChild(img)

    var handle = el('div', 'md-resize')
    handle.title = '拖动缩放（也可在猫身上滚轮缩放）'
    wrap.appendChild(handle)

    var tip = el('div', 'md-tip', '拖动移动 · 滚轮缩放 · 点击哈气 · 右键设置')
    wrap.appendChild(tip)

    root.appendChild(wrap)
    document.body.appendChild(root)

    cat.root = root
    cat.img = img
    cat.wrap = wrap
    cat.handle = handle
    cat.tip = tip

    // 自己上传的图第一次上场：在本地量一次 alpha 包围盒，回写给 Host 缓存
    img.addEventListener('load', function () {
      var id = (POSE_GEOM[cat.pose || 'idle'] || POSE_GEOM.idle).file
      var im = imageById(id)
      if (!im || im.builtin || (im.meta && im.meta.bboxW > 0)) return
      computeAlphaMeta(img, function (meta) {
        if (!meta) return
        im.meta = meta
        applyPoseConfig()
        applyAppearance()
        json(api('/image-meta.json'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, meta: meta }),
        }).catch(function () {})
      })
    })

    applyPoseConfig()
    applyAppearance()
    bindCatEvents()
  }

  function applyAppearance() {
    if (!cat.root || !state) return
    var a = state.appearance || {}
    var base = clamp(a.baseSize || 220, 80, 900)
    var scale = clamp(a.scale || 1, 0.2, 4)
    var px = base * scale
    // 容器宽度：画布宽度 = px
    cat.root.style.setProperty('--md-cat-w', px + 'px')
    recomputeGeom(px)
    positionCatImg()
    cat.root.style.opacity = String(clamp(a.opacity === undefined ? 1 : a.opacity, 0.15, 1))
    cat.root.setAttribute('data-shadow', a.shadow === false ? 'off' : 'on')
    cat.root.setAttribute('data-pet', a.pet === false ? 'off' : 'on')

    // 位置（归一化 -> 像素）
    var w = window.innerWidth
    var h = window.innerHeight
    var maxX = w - px * 0.5
    var maxY = h - px * 0.5
    var x = a.x === null || a.x === undefined ? Math.max(8, maxX - 30) : clamp(a.x * w, 0, Math.max(0, maxX))
    var y = a.y === null || a.y === undefined ? Math.max(8, maxY - 30) : clamp(a.y * h, 0, Math.max(0, maxY))
    cat.root.style.left = Math.round(x) + 'px'
    cat.root.style.top = Math.round(y) + 'px'

    // 贴左翻转
    if (state.look && state.look.flipAtLeft) {
      var centerX = x + px * 0.5
      cat.root.setAttribute('data-flip', centerX < w / 2 ? 'on' : 'off')
    } else {
      cat.root.setAttribute('data-flip', 'off')
    }
  }

  function savePosition() {
    if (!state || !cat.root) return
    // 直接用自己写入的 left/top：图片在容器里是底部对齐，用 rect 会与写入值不一致
    var w = window.innerWidth
    var h = window.innerHeight
    var left = parseFloat(cat.root.style.left)
    var top = parseFloat(cat.root.style.top)
    if (!isFinite(left) || !isFinite(top)) return
    state.appearance.x = clamp(left / w, 0, 1)
    state.appearance.y = clamp(top / h, 0, 1)
    persist()
  }

  var saveTimer = 0
  // 自己刚保存过 → 随后 2.5s 内到达的 state 广播就是**自己的回显**，直接忽略：
  // 否则每次改一个控件都会把整个设置面板重建一遍。
  var lastSelfSaveAt = 0
  function persist() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () {
      saveTimer = 0
      json(api('/state.json'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: state }),
      })
        .then(function () {
          lastSelfSaveAt = Date.now()
        })
        .catch(function () {
          lastSelfSaveAt = Date.now()
        })
    }, 350)
  }
  function isSelfEcho() {
    return Date.now() - lastSelfSaveAt < 2500
  }

  function setPose(name, holdMs) {
    if (!cat.img) return
    var geom = POSE_GEOM[name] || POSE_GEOM.idle
    if (cat.pose !== name) {
      cat.pose = name
      cat.img.src = api('/image?id=') + encodeURIComponent(geom.file)
      positionCatImg()
    }
    if (cat.poseTimer) clearTimeout(cat.poseTimer)
    cat.poseTimer = setTimeout(function () {
      cat.poseTimer = 0
      setPose('idle', 0)
    }, holdMs || 1400)
  }

  // 按当前几何把图片摆正（像素级，避免 CSS calc 单位混算）
  function positionCatImg() {
    if (!cat.img || !cat.root) return
    var catW = parseFloat(cat.root.style.getPropertyValue('--md-cat-w')) || 220
    var geom = POSE_GEOM[cat.pose] || POSE_GEOM.idle
    cat.img.style.width = Math.round(geom.wpx) + 'px'
    cat.img.style.marginLeft = Math.round(-geom.wpx / 2) + 'px'
    cat.img.style.bottom = Math.round(-geom.dy) + 'px'
  }

  function shakeCat() {
    if (!cat.wrap) return
    if (state && state.look && state.look.tripleShake === false) return
    cat.wrap.classList.remove('md-shake')
    // 强制重排以便动画可重复触发
    void cat.wrap.offsetWidth
    cat.wrap.classList.add('md-shake')
    if (cat.shakeTimer) clearTimeout(cat.shakeTimer)
    cat.shakeTimer = setTimeout(function () {
      cat.wrap.classList.remove('md-shake')
      cat.shakeTimer = 0
    }, 620)
  }

  function bindCatEvents() {
    var root = cat.root

    // —— 拖动 / 点击 判定 ——
    root.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return
      if (e.target === cat.handle) return
      cat.dragging = true
      cat.dragMoved = false
      cat.downAt = Date.now()
      cat.downPos = { x: e.clientX, y: e.clientY }
      cat.offset = (function () {
        var r = root.getBoundingClientRect()
        return { x: e.clientX - r.left, y: e.clientY - r.top }
      })()
      root.classList.add('md-dragging')
      root.setPointerCapture && root.setPointerCapture(e.pointerId)
      e.preventDefault()
    })

    root.addEventListener('pointermove', function (e) {
      if (!cat.dragging) return
      var dx = e.clientX - cat.downPos.x
      var dy = e.clientY - cat.downPos.y
      if (!cat.dragMoved && Math.abs(dx) + Math.abs(dy) > 4) cat.dragMoved = true
      if (!cat.dragMoved) return
      var w = window.innerWidth
      var h = window.innerHeight
      var r = root.getBoundingClientRect()
      var nx = clamp(e.clientX - cat.offset.x, -r.width * 0.35, w - r.width * 0.65)
      var ny = clamp(e.clientY - cat.offset.y, 0, h - r.height * 0.5)
      root.style.left = Math.round(nx) + 'px'
      root.style.top = Math.round(ny) + 'px'
      applyFlipOnly()
    })

    function endDrag(e) {
      if (!cat.dragging) return
      cat.dragging = false
      root.classList.remove('md-dragging')
      try {
        root.releasePointerCapture && root.releasePointerCapture(e.pointerId)
      } catch (err) {
        /* 忽略 */
      }
      if (cat.dragMoved) {
        savePosition()
      } else {
        handleCatTap(e)
      }
    }
    root.addEventListener('pointerup', endDrag)
    root.addEventListener('pointercancel', function () {
      cat.dragging = false
      root.classList.remove('md-dragging')
    })

    // —— 滚轮缩放 ——
    root.addEventListener(
      'wheel',
      function (e) {
        if (e.ctrlKey) return
        e.preventDefault()
        var step = e.deltaY > 0 ? -0.06 : 0.06
        state.appearance.scale = clamp((state.appearance.scale || 1) + step, 0.3, 3.5)
        applyAppearance()
        persist()
      },
      { passive: false },
    )

    // —— 右键 = 设置 ——
    root.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      e.stopPropagation()
      fireTrigger('cat.rightclick')
      openSettings()
    })

    // —— 悬浮 ——
    var hoverAt = 0
    root.addEventListener('pointerenter', function () {
      if (Date.now() - hoverAt < 1500) return
      hoverAt = Date.now()
      fireTrigger('cat.hover')
    })

    // —— 缩放柄 ——
    cat.handle.addEventListener('pointerdown', function (e) {
      e.preventDefault()
      e.stopPropagation()
      cat.resizing = true
      cat.resizeStart = {
        x: e.clientX,
        y: e.clientY,
        scale: state.appearance.scale || 1,
      }
      cat.handle.setPointerCapture && cat.handle.setPointerCapture(e.pointerId)
    })
    cat.handle.addEventListener('pointermove', function (e) {
      if (!cat.resizing) return
      var delta = (e.clientX - cat.resizeStart.x + (e.clientY - cat.resizeStart.y)) / 240
      state.appearance.scale = clamp(cat.resizeStart.scale + delta, 0.3, 3.5)
      applyAppearance()
    })
    cat.handle.addEventListener('pointerup', function (e) {
      if (!cat.resizing) return
      cat.resizing = false
      try {
        cat.handle.releasePointerCapture && cat.handle.releasePointerCapture(e.pointerId)
      } catch (err) {
        /* 忽略 */
      }
      persist()
    })
  }

  function applyFlipOnly() {
    if (!state || !state.look || !state.look.flipAtLeft || !cat.root) return
    var r = cat.root.getBoundingClientRect()
    var center = r.left + r.width * 0.5
    cat.root.setAttribute('data-flip', center < window.innerWidth / 2 ? 'on' : 'off')
  }

  function handleCatTap(e) {
    // 三连击判定
    cat.clicks += 1
    if (cat.clickTimer) clearTimeout(cat.clickTimer)
    if (cat.clicks >= 3) {
      cat.clicks = 0
      cat.clickTimer = 0
      tripleHit(e)
      return
    }
    cat.clickTimer = setTimeout(function () {
      cat.clickTimer = 0
      var count = cat.clicks
      cat.clicks = 0
      // 单击：哈气
      if (count > 0) singleHiss(e)
    }, 380)
  }

  function singleHiss(e) {
    setPose('hiss', 1300)
    fireTrigger('cat.click')
    cat.wrap && cat.wrap.classList.add('md-pop')
    setTimeout(function () {
      cat.wrap && cat.wrap.classList.remove('md-pop')
    }, 260)
    showBubble({ reason: 'tap' })
  }

  function tripleHit(e) {
    // 攻击：只用哈气图 + 摇晃 + 粒子 + 哈气音效
    setPose('hiss', 1500)
    shakeCat()
    fireTrigger('cat.triple')
    explode(e.clientX, e.clientY, (state.look && state.look.particleCount) || 26)
    showBubble({ reason: 'triple' })
  }

  // ------------------------------------------------------------ 气泡
  function bubbleData() {
    var peak = (status && status.peak) || (boot && boot.peak) || null
    var usage = (status && status.usage) || (boot && boot.usage) || null
    var session = (status && status.session) || (boot && boot.session) || null
    return { peak: peak, usage: usage, session: session }
  }

  function showBubble(opts) {
    if (!cat.root) return
    var data = bubbleData()
    closeBubble()
    var node = el('div', 'md-bubble')
    var shape = el('div', 'md-bubble-shape')
    var body = el('div', 'md-bubble-body')

    var title = el('div', 'md-bubble-title')
    if (data.peak) {
      var isPeak = data.peak.kind === 'peak'
      title.appendChild(el('span', 'md-peak-badge ' + (isPeak ? 'md-peak' : 'md-valley'), isPeak ? '⛰️ 高峰' : '🌙 谷价'))
      var sub = el('span', 'md-peak-sub')
      if (data.peak.nextAt) {
        sub.textContent = '距' + (data.peak.nextKind === 'peak' ? '高峰' : '谷价') + ' ' + fmtDuration(data.peak.nextAt - Date.now())
      } else {
        sub.textContent = data.peak.reason || ''
      }
      title.appendChild(sub)
    }
    body.appendChild(title)

    if (data.usage) {
      var rows = el('div', 'md-bubble-rows')
      // —— 本轮（一次指令 → 一次完成）优先：金额 + token，并标出口径 ——
      var turnInfo = (status && status.turn) || null
      var provInfo = (status && status.providers) || null
      var curId = (turnInfo && turnInfo.provider) || (status && status.modelCtx && status.modelCtx.provider) || ''
      var curProv = null
      if (provInfo && Array.isArray(provInfo.providers)) {
        for (var bi = 0; bi < provInfo.providers.length; bi++) {
          if (provInfo.providers[bi] && provInfo.providers[bi].id === curId) {
            curProv = provInfo.providers[bi]
            break
          }
        }
      }
      // 气泡里只留主行，不放小字（口径明细、账户清单都去设置里的「用量」页看）；
      // 「仅供参考」这类诚实标注并到数值后面的括号里，不额外占一行。
      if (turnInfo) {
        var r0 = el('div', 'md-bubble-row')
        r0.appendChild(el('span', 'md-k', '本次消耗'))
        var turnV = '¥ ' + fmtMoney(turnInfo.amount) + ' · ' + fmtTokens(turnInfo.tokens || 0) + ' tokens'
        if (String(turnInfo.amountBasis || '').indexOf('仅供参考') !== -1) turnV += '（仅供参考）'
        r0.appendChild(el('span', 'md-v', turnV))
        rows.appendChild(r0)
      }
      // 今日（当前账户）+ 总消耗（所有账户）
      if (curProv && curProv.today) {
        var rt = el('div', 'md-bubble-row')
        rt.appendChild(el('span', 'md-k', '今日（本账户）'))
        var todayV =
          curProv.today.officialCost !== null && curProv.today.officialCost !== undefined
            ? '¥ ' + fmtMoney(curProv.today.officialCost) + '（官方）'
            : curProv.today.estimateCost
              ? '¥ ' + fmtMoney(curProv.today.estimateCost) + '（仅供参考）'
              : '--'
        rt.appendChild(el('span', 'md-v', todayV))
        rows.appendChild(rt)
      }
      if (provInfo && provInfo.totals) {
        var ra = el('div', 'md-bubble-row')
        ra.appendChild(el('span', 'md-k', '总消耗（全部）'))
        var allV = '¥ ' + fmtMoney(provInfo.totals.todayAmount) + ' · ' + fmtTokens(provInfo.totals.todayTokens || 0)
        var estN = provInfo.totals.estimated ? provInfo.totals.estimated.length : 0
        if (estN > 0) allV += '（部分仅供参考）'
        ra.appendChild(el('span', 'md-v', allV))
        rows.appendChild(ra)
      }
      var r1 = el('div', 'md-bubble-row')
      r1.appendChild(el('span', 'md-k', '余额'))
      var balV = '--'
      if (curProv && curProv.balance) {
        balV = curProv.balance.known ? '¥ ' + fmtMoney(curProv.balance.total) : '余额未知'
      } else if (data.usage.balance !== null && data.usage.balance !== undefined) {
        balV = '¥ ' + fmtMoney(data.usage.balance)
      }
      r1.appendChild(el('span', 'md-v', balV))
      rows.appendChild(r1)
      // （今日 token 总量与口径不再占气泡的行，去设置里看）
      // 会话累计口径不再进气泡（用户要的是「本次消耗」＝这一轮）：
      // 会话数据仍在 status.json / diag / 「用量」页里，想看随时能看。
      body.appendChild(rows)
    }

    var hint = el('div', 'md-bubble-hint', '戳一下关掉（会同时掐断声音）')
    body.appendChild(hint)

    // 额外文字：任务完成/闹钟时显示的自定义文案（醒目不折叠）
    if (opts && opts.extraText) {
      var extra = el('div', 'md-bubble-extra', opts.extraText)
      body.appendChild(extra)
    }

    shape.appendChild(body)
    node.appendChild(shape)
    // 气泡放在猫的左上或右上（按屏幕位置决定）
    var r = cat.root.getBoundingClientRect()
    node.style.left = Math.round(r.left + r.width * 0.5) + 'px'
    node.style.top = Math.round(r.top + r.height * 0.18) + 'px'
    document.body.appendChild(node)
    cat.bubble = node

    requestAnimationFrame(function () {
      node.classList.add('md-open')
    })

    // 点破 = 关掉 + 掐断声音（用户明确要求：不用等它播完）
    node.addEventListener('pointerdown', function (e) {
      e.preventDefault()
      e.stopPropagation()
      popBubble()
    })

    var auto = Number(opts && opts.autoCloseSec) || 0
    if (auto > 0) {
      cat.bubbleTimer = setTimeout(popBubble, auto * 1000)
    }
    if (opts && opts.sticky) cat.bubbleSticky = true
  }

  function popBubble() {
    if (!cat.bubble) return
    var node = cat.bubble
    cat.bubble = null
    if (cat.bubbleTimer) {
      clearTimeout(cat.bubbleTimer)
      cat.bubbleTimer = 0
    }
    // 掐断所有非循环音（完成音、哈气音都算）
    stopAllAudio(TAG.notify)
    stopAllAudio(TAG.click)
    node.classList.remove('md-open')
    node.classList.add('md-pop-out')
    setTimeout(function () {
      try {
        node.remove()
      } catch (err) {
        /* 忽略 */
      }
    }, 240)
  }

  function closeBubble() {
    if (!cat.bubble) return
    try {
      cat.bubble.remove()
    } catch (err) {
      /* 忽略 */
    }
    cat.bubble = null
  }

  // 闹钟冒泡：显示用户自定义的文字（默认「起床」）+ 时刻
  function showAlarmBubble(data) {
    data = data || {}
    var head = data.text || '起床'
    var when = data.time ? ' · ' + data.time : ''
    showBubble({ reason: 'alarm', autoCloseSec: 0, extraText: head + when })
  }

  // ------------------------------------------------------------ 标题闪烁 + 网页通知
  var flash = { timer: 0, original: null }

  function startTitleFlash(text) {
    stopTitleFlash()
    flash.original = document.title
    var on = false
    flash.timer = setInterval(function () {
      on = !on
      document.title = on ? text : flash.original
    }, 900)
    window.addEventListener('focus', stopTitleFlash, { once: true })
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) stopTitleFlash()
    })
  }
  function stopTitleFlash() {
    if (!flash.timer) return
    clearInterval(flash.timer)
    flash.timer = 0
    if (flash.original !== null) document.title = flash.original
  }

  function webNotify(title, body) {
    try {
      if (!('Notification' in window)) return false
      if (Notification.permission !== 'granted') return false
      var n = new Notification(title, { body: body })
      n.onclick = function () {
        try {
          window.focus()
        } catch (err) {
          /* 忽略 */
        }
      }
      return true
    } catch (err) {
      return false
    }
  }

  function requestNotifyPermission() {
    try {
      if (!('Notification' in window)) return Promise.resolve('unsupported')
      return Notification.requestPermission()
    } catch (err) {
      return Promise.resolve('error')
    }
  }

  // ------------------------------------------------------------ 设置窗
  function openSettings(tab) {
    if (settingsWin) {
      // 复用时也把位置清干净：以前拖到屏幕边上的窗口，一打开就自动回到居中
      try {
        settingsWin.win.style.left = ''
        settingsWin.win.style.top = ''
        settingsWin.win.style.margin = ''
        settingsWin.win.style.transform = ''
      } catch (err) {
        /* 忽略 */
      }
      settingsWin.root.style.display = 'flex'
      if (tab) selectTab(tab)
      return
    }
    var root = el('div', 'md-set-mask')
    var win = el('div', 'md-set')
    var head = el('div', 'md-set-head')
    // 标题里带上「前端 / Host」两个版本：一眼就能看出页面跑的是不是磁盘上那一份
    // （踩过的坑：改了代码但页面还跑着旧脚本，看起来就像「越修越坏」）
    var title = el('div', 'md-set-title', '耄耋 · 设置')
    title.setAttribute('data-md-versions', '1')
    title.textContent =
      '耄耋 · 设置（前端 ' + MAODIE_VERSION + ' · Host ' + ((boot && boot.version) || '?') + '）'
    var close = el('button', 'md-set-close', '✕')
    close.type = 'button'
    head.appendChild(title)
    head.appendChild(close)

    var tabsBar = el('div', 'md-set-tabs')
    var content = el('div', 'md-set-content')
    var tabs = [
      { id: 'look', name: '外观' },
      { id: 'audio', name: '声音' },
      { id: 'notify', name: '提醒' },
      { id: 'peak', name: '峰谷' },
      { id: 'usage', name: '用量' },
      { id: 'about', name: '关于' },
    ]
    var panes = {}
    tabs.forEach(function (t) {
      var b = el('button', 'md-set-tab', t.name)
      b.type = 'button'
      b.addEventListener('click', function () {
        selectTab(t.id)
      })
      b.setAttribute('data-tab', t.id)
      tabsBar.appendChild(b)
      var pane = el('div', 'md-set-pane')
      pane.setAttribute('data-pane', t.id)
      panes[t.id] = pane
      content.appendChild(pane)
    })

    win.appendChild(head)
    win.appendChild(tabsBar)
    win.appendChild(content)
    root.appendChild(win)
    document.body.appendChild(root)

    settingsWin = { root: root, win: win, panes: panes, tabsBar: tabsBar, current: '' }

    close.addEventListener('click', function () {
      root.style.display = 'none'
    })
    root.addEventListener('pointerdown', function (e) {
      if (e.target === root) root.style.display = 'none'
    })

    // 设置窗口固定居中、**不可拖动**：拖动会把它停在屏幕边缘/被别的界面盖住
    // （用户反馈「设置卡到那个页面上面了」），而且拖走之后很难再拉回来。
    // 这里清掉可能残留的 inline 位置，保证每次打开都居中。
    win.style.left = ''
    win.style.top = ''
    win.style.margin = ''
    win.style.transform = ''

    renderAllPanes('open-settings')
    selectTab(tab || 'look')
  }

  function selectTab(id) {
    if (!settingsWin) return
    settingsWin.current = id
    var tabs = settingsWin.tabsBar.querySelectorAll('.md-set-tab')
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('md-on', tabs[i].getAttribute('data-tab') === id)
    }
    for (var key in settingsWin.panes) {
      settingsWin.panes[key].style.display = key === id ? 'block' : 'none'
    }
  }

  function renderAllPanes(cause) {
    if (!settingsWin) return
    noteInputDiag('rebuild-all', String(cause || 'unknown'))
    renderLookPane()
    renderAudioPane()
    renderNotifyPane()
    renderPeakPane()
    renderUsagePane()
    renderAboutPane()
  }

  // 通用控件
  function row(label, control, hint) {
    var r = el('div', 'md-row')
    var l = el('label', 'md-row-label', label)
    var c = el('div', 'md-row-ctl')
    if (control) c.appendChild(control)
    r.appendChild(l)
    r.appendChild(c)
    if (hint) {
      var h = el('div', 'md-row-hint', hint)
      r.appendChild(h)
    }
    return r
  }
  function checkbox(checked, onChange) {
    var i = el('input')
    i.type = 'checkbox'
    i.checked = !!checked
    i.addEventListener('change', function () {
      onChange(i.checked)
    })
    return i
  }
  function numberInput(value, opts, onChange) {
    var i = el('input')
    i.type = 'number'
    i.value = String(value)
    if (opts) {
      if (opts.min !== undefined) i.min = String(opts.min)
      if (opts.max !== undefined) i.max = String(opts.max)
      if (opts.step !== undefined) i.step = String(opts.step)
    }
    i.addEventListener('change', function () {
      onChange(Number(i.value))
    })
    return i
  }
  function textInput(value, onChange, placeholder) {
    var i = el('input')
    i.type = 'text'
    i.value = value === undefined || value === null ? '' : String(value)
    if (placeholder) i.placeholder = placeholder
    i.addEventListener('change', function () {
      onChange(i.value)
    })
    return i
  }
  function rangeInput(value, min, max, step, onInput) {
    var i = el('input')
    i.type = 'range'
    i.min = String(min)
    i.max = String(max)
    i.step = String(step)
    i.value = String(value)
    i.addEventListener('input', function () {
      onInput(Number(i.value))
    })
    return i
  }
  function button(label, cls, onClick) {
    var b = el('button', 'md-btn ' + (cls || ''), label)
    b.type = 'button'
    b.addEventListener('click', onClick)
    return b
  }

  // ---------------- 外观 ----------------
  function renderLookPane() {
    var pane = settingsWin.panes.look
    pane.innerHTML = ''
    var a = state.appearance
    var look = state.look

    pane.appendChild(row('大小', rangeInput(a.scale, 0.3, 3.5, 0.05, function (v) {
      a.scale = v
      applyAppearance()
      persist()
    }), '也可以直接在猫身上滚滚轮'))
    pane.appendChild(row('不透明度', rangeInput(a.opacity === undefined ? 1 : a.opacity, 0.2, 1, 0.02, function (v) {
      a.opacity = v
      applyAppearance()
      persist()
    })))
    pane.appendChild(row('投影', checkbox(a.shadow !== false, function (v) {
      a.shadow = v
      applyAppearance()
      persist()
    })))
    pane.appendChild(row('按压缩放回弹', checkbox(a.pet !== false, function (v) {
      a.pet = v
      applyAppearance()
      persist()
    })))
    pane.appendChild(row('贴左侧时水平翻转', checkbox(look.flipAtLeft !== false, function (v) {
      look.flipAtLeft = v
      applyAppearance()
      persist()
    })))
    pane.appendChild(row('三连击摇晃', checkbox(look.tripleShake !== false, function (v) {
      look.tripleShake = v
      persist()
    })))
    pane.appendChild(row('粒子爆炸', checkbox(look.particles !== false, function (v) {
      look.particles = v
      persist()
    })))
    pane.appendChild(row('粒子数量', numberInput(look.particleCount || 26, { min: 4, max: 120, step: 1 }, function (v) {
      look.particleCount = clamp(v, 4, 120)
      persist()
    })))
    pane.appendChild(row('位置复位', button('回到右下角', '', function () {
      a.x = null
      a.y = null
      applyAppearance()
      persist()
    }), '把猫挪回默认位置'))
    pane.appendChild(row('气泡显示本次消耗', checkbox(look.showSessionCost !== false, function (v) {
      look.showSessionCost = v
      persist()
    }), '「本次消耗」= 当前这个会话从开始到现在的花费（余额差口径）+ 真实 token'))

    renderAppearanceSection(pane)
    // 打开设置页时顺手把自定义图的包围盒补齐
    ensureAllImageMeta(function (changed) {
      if (changed) {
        applyPoseConfig()
        applyAppearance()
        renderLookPane()
      }
    })

    pane.appendChild(row('测试', button('哈气一下', '', function () {
      singleHiss({ clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 })
    })))
  }

  // ---------------- 声音 ----------------
  function renderAudioPane() {
    var pane = settingsWin.panes.audio
    pane.innerHTML = ''
    var au = state.audio

    pane.appendChild(row('总音量', rangeInput(au.volume === undefined ? 0.9 : au.volume, 0, 1, 0.02, function (v) {
      au.volume = v
      persist()
    })))

    // 「为什么没声音」先摆出来：槽位没勾启用 / 素材池是空的都在这里说清楚
    var warns = soundWarningsLocal()
    if (warns.length > 0) {
      var warnBox = el('div', 'md-warn')
      warns.forEach(function (w) {
        warnBox.appendChild(el('div', null, '⚠️ ' + w))
      })
      // 「为什么没声音」里最常见的一种：槽位配了素材但没勾启用 —— 一键修好
      warnBox.appendChild(
        button('一键启用「配了素材但没勾启用」的槽位', 'md-btn-mini', function () {
          var fixed = 0
          ;((state.audio && state.audio.slots) || []).forEach(function (sl) {
            if (sl && sl.enabled === false && sl.sounds && sl.sounds.length > 0) {
              sl.enabled = true
              fixed += 1
            }
          })
          if (state.notify && state.notify.turnEnd && state.notify.turnEnd.enabled === false) {
            state.notify.turnEnd.enabled = true
          }
          persist()
          renderAudioPane()
          if (typeof alert === 'function') {
            alert(fixed > 0 ? '已启用 ' + fixed + ' 个槽位' : '没有需要修复的槽位（看看上面的提示）')
          }
        }),
      )
      pane.appendChild(warnBox)
    }
    pane.appendChild(el('div', 'md-dim', '当前试听：' + (preview.key ? preview.key : '无')))

    var head = el('div', 'md-sub-head')
    head.appendChild(el('div', 'md-sub-title', '声音槽位'))
    head.appendChild(button('停止全部试听', '', function () {
      stopPreview()
      stopAllAudio(TAG.notify)
      stopAllAudio(TAG.click)
      stopAllAudio('preview')
    }))
    head.appendChild(button('＋ 新增槽位', 'md-btn-primary', function () {
      au.slots = au.slots || []
      au.slots.push({
        id: uid('slot'),
        name: '新槽位',
        trigger: 'turn.end',
        sounds: [],
        strategy: 'random',
        loop: false,
        cooldownMs: 500,
        enabled: true,
      })
      persist()
      renderAudioPane()
    }))
    pane.appendChild(head)

    var list = el('div', 'md-slot-list')
    ;(au.slots || []).forEach(function (slot, index) {
      list.appendChild(slotCard(slot, index))
    })
    pane.appendChild(list)

    var libHead = el('div', 'md-sub-head')
    libHead.appendChild(el('div', 'md-sub-title', '素材库'))
    libHead.appendChild(button('＋ 上传音频', 'md-btn-primary', function () {
      pickAndCrop(null)
    }))
    pane.appendChild(libHead)

    var lib = el('div', 'md-lib')
    sounds.forEach(function (s) {
      var item = el('div', 'md-lib-item')
      item.appendChild(el('span', 'md-lib-name', s.name))
      if (s.builtin) item.appendChild(el('span', 'md-tag', '内置'))
      if (s.note) item.appendChild(el('span', 'md-lib-note', s.note))
      var sndPreview = previewButton('sound:' + s.id, '试听', '停止试听')
      sndPreview.addEventListener('click', function () {
        startSoundPreview(s)
      })
      item.appendChild(sndPreview)
      item.appendChild(button('裁剪', 'md-btn-mini', function () {
        openCropper(s.id, s.name)
      }))
      if (!s.builtin) {
        item.appendChild(button('删除', 'md-btn-mini md-btn-danger', function () {
          json(api('/delete-sound.json'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: s.id }),
          })
            .then(function (r) {
              if (r && r.sounds) sounds = r.sounds
              renderAudioPane()
            })
            .catch(function () {})
        }))
      }
      lib.appendChild(item)
    })
    pane.appendChild(lib)
  }

  function slotCard(slot, index) {
    var card = el('div', 'md-slot')
    var top = el('div', 'md-slot-top')

    top.appendChild(textInput(slot.name, function (v) {
      slot.name = v || '未命名'
      persist()
    }, '槽位名'))

    var trig = el('select', 'md-select')
    triggers.forEach(function (t) {
      var o = el('option', null, t.name)
      o.value = t.id
      if (t.id === slot.trigger) o.selected = true
      trig.appendChild(o)
    })
    trig.addEventListener('change', function () {
      slot.trigger = trig.value
      persist()
    })
    top.appendChild(trig)

    top.appendChild(checkbox(slot.enabled !== false, function (v) {
      slot.enabled = v
      persist()
    }))
    top.appendChild(el('span', 'md-dim', '启用'))

    top.appendChild(button('删除槽位', 'md-btn-mini md-btn-danger', function () {
      state.audio.slots.splice(index, 1)
      persist()
      renderAudioPane()
    }))
    card.appendChild(top)

    var opts = el('div', 'md-slot-opts')
    var strat = el('select', 'md-select')
    ;[
      ['random', '随机抽一个'],
      ['sequence', '顺序轮播'],
      ['all', '全部一起播'],
    ].forEach(function (pair) {
      var o = el('option', null, pair[1])
      o.value = pair[0]
      if ((slot.strategy || 'random') === pair[0]) o.selected = true
      strat.appendChild(o)
    })
    strat.addEventListener('change', function () {
      slot.strategy = strat.value
      persist()
    })
    opts.appendChild(el('span', 'md-dim', '播放'))
    opts.appendChild(strat)
    opts.appendChild(el('span', 'md-dim', '冷却(ms)'))
    opts.appendChild(numberInput(slot.cooldownMs || 0, { min: 0, max: 60000, step: 100 }, function (v) {
      slot.cooldownMs = clamp(v, 0, 60000)
      persist()
    }))
    opts.appendChild(checkbox(slot.loop === true, function (v) {
      slot.loop = v
      persist()
    }))
    opts.appendChild(el('span', 'md-dim', '循环'))
    var slotPreview = previewButton('slot:' + (slot.id || slot.trigger), '试听槽位', '停止试听')
    slotPreview.addEventListener('click', function () {
      startSlotPreview(slot)
    })
    opts.appendChild(slotPreview)
    card.appendChild(opts)

    var pool = el('div', 'md-slot-pool')
    pool.appendChild(el('div', 'md-dim', '素材池（勾选的会被随机/轮播）'))
    var grid = el('div', 'md-pool-grid')
    sounds.forEach(function (s) {
      var lab = el('label', 'md-pool-item')
      var checked = (slot.sounds || []).indexOf(s.id) !== -1
      var cb = checkbox(checked, function (v) {
        slot.sounds = slot.sounds || []
        if (v) {
          if (slot.sounds.indexOf(s.id) === -1) slot.sounds.push(s.id)
        } else {
          slot.sounds = slot.sounds.filter(function (x) {
            return x !== s.id
          })
        }
        persist()
      })
      lab.appendChild(cb)
      lab.appendChild(el('span', null, s.name))
      grid.appendChild(lab)
    })
    pool.appendChild(grid)
    pool.appendChild(button('＋ 上传并加入本槽位', 'md-btn-mini', function () {
      pickAndCrop(slot)
    }))
    card.appendChild(pool)
    return card
  }

  // ---------------- 提醒 ----------------
  function renderNotifyPane() {
    var pane = settingsWin.panes.notify
    pane.innerHTML = ''
    var n = state.notify.turnEnd

    pane.appendChild(row('任务完成提醒', checkbox(n.enabled !== false, function (v) {
      n.enabled = v
      persist()
    })))
    pane.appendChild(row('原生窗口闪烁（任务栏 / 还原前台）', checkbox(n.native !== false, function (v) {
      n.native = v
      persist()
    }), '需要 Electron 主进程可用；不可用时自动降级，不影响其它提醒'))
    pane.appendChild(row('系统通知', checkbox(n.systemNotification !== false, function (v) {
      n.systemNotification = v
      persist()
    })))
    pane.appendChild(row('标签页标题闪烁', checkbox(n.titleFlash !== false, function (v) {
      n.titleFlash = v
      persist()
    })))
    pane.appendChild(row('闪烁文字', textInput(n.flashText, function (v) {
      n.flashText = v
      persist()
    })))
    pane.appendChild(row('播放声音', checkbox(n.sound !== false, function (v) {
      n.sound = v
      persist()
    })))
    pane.appendChild(row('冒气泡', checkbox(n.bubble !== false, function (v) {
      n.bubble = v
      persist()
    })))
    pane.appendChild(row('猫表演一下', checkbox(n.catAct !== false, function (v) {
      n.catAct = v
      persist()
    })))
    pane.appendChild(row('自动关闭（秒，0 = 不自动关）', numberInput(n.autoCloseSec || 0, { min: 0, max: 600, step: 1 }, function (v) {
      n.autoCloseSec = clamp(v, 0, 600)
      persist()
    })))
    pane.appendChild(row('通知正文模板', textInput(n.body, function (v) {
      n.body = v
      persist()
    }), '可用占位符：{turnCost} {turnTokens} {turnModel}（本次消耗）· {today} {balance} {tokens} {peak} {currency} · {session} {sessionTokens} {turns}（本次会话）'))

    var np = el('div', 'md-row-hint')
    np.textContent = '当前通知权限：' + (typeof Notification !== 'undefined' ? Notification.permission : '不支持')
    pane.appendChild(np)
    pane.appendChild(row('启用桌面通知', button('授权并测试', 'md-btn-primary', function () {
      requestNotifyPermission().then(function (p) {
        if (p === 'granted') {
          webNotify('耄耋 · 测试通知', '授权成功，任务完成时会用系统通知提醒你。')
        }
        renderNotifyPane()
      })
    })))

    pane.appendChild(row('原生能力状态', button('检测一次', '', function () {
      json(api('/native.json')).then(function (r) {
        nativeInfo = (r && r.native) || nativeInfo
        renderNotifyPane()
      })
    }), nativeInfo && nativeInfo.electron
      ? '可用（Electron ' + (nativeInfo.window ? '窗口✓' : '窗口✗') + (nativeInfo.notify ? ' 通知✓' : ' 通知✗') + '）'
      : '不可用：' + ((nativeInfo && nativeInfo.reason) || '未检测') + ' → 自动降级为网页通知 + 标题闪烁 + 声音'))

    var bt = el('div', 'md-sub-head')
    bt.appendChild(el('div', 'md-sub-title', '测试'))
    bt.appendChild(button('完整跑一次任务完成提醒', 'md-btn-primary', function () {
      runTurnEndDelivery({
        titleFlash: n.titleFlash,
        flashText: n.flashText,
        sound: n.sound,
        bubble: n.bubble,
        catAct: n.catAct,
        body: '（测试）任务完成提醒',
        autoCloseSec: n.autoCloseSec,
      })
    }))
    pane.appendChild(bt)

    var alertBox = el('div', 'md-sub-head')
    alertBox.appendChild(el('div', 'md-sub-title', '余额预警 / 今日预算'))
    pane.appendChild(alertBox)
    var low = state.notify.balanceLow
    var bud = state.notify.budget
    pane.appendChild(row('余额低于（元）启用', checkbox(low.enabled === true, function (v) {
      low.enabled = v
      persist()
    })))
    pane.appendChild(row('余额阈值', numberInput(low.below || 5, { min: 0, step: 0.5 }, function (v) {
      low.below = v
      persist()
    })))
    pane.appendChild(row('今日预算（元）启用', checkbox(bud.enabled === true, function (v) {
      bud.enabled = v
      persist()
    })))
    pane.appendChild(row('预算阈值', numberInput(bud.amount || 10, { min: 0, step: 0.5 }, function (v) {
      bud.amount = v
      persist()
    })))
  }

  // ---------------- 峰谷 ----------------
  function renderPeakPane() {
    var pane = settingsWin.panes.peak
    pane.innerHTML = ''
    var peak = (status && status.peak) || null

    var now = el('div', 'md-peak-now')
    if (peak) {
      now.appendChild(el('div', 'md-peak-big', peak.kind === 'peak' ? '⛰️ 高峰' : '🌙 谷价'))
      now.appendChild(el('div', 'md-dim', peak.reason || ''))
      if (peak.nextAt) now.appendChild(el('div', 'md-dim', '距切换 ' + fmtDuration(peak.nextAt - Date.now())))
    } else {
      now.appendChild(el('div', 'md-dim', '正在读取…'))
    }
    pane.appendChild(now)

    pane.appendChild(row('规则说明', el('div', 'md-dim', '工作时间 9:00–12:00、14:00–18:00 为高峰；周六周日与法定节假日全天谷价。'), ''))
    pane.appendChild(row('联网自动更新节假日', checkbox(state.peak.online !== false, function (v) {
      state.peak.online = v
      persist()
    }), '数据源为公开节假日接口；失败自动回落到内置表，不影响使用'))
    pane.appendChild(row('立即拉取', button('联网更新', '', function () {
      json(api('/holidays.json?force=1')).then(function (r) {
        alert(
          r && r.ok
            ? '更新完成：' + (r.count || 0) + ' 个节假日日期' + (r.source ? '（来源 ' + r.source + '）' : '')
            : '更新失败，继续使用内置/缓存数据',
        )
        refreshStatus()
      })
    }), (boot && boot.peak && boot.peak.holidaySource) || ''))

    pane.appendChild(el('div', 'md-sub-title', '手动覆盖（优先级最高）'))
    var ov = state.peak.overrides || {}
    var listBox = el('div', 'md-lib')
    Object.keys(ov).forEach(function (date) {
      var item = el('div', 'md-lib-item')
      item.appendChild(el('span', 'md-lib-name', date))
      item.appendChild(el('span', 'md-tag', ov[date] === 'valley' ? '谷价' : '高峰'))
      item.appendChild(button('删除', 'md-btn-mini md-btn-danger', function () {
        delete state.peak.overrides[date]
        persist()
        renderPeakPane()
      }))
      listBox.appendChild(item)
    })
    pane.appendChild(listBox)

    var addRow = el('div', 'md-row')
    var dateInput = el('input')
    dateInput.type = 'date'
    var kindSel = el('select', 'md-select')
    ;[
      ['valley', '谷价'],
      ['peak', '高峰'],
    ].forEach(function (p) {
      var o = el('option', null, p[1])
      o.value = p[0]
      kindSel.appendChild(o)
    })
    addRow.appendChild(dateInput)
    addRow.appendChild(kindSel)
    addRow.appendChild(button('添加', '', function () {
      if (!dateInput.value) return
      state.peak.overrides = state.peak.overrides || {}
      state.peak.overrides[dateInput.value] = kindSel.value
      persist()
      renderPeakPane()
    }))
    pane.appendChild(addRow)

    // 闹钟
    pane.appendChild(el('div', 'md-sub-title', '闹钟（按本机时间；DSH 开着就会响）'))
    var alarmSlotInfo = (state.audio.slots || []).filter(function (sl) {
      return sl && sl.enabled !== false && sl.trigger === 'alarm.fire' && sl.sounds && sl.sounds.length > 0
    })[0]
    var testRow = el('div', 'md-slot-opts')
    testRow.appendChild(
      button('立即测试整条链路', 'md-btn-primary', function () {
        json(api('/alarm-test.json'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) {
            alert(
              r && r.ok
                ? '已投递测试闹钟（seq ' + (r.delivered && r.delivered.seq) + '，SSE 客户端 ' + (r.sseClients || 0) + ' 个）。' +
                  '如果没声音：看设置→声音里的告警提示，或打开 /maodie/diag 看 frontend.report。'
                : '测试失败：' + ((r && r.error) || '未知错误'),
            )
          })
          .catch(function (err) {
            alert('测试失败：' + String((err && err.message) || err))
          })
      }),
    )
    testRow.appendChild(
      el(
        'span',
        'md-dim',
        alarmSlotInfo
          ? '闹钟音来自槽位「' + (alarmSlotInfo.name || alarmSlotInfo.id) + '」（' + alarmSlotInfo.sounds.length + ' 个素材）'
          : '⚠️ 没有任何可用槽位绑定 alarm.fire → 闹钟不会出声',
      ),
    )
    pane.appendChild(testRow)
    var alarms = state.alarms || (state.alarms = [])
    var schedule = (status && status.alarms) || []
    var alarmList = el('div', 'md-lib')
    alarms.forEach(function (al, idx) {
      var item = el('div', 'md-alarm')
      item.appendChild(el('span', 'md-dim', '名称'))
      item.appendChild(textInput(al.name, function (v) {
        al.name = v
        persist()
      }, '闹钟'))
      item.appendChild(el('span', 'md-dim', '时间'))
      var time = el('input')
      time.type = 'time'
      time.value = al.time || '09:00'
      time.addEventListener('change', function () {
        al.time = time.value
        // 停用状态下改时间 = 明确想让它响：直接一起启用。
        // （之前用 confirm() 问一句，结果弹窗被点掉/被面板重建吞掉时就留下
        //   一个「看起来配好了但永远不会响」的闹钟，正是踩过的坑。）
        if (al.enabled === false) {
          al.enabled = true
          try {
            if (enableBox) enableBox.checked = true
            if (noteEl) noteEl.textContent = '已随改时间自动启用'
          } catch (err) {
            /* 忽略 */
          }
        }
        persist()
        // 只刷新「下次…」那行文字，绝不重建整行 ——
        // 时间选择器还开着的时候重建，输入就会直接丢掉
        refreshAlarmTicks()
      })
      item.appendChild(time)
      var mode = el('select', 'md-select')
      ;[
        ['daily', '每天'],
        ['once', '一次性'],
      ].forEach(function (p) {
        var o = el('option', null, p[1])
        o.value = p[0]
        if ((al.mode || 'daily') === p[0]) o.selected = true
        mode.appendChild(o)
      })
      mode.addEventListener('change', function () {
        al.mode = mode.value
        persist()
        refreshAlarmTicks()
        renderPeakPane()
      })
      item.appendChild(mode)
      if (al.mode === 'once') {
        item.appendChild(el('span', 'md-dim', '日期'))
        var date = el('input')
        date.type = 'date'
        date.value = al.date || ''
        date.addEventListener('change', function () {
          al.date = date.value
          persist()
          refreshAlarmTicks()
        })
        item.appendChild(date)
      }
      // 到点时气泡上显示的文字（默认「起床」）
      item.appendChild(el('span', 'md-dim', '提示文字'))
      var txt = el('input')
      txt.type = 'text'
      txt.className = 'md-alarm-text'
      txt.placeholder = '起床'
      txt.value = al.text === undefined || al.text === null ? '起床' : al.text
      txt.addEventListener('change', function () {
        al.text = txt.value
        persist()
      })
      item.appendChild(txt)
      var noteEl = el('span', 'md-dim', '')
      var enableBox = checkbox(al.enabled !== false, function (v) {
        al.enabled = v
        if (noteEl) noteEl.textContent = v ? '已启用' : '已停用：不会响'
        persist()
        refreshAlarmTicks()
      })
      item.appendChild(enableBox)
      item.appendChild(el('span', 'md-dim', '启用'))
      item.appendChild(noteEl)
      // 「下次…」在前端本地算，改完时间立刻反映（Host 的排程只在 /maodie/diag 里做交叉验证）
      var nextLine = el('span', 'md-dim', alarmNextText(al, Date.now()))
      nextLine.setAttribute('data-md-alarm-next', String(al.id))
      item.appendChild(nextLine)
      var alarmPreview = previewButton('slot:alarm.fire:' + (al.id || idx), '试听声音', '停止试听')
      alarmPreview.addEventListener('click', function () {
        togglePreview('slot:alarm.fire:' + (al.id || idx), function () {
          fireTrigger('alarm.fire', {})
          return function () {
            stopAllAudio(TAG.notify)
          }
        })
      })
      item.appendChild(alarmPreview)
      item.appendChild(button('试听气泡', 'md-btn-mini', function () {
        showAlarmBubble({ name: al.name || '闹钟', time: al.time || '', text: al.text || '起床' })
      }))
      item.appendChild(button('删除', 'md-btn-mini md-btn-danger', function () {
        alarms.splice(idx, 1)
        persist()
        renderPeakPane()
      }))
      alarmList.appendChild(item)
    })
    pane.appendChild(alarmList)
    refreshAlarmTicks()
    pane.appendChild(button('＋ 新增闹钟', 'md-btn-primary', function () {
      // 新闹钟默认带上闹钟音槽位的素材，避免"建了但没声音"
      var alarmSlot = (state.audio.slots || []).filter(function (s) {
        return s && s.trigger === 'alarm.fire'
      })[0]
      var times = []
      if (alarmSlot && Array.isArray(alarmSlot.sounds)) times = alarmSlot.sounds.slice()
      // 如果闹钟槽位只有内置 MP3 没勾，兜底给全部内置 MP3
      if (times.length === 0) {
        times = sounds
          .filter(function (s) {
            return s.builtin && /\.mp3$|audio\/mpeg/.test((s.mime || '') + (s.name || ''))
          })
          .map(function (s) {
            return s.id
          })
      }
      alarms.push({
        id: uid('alarm'),
        name: '闹钟',
        time: '09:00',
        mode: 'daily',
        date: '',
        text: '起床',
        sounds: times,
        enabled: true,
      })
      persist()
      renderPeakPane()
    }))
  }

  // ---------------- 关于 ----------------
  // ---------------- 用量（账户分开；余额与今日已用按官方口径，第三方标「仅供参考」）----------------
  function mdClock(ts) {
    try {
      if (!ts) return '未更新'
      var d = new Date(Number(ts))
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    } catch (err) {
      return '未更新'
    }
  }
  function mdMoney(v) {
    try {
      return fmtMoney(Number(v) || 0)
    } catch (err) {
      return String(v)
    }
  }
  function renderUsagePane() {
    var pane = settingsWin.panes.usage
    pane.innerHTML = ''
    var provs = (status && status.providers) || null
    var turn = (status && status.turn) || null
    var ctxInfo = (status && status.modelCtx) || null
    var cur = (turn && turn.provider) || (ctxInfo && ctxInfo.provider) || ''
    var curModel = (turn && turn.model) || (ctxInfo && ctxInfo.model) || ''

    pane.appendChild(el('div', 'md-sub-title', '当前模型'))
    pane.appendChild(el('div', 'md-dim', (cur || '未知') + ' / ' + (curModel || '未知')))

    pane.appendChild(el('div', 'md-sub-title', '总消耗（所有账户加总）'))
    if (provs && provs.totals) {
      var t = provs.totals
      pane.appendChild(row('今日合计', el('span', 'md-v', '¥ ' + mdMoney(t.todayAmount) + ' · ' + fmtTokens(t.todayTokens || 0) + ' tokens')))
      pane.appendChild(row('口径', el('span', 'md-dim', t.note || '')))
    } else {
      pane.appendChild(el('div', 'md-dim', '正在读取…'))
    }

    pane.appendChild(el('div', 'md-sub-title', '各账户'))
    pane.appendChild(el('div', 'md-dim', '余额与「今日已用」优先读官方；没有官方来源的账户余额显示「未知」，金额只按单价估算并标注仅供参考。'))
    var list = (provs && provs.providers) || []
    if (list.length === 0) pane.appendChild(el('div', 'md-dim', '还没读到供应商信息（重启后或等一次心跳）'))
    list.forEach(function (p) {
      var card = el('div', 'md-set-card')
      var head = el('div', 'md-row')
      head.appendChild(el('b', null, p.displayName || p.name || p.id))
      head.appendChild(el('span', 'md-dim', p.id ? '（' + p.id + '）' : ''))
      if (p.available === false) head.appendChild(el('span', 'md-tag', '未配通'))
      card.appendChild(head)
      if (p.configError) card.appendChild(el('div', 'md-dim', '配置问题：' + p.configError))
      var bal = p.balance || {}
      card.appendChild(
        row(
          '余额',
          el(
            'span',
            'md-v',
            bal.known
              ? '¥ ' + mdMoney(bal.total) + '（官方 · ' + mdClock(bal.updatedAt) + '）'
              : '余额未知（该账户没有官方余额来源）',
          ),
        ),
      )
      if (!bal.known && bal.error) card.appendChild(el('div', 'md-dim', bal.error))
      var today = p.today || {}
      var todayText = '—'
      if (today.officialCost !== null && today.officialCost !== undefined) {
        todayText = '¥ ' + mdMoney(today.officialCost) + '（官方读数差）'
      } else if (today.estimateCost) {
        todayText = '¥ ' + mdMoney(today.estimateCost) + '（' + (today.estimateBasis || '仅供参考') + '）'
      }
      card.appendChild(row('今日已用', el('span', 'md-v', todayText)))
      card.appendChild(row('今日 tokens', el('span', 'md-v', fmtTokens(today.tokens || 0))))
      if (p.lastTurn) {
        card.appendChild(
          row('本轮', el('span', 'md-v', '¥ ' + mdMoney(p.lastTurn.amount) + ' · ' + fmtTokens(p.lastTurn.tokens || 0) + ' tokens')),
        )
        card.appendChild(el('div', 'md-dim', (p.lastTurn.model || '') + '　' + (p.lastTurn.amountBasis || '')))
      }
      pane.appendChild(card)
    })

    // —— 单价表（第三方模型用；DeepSeek 内置官方参考价）——
    pane.appendChild(el('div', 'md-sub-title', '单价表（元/百万 token）'))
    pane.appendChild(
      el(
        'div',
        'md-dim',
        '内置 DeepSeek 官方参考价（含峰谷：工作日 9-12、14-18 为峰价，周末全天谷价）。第三方模型请填自定义单价（关键词按模型名子串匹配，长的优先），填了之后金额才按它算，并标注「仅供参考」。',
      ),
    )
    if (!state.pricing) state.pricing = {}
    if (!state.pricing.custom) state.pricing.custom = {}
    var custom = state.pricing.custom
    Object.keys(custom).forEach(function (key) {
      var p0 = custom[key] || {}
      var line = el('div', 'md-row')
      line.appendChild(el('span', 'md-row-label', key))
      var ctl = el('div', 'md-row-ctl')
      var fields = [
        ['hit', '命中'],
        ['miss', '未命中'],
        ['out', '输出'],
      ]
      fields.forEach(function (f) {
        ctl.appendChild(el('span', 'md-dim', f[1]))
        ctl.appendChild(
          numberInput(Number(p0[f[0]]) || 0, { min: 0, step: 0.01 }, function (v) {
            var next = Object.assign({}, custom[key])
            next[f[0]] = v
            custom[key] = next
            persist()
          }),
        )
      })
      ctl.appendChild(el('span', 'md-dim', '币种'))
      var cur = el('select', 'md-select')
      ;['CNY', 'USD'].forEach(function (c) {
        var o = el('option', null, c)
        o.value = c
        if (String(p0.cur || 'CNY').toUpperCase() === c) o.selected = true
        cur.appendChild(o)
      })
      cur.addEventListener('change', function () {
        var next = Object.assign({}, custom[key])
        next.cur = cur.value
        custom[key] = next
        persist()
      })
      ctl.appendChild(cur)
      if (String(p0.cur || 'CNY').toUpperCase() === 'USD') {
        ctl.appendChild(el('span', 'md-dim', '汇率'))
        ctl.appendChild(
          numberInput(Number(p0.rate) || 0, { min: 0, step: 0.01 }, function (v) {
            var next = Object.assign({}, custom[key])
            next.rate = v
            custom[key] = next
            persist()
          }),
        )
      }
      ctl.appendChild(
        button('删除', 'md-btn-mini md-btn-danger', function () {
          delete custom[key]
          persist()
          renderUsagePane()
        }),
      )
      line.appendChild(ctl)
      pane.appendChild(line)
    })

    // 新增一条自定义单价
    var add = el('div', 'md-row')
    add.appendChild(el('span', 'md-row-label', '新增单价'))
    var addCtl = el('div', 'md-row-ctl')
    var keyInput = textInput('', null, '模型名关键词，如 mimo')
    addCtl.appendChild(keyInput)
    var nums = { hit: 0.02, miss: 1, out: 4 }
    ;[
      ['hit', '命中'],
      ['miss', '未命中'],
      ['out', '输出'],
    ].forEach(function (f) {
      addCtl.appendChild(el('span', 'md-dim', f[1]))
      addCtl.appendChild(
        numberInput(nums[f[0]], { min: 0, step: 0.01 }, function (v) {
          nums[f[0]] = v
        }),
      )
    })
    addCtl.appendChild(
      button('添加', '', function () {
        var k = String(keyInput.value || '').trim()
        if (!k) return
        state.pricing.custom[k] = { hit: Number(nums.hit) || 0, miss: Number(nums.miss) || 0, out: Number(nums.out) || 0, cur: 'CNY' }
        persist()
        renderUsagePane()
      }),
    )
    add.appendChild(addCtl)
    pane.appendChild(add)
  }

  function renderAboutPane() {
    var pane = settingsWin.panes.about
    pane.innerHTML = ''
    var box = el('div', 'md-about')
    box.appendChild(el('div', 'md-about-title', '耄耋'))
    box.appendChild(el('div', 'md-dim', '前端 ' + MAODIE_VERSION + ' · Host ' + ((boot && boot.version) || '?')))
    box.appendChild(el('div', 'md-dim', '一个常驻的猫：峰谷价、余额、今日已用与本次消耗、任务完成与闹钟提醒、自定义外观与声音。'))
    box.appendChild(el('div', 'md-dim', '状态目录：' + ((boot && boot.paths && boot.paths.stateDir) || '（由宿主提供）')))
    box.appendChild(el('div', 'md-dim', '素材目录：' + ((boot && boot.paths && boot.paths.assets) || '（由宿主提供）')))
    pane.appendChild(box)

    pane.appendChild(row('检查更新', button('检查', '', function () {
      alert('尚未配置仓库地址。把插件传到 GitHub 后，在 package.json 的 repository 字段填写仓库地址，这里就能检查更新了。')
    }), '仓库地址以后从 package.json 读取，不硬编码'))

    var s = sessionOf()
    var sbox = el('div', 'md-about')
    sbox.appendChild(el('div', 'md-about-title', '本次消耗（当前会话）'))
    sbox.appendChild(el('div', 'md-dim', fmtSessionLine(s)))
    if (s) {
      sbox.appendChild(el('div', 'md-dim', (s.costBasis || '') + (s.startedAt ? ' · 始于 ' + new Date(s.startedAt).toLocaleString() : '')))
      sbox.appendChild(el('div', 'md-dim', '输入 ' + fmtTokens(s.input) + ' · 缓存 ' + fmtTokens(s.cacheRead) + ' · 输出 ' + fmtTokens(s.output)))
      if (s.lastTurnCost !== null && s.lastTurnCost !== undefined) {
        sbox.appendChild(el('div', 'md-dim', '上一轮：¥ ' + fmtMoney(s.lastTurnCost) + ' · ' + fmtTokens(s.lastTurnTokens) + ' tokens'))
      }
    }
    pane.appendChild(sbox)

    var dbox = el('div', 'md-about')
    dbox.appendChild(el('div', 'md-about-title', '声音 / 事件自检'))
    var warns = soundWarningsLocal()
    if (warns.length === 0) dbox.appendChild(el('div', 'md-dim', '声音配置看起来没问题'))
    warns.forEach(function (w) {
      dbox.appendChild(el('div', 'md-dim', '⚠️ ' + w))
    })
    dbox.appendChild(
      el(
        'div',
        'md-dim',
        'SSE：' + evState.sse.state + '（错误 ' + evState.sse.errors + '）· 收件箱轮询 ' + evState.inbox.polls + ' 次（lastSeq ' + evState.lastSeq + '）',
      ),
    )
    dbox.appendChild(
      el(
        'div',
        'md-dim',
        '音频：' + (audio.unlocked ? '已解锁' : '未解锁（没点过页面）') + (audio.lastResult ? ' · 上次播放 ' + (audio.lastResult.ok ? '成功' : '失败 ' + audio.lastResult.error) : ''),
      ),
    )
    pane.appendChild(dbox)

    pane.appendChild(row('诊断页', button('打开 /maodie/diag', '', function () {
      window.open(api('/diag'), '_blank')
    }), 'Host 侧会汇总注入行、前端心跳、声音配置告警、闹钟排程与本次消耗'))

    pane.appendChild(row('重新载入设置', button('从磁盘重载', '', function () {
      location.reload()
    })))
  }

  // ------------------------------------------------------------ 音频裁剪器
  // 设计：波形 + 缩放/平移 + 双边界（拖动条 + 毫秒输入）+ 选区循环试听 +
  //       淡入淡出（可开关、时长可调）+ 音量归一化 + 自动去首尾静音 + 导出 WAV
  function openCropper(soundId, soundName) {
    var src = soundUrl(soundId)
    var mask = el('div', 'md-crop-mask')
    var win = el('div', 'md-crop')
    var head = el('div', 'md-crop-head')
    head.appendChild(el('div', 'md-crop-title', '裁剪音频 · ' + (soundName || '')))
    var closeBtn = el('button', 'md-set-close', '✕')
    closeBtn.type = 'button'
    head.appendChild(closeBtn)
    win.appendChild(head)

    var canvas = el('canvas', 'md-crop-canvas')
    canvas.width = 620
    canvas.height = 190
    win.appendChild(canvas)
    var statusLine = el('div', 'md-crop-status', '正在解码…')
    win.appendChild(statusLine)

    // 双边界
    var dualWrap = el('div', 'md-dual')
    var dualTrack = el('div', 'md-dual-track')
    var dualFill = el('div', 'md-dual-fill')
    var thumbA = el('div', 'md-dual-thumb')
    var thumbB = el('div', 'md-dual-thumb')
    dualWrap.appendChild(dualTrack)
    dualWrap.appendChild(dualFill)
    dualWrap.appendChild(thumbA)
    dualWrap.appendChild(thumbB)
    win.appendChild(dualWrap)

    var numRow = el('div', 'md-crop-nums')
    var startNum = el('input')
    startNum.type = 'number'
    startNum.step = '0.001'
    startNum.min = '0'
    var endNum = el('input')
    endNum.type = 'number'
    endNum.step = '0.001'
    endNum.min = '0'
    numRow.appendChild(el('span', 'md-dim', '起点(秒)'))
    numRow.appendChild(startNum)
    numRow.appendChild(el('span', 'md-dim', '终点(秒)'))
    numRow.appendChild(endNum)
    win.appendChild(numRow)

    // 缩放
    var zoomRow = el('div', 'md-crop-nums')
    var zoom = el('input')
    zoom.type = 'range'
    zoom.min = '1'
    zoom.max = '50'
    zoom.step = '0.5'
    zoom.value = '1'
    var zoomNum = el('input')
    zoomNum.type = 'number'
    zoomNum.min = '1'
    zoomNum.max = '50'
    zoomNum.step = '1'
    zoomNum.value = '1'
    zoomRow.appendChild(el('span', 'md-dim', '缩放'))
    zoomRow.appendChild(zoom)
    zoomRow.appendChild(zoomNum)
    win.appendChild(zoomRow)

    // 选项
    var optRow = el('div', 'md-crop-opts')
    var cfg = state.crop || (state.crop = {})
    var fadeCb = checkbox(cfg.fadeEnabled !== false, function (v) {
      cfg.fadeEnabled = v
      persist()
    })
    var fadeMs = numberInput(cfg.fadeMs || 15, { min: 0, max: 2000, step: 1 }, function (v) {
      cfg.fadeMs = clamp(v, 0, 2000)
      persist()
    })
    var normCb = checkbox(cfg.normalize === true, function (v) {
      cfg.normalize = v
      persist()
    })
    var silenceCb = checkbox(cfg.trimSilence === true, function (v) {
      cfg.trimSilence = v
      persist()
    })
    optRow.appendChild(fadeCb)
    optRow.appendChild(el('span', 'md-dim', '首尾淡入淡出'))
    optRow.appendChild(fadeMs)
    optRow.appendChild(el('span', 'md-dim', 'ms'))
    optRow.appendChild(normCb)
    optRow.appendChild(el('span', 'md-dim', '音量归一化'))
    optRow.appendChild(silenceCb)
    optRow.appendChild(el('span', 'md-dim', '自动去首尾静音'))
    win.appendChild(optRow)

    // 名字 + 按钮
    var nameRow = el('div', 'md-crop-nums')
    var nameInput = el('input')
    nameInput.type = 'text'
    nameInput.placeholder = '片段名称'
    nameInput.value = (soundName || '片段') + '（裁剪）'
    nameRow.appendChild(nameInput)
    win.appendChild(nameRow)

    var btnRow = el('div', 'md-crop-btns')
    var playBtn = button('试听选区（循环）', 'md-btn-primary', function () {})
    var stopBtn = button('停止试听', '', function () {
      stopCropPreview()
      updatePlayBtn()
    })
    var silenceBtn = button('一键去首尾静音', '', function () {})
    var resetBtn = button('重置选区', '', function () {})
    var saveBtn = button('导出并保存 WAV', 'md-btn-primary', function () {})
    btnRow.appendChild(playBtn)
    btnRow.appendChild(stopBtn)
    btnRow.appendChild(silenceBtn)
    btnRow.appendChild(resetBtn)
    btnRow.appendChild(saveBtn)
    win.appendChild(btnRow)

    mask.appendChild(win)
    document.body.appendChild(mask)

    var crop = {
      mask: mask,
      win: win,
      canvas: canvas,
      ctx2d: canvas.getContext('2d'),
      buffer: null,
      ctxAudio: null,
      duration: 0,
      start: 0,
      end: 0,
      zoom: 1,
      offset: 0,
      preview: null,
      drag: null,
      soundId: soundId,
      soundName: soundName,
      status: statusLine,
    }
    activeCrop = crop

    closeBtn.addEventListener('click', closeCropper)
    mask.addEventListener('pointerdown', function (e) {
      if (e.target === mask) closeCropper()
    })

    // 解码
    ;(function decode() {
      var Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) {
        statusLine.textContent = '当前环境不支持音频解码'
        return
      }
      crop.ctxAudio = new Ctx()
      fetch(src)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.arrayBuffer()
        })
        .then(function (buf) {
          return new Promise(function (resolve, reject) {
            var p = crop.ctxAudio.decodeAudioData(buf, resolve, reject)
            if (p && typeof p.then === 'function') p.then(resolve).catch(reject)
          })
        })
        .then(function (audioBuf) {
          crop.buffer = audioBuf
          crop.duration = audioBuf.duration
          crop.start = 0
          crop.end = audioBuf.duration
          startNum.max = String(audioBuf.duration.toFixed(3))
          endNum.max = String(audioBuf.duration.toFixed(3))
          startNum.value = '0'
          endNum.value = audioBuf.duration.toFixed(3)
          updateCropUI()
        })
        .catch(function (err) {
          statusLine.textContent = '解码失败：' + String((err && err.message) || err)
        })
    })()

    function stopCropPreview() {
      if (crop.preview) {
        try {
          crop.preview.stop()
        } catch (err) {
          /* 忽略 */
        }
        crop.preview = null
      }
      try {
        updatePlayBtn()
      } catch (err) {
        /* 忽略 */
      }
    }

    function rangeOf() {
      var s = clamp(crop.start, 0, crop.duration)
      var e = clamp(crop.end, 0, crop.duration)
      if (e < s) {
        var t = s
        s = e
        e = t
      }
      if (e - s < 0.002) e = Math.min(crop.duration, s + 0.002)
      return { start: s, end: e }
    }

    function updateCropUI() {
      if (!crop.buffer) return
      var r = rangeOf()
      crop.start = r.start
      crop.end = r.end
      startNum.value = r.start.toFixed(3)
      endNum.value = r.end.toFixed(3)
      statusLine.textContent =
        '总长 ' + crop.duration.toFixed(2) + 's · 选区 ' + r.start.toFixed(3) + 's → ' + r.end.toFixed(3) + 's（' + (r.end - r.start).toFixed(3) + 's）· 缩放 x' + crop.zoom.toFixed(1)
      // 拖动条
      var usable = Math.max(1, dualWrap.clientWidth - 8)
      thumbA.style.left = 4 + (crop.duration ? (r.start / crop.duration) * usable : 0) + 'px'
      thumbB.style.left = 4 + (crop.duration ? (r.end / crop.duration) * usable : 0) + 'px'
      dualFill.style.left = thumbA.style.left
      dualFill.style.width = Math.max(0, parseFloat(thumbB.style.left) - parseFloat(thumbA.style.left)) + 'px'
      drawWave()
    }

    function peakBuckets(width) {
      var buf = crop.buffer
      var ch = buf.getChannelData(0)
      var viewStart = crop.offset * buf.length
      var viewSpan = buf.length / crop.zoom
      var step = viewSpan / width
      var out = new Float32Array(width)
      for (var x = 0; x < width; x++) {
        var from = Math.floor(viewStart + x * step)
        var to = Math.min(buf.length, Math.floor(viewStart + (x + 1) * step))
        var peak = 0
        for (var i = from; i < to; i += 1) {
          var v = ch[i] < 0 ? -ch[i] : ch[i]
          if (v > peak) peak = v
        }
        out[x] = peak
      }
      return out
    }

    function drawWave() {
      var g = crop.ctx2d
      var W = crop.canvas.width
      var H = crop.canvas.height
      g.clearRect(0, 0, W, H)
      g.fillStyle = 'rgba(32,49,112,.05)'
      g.fillRect(0, 0, W, H)
      if (!crop.buffer) return
      var peaks = peakBuckets(W)
      var mid = H / 2
      // 选区背景
      var r = rangeOf()
      var viewStartSec = crop.offset * crop.duration
      var viewSpanSec = crop.duration / crop.zoom
      var toX = function (sec) {
        return ((sec - viewStartSec) / viewSpanSec) * W
      }
      var xa = toX(r.start)
      var xb = toX(r.end)
      g.fillStyle = 'rgba(32,49,112,.10)'
      g.fillRect(0, 0, W, H)
      g.fillStyle = 'rgba(255,255,255,.92)'
      g.fillRect(clamp(xa, 0, W), 0, Math.max(0, clamp(xb, 0, W) - clamp(xa, 0, W)), H)
      g.fillStyle = 'rgba(32,49,112,.55)'
      for (var x = 0; x < W; x++) {
        var h = Math.max(1, peaks[x] * (H * 0.44))
        g.fillRect(x, mid - h, 1, h * 2)
      }
      // 选区边界线
      g.fillStyle = '#203170'
      if (xa >= 0 && xa <= W) g.fillRect(Math.round(xa), 0, 2, H)
      if (xb >= 0 && xb <= W) g.fillRect(Math.round(xb) - 2, 0, 2, H)
      // 时间刻度
      g.fillStyle = 'rgba(32,49,112,.5)'
      g.font = '11px system-ui'
      g.fillText(viewStartSec.toFixed(2) + 's', 4, H - 4)
      g.fillText((viewStartSec + viewSpanSec).toFixed(2) + 's', W - 46, H - 4)
    }

    // 画布拖动选区 / 平移
    canvas.addEventListener('pointerdown', function (e) {
      if (!crop.buffer) return
      var r = crop.canvas.getBoundingClientRect()
      var sec = crop.offset * crop.duration + ((e.clientX - r.left) / r.width) * (crop.duration / crop.zoom)
      crop.drag = { mode: e.shiftKey ? 'pan' : 'select', startSec: sec, startX: e.clientX, startOffset: crop.offset }
      if (!e.shiftKey) {
        crop.start = sec
        crop.end = sec
      }
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId)
      updateCropUI()
    })
    canvas.addEventListener('pointermove', function (e) {
      if (!crop.drag) return
      if (crop.drag.mode === 'pan') {
        var dx = e.clientX - crop.drag.startX
        var r0 = crop.canvas.getBoundingClientRect()
        crop.offset = clamp(crop.drag.startOffset - (dx / r0.width) / crop.zoom, 0, Math.max(0, 1 - 1 / crop.zoom))
        updateCropUI()
        return
      }
      var rect = crop.canvas.getBoundingClientRect()
      var sec = crop.offset * crop.duration + ((e.clientX - rect.left) / rect.width) * (crop.duration / crop.zoom)
      sec = clamp(sec, 0, crop.duration)
      if (sec >= crop.drag.startSec) {
        crop.start = crop.drag.startSec
        crop.end = sec
      } else {
        crop.start = sec
        crop.end = crop.drag.startSec
      }
      updateCropUI()
    })
    canvas.addEventListener('pointerup', function (e) {
      crop.drag = null
      try {
        canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId)
      } catch (err) {
        /* 忽略 */
      }
    })
    canvas.addEventListener(
      'wheel',
      function (e) {
        if (!crop.buffer) return
        e.preventDefault()
        var midSec = crop.offset * crop.duration + 0.5 * (crop.duration / crop.zoom)
        var next = clamp(crop.zoom * (e.deltaY > 0 ? 0.88 : 1.14), 1, 50)
        zoom.value = String(next)
        zoomNum.value = String(Math.round(next))
        applyZoom(next, midSec)
      },
      { passive: false },
    )

    function applyZoom(next, anchorSec) {
      if (!crop.buffer) return
      if (anchorSec === undefined) anchorSec = crop.offset * crop.duration + 0.5 * (crop.duration / crop.zoom)
      var midRatio = crop.duration ? (anchorSec - crop.offset * crop.duration) / (crop.duration / crop.zoom) : 0.5
      crop.zoom = clamp(next, 1, 50)
      var span = 1 / crop.zoom
      crop.offset = clamp(anchorSec / crop.duration - midRatio * span, 0, Math.max(0, 1 - span))
      updateCropUI()
    }

    zoom.addEventListener('input', function () {
      applyZoom(Number(zoom.value))
      zoomNum.value = String(Math.round(Number(zoom.value)))
    })
    zoomNum.addEventListener('change', function () {
      zoom.value = String(clamp(Number(zoomNum.value), 1, 50))
      applyZoom(Number(zoom.value))
    })

    // 双边界拖动
    function dualDrag(which, e) {
      if (!crop.buffer) return
      var rect = dualWrap.getBoundingClientRect()
      var ratio = clamp((e.clientX - rect.left - 4) / Math.max(1, rect.width - 8), 0, 1)
      var sec = ratio * crop.duration
      if (which === 'a') crop.start = Math.min(sec, crop.end - 0.002)
      else crop.end = Math.max(sec, crop.start + 0.002)
      updateCropUI()
    }
    thumbA.addEventListener('pointerdown', function (e) {
      e.stopPropagation()
      crop.drag = { mode: 'thumbA' }
      thumbA.setPointerCapture && thumbA.setPointerCapture(e.pointerId)
    })
    thumbB.addEventListener('pointerdown', function (e) {
      e.stopPropagation()
      crop.drag = { mode: 'thumbB' }
      thumbB.setPointerCapture && thumbB.setPointerCapture(e.pointerId)
    })
    thumbA.addEventListener('pointermove', function (e) {
      if (crop.drag && crop.drag.mode === 'thumbA') dualDrag('a', e)
    })
    thumbB.addEventListener('pointermove', function (e) {
      if (crop.drag && crop.drag.mode === 'thumbB') dualDrag('b', e)
    })
    ;[thumbA, thumbB].forEach(function (t) {
      t.addEventListener('pointerup', function (e) {
        crop.drag = null
        try {
          t.releasePointerCapture && t.releasePointerCapture(e.pointerId)
        } catch (err) {
          /* 忽略 */
        }
      })
    })

    startNum.addEventListener('change', function () {
      crop.start = clamp(Number(startNum.value), 0, crop.duration)
      if (crop.start >= crop.end) crop.end = Math.min(crop.duration, crop.start + 0.002)
      stopCropPreview()
      updateCropUI()
    })
    endNum.addEventListener('change', function () {
      crop.end = clamp(Number(endNum.value), 0, crop.duration)
      if (crop.end <= crop.start) crop.start = Math.max(0, crop.end - 0.002)
      stopCropPreview()
      updateCropUI()
    })

    // 循环试听选区：同一个按钮就是开关（再点一次停止）
    function updatePlayBtn() {
      var on = !!crop.preview
      playBtn.textContent = on ? '停止试听（循环）' : '试听选区（循环）'
      stopBtn.disabled = !on
    }
    playBtn.addEventListener('click', function () {
      if (!crop.buffer || !crop.ctxAudio) return
      if (crop.preview) {
        stopCropPreview()
        statusLine.textContent = '已停止试听'
        updatePlayBtn()
        return
      }
      stopPreview(true)
      var r = rangeOf()
      var srcNode = crop.ctxAudio.createBufferSource()
      srcNode.buffer = crop.buffer
      srcNode.loop = true
      srcNode.loopStart = r.start
      srcNode.loopEnd = r.end
      var gain = crop.ctxAudio.createGain()
      gain.gain.value = clamp(state.audio.volume, 0, 1)
      srcNode.connect(gain)
      gain.connect(crop.ctxAudio.destination)
      srcNode.start(0, r.start)
      crop.preview = srcNode
      statusLine.textContent = '正在循环试听选区…（再点一次「停止试听（循环）」结束）'
      updatePlayBtn()
    })

    // 自动去首尾静音
    silenceBtn.addEventListener('click', function () {
      if (!crop.buffer) return
      var ch = crop.buffer.getChannelData(0)
      var n = ch.length
      var threshold = 0.012
      var from = 0
      while (from < n && Math.abs(ch[from]) < threshold) from += 1
      var to = n - 1
      while (to > from && Math.abs(ch[to]) < threshold) to -= 1
      if (to <= from) {
        statusLine.textContent = '没找到明显的有声段落'
        return
      }
      // 留 30ms 余量，避免切掉起音
      var pad = Math.floor(crop.buffer.sampleRate * 0.03)
      crop.start = Math.max(0, (from - pad) / crop.buffer.sampleRate)
      crop.end = Math.min(crop.duration, (to + pad) / crop.buffer.sampleRate)
      updateCropUI()
      statusLine.textContent = '已收紧到有声段落：' + crop.start.toFixed(3) + 's → ' + crop.end.toFixed(3) + 's'
    })

    resetBtn.addEventListener('click', function () {
      crop.start = 0
      crop.end = crop.duration
      crop.zoom = 1
      crop.offset = 0
      zoom.value = '1'
      zoomNum.value = '1'
      updateCropUI()
    })

    saveBtn.addEventListener('click', function () {
      if (!crop.buffer || !crop.ctxAudio) return
      var r = rangeOf()
      var sr = crop.buffer.sampleRate
      var channels = crop.buffer.numberOfChannels
      var from = Math.floor(r.start * sr)
      var len = Math.max(1, Math.floor((r.end - r.start) * sr))
      var slice = crop.ctxAudio.createBuffer(channels, len, sr)
      var fadeSamples = cfg.fadeEnabled === false ? 0 : Math.floor((sr * (cfg.fadeMs || 0)) / 1000)
      var peak = 0
      for (var c = 0; c < channels; c++) {
        var srcData = crop.buffer.getChannelData(c)
        var dstData = slice.getChannelData(c)
        for (var i = 0; i < len; i++) {
          var v = srcData[from + i] || 0
          if (fadeSamples > 0) {
            if (i < fadeSamples) v *= i / fadeSamples
            var tail = len - 1 - i
            if (tail < fadeSamples) v *= tail / fadeSamples
          }
          dstData[i] = v
          var av = v < 0 ? -v : v
          if (av > peak) peak = av
        }
      }
      if (cfg.normalize === true && peak > 0.0001) {
        var gain = Math.min(8, 0.891 / peak)
        for (var c2 = 0; c2 < channels; c2++) {
          var d2 = slice.getChannelData(c2)
          for (var j = 0; j < len; j++) {
            var nv = d2[j] * gain
            d2[j] = nv > 1 ? 1 : nv < -1 ? -1 : nv
          }
        }
      }
      var blob = encodeWav(slice)
      var reader = new FileReader()
      reader.onload = function () {
        json(api('/upload-sound.json'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dataUrl: reader.result,
            name: nameInput.value || '自定义片段',
            cropped: true,
            crop: { start: r.start, end: r.end, fade: cfg.fadeEnabled !== false, fadeMs: cfg.fadeMs, normalize: cfg.normalize === true },
          }),
        })
          .then(function (res) {
            if (res && res.ok) {
              sounds = res.sounds || sounds
              statusLine.textContent = '已保存为 WAV 片段（' + (len / sr).toFixed(2) + 's）'
              stopCropPreview()
              renderAudioPane()
              setTimeout(closeCropper, 500)
            } else {
              statusLine.textContent = '保存失败：' + ((res && res.error) || '未知错误')
            }
          })
          .catch(function (err) {
            statusLine.textContent = '保存失败：' + String((err && err.message) || err)
          })
      }
      reader.readAsDataURL(blob)
    })

    function closeCropper() {
      stopCropPreview()
      try {
        mask.remove()
      } catch (err) {
        /* 忽略 */
      }
      activeCrop = null
    }
    crop.close = closeCropper

    // 初始布局完成后刷新一次（拿到拖动条宽度）
    setTimeout(updateCropUI, 30)
  }

  // 16-bit PCM WAV 编码（手写 RIFF，无第三方库）
  function encodeWav(buffer) {
    var numCh = buffer.numberOfChannels
    var sampleRate = buffer.sampleRate
    var len = buffer.length
    var bytesPerSample = 2
    var blockAlign = numCh * bytesPerSample
    var dataSize = len * blockAlign
    var ab = new ArrayBuffer(44 + dataSize)
    var dv = new DataView(ab)
    function writeStr(offset, s) {
      for (var i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i))
    }
    writeStr(0, 'RIFF')
    dv.setUint32(4, 36 + dataSize, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true)
    dv.setUint16(22, numCh, true)
    dv.setUint32(24, sampleRate, true)
    dv.setUint32(28, sampleRate * blockAlign, true)
    dv.setUint16(32, blockAlign, true)
    dv.setUint16(34, 16, true)
    writeStr(36, 'data')
    dv.setUint32(40, dataSize, true)
    var offset = 44
    var data = []
    for (var c = 0; c < numCh; c++) data.push(buffer.getChannelData(c))
    for (var i = 0; i < len; i++) {
      for (var c2 = 0; c2 < numCh; c2++) {
        var v = data[c2][i]
        var s = v < -1 ? -1 : v > 1 ? 1 : v
        dv.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        offset += 2
      }
    }
    return new Blob([ab], { type: 'audio/wav' })
  }

  function pickAndCrop(slot) {
    var input = el('input')
    input.type = 'file'
    input.accept = 'audio/*'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener('change', function () {
      var file = input.files && input.files[0]
      try {
        input.remove()
      } catch (err) {
        /* 忽略 */
      }
      if (!file) return
      // 直接上传原文件到素材库，然后打开裁剪器
      var reader = new FileReader()
      reader.onload = function () {
        json(api('/upload-sound.json'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: reader.result, name: file.name.replace(/\.[^.]+$/, ''), cropped: false }),
        })
          .then(function (res) {
            if (!res || !res.ok) return
            sounds = res.sounds || sounds
            if (slot) {
              slot.sounds = slot.sounds || []
              slot.sounds.push(res.id)
              persist()
              renderAudioPane()
            } else {
              renderAudioPane()
            }
            openCropper(res.id, file.name.replace(/\.[^.]+$/, ''))
          })
          .catch(function () {})
      }
      reader.readAsDataURL(file)
    })
    input.click()
  }

  // ------------------------------------------------------------ 任务完成提醒链路
  function runTurnEndDelivery(deliver) {
    if (!deliver) return
    if (deliver.titleFlash && deliver.flashText) startTitleFlash(deliver.flashText)
    if (deliver.webNotification) webNotify('耄耋 · 任务完成', deliver.body || '任务完成')
    if (deliver.sound) fireTrigger('turn.end', { intent: true })
    if (deliver.catAct) {
      setPose('hiss', 1600)
      shakeCat()
    }
    if (deliver.bubble !== false) {
      showBubble({ reason: 'turn-end', autoCloseSec: deliver.autoCloseSec || 0, extraText: deliver.body || '' })
    }
  }

  // ------------------------------------------------------------ 事件通道（SSE + 收件箱双通道）
  // 桌面端主窗口跑在 dsh-app:// 下，EventSource 不一定连得上；收件箱轮询是兜底。
  // 两条通道都带 Host 发的 seq，靠它去重；seq 也存 localStorage，
  // 刷新页面不会把已经处理过的闹钟再补一遍。
  var evState = {
    // seq 只在**同一个 Host 进程（boot）**内可比：Host 重启后计数器从 1 重新开始。
    // 所以每条事件都带 boot 标识，boot 变了就把 lastSeq 清零 —— 否则新进程的
    // seq(1,2,3…) 会被当成「处理过的旧事件」全部丢掉（弹窗和声音都会没）。
    // lastSeq 也**不再写 localStorage**：跨重启的旧值只会害人。
    boot: null,
    lastSeq: 0,
    aligned: false,
    sse: { state: 'connecting', helloAt: 0, lastAt: 0, errors: 0 },
    inbox: { polls: 0, lastPollAt: 0, errors: 0 },
  }

  // 返回 true 表示「换了一个 Host 进程」
  function noteBoot(boot) {
    if (typeof boot !== 'string' || boot === '') return false
    if (evState.boot === boot) return false
    evState.boot = boot
    evState.lastSeq = 0
    return true
  }

  function noteSeq(payload) {
    var seq = payload && payload.seq
    if (typeof seq !== 'number' || !isFinite(seq)) return
    if (seq > evState.lastSeq) evState.lastSeq = seq
  }

  // 需要重建设置面板但用户正在操作时，先记下来，等他松手再补
  var pendingPaneRender = false
  var pendingRenderTimer = 0
  function requestPaneRender() {
    if (!settingsWin) return
    if (!isInteracting()) {
      pendingPaneRender = false
      renderAllPanes('remote-state')
      return
    }
    pendingPaneRender = true
    if (pendingRenderTimer) return
    var retry = function () {
      pendingRenderTimer = 0
      if (!pendingPaneRender) return
      if (isInteracting()) {
        pendingRenderTimer = setTimeout(retry, 500)
        return
      }
      pendingPaneRender = false
      noteInputDiag('rebuild-deferred', '松手后补建')
      renderAllPanes('remote-state-deferred')
    }
    pendingRenderTimer = setTimeout(retry, 500)
  }

  // Host 推来的状态刷新：如果用户正在输入，**先别合并** —— 否则会把你正在敲的那一格
  // 用 Host 上的旧值覆盖掉（然后 350ms 后的 persist 又把这个旧值写回 Host），
  // 表现就是「输不进去」。等你松手再合并（最多推迟 10 秒，避免一直不更新）。
  var pendingStateRefresh = false
  var pendingStateSince = 0
  var pendingStateTimer = 0

  function applyRemoteState(r) {
    boot = r
    sounds = r.sounds || sounds
    images = r.images || images
    state = deepMerge(state, r.state)
    applyPoseConfig()
    requestPaneRender()
    applyAppearance()
    refreshPoseImage()
    checkVersion(r.version)
  }

  function drainPendingStateRefresh() {
    if (!pendingStateRefresh) return
    if (isInteracting() && Date.now() - pendingStateSince < 10000) {
      if (!pendingStateTimer) pendingStateTimer = setTimeout(drainPendingStateRefresh, 600)
      return
    }
    pendingStateRefresh = false
    pendingStateTimer = 0
    noteInputDiag('state-applied-late', '等了 ' + Math.round((Date.now() - pendingStateSince) / 1000) + 's')
    json(api('/init.json')).then(function (r) {
      if (r && r.ok) applyRemoteState(r)
    })
  }

  function refreshFromHost() {
    if (isInteracting()) {
      // 首字节还没落地的输入也不能被覆盖：推迟到松手后再合并
      if (!pendingStateRefresh) noteInputDiag('state-deferred', '用户正在操作')
      pendingStateRefresh = true
      pendingStateSince = pendingStateSince || Date.now()
      if (!pendingStateTimer) pendingStateTimer = setTimeout(drainPendingStateRefresh, 600)
      return
    }
    json(api('/init.json')).then(function (r) {
      if (!r || !r.ok) return
      applyRemoteState(r)
    })
  }

  // Host 模块热重载后版本会变：前端脚本对不上就自动刷新一次（只刷一次，防循环）
  function checkVersion(hostVersion) {
    if (!hostVersion || hostVersion === MAODIE_VERSION) return
    try {
      if (sessionStorage.getItem('md:reloaded-for') === String(hostVersion)) return
      sessionStorage.setItem('md:reloaded-for', String(hostVersion))
    } catch (err) {
      /* 忽略 */
    }
    try {
      location.reload()
    } catch (err) {
      /* 某些环境（jsdom）不支持 reload：忽略 */
    }
  }

  function handleEvent(payload) {
    if (!payload || !payload.type) return
    // Host 换进程了：序号重置，别把新事件当旧的丢掉
    noteBoot(payload.boot)
    if (typeof payload.seq === 'number' && payload.seq > 0 && payload.seq <= evState.lastSeq) {
      // 同一个 Host 进程内已经处理过（SSE 与轮询重复送达）
      return
    }
    noteSeq(payload)
    if (payload.type === 'turn-end') {
      if (status) status.lastTurn = payload.data
      runTurnEndDelivery(payload.deliver || {})
      refreshStatus()
      return
    }
    if (payload.type === 'alarm') {
      var d = payload.data || {}
      noteAlarmFired(d)
      // 声音/气泡都带 'notify' 标签 → 戳破气泡会立刻掐断（含循环播放的闹钟音）
      if (payload.deliver === undefined || payload.deliver.sound !== false) fireTrigger('alarm.fire', { intent: true })
      setPose('hiss', 2000)
      shakeCat()
      showAlarmBubble(d)
      if (payload.deliver && payload.deliver.webNotification) {
        webNotify('耄耋 · 闹钟', d.text || '起床')
      }
      return
    }
    if (payload.type === 'state') {
      // 自己刚保存的回显：数据本来就是自己在本地改的，重新拉一遍只会把面板重建掉
      if (isSelfEcho()) return
      refreshFromHost()
    }
  }

  function connectEvents() {
    var ok = false
    try {
      var es = new EventSource(api('/events'))
      es.onopen = function () {
        evState.sse.state = 'open'
      }
      es.onmessage = function (ev) {
        var payload = null
        try {
          payload = JSON.parse(ev.data)
        } catch (err) {
          return
        }
        if (!payload || !payload.type) return
        evState.sse.lastAt = Date.now()
        if (payload.type === 'hello') {
          ok = true
          evState.sse.helloAt = Date.now()
          evState.sse.state = 'open'
          return
        }
        handleEvent(payload)
      }
      es.onerror = function () {
        evState.sse.state = 'error'
        evState.sse.errors += 1
      }
    } catch (err) {
      evState.sse.state = 'unsupported'
      ok = false
    }
    return ok
  }

  // 收件箱轮询：SSE 掉线也能收到「闹钟 / 任务完成」
  function pollInbox() {
    var url = api('/inbox.json') + (evState.aligned ? '?since=' + encodeURIComponent(String(evState.lastSeq)) : '')
    json(url)
      .then(function (r) {
        if (!r || !r.ok) return
        evState.inbox.polls += 1
        evState.inbox.lastPollAt = Date.now()
        var rebooted = noteBoot(r.boot)
        // 同一个 boot 内序号倒退（不该发生）也当成重启：宁可重放，不要再丢
        if (typeof r.seq === 'number' && r.seq < evState.lastSeq) {
          evState.lastSeq = 0
          evState.aligned = false
        }
        if (rebooted) {
          // Host 刚重启：立刻用 since=0 再拉一次，把这 2 分钟内的事件补上
          setTimeout(pollInbox, 60)
          return
        }
        if (!evState.aligned) {
          // 首次（刚打开页面）只对齐基线，不补发历史事件
          evState.aligned = true
          if (typeof r.seq === 'number') evState.lastSeq = r.seq
          return
        }
        var items = r.items || []
        for (var i = 0; i < items.length; i++) handleEvent(items[i])
      })
      .catch(function () {
        evState.inbox.errors += 1
      })
  }

  // 心跳：把「前端活没活、SSE 通不通、声音为什么没响」上报给 Host（/maodie/diag 能看）
  function buildReport() {
    var slots = (state.audio && state.audio.slots) || []
    var ctxState = 'none'
    try {
      var ctx = audioContext()
      if (ctx) ctxState = String(ctx.state || 'unknown')
    } catch (err) {
      ctxState = 'error'
    }
    return {
      version: MAODIE_VERSION,
      href: String(location.href || ''),
      protocol: String(location.protocol || ''),
      apiBase: String(API_BASE || ''),
      pose: cat.pose || 'idle',
      images: { idle: poseImageId('idle'), hiss: poseImageId('hiss'), total: images.length },
      sse: evState.sse,
      inbox: {
        boot: evState.boot,
        lastSeq: evState.lastSeq,
        lastPollAt: evState.inbox.lastPollAt,
        polls: evState.inbox.polls,
        errors: evState.inbox.errors,
      },
      // 闹钟兜底的状态：前端有没有替 Host 补过枪、最后一次检查是什么时候
      alarmWatch: { lastCheck: alarmWatch.lastCheck, pokes: alarmWatch.pokes.slice(-5) },
      // 交付时自愈的流水账：非空说明「通知弹了却没声音」的配置被前端当场修好了
      soundRepair: soundRepairs.slice(-5),
      // 输入诊断：焦点/按键/值变化/面板重建的时间线（排查「输不进去」）
      inputDiag: inputDiag.slice(-20),
      audio: {
        unlocked: !!audio.unlocked,
        contextState: ctxState,
        volume: audio.volume,
        last: audio.lastResult || {},
      },
      slots: slots.map(function (sl) {
        return {
          id: sl.id,
          name: sl.name,
          trigger: sl.trigger,
          enabled: sl.enabled !== false,
          pool: (sl.sounds || []).length,
          loop: sl.loop === true,
        }
      }),
      errors: pageErrors.slice(-10),
    }
  }

  function sendReport() {
    try {
      fetch(api('/report.json'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReport()),
        credentials: 'include',
        cache: 'no-store',
      }).catch(function () {
        /* 心跳失败不影响功能 */
      })
    } catch (err) {
      /* 忽略 */
    }
  }

  // ------------------------------------------------------------ 轮询兜底
  var polls = { status: 0, turn: 0 }

  function refreshStatus(cb) {
    json(api('/status.json'))
      .then(function (r) {
        if (!r || !r.ok) return
        status = r
        // 任务完成的兜底已经交给「收件箱轮询 + seq 去重」，
        // 这里再按 turnSeq 触发会和收件箱重复提示，所以只更新数据。
        if (typeof r.turnSeq === 'number') polls.turn = r.turnSeq
        if (cb) cb(r)
      })
      .catch(function () {})
  }

  function startPolling() {
    // 事件收件箱 + 心跳：这两个是「闹钟/任务完成一定送达」和「声音为什么没响」的关键
    // （lastSeq 不跨页面/跨进程保留：基线由第一次轮询对齐）
    pollInbox()
    sendReport()
    setInterval(pollInbox, 5000)
    setInterval(sendReport, 15000)
    // 闹钟「下次…」倒计时：每秒自己走
    setInterval(refreshAlarmTicks, 1000)
    // 闹钟兜底：到点那一分钟如果 Host 没动静，就请它投一次（Host 侧幂等，不会重复响）
    alarmWatchdog()
    setInterval(alarmWatchdog, 3000)
    setInterval(function () {
      refreshStatus()
      // 倒计时刷新：气泡开着就更新文字
      if (cat.bubble) {
        var sub = cat.bubble.querySelector('.md-peak-sub')
        var peak = (status && status.peak) || null
        if (sub && peak && peak.nextAt) {
          sub.textContent = '距' + (peak.nextKind === 'peak' ? '高峰' : '谷价') + ' ' + fmtDuration(peak.nextAt - Date.now())
        }
      }
    }, 30000)
    // 气泡开着时更频繁地刷新倒计时
    setInterval(function () {
      if (!cat.bubble) return
      var peak = (status && status.peak) || null
      var sub = cat.bubble.querySelector('.md-peak-sub')
      if (sub && peak && peak.nextAt) {
        sub.textContent = '距' + (peak.nextKind === 'peak' ? '高峰' : '谷价') + ' ' + fmtDuration(peak.nextAt - Date.now())
      }
    }, 1000)
  }

  // ------------------------------------------------------------ 余额预警 / 预算（前端判定）
  var alertsFired = {}
  function checkAlerts() {
    if (!status || !status.usage) return
    var n = state.notify
    var usage = status.usage
    if (n.balanceLow && n.balanceLow.enabled && usage.balance !== null && usage.balance < Number(n.balanceLow.below || 0)) {
      var key = 'low:' + bjKey()
      if (!alertsFired[key]) {
        alertsFired[key] = true
        fireTrigger('balance.low', { intent: true })
        showBubble({ reason: 'alert' })
      }
    }
    if (n.budget && n.budget.enabled && usage.cost > Number(n.budget.amount || 0)) {
      var key2 = 'bud:' + bjKey()
      if (!alertsFired[key2]) {
        alertsFired[key2] = true
        fireTrigger('budget.over', { intent: true })
        showBubble({ reason: 'alert' })
      }
    }
  }
  function bjKey() {
    var d = new Date(Date.now() + 8 * 3600 * 1000)
    return d.toISOString().slice(0, 10)
  }

  // ------------------------------------------------------------ 样式
  var CSS = [
    // —— 猫 ——
    // 基准尺寸：容器宽度 = 图片画布宽度；规范画布（idle 的 bbox）占 84.2%
    '.md-root{position:fixed;left:0;top:0;--md-cat-w:220px;--md-cat-s:1;width:var(--md-cat-w);z-index:' + Z + ';user-select:none;-webkit-user-select:none;touch-action:none;cursor:grab;transition:opacity .2s ease}',
    '.md-root[data-shadow="on"] .md-cat{filter:drop-shadow(0 8px 18px rgba(15,23,42,.30))}',
    '.md-root[data-flip="on"] .md-cat{transform:scaleX(-1)}',
    '.md-root[data-flip="on"] .md-tip{transform:scaleX(-1)}',
    '.md-root.md-dragging{cursor:grabbing}',
    // 容器宽度固定 = --md-cat-w（idle 图的画布宽），高度固定 = 画布宽 * (2048/1248)
    // 图片绝对定位、底边锚定；具体的 left / width / bottom 由 JS 按几何算成像素写入
    '.md-cat{position:relative;width:100%;height:calc(var(--md-cat-w) * 1.6410);line-height:0}',
    '.md-cat-img{position:absolute;display:block;height:auto;left:50%;',
    '  pointer-events:none;-webkit-user-drag:none;transition:filter .15s ease}',
    '.md-root[data-pet="on"] .md-cat:active .md-cat-img{filter:brightness(1.03) saturate(1.05)}',
    '.md-root.md-dragging .md-cat-img{transition:none}',
    '.md-tip{position:absolute;left:50%;bottom:-2px;transform:translateX(-50%);white-space:nowrap;font:500 11px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;background:rgba(32,49,112,.86);padding:2px 8px;border-radius:999px;opacity:0;transition:opacity .18s ease;pointer-events:none}',
    '.md-root:hover .md-tip{opacity:1}',
    '.md-resize{position:absolute;right:-4px;bottom:-4px;width:18px;height:18px;border-radius:50%;background:#fff;border:2px solid rgba(32,49,112,.65);box-shadow:0 2px 6px rgba(15,23,42,.25);cursor:nwse-resize;opacity:0;transition:opacity .18s ease;touch-action:none}',
    '.md-root:hover .md-resize{opacity:1}',
    // 摇晃（三连击）
    '@keyframes mdShake{0%{transform:translateX(0) rotate(0)}12%{transform:translateX(-9px) rotate(-3deg)}26%{transform:translateX(8px) rotate(3deg)}40%{transform:translateX(-7px) rotate(-2.5deg)}54%{transform:translateX(6px) rotate(2deg)}70%{transform:translateX(-4px) rotate(-1.2deg)}85%{transform:translateX(3px) rotate(.8deg)}100%{transform:translateX(0) rotate(0)}}',
    '.md-shake{animation:mdShake .6s cubic-bezier(.36,.07,.19,.97)}',
    '.md-root[data-flip="on"] .md-shake{animation-direction:reverse}',
    '@keyframes mdPop{0%{transform:scale(1)}40%{transform:scale(1.045)}100%{transform:scale(1)}}',
    '.md-pop .md-cat-img{animation:mdPop .26s ease-out}',
    // —— 气泡（参考鲸鱼的啵出感：形状 + 内容两层错时浮现）——
    '.md-bubble{position:fixed;z-index:' + (Z + 20) + ';transform:translate(-50%,-100%);pointer-events:auto;cursor:pointer;',
    '  --md-bub-bg:rgba(255,255,255,.96);--md-bub-line:rgba(32,49,112,.35);--md-bub-ink:#203170;color:var(--md-bub-ink);',
    '  font:500 12px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.md-bubble-shape{position:relative;background:var(--md-bub-bg);border:1px solid var(--md-bub-line);border-radius:14px;',
    '  padding:10px 12px 9px;min-width:186px;max-width:min(300px,86vw);box-shadow:0 10px 26px rgba(15,23,42,.22);',
    '  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transform:scale(.72);transform-origin:50% 100%;',
    '  transition:opacity .18s ease,transform .22s cubic-bezier(.34,1.28,.6,1)}',
    '.md-bubble.md-open .md-bubble-shape{opacity:1;transform:scale(1)}',
    '.md-bubble.md-pop-out .md-bubble-shape{opacity:0;transform:scale(.66);transition:opacity .18s ease,transform .18s ease}',
    // 小尾巴
    '.md-bubble-shape::after{content:"";position:absolute;left:50%;bottom:-8px;width:14px;height:14px;margin-left:-7px;',
    '  background:var(--md-bub-bg);border-right:1px solid var(--md-bub-line);border-bottom:1px solid var(--md-bub-line);',
    '  transform:rotate(45deg);border-bottom-right-radius:4px}',
    '.md-bubble-body{opacity:0;transform:translateY(4px);transition:opacity .16s ease .10s,transform .2s ease .10s}',
    '.md-bubble.md-open .md-bubble-body{opacity:1;transform:none}',
    '.md-bubble-title{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;flex-wrap:wrap}',
    '.md-peak-badge{font-weight:700;font-size:13px;padding:1px 7px;border-radius:999px}',
    '.md-peak{background:rgba(224,67,63,.12);color:#c0392b}',
    '.md-valley{background:rgba(47,122,66,.12);color:#2f7a42}',
    '.md-peak-sub{font-size:11px;color:#7b8dbb}',
    '.md-bubble-rows{display:flex;flex-direction:column;gap:2px}',
    '.md-bubble-row{display:flex;justify-content:space-between;gap:14px}',
    '.md-bubble-row .md-k{color:#7b8dbb}',
    '.md-bubble-row .md-v{font-weight:600;font-variant-numeric:tabular-nums}',
    '.md-bubble-row.md-dim .md-v{font-weight:500;color:#5a6c9c}',
    '.md-bubble-hint{margin-top:7px;padding-top:6px;border-top:1px dashed rgba(32,49,112,.2);font-size:10px;color:#93a3c9;text-align:center}',
    '.md-bubble-extra{margin-top:7px;padding-top:6px;border-top:1px solid rgba(32,49,112,.18);font-size:13px;font-weight:700;color:#203170;text-align:center;word-break:break-word}',
    // —— 设置窗 ——
    '.md-set-mask{position:fixed;inset:0;background:rgba(15,23,42,.42);z-index:' + (Z + 60) + ';display:flex;align-items:center;justify-content:center}',
    '.md-set{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(640px,94vw);max-height:86vh;display:flex;flex-direction:column;',
    '  background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(15,23,42,.35);overflow:hidden;color:#203170;',
    '  font:500 13px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.md-set-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:rgba(32,49,112,.06);border-bottom:1px solid rgba(32,49,112,.14);cursor:default}',
    '.md-set-title{font-weight:700;font-size:14px}',
    '.md-set-close{border:none;background:none;font-size:16px;color:#203170;opacity:.55;cursor:pointer;padding:2px 6px;border-radius:6px}',
    '.md-set-close:hover{opacity:1;background:rgba(32,49,112,.08)}',
    '.md-set-tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid rgba(32,49,112,.14);background:#fff}',
    '.md-set-tab{border:none;background:rgba(32,49,112,.06);color:#203170;font-size:12px;padding:6px 12px;border-radius:8px 8px 0 0;cursor:pointer}',
    '.md-set-tab.md-on{background:#203170;color:#fff}',
    '.md-set-content{padding:12px 16px 18px;overflow-y:auto}',
    '.md-set-pane{display:none}',
    '.md-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed rgba(32,49,112,.12)}',
    '.md-row-label{flex:0 0 200px;color:#3b4d7d}',
    '.md-row-ctl{flex:1;display:flex;align-items:center;gap:8px;min-width:0}',
    '.md-row-hint{flex-basis:100%;font-size:11px;color:#93a3c9;margin-left:200px}',
    '.md-row input[type=number],.md-row input[type=text],.md-crop input[type=number],.md-crop input[type=text],.md-alarm input[type=text],.md-alarm input[type=number],.md-alarm input[type=time],.md-alarm input[type=date]{border:1px solid rgba(32,49,112,.35);border-radius:7px;padding:3px 7px;font-size:12px;color:#203170;background:#fff;box-sizing:border-box;max-width:100%}',
    '.md-crop input[type=number]{width:96px}',
    '.md-crop input[type=text]{width:220px}',
    '.md-select{border:1px solid rgba(32,49,112,.35);border-radius:7px;padding:3px 6px;font-size:12px;color:#203170;background:#fff}',
    '.md-btn{border:1px solid rgba(32,49,112,.4);border-radius:7px;background:rgba(32,49,112,.08);color:#203170;font-size:12px;padding:4px 10px;cursor:pointer}',
    '.md-btn:hover{background:rgba(32,49,112,.16)}',
    '.md-btn-primary{border:none;background:#203170;color:#fff}',
    '.md-btn-primary:hover{background:#2f4488}',
    '.md-btn-danger{border-color:rgba(201,57,43,.45);color:#c9392b}',
    '.md-btn-mini{font-size:11px;padding:2px 7px}',
    '.md-sub-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0 6px}',
    '.md-sub-title{font-weight:700;font-size:13px;color:#203170}',
    '.md-slot{border:1px solid rgba(32,49,112,.16);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:#fafbfe}',
    '.md-slot-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.md-slot-top input[type=text]{width:130px}',
    '.md-slot-opts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px}',
    '.md-slot-pool{margin-top:6px}',
    '.md-pool-grid{display:flex;flex-wrap:wrap;gap:4px 12px;margin:4px 0}',
    '.md-pool-item{display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer}',
    '.md-lib{display:flex;flex-direction:column;gap:4px}',
    '.md-lib-item{display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid rgba(32,49,112,.12);border-radius:8px;background:#fafbfe;flex-wrap:wrap}',
    '.md-lib-name{font-weight:600;min-width:80px}',
    '.md-lib-note{font-size:11px;color:#93a3c9}',
    '.md-tag{font-size:10px;color:#fff;background:#203170;border-radius:4px;padding:1px 5px}',
    '.md-dim{font-size:11px;color:#7b8dbb}',
    '.md-alarm{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;border:1px solid rgba(32,49,112,.12);border-radius:8px;background:#fafbfe}',
    '.md-alarm input[type=text]{width:100px}',
    '.md-peak-now{display:flex;flex-direction:column;align-items:center;gap:2px;padding:10px;margin-bottom:6px;border-radius:10px;background:rgba(32,49,112,.05)}',
    '.md-peak-big{font-size:20px;font-weight:800}',
    '.md-about{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:10px;background:rgba(32,49,112,.05);margin-bottom:10px}',
    '.md-about-title{font-size:18px;font-weight:800}',
    // —— 裁剪器 ——
    '.md-crop-mask{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:' + (Z + 80) + ';display:flex;align-items:center;justify-content:center}',
    '.md-crop{width:min(680px,96vw);max-height:92vh;overflow-y:auto;background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(15,23,42,.4);padding:0 0 14px;color:#203170;',
    '  font:500 13px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.md-crop-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(32,49,112,.14);background:rgba(32,49,112,.05)}',
    '.md-crop-title{font-weight:700}',
    '.md-crop-canvas{display:block;width:calc(100% - 28px);margin:12px 14px 6px;height:170px;background:#f3f5fb;border:1px solid rgba(32,49,112,.2);border-radius:10px;cursor:crosshair;touch-action:none}',
    '.md-crop-status{margin:0 14px 8px;font-size:11px;color:#7b8dbb}',
    '.md-dual{position:relative;height:22px;margin:0 14px 6px;touch-action:none}',
    '.md-dual-track{position:absolute;left:4px;right:4px;top:50%;height:5px;transform:translateY(-50%);background:rgba(32,49,112,.16);border-radius:3px}',
    '.md-dual-fill{position:absolute;top:50%;height:5px;transform:translateY(-50%);background:rgba(32,49,112,.5);border-radius:3px}',
    '.md-dual-thumb{position:absolute;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:#203170;border:2px solid #fff;box-shadow:0 1px 4px rgba(15,23,42,.35);cursor:ew-resize;box-sizing:border-box;touch-action:none}',
    '.md-crop-nums{display:flex;align-items:center;gap:8px;margin:6px 14px;flex-wrap:wrap}',
    '.md-crop-nums input[type=range]{flex:1;min-width:120px;accent-color:#203170}',
    '.md-crop-opts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 14px}',
    '.md-crop-btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin:10px 14px 0}',
    // —— 粒子画布 ——
    '.md-fx{position:fixed;inset:0;pointer-events:none}',
    // —— 外观图列表 / 试听按钮 ——
    '.md-img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;margin:8px 0}',
    '.md-img-card{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;border:1px solid rgba(32,49,112,.14);border-radius:10px;background:#fff}',
    '.md-img-thumb{width:72px;height:72px;object-fit:contain;border-radius:6px;background:repeating-conic-gradient(#f1f3f9 0% 25%, #fff 0% 50%) 50%/12px 12px}',
    '.md-img-name{font-size:11px;font-weight:600;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.md-img-btns{display:flex;gap:4px;flex-wrap:wrap;justify-content:center}',
    '.md-warn{margin:6px 0;padding:8px 10px;border-radius:8px;background:rgba(214,69,69,.08);border:1px solid rgba(214,69,69,.28);color:#a13b3b;font-size:12px;line-height:1.6}',
  ].join('\n')

  function injectStyle() {
    var style = el('style')
    style.textContent = CSS
    document.head.appendChild(style)
  }

  // ------------------------------------------------------------ 启动回执
  // 起来之后（或彻底失败之后）向 Host POST 一次 /maodie/hello。
  // 这是 Host 侧唯一能证明「脚本真的进了页面」的证据：看 /maodie/diag 的
  // frontend.booted / lastHello 即可区分「注入没生效」和「注入生效但前端报错」。
  function beacon(errorText) {
    try {
      var payload = {
        version: (boot && boot.version) || '',
        href: String(location.href || ''),
        protocol: String(location.protocol || ''),
        apiBase: String(API_BASE || ''),
        ua: String(navigator.userAgent || ''),
        error: errorText ? String(errorText) : '',
      }
      fetch((API_BASE || '') + API + '/hello', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
        cache: 'no-store',
      }).catch(function () {
        /* 回执失败不影响任何功能 */
      })
    } catch (err) {
      /* 忽略 */
    }
  }

  // ------------------------------------------------------------ 启动
  // 依次尝试候选基址取 init.json。第一个候选固定是相对路径（同源），
  // 桌面端由 dsh-app:// 协议处理器转发给 Host，浏览器端本来就是同源。
  function loadInit() {
    var candidates = computeBaseCandidates()
    var attempts = []
    for (var i = 0; i < candidates.length; i++) attempts.push(candidates[i])

    var tried = []
    function next() {
      if (attempts.length === 0) {
        var detail = tried.join(' | ')
        try {
          console.error('[耄耋] 所有基址都取不到 init.json', detail)
        } catch (err) {
          /* 忽略 */
        }
        showErrorBanner(
          '取不到 /maodie/init.json。已尝试：' + (detail || '（无）') + '。' +
            '如果这里是 401，说明会话 cookie 没带上；请把这一行发我。',
        )
        beacon('init.json 全部基址失败: ' + detail)
        return
      }
      var base = attempts.shift()
      var url = (base || '') + API + '/init.json'
      fetch(url, { credentials: 'include', cache: 'no-store' })
        .then(function (res) {
          tried.push(url + ' → HTTP ' + res.status)
          return res.json().catch(function () {
            return null
          })
        })
        .then(function (r) {
          if (!r || !r.ok) {
            next()
            return
          }
          // 成功：Host 的 apiBase 已经带 /maodie 前缀，直接用它（不要再剥）
          API_BASE = (r.apiBase && String(r.apiBase)) || base || ''
          // 自检：apiBase 必须在某个候选基址之下，否则说明拿错了
          if (API_BASE && BASE_CANDIDATES.length > 0) {
            var okBase = BASE_CANDIDATES.some(function (c) {
              return API_BASE.indexOf(c) === 0
            })
            if (!okBase) {
              try {
                console.warn('[耄耋] apiBase 不在候选基址内，回退到候选基址', API_BASE, BASE_CANDIDATES)
              } catch (err) {
                /* 忽略 */
              }
              API_BASE = BASE_CANDIDATES[0]
            }
          }
          startWith(r)
        })
        .catch(function (err) {
          tried.push(url + ' → ' + String((err && err.message) || err))
          next()
        })
    }
    next()
  }

  function startWith(r) {
    boot = r
    state = r.state
    sounds = r.sounds || []
    triggers = r.triggers || []
    images = r.images || []
    if (state.appearance && !state.appearance.poses) {
      state.appearance.poses = { idle: 'builtin:idle', hiss: 'builtin:hiss' }
    }
    nativeInfo = r.native || nativeInfo
    audio.volume = (state.audio && state.audio.volume) || 0.9
    try {
      applyPoseConfig()
      buildCat()
      applyAppearance()
      connectEvents()
      startPolling()
      refreshStatus(function () {
        checkAlerts()
      })
      setInterval(checkAlerts, 60000)
      window.addEventListener('resize', function () {
        applyAppearance()
      })
      // 第一次用户手势：解锁音频 + 补播被浏览器拦掉的那一条
      document.addEventListener(
        'pointerdown',
        function () {
          unlockAudio()
          retryPendingAudio()
        },
        true,
      )
      pollInbox()
      sendReport()
      checkVersion(r.version)
      console.log(
        '[耄耋] 已就绪（基址 ' + (API_BASE || '相对路径') + '）：拖动移动 · 滚轮缩放 · 点击哈气 · 连点三下 · 右键设置',
      )
      beacon('')
    } catch (err) {
      try {
        console.error('[耄耋] 初始化失败', err)
      } catch (err2) {
        /* 忽略 */
      }
      showErrorBanner('初始化失败：' + String((err && err.message) || err))
      beacon('初始化失败: ' + String((err && err.message) || err))
    }
  }

  function bootUp() {
    injectStyle()
    loadInit()
    // 外部脚本加载后立刻回一次：即使 init.json 还没回来，也能证明脚本进来了。
    // 真正的「已就绪」回执在 startWith() 里再发一次（会覆盖成 apiBase 已知的那条）。
    beacon('')
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUp)
  else bootUp()
})()
