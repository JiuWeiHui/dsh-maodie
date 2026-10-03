// Frontend patch 11 (1.3.0)：账户分开的「用量」页 + 气泡改成本轮口径
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

rep('V1 version', `  var MAODIE_VERSION = '1.2.9'`, `  var MAODIE_VERSION = '1.3.0'`)

// ---------------------------------------------------------------- V2 第 6 个标签页
rep(
  'V2 标签页',
  `    var tabs = [
      { id: 'look', name: '外观' },
      { id: 'audio', name: '声音' },
      { id: 'notify', name: '提醒' },
      { id: 'peak', name: '峰谷' },
      { id: 'about', name: '关于' },
    ]`,
  `    var tabs = [
      { id: 'look', name: '外观' },
      { id: 'audio', name: '声音' },
      { id: 'notify', name: '提醒' },
      { id: 'peak', name: '峰谷' },
      { id: 'usage', name: '用量' },
      { id: 'about', name: '关于' },
    ]`,
)
rep(
  'V2b renderAllPanes',
  `    renderPeakPane()
    renderAboutPane()
  }`,
  `    renderPeakPane()
    renderUsagePane()
    renderAboutPane()
  }`,
)

// ---------------------------------------------------------------- V3 用量页
rep(
  'V3 renderUsagePane',
  `  function renderAboutPane() {`,
  `  // ---------------- 用量（账户分开；余额与今日已用按官方口径，第三方标「仅供参考」）----------------
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

  function renderAboutPane() {`,
)

// ---------------------------------------------------------------- V4 气泡：本轮优先
rep(
  'V4 气泡本轮',
  `    if (data.usage) {
      var rows = el('div', 'md-bubble-rows')
      var r1 = el('div', 'md-bubble-row')
      r1.appendChild(el('span', 'md-k', '余额'))
      r1.appendChild(el('span', 'md-v', data.usage.balance === null ? '--' : '¥ ' + fmtMoney(data.usage.balance)))
      rows.appendChild(r1)
      var r2 = el('div', 'md-bubble-row')
      r2.appendChild(el('span', 'md-k', '今日已用'))
      r2.appendChild(el('span', 'md-v', '¥ ' + fmtMoney(data.usage.cost)))
      rows.appendChild(r2)
      var r3 = el('div', 'md-bubble-row md-dim')
      r3.appendChild(el('span', 'md-k', '≈ tokens'))
      r3.appendChild(el('span', 'md-v', fmtTokens(data.usage.tokens) + ' · ' + (data.usage.costBasis || '')))
      rows.appendChild(r3)`,
  `    if (data.usage) {
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
      if (turnInfo) {
        var r0 = el('div', 'md-bubble-row')
        r0.appendChild(el('span', 'md-k', '本轮'))
        r0.appendChild(el('span', 'md-v', '¥ ' + fmtMoney(turnInfo.amount) + ' · ' + fmtTokens(turnInfo.tokens || 0) + ' tokens'))
        rows.appendChild(r0)
        var r0b = el('div', 'md-bubble-row md-dim')
        r0b.appendChild(el('span', 'md-k', ''))
        r0b.appendChild(el('span', 'md-v', (turnInfo.model || turnInfo.provider || '') + ' · ' + (turnInfo.amountBasis || '')))
        rows.appendChild(r0b)
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
        ra.appendChild(el('span', 'md-v', '¥ ' + fmtMoney(provInfo.totals.todayAmount) + ' · ' + fmtTokens(provInfo.totals.todayTokens || 0)))
        rows.appendChild(ra)
        if (provInfo.totals.note) {
          var rb = el('div', 'md-bubble-row md-dim')
          rb.appendChild(el('span', 'md-k', ''))
          rb.appendChild(el('span', 'md-v', provInfo.totals.note))
          rows.appendChild(rb)
        }
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
      var r3 = el('div', 'md-bubble-row md-dim')
      r3.appendChild(el('span', 'md-k', '≈ tokens（今日）'))
      r3.appendChild(el('span', 'md-v', fmtTokens(data.usage.tokens) + ' · ' + (data.usage.costBasis || '')))
      rows.appendChild(r3)`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
