// Frontend patch 8 (1.2.7): repair the sound config AT DELIVERY TIME.
//
// The reported bug: the notification bubble appears, but there is no sound.
// Live diag showed why: slot-done (trigger turn.end) was `enabled: false` again, while
// state.meta.soundAutoHealed still carried `{turn.end: <stamp>}` from the 1.2.1 heal —
// so the "heal only once ever" record was itself blocking the repair. The popup and the
// sound are separate delivery channels, so you get a silent notification forever.
//
// New contract: whenever a delivery WANTS a sound (deliver.sound === true, i.e. the
// 「提醒」pane says sound is on) and no usable slot exists for that trigger, the page
// repairs the config on the spot (enable the populated slot / fill the empty pool /
// create a default slot), persists it to the Host, and then plays it. Deliberate mutes
// are still respected: click/hover/triple sounds carry no intent flag and are never
// repaired (that toggle IS the user's switch for them).
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

rep('K1 version', `  var MAODIE_VERSION = '1.2.6'`, `  var MAODIE_VERSION = '1.2.7'`)

// ---------------------------------------------------------------- K2 repair helper + hook into fireTrigger
rep(
  'K2 ensureSoundSlot + fireTrigger hook',
  `  function fireTrigger(trigger, opts) {
    opts = opts || {}
    var slot = slotFor(trigger)
    if (!slot) return false`,
  `  // 交付时自愈的流水账（随心跳上报，diag 里能看出「前端替谁补过配置」）
  var soundRepairs = []

  // 默认素材池：内置 MP3（和 Host 侧自愈用的是同一批口径）
  function soundPoolForTrigger() {
    try {
      var pool = []
      var list = Array.isArray(sounds) ? sounds : []
      for (var i = 0; i < list.length; i++) {
        var one = list[i]
        if (!one || !one.id || one.builtin !== true) continue
        if (!/\\.mp3$|audio\\/mpeg/.test(String(one.file || '') + String(one.mime || ''))) continue
        pool.push(one.id)
      }
      if (pool.length === 0) pool = ['builtin:hiss']
      return pool
    } catch (err) {
      return ['builtin:hiss']
    }
  }

  // 「通知弹出来了、可是没声音」的现场：\`提醒\` 里声音是开着的，却没有任何
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
    if (!slot) return false`,
)

// ---------------------------------------------------------------- K3 reply with intent flags
rep('K3 turn-end intent', `    if (deliver.sound) fireTrigger('turn.end')`, `    if (deliver.sound) fireTrigger('turn.end', { intent: true })`)
rep(
  'K3b alarm intent',
  `      if (payload.deliver === undefined || payload.deliver.sound !== false) fireTrigger('alarm.fire')`,
  `      if (payload.deliver === undefined || payload.deliver.sound !== false) fireTrigger('alarm.fire', { intent: true })`,
)
rep('K3c balance alert intent', `        fireTrigger('balance.low')`, `        fireTrigger('balance.low', { intent: true })`)
rep('K3d budget alert intent', `        fireTrigger('budget.over')`, `        fireTrigger('budget.over', { intent: true })`)

// ---------------------------------------------------------------- K4 report the repairs
rep(
  'K4 report soundRepair',
  `      // 闹钟兜底的状态：前端有没有替 Host 补过枪、最后一次检查是什么时候
      alarmWatch: { lastCheck: alarmWatch.lastCheck, pokes: alarmWatch.pokes.slice(-5) },`,
  `      // 闹钟兜底的状态：前端有没有替 Host 补过枪、最后一次检查是什么时候
      alarmWatch: { lastCheck: alarmWatch.lastCheck, pokes: alarmWatch.pokes.slice(-5) },
      // 交付时自愈的流水账：非空说明「通知弹了却没声音」的配置被前端当场修好了
      soundRepair: soundRepairs.slice(-5),`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
