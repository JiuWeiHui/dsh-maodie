// Frontend patch 4 (1.2.3): stop rebuilding the settings panes while the user is editing.
//
// The bug: every change called persist() → POST /state.json → the Host echoed a
// {type:'state'} SSE event → the page called refreshFromHost() → renderAllPanes(),
// which replaces every control in every pane. So ~350 ms after you touched anything,
// the input/select you were using was a detached node: the native time picker or
// dropdown lost its owner and "couldn't be typed into / opened again".
// Also: the alarm time/enable handlers called renderPeakPane() directly, and the pose
// selects called renderLookPane() — rebuilding the very control that had just changed.
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

rep('D1 version', `  var MAODIE_VERSION = '1.2.2'`, `  var MAODIE_VERSION = '1.2.3'`)

// ---------------------------------------------------------------- D2 interaction tracking + safe render
rep(
  'D2 interaction tracking',
  `  // 页面里的异常留一份，随心跳上报给 Host（/maodie/diag 能看到）
  var pageErrors = []`,
  `  // 页面里的异常留一份，随心跳上报给 Host（/maodie/diag 能看到）
  var pageErrors = []
  // 「用户正在操作」的判定：重建设置面板必须避开这个窗口，
  // 否则正在用的输入框/下拉会被换成新节点（时间选择器和下拉会立刻失去宿主，
  // 表现就是「改过一次之后就点不开、输入不进去」）。
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
  }`,
)

rep(
  'D2b interaction listeners',
  `    window.addEventListener('unhandledrejection', function (e) {
      pageErrors.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || ''))
      if (pageErrors.length > 30) pageErrors = pageErrors.slice(-30)
    })`,
  `    window.addEventListener('unhandledrejection', function (e) {
      pageErrors.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || ''))
      if (pageErrors.length > 30) pageErrors = pageErrors.slice(-30)
    })
    document.addEventListener('pointerdown', markInteract, true)
    document.addEventListener('keydown', markInteract, true)
    document.addEventListener('input', markInteract, true)
    document.addEventListener('change', markInteract, true)`,
)

// ---------------------------------------------------------------- D3 persist records the self-save
rep(
  'D3 persist self-save stamp',
  `  var saveTimer = 0
  function persist() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () {
      saveTimer = 0
      json(api('/state.json'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: state }),
      }).catch(function () {})
    }, 350)
  }`,
  `  var saveTimer = 0
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
  }`,
)

// ---------------------------------------------------------------- D4 refreshFromHost defers the rebuild
rep(
  'D4 refreshFromHost',
  `  function refreshFromHost() {
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
  }`,
  `  // 需要重建设置面板但用户正在操作时，先记下来，等他松手再补
  var pendingPaneRender = false
  var pendingRenderTimer = 0
  function requestPaneRender() {
    if (!settingsWin) return
    if (!isInteracting()) {
      pendingPaneRender = false
      renderAllPanes()
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
      renderAllPanes()
    }
    pendingRenderTimer = setTimeout(retry, 500)
  }

  function refreshFromHost() {
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
)

// ---------------------------------------------------------------- D5 ignore our own echo
rep(
  'D5 state echo guard',
  `    if (payload.type === 'state') {
      refreshFromHost()
    }`,
  `    if (payload.type === 'state') {
      // 自己刚保存的回显：数据本来就是自己在本地改的，重新拉一遍只会把面板重建掉
      if (isSelfEcho()) return
      refreshFromHost()
    }`,
)

// ---------------------------------------------------------------- D6 alarm handlers must not rebuild the row
rep(
  'D6 alarm time handler',
  `        persist()
        refreshAlarmTicks()
        renderPeakPane()
      })
      item.appendChild(time)`,
  `        persist()
        // 只刷新「下次…」那行文字，绝不重建整行 ——
        // 时间选择器还开着的时候重建，输入就会直接丢掉
        refreshAlarmTicks()
      })
      item.appendChild(time)`,
)
rep(
  'D6b alarm enable handler',
  `      item.appendChild(checkbox(al.enabled !== false, function (v) {
        al.enabled = v
        persist()
        refreshAlarmTicks()
        renderPeakPane()
      }))`,
  `      item.appendChild(checkbox(al.enabled !== false, function (v) {
        al.enabled = v
        persist()
        refreshAlarmTicks()
      }))`,
)

// ---------------------------------------------------------------- D7 pose select must not rebuild itself
rep(
  'D7 pose select',
  `      sel.addEventListener('change', function () {
        state.appearance.poses = state.appearance.poses || {}
        state.appearance.poses[p] = sel.value
        applyPoseConfig()
        ensureAllImageMeta(function () {
          applyPoseConfig()
          applyAppearance()
          refreshPoseImage()
          renderLookPane()
        })
        applyAppearance()
        refreshPoseImage()
        persist()
      })`,
  `      sel.addEventListener('change', function () {
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
      })`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
