// Frontend pass A: audio diagnostics + preview toggles + event pipeline (SSE + inbox) + report heartbeat.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'frontend.js')

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

// ---------------------------------------------------------------- A1 version + page errors
rep(
  'A1 version',
  `  var API = '/maodie'`,
  `  var API = '/maodie'
  // 前端脚本自己的版本：与 Host 的 /maodie/init.json.version 对不上就自动刷新页面。
  // 这样以后升级插件只要 Host 模块热重载 + 一次自动刷新，不用手动重启桌面端。
  var MAODIE_VERSION = '1.2.0'
  // 页面里的异常留一份，随心跳上报给 Host（/maodie/diag 能看到）
  var pageErrors = []
  try {
    window.addEventListener('error', function (e) {
      pageErrors.push(String((e && e.message) || '') + ' @' + String((e && e.filename) || '').split('/').pop() + ':' + String((e && e.lineno) || ''))
      if (pageErrors.length > 30) pageErrors = pageErrors.slice(-30)
    }, true)
    window.addEventListener('unhandledrejection', function (e) {
      pageErrors.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || ''))
      if (pageErrors.length > 30) pageErrors = pageErrors.slice(-30)
    })
  } catch (err) {
    /* 忽略 */
  }`,
)

// ---------------------------------------------------------------- A2 audio state fields
rep(
  'A2 audio fields',
  `  var audio = {
    active: [], // { node, gain, stop, tag }
    volume: 0.9,
    cooldowns: {},
  }`,
  `  var audio = {
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
  }`,
)

// ---------------------------------------------------------------- A3 playSound records the result
rep(
  'A3 playSound result',
  `    var p = node.play()
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        // 自动播放被拦（没有用户手势）——静默降级，不打扰用户
        audio.active = audio.active.filter(function (x) {
          return x !== entry
        })
      })
    }
    return entry`,
  `    var p = node.play()
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
    return entry`,
)

// ---------------------------------------------------------------- A4 startSlotPreview helper + trigger passthrough
rep(
  'A4 fireTrigger trigger',
  `    var list = Array.isArray(picked) ? picked : [picked]
    for (var i = 0; i < list.length; i++) {
      playSound(list[i], {
        tag: trigger === 'turn.end' || trigger === 'alarm.fire' ? TAG.notify : TAG.click,
        loop: slot.loop === true,
        cooldownMs: Number(slot.cooldownMs) || 0,
        volume: clamp((state.audio && state.audio.volume !== undefined ? state.audio.volume : 0.9) * (opts.gain || 1), 0, 1),
      })
    }
    return true
  }`,
  `    var list = Array.isArray(picked) ? picked : [picked]
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
  }`,
)

