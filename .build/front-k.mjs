// Frontend patch 9 (1.2.8): stop remote state refreshes from eating what you are typing,
// and instrument the input path so the next report is measurable instead of guesswork.
//
// Why: the pane is NOT rebuilt while you type (the 1.2.3 gate covers that), but
// refreshFromHost() still did `state = deepMerge(state, remote)` unconditionally — so a
// state broadcast arriving right after a keystroke (turn end, sound heal, alarm watchdog,
// any Host-side change) restored the OLD value into the very field you were editing, and
// the debounced persist() then wrote that old value back. Net effect: "输不进去".
//
// Fix: while you are interacting (focus inside an input/select/textarea, or just acted),
// defer the remote merge; apply it once you let go (forced after 10s so it can't go stale).
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

rep('M1 version', `  var MAODIE_VERSION = '1.2.7'`, `  var MAODIE_VERSION = '1.2.8'`)

// ---------------------------------------------------------------- M2 input diagnostics
rep(
  'M2 inputDiag',
  `  var lastInteractAt = 0`,
  `  // 输入诊断：把「焦点有没有落到输入框 / 按键有没有到 / 值有没有变 / 面板有没有被重建」
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

  var lastInteractAt = 0`,
)

rep(
  'M2b input listeners',
  `    document.addEventListener('pointerdown', markInteract, true)
    document.addEventListener('keydown', markInteract, true)
    document.addEventListener('input', markInteract, true)
    document.addEventListener('change', markInteract, true)`,
  `    document.addEventListener('pointerdown', markInteract, true)
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
    )`,
)

// ---------------------------------------------------------------- M3 defer remote merges while interacting
rep(
  'M3 refreshFromHost defers while interacting',
  `  function refreshFromHost() {
    json(api('/init.json')).then(function (r) {
      if (!r || !r.ok) return
      boot = r
      sounds = r.sounds || sounds
      images = r.images || images
      state = deepMerge(state, r.state)
      applyPoseConfig()
      // 关键：不要一边用一边把面板拆了重建
      requestPaneRender()
      applyAppearance()
      refreshPoseImage()
      checkVersion(r.version)
    })
  }`,
  `  // Host 推来的状态刷新：如果用户正在输入，**先别合并** —— 否则会把你正在敲的那一格
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
  }`,
)

// ---------------------------------------------------------------- M4 rebuild cause labels
rep(
  'M4 renderAllPanes cause',
  `  function renderAllPanes() {
    if (!settingsWin) return
    renderLookPane()`,
  `  function renderAllPanes(cause) {
    if (!settingsWin) return
    noteInputDiag('rebuild-all', String(cause || 'unknown'))
    renderLookPane()`,
)
rep('M4b openSettings cause', `    renderAllPanes()\n    selectTab(tab || 'look')`, `    renderAllPanes('open-settings')\n    selectTab(tab || 'look')`)
rep(
  'M4c requestPaneRender cause',
  `    if (!isInteracting()) {
      pendingPaneRender = false
      renderAllPanes()
      return
    }`,
  `    if (!isInteracting()) {
      pendingPaneRender = false
      renderAllPanes('remote-state')
      return
    }`,
)
rep(
  'M4d retry cause',
  `      pendingPaneRender = false
      renderAllPanes()
    }
    pendingRenderTimer = setTimeout(retry, 500)`,
  `      pendingPaneRender = false
      noteInputDiag('rebuild-deferred', '松手后补建')
      renderAllPanes('remote-state-deferred')
    }
    pendingRenderTimer = setTimeout(retry, 500)`,
)

// ---------------------------------------------------------------- M5 async rebuilds go through the gate
rep(
  'M5 image upload callback uses the gate',
  `                  applyPoseConfig()
                  applyAppearance()
                  refreshPoseImage()
                  renderLookPane()
                } else {
                  alert('上传失败：' + ((r && r.error) || '未知错误'))`,
  `                  applyPoseConfig()
                  applyAppearance()
                  refreshPoseImage()
                  // 异步回调里重建面板也要看用户在不在打字（否则会打断输入）
                  if (isInteracting()) noteInputDiag('look-rebuild-deferred', '上传回调')
                  else renderLookPane()
                } else {
                  alert('上传失败：' + ((r && r.error) || '未知错误'))`,
)

// ---------------------------------------------------------------- M6 report the diagnostics
rep(
  'M6 report inputDiag',
  `      soundRepair: soundRepairs.slice(-5),`,
  `      soundRepair: soundRepairs.slice(-5),
      // 输入诊断：焦点/按键/值变化/面板重建的时间线（排查「输不进去」）
      inputDiag: inputDiag.slice(-20),`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
