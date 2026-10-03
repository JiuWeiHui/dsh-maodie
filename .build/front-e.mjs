// Frontend patch 3 (1.2.2): make the event dedupe restart-safe.
//
// The bug it fixes: lastSeq was persisted in localStorage, so after the Host process
// restarted (its seq counter back at 1) the page kept lastSeq=9 and dropped every new
// event as "already handled" — no task-complete bubble, no sound, while the local test
// button still worked. Now: seq is only compared inside one Host boot, the boot id
// comes with every event, and nothing is persisted across restarts.
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

rep('C1 version', `  var MAODIE_VERSION = '1.2.1'`, `  var MAODIE_VERSION = '1.2.2'`)

// ---------------------------------------------------------------- C2 evState + boot helpers
rep(
  'C2 evState/boot helpers',
  `  var evState = {
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
  }`,
  `  var evState = {
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
  }`,
)

// ---------------------------------------------------------------- C3 handleEvent gate
rep(
  'C3 handleEvent gate',
  `  function handleEvent(payload) {
    if (!payload || !payload.type) return
    if (typeof payload.seq === 'number' && payload.seq > 0 && payload.seq <= evState.lastSeq) {
      // 已经处理过（SSE 与轮询重复送达）
      return
    }
    noteSeq(payload)`,
  `  function handleEvent(payload) {
    if (!payload || !payload.type) return
    // Host 换进程了：序号重置，别把新事件当旧的丢掉
    noteBoot(payload.boot)
    if (typeof payload.seq === 'number' && payload.seq > 0 && payload.seq <= evState.lastSeq) {
      // 同一个 Host 进程内已经处理过（SSE 与轮询重复送达）
      return
    }
    noteSeq(payload)`,
)

// ---------------------------------------------------------------- C4 pollInbox: boot-aware alignment
rep(
  'C4 pollInbox',
  `        if (!r || !r.ok) return
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
        for (var i = 0; i < items.length; i++) handleEvent(items[i])`,
  `        if (!r || !r.ok) return
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
        for (var i = 0; i < items.length; i++) handleEvent(items[i])`,
)

// ---------------------------------------------------------------- C5 no persisted seq
rep(
  'C5 startPolling',
  `    // 事件收件箱 + 心跳：这两个是「闹钟/任务完成一定送达」和「声音为什么没响」的关键
    evState.lastSeq = loadSeq()
    pollInbox()`,
  `    // 事件收件箱 + 心跳：这两个是「闹钟/任务完成一定送达」和「声音为什么没响」的关键
    // （lastSeq 不跨页面/跨进程保留：基线由第一次轮询对齐）
    pollInbox()`,
)

// ---------------------------------------------------------------- C6 report the boot too (便于排查)
rep(
  'C6 report boot',
  `      inbox: {
        lastSeq: evState.lastSeq,
        lastPollAt: evState.inbox.lastPollAt,
        polls: evState.inbox.polls,
        errors: evState.inbox.errors,
      },`,
  `      inbox: {
        boot: evState.boot,
        lastSeq: evState.lastSeq,
        lastPollAt: evState.inbox.lastPollAt,
        polls: evState.inbox.polls,
        errors: evState.inbox.errors,
      },`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
