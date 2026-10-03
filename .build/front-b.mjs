// Frontend pass B: custom appearance images, session cost display, settings panes, cropper preview toggle.
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

// ---------------------------------------------------------------- B1 pose/image helpers
rep(
  'B1 pose helpers',
  `  function recomputeGeom(catW) {
    for (var key in POSE_SRC) {
      var src = POSE_SRC[key]
      var s = MODEL_W / src.bboxW
      var wpx = (catW * src.bboxW) / CANVAS_W
      // 容器基准高度 = 画布高宽比 * 容器宽；补偿 = (图高*s - 蓝本高) / 2，换算到容器像素
      var dy = ((src.bboxH * s - MODEL_H) / 2) * (catW / CANVAS_W)
      POSE_GEOM[key] = { file: src.file, cls: 'md-cat-img', s: s, wpx: wpx, dy: dy }
    }
  }`,
  `  function recomputeGeom(catW) {
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
    if (!hasPool('turn.end')) out.push('没有任何可用槽位绑定 turn.end → 任务完成不会出声')
    if (!hasPool('alarm.fire')) out.push('没有任何可用槽位绑定 alarm.fire → 闹钟不会出声')
    if (audio.lastResult && audio.lastResult.ok === false && audio.lastResult.trigger) {
      out.push('上次播放「' + audio.lastResult.id + '」失败：' + audio.lastResult.error)
    }
    return out
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
                name: String(file.name || '自定义外观').replace(/\.[^.]+$/, ''),
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
                  renderLookPane()
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
        ensureAllImageMeta(function () {
          applyPoseConfig()
          applyAppearance()
          refreshPoseImage()
          renderLookPane()
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
  }`,
)

// ---------------------------------------------------------------- B2 CSS for the image grid
rep(
  'B2 css',
  `    '.md-fx{position:fixed;inset:0;pointer-events:none}',`,
  `    '.md-fx{position:fixed;inset:0;pointer-events:none}',
    // —— 外观图列表 / 试听按钮 ——
    '.md-img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;margin:8px 0}',
    '.md-img-card{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;border:1px solid rgba(32,49,112,.14);border-radius:10px;background:#fff}',
    '.md-img-thumb{width:72px;height:72px;object-fit:contain;border-radius:6px;background:repeating-conic-gradient(#f1f3f9 0% 25%, #fff 0% 50%) 50%/12px 12px}',
    '.md-img-name{font-size:11px;font-weight:600;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.md-img-btns{display:flex;gap:4px;flex-wrap:wrap;justify-content:center}',
    '.md-warn{margin:6px 0;padding:8px 10px;border-radius:8px;background:rgba(214,69,69,.08);border:1px solid rgba(214,69,69,.28);color:#a13b3b;font-size:12px;line-height:1.6}',`,
)

// ---------------------------------------------------------------- B3 buildCat: meta probe
rep(
  'B3 buildCat meta probe',
  `    cat.root = root
    cat.img = img
    cat.wrap = wrap
    cat.handle = handle
    cat.tip = tip

    applyAppearance()
    bindCatEvents()
  }`,
  `    cat.root = root
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
  }`,
)