// ---------------------------------------------------------------- A5 event pipeline + inbox + report
rep(
  'A5 connectEvents',
  `  // ------------------------------------------------------------ SSE
  function connectEvents() {
    var ok = false
    try {
      var es = new EventSource(api('/events'))
      es.onmessage = function (ev) {
        var payload = null
        try {
          payload = JSON.parse(ev.data)
        } catch (err) {
          return
        }
        if (!payload || !payload.type) return
        if (payload.type === 'hello') {
          ok = true
          return
        }
        if (payload.type === 'turn-end') {
          if (status) status.lastTurn = payload.data
          runTurnEndDelivery(payload.deliver || {})
          refreshStatus()
          return
        }
        if (payload.type === 'alarm') {
          var d = payload.data || {}
          // 声音/气泡都带 'notify' 标签 → 戳破气泡会立刻掐断（含循环播放的闹钟音）
          if (payload.deliver === undefined || payload.deliver.sound !== false) fireTrigger('alarm.fire')
          setPose('hiss', 2000)
          shakeCat()
          showAlarmBubble(d)
          if (payload.deliver && payload.deliver.webNotification) {
            webNotify('耄耋 · 闹钟', d.text || '起床')
          }
          return
        }
        if (payload.type === 'state') {
          // 另一端改了配置，重新拉一次
          json(api('/init.json')).then(function (r) {
            if (r && r.ok) {
              boot = r
              sounds = r.sounds || sounds
              state = deepMerge(state, r.state)
              renderAllPanes()
              applyAppearance()
            }
          })
        }
      }
      es.onerror = function () {
        // EventSource 会自动重连；这里不动
      }
    } catch (err) {
      ok = false
    }
    return ok
  }`,
  `  // ------------------------------------------------------------ 事件通道（SSE + 收件箱双通道）
  // 桌面端主窗口跑在 dsh-app:// 下，EventSource 不一定连得上；收件箱轮询是兜底。
  // 两条通道都带 Host 发的 seq，靠它去重；seq 也存 localStorage，
  // 刷新页面不会把已经处理过的闹钟再补一遍。
  var evState = {
    lastSeq: 0,
    aligned: false,
    sse: { state: 'connecting', helloAt: 0, lastAt: 0, errors: 0 },
    inbox: { polls: 0, lastPollAt: 0, errors: 0 },
  }

  function loadSeq() {
    try {
      var v = localStorage.getItem('md:lastSeq')
      return v ? Number(v) || 0 : 0
    } catch (err) {
      return 0
    }
  }

  function saveSeq(n) {
    try {
      localStorage.setItem('md:lastSeq', String(n))
    } catch (err) {
      /* 忽略 */
    }
  }

  function noteSeq(payload) {
    var seq = payload && payload.seq
    if (typeof seq !== 'number' || !isFinite(seq)) return
    if (seq > evState.lastSeq) {
      evState.lastSeq = seq
      saveSeq(seq)
    }
  }

  function refreshFromHost() {
    json(api('/init.json')).then(function (r) {
      if (!r || !r.ok) return
      boot = r
      sounds = r.sounds || sounds
      images = r.images || images
      state = deepMerge(state, r.state)
      applyPoseConfig()
      renderAllPanes()
      applyAppearance()
      checkVersion(r.version)
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
    if (typeof payload.seq === 'number' && payload.seq > 0 && payload.seq <= evState.lastSeq) {
      // 已经处理过（SSE 与轮询重复送达）
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
      // 声音/气泡都带 'notify' 标签 → 戳破气泡会立刻掐断（含循环播放的闹钟音）
      if (payload.deliver === undefined || payload.deliver.sound !== false) fireTrigger('alarm.fire')
      setPose('hiss', 2000)
      shakeCat()
      showAlarmBubble(d)
      if (payload.deliver && payload.deliver.webNotification) {
        webNotify('耄耋 · 闹钟', d.text || '起床')
      }
      return
    }
    if (payload.type === 'state') {
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
        if (!evState.aligned) {
          // 首次只对齐基线，不补发历史事件
          evState.aligned = true
          if (!evState.lastSeq && typeof r.seq === 'number') {
            evState.lastSeq = r.seq
            saveSeq(r.seq)
          }
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
        lastSeq: evState.lastSeq,
        lastPollAt: evState.inbox.lastPollAt,
        polls: evState.inbox.polls,
        errors: evState.inbox.errors,
      },
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
  }`,
)

// ---------------------------------------------------------------- A6 refreshStatus drops the turnSeq path
rep(
  'A6 refreshStatus',
  `        status = r
        if (typeof r.turnSeq === 'number') {
          if (polls.turn === 0) polls.turn = r.turnSeq
          else if (r.turnSeq > polls.turn) {
            polls.turn = r.turnSeq
            // SSE 掉线时靠这里兜底
            runTurnEndDelivery({
              titleFlash: state.notify.turnEnd.titleFlash,
              flashText: state.notify.turnEnd.flashText,
              sound: state.notify.turnEnd.sound,
              bubble: state.notify.turnEnd.bubble,
              catAct: state.notify.turnEnd.catAct,
              body: '',
              autoCloseSec: state.notify.turnEnd.autoCloseSec,
            })
          } else {
            polls.turn = r.turnSeq
          }
        }
        if (cb) cb(r)`,
  `        status = r
        // 任务完成的兜底已经交给「收件箱轮询 + seq 去重」，
        // 这里再按 turnSeq 触发会和收件箱重复提示，所以只更新数据。
        if (typeof r.turnSeq === 'number') polls.turn = r.turnSeq
        if (cb) cb(r)`,
)

// ---------------------------------------------------------------- A7 polling adds inbox + heartbeat
rep(
  'A7 startPolling',
  `  function startPolling() {
    setInterval(function () {`,
  `  function startPolling() {
    // 事件收件箱 + 心跳：这两个是「闹钟/任务完成一定送达」和「声音为什么没响」的关键
    evState.lastSeq = loadSeq()
    pollInbox()
    sendReport()
    setInterval(pollInbox, 5000)
    setInterval(sendReport, 15000)
    setInterval(function () {`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