// ---------------------------------------------------------------- B4 bubble: session row
rep(
  'B4 bubbleData',
  `  function bubbleData() {
    var peak = (status && status.peak) || (boot && boot.peak) || null
    var usage = (status && status.usage) || (boot && boot.usage) || null
    return { peak: peak, usage: usage }
  }`,
  `  function bubbleData() {
    var peak = (status && status.peak) || (boot && boot.peak) || null
    var usage = (status && status.usage) || (boot && boot.usage) || null
    var session = (status && status.session) || (boot && boot.session) || null
    return { peak: peak, usage: usage, session: session }
  }`,
)
rep(
  'B4b bubble session row',
  `      var r3 = el('div', 'md-bubble-row md-dim')
      r3.appendChild(el('span', 'md-k', '≈ tokens'))
      r3.appendChild(el('span', 'md-v', fmtTokens(data.usage.tokens) + ' · ' + (data.usage.costBasis || '')))
      rows.appendChild(r3)
      body.appendChild(rows)`,
  `      var r3 = el('div', 'md-bubble-row md-dim')
      r3.appendChild(el('span', 'md-k', '≈ tokens'))
      r3.appendChild(el('span', 'md-v', fmtTokens(data.usage.tokens) + ' · ' + (data.usage.costBasis || '')))
      rows.appendChild(r3)
      // 本次消耗：当前会话花了多少（余额差口径 + 真实 usage）
      if (state.look.showSessionCost !== false) {
        var r4 = el('div', 'md-bubble-row')
        r4.appendChild(el('span', 'md-k', '本次消耗'))
        r4.appendChild(el('span', 'md-v', data.session ? fmtSessionLine(data.session) : '等待会话数据'))
        rows.appendChild(r4)
        if (data.session && data.session.costBasis) {
          var r5 = el('div', 'md-bubble-row md-dim')
          r5.appendChild(el('span', 'md-k', ''))
          r5.appendChild(el('span', 'md-v', data.session.costBasis))
          rows.appendChild(r5)
        }
      }
      body.appendChild(rows)`,
)

// ---------------------------------------------------------------- B5 look pane: appearance section + toggle
rep(
  'B5 look pane',
  `    pane.appendChild(row('测试', button('哈气一下', '', function () {
      singleHiss({ clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 })
    })))
  }`,
  `    pane.appendChild(row('气泡显示本次消耗', checkbox(look.showSessionCost !== false, function (v) {
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
  }`,
)

// ---------------------------------------------------------------- B6 audio pane: warnings + stop-all + preview buttons
rep(
  'B6 audio pane head',
  `    var head = el('div', 'md-sub-head')
    head.appendChild(el('div', 'md-sub-title', '声音槽位'))
    head.appendChild(button('＋ 新增槽位', 'md-btn-primary', function () {`,
  `    // 「为什么没声音」先摆出来：槽位没勾启用 / 素材池是空的都在这里说清楚
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
          if (typeof alert === 'function') alert(fixed > 0 ? '已启用 ' + fixed + ' 个槽位' : '没有需要修复的槽位（看看上面的提示）')
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
    head.appendChild(button('＋ 新增槽位', 'md-btn-primary', function () {`,
)
rep(
  'B6b library preview button',
  `      item.appendChild(button('试听', 'md-btn-mini', function () {
        playSound(s.id, { tag: 'preview', volume: au.volume })
      }))`,
  `      var sndPreview = previewButton('sound:' + s.id, '试听', '停止试听')
      sndPreview.addEventListener('click', function () {
        startSoundPreview(s)
      })
      item.appendChild(sndPreview)`,
)

// ---------------------------------------------------------------- B7 slot card preview toggle
rep(
  'B7 slot preview',
  `    opts.appendChild(button('试听', 'md-btn-mini', function () {
      fireTrigger(slot.trigger, {})
    }))`,
  `    var slotPreview = previewButton('slot:' + (slot.id || slot.trigger), '试听槽位', '停止试听')
    slotPreview.addEventListener('click', function () {
      startSlotPreview(slot)
    })
    opts.appendChild(slotPreview)`,
)

// ---------------------------------------------------------------- B8 peak pane: alarm test + schedule + sound source
rep(
  'B8 alarm header',
  `    // 闹钟
    pane.appendChild(el('div', 'md-sub-title', '闹钟（DSH 开着就会响）'))
    var alarms = state.alarms || (state.alarms = [])`,
  `    // 闹钟
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
    var schedule = (status && status.alarms) || []`,
)
rep(
  'B8b alarm item schedule + preview',
  `      item.appendChild(button('试听', 'md-btn-mini', function () {
        fireTrigger('alarm.fire', {})
      }))`,
  `      var sched = schedule.filter(function (x) {
        return x && x.id === al.id
      })[0]
      if (sched && sched.nextAt) {
        item.appendChild(el('span', 'md-dim', '下次 ' + fmtDuration(sched.nextAt - Date.now()) + '后'))
      }
      var alarmPreview = previewButton('slot:alarm.fire:' + (al.id || idx), '试听声音', '停止试听')
      alarmPreview.addEventListener('click', function () {
        togglePreview('slot:alarm.fire:' + (al.id || idx), function () {
          fireTrigger('alarm.fire', {})
          return function () {
            stopAllAudio(TAG.notify)
          }
        })
      })
      item.appendChild(alarmPreview)`,
)

// ---------------------------------------------------------------- B9 about pane: version + session
rep(
  'B9 about pane',
  `    box.appendChild(el('div', 'md-dim', '版本 ' + ((boot && boot.version) || '1.0.0')))
    box.appendChild(el('div', 'md-dim', '一个常驻的猫：峰谷价、余额、今日已用、任务完成提醒、自定义声音。'))`,
  `    box.appendChild(el('div', 'md-dim', '前端 ' + MAODIE_VERSION + ' · Host ' + ((boot && boot.version) || '?')))
    box.appendChild(el('div', 'md-dim', '一个常驻的猫：峰谷价、余额、今日已用与本次消耗、任务完成与闹钟提醒、自定义外观与声音。'))`,
)
rep(
  'B9b about session box',
  `    pane.appendChild(row('重新载入设置', button('从磁盘重载', '', function () {
      location.reload()
    })))`,
  `    var s = sessionOf()
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
    })))`,
)

// ---------------------------------------------------------------- B10 cropper: preview toggle
rep(
  'B10 cropper preview toggle',
  `    var btnRow = el('div', 'md-crop-btns')
    var playBtn = button('试听选区（循环）', 'md-btn-primary', function () {})
    var stopBtn = button('停止', '', function () {
      stopCropPreview()
    })`,
  `    var btnRow = el('div', 'md-crop-btns')
    var playBtn = button('试听选区（循环）', 'md-btn-primary', function () {})
    var stopBtn = button('停止试听', '', function () {
      stopCropPreview()
      updatePlayBtn()
    })`,
)
rep(
  'B10b cropper play handler',
  `    // 循环试听选区
    playBtn.addEventListener('click', function () {
      if (!crop.buffer || !crop.ctxAudio) return
      stopCropPreview()
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
      statusLine.textContent = '正在循环试听选区…（点「停止」结束）'
    })`,
  `    // 循环试听选区：同一个按钮就是开关（再点一次停止）
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
    })`,
)
rep(
  'B10c cropper stopCropPreview updates button',
  `    function stopCropPreview() {
      if (crop.preview) {
        try {
          crop.preview.stop()
        } catch (err) {
          /* 忽略 */
        }
        crop.preview = null
      }
    }`,
  `    function stopCropPreview() {
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
    }`,
)
// 改选区 = 停掉试听，避免听到的和你看到的不一致
rep(
  'B10d cropper selection stops preview',
  `    startNum.addEventListener('change', function () {
      crop.start = clamp(Number(startNum.value), 0, crop.duration)
      if (crop.start >= crop.end) crop.end = Math.min(crop.duration, crop.start + 0.002)
      updateCropUI()
    })
    endNum.addEventListener('change', function () {
      crop.end = clamp(Number(endNum.value), 0, crop.duration)
      if (crop.end <= crop.start) crop.start = Math.max(0, crop.end - 0.002)
      updateCropUI()
    })`,
  `    startNum.addEventListener('change', function () {
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
    })`,
)

// ---------------------------------------------------------------- B11 startWith wiring
rep(
  'B11 startWith',
  `  function startWith(r) {
    boot = r
    state = r.state
    sounds = r.sounds || []
    triggers = r.triggers || []
    images = r.images || []
    nativeInfo = r.native || nativeInfo
    audio.volume = (state.audio && state.audio.volume) || 0.9
    try {
      buildCat()`,
  `  function startWith(r) {
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
      buildCat()`,
)
rep(
  'B11b startWith gesture + first report',
  `      console.log(
        '[耄耋] 已就绪（基址 ' + (API_BASE || '相对路径') + '）：拖动移动 · 滚轮缩放 · 点击哈气 · 连点三下 · 右键设置',
      )
      beacon('')`,
  `      // 第一次用户手势：解锁音频 + 补播被浏览器拦掉的那一条
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
      beacon('')`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
