// Host patch 7 (1.2.7): make the sound heal repeatable instead of "once ever".
//
// state.meta.soundAutoHealed was a "already fixed this trigger, never touch it again"
// record. Live diag showed exactly how that backfires: the user disabled the 任务完成音
// slot AFTER 1.2.1 had healed it, and the record then blocked every later repair — the
// notification kept popping with no sound, forever.
//
// New rule: the heal runs whenever the stated intent wants a sound but no usable slot
// exists (same intent gate as before: 「任务完成提醒」的声音开关 / 有启用的闹钟).
// A deliberate mute still wins, because turning the sound off in 「提醒」 changes the intent.
// Every heal is appended to state.meta.soundHealLog (bounded) and reported in diag.
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

rep('L1 version', `const PLUGIN_VERSION = '1.2.6'`, `const PLUGIN_VERSION = '1.2.7'`)

rep(
  'L2 heal is repeatable',
  `  // 声音自愈（每个触发器只做一次，记录在 state.meta.soundAutoHealed 里）。
  // 触发条件是一个**内部矛盾的配置**：「提醒」里声音是开着的，但没有任何
  // 「已启用且勾了素材」的槽位绑在 turn.end / alarm.fire 上 —— 用户看到的现象
  // 就是「通知弹出来了，可是没声音」。这里把那个「配了素材但没勾启用」的槽位打开；
  // 如果连槽位都没有（或素材池是空的），就补上内置默认素材。
  // 修过一次就不再动，避免和用户自己的选择打架；结果同时写进 state.meta 和 /maodie/diag。
  const healSilentTriggers = () => {
    const result = { healed: [], at: Date.now() }
    try {
      const audioCfg = state.audio || (state.audio = {})
      const slots = audioCfg.slots || (audioCfg.slots = [])
      const meta = state.meta || (state.meta = {})
      const done = isPlainObject(meta.soundAutoHealed) ? meta.soundAutoHealed : (meta.soundAutoHealed = {})`,
  `  // 声音自愈（**可重复**，流水记在 state.meta.soundHealLog 里）。
  // 触发条件是一个**内部矛盾的配置**：「提醒」里声音是开着的，但没有任何
  // 「已启用且勾了素材」的槽位绑在 turn.end / alarm.fire 上 —— 用户看到的现象
  // 就是「通知弹出来了，可是没声音」。这里把那个「配了素材但没勾启用」的槽位打开；
  // 如果连槽位都没有（或素材池是空的），就补上内置默认素材。
  // 血坑：1.2.1 用 state.meta.soundAutoHealed 记「这个触发器修过了、以后不再碰」，
  // 结果用户在自愈之后又把槽位关掉，那条记录反而**挡住了后续所有修复** ——
  // 弹窗照旧、声音永远没有，而且看起来「我已经修过了」。
  // 现在：只要「意图」是要声音（提醒里开着 / 有启用的闹钟）就修；靠**关掉提醒里的声音开关**
  // 来表达「我不要声音」，而不是靠静默地不修。
  const healSilentTriggers = () => {
    const result = { healed: [], at: Date.now() }
    try {
      const audioCfg = state.audio || (state.audio = {})
      const slots = audioCfg.slots || (audioCfg.slots = [])
      const meta = state.meta || (state.meta = {})`,
)

rep(
  'L3 drop the done gate, log instead',
  `      for (const trigger of wants) {
        if (done[trigger]) continue
        const usable = slots.some(`,
  `      for (const trigger of wants) {
        const usable = slots.some(`,
)

rep(
  'L4 record heal log',
  `            if (fixed) {
              done[trigger] = Date.now()
              result.healed.push({ trigger, slot: s.id, name: s.name, pool: (s.sounds || []).length, filledPool: true })
              break
            }`,
  `            if (fixed) {
              result.healed.push({ trigger, slot: s.id, name: s.name, pool: (s.sounds || []).length, filledPool: true })
              break
            }`,
)

rep(
  'L5 log new slot',
  `          done[trigger] = Date.now()
          result.healed.push({ trigger, slot: id, name: '自动补的默认槽位', pool: pool.length, created: true })`,
  `          result.healed.push({ trigger, slot: id, name: '自动补的默认槽位', pool: pool.length, created: true })`,
)

rep(
  'L6 write the bounded log',
  `      if (result.healed.length > 0) {
        meta.updatedAt = Date.now()
        saveState()`,
  `      if (result.healed.length > 0) {
        meta.updatedAt = Date.now()
        // 保留最近 10 条自愈流水（谁在什么时候被修好了），diag 直接可查
        const log = Array.isArray(meta.soundHealLog) ? meta.soundHealLog : (meta.soundHealLog = [])
        for (const h of result.healed) log.push(Object.assign({ at: Date.now() }, h))
        if (log.length > 10) meta.soundHealLog = log.slice(-10)
        saveState()`,
)

rep(
  'L7 report whitelists soundRepair',
  `          // 前端闹钟兜底的状态（它有没有替 Host 补过枪、最后一次检查是什么时候）
          alarmWatch: isPlainObject(body.alarmWatch)`,
  `          // 前端「交付时自愈」的流水：非空说明「通知弹了却没声音」的配置被前端当场修好了
          soundRepair: Array.isArray(body.soundRepair)
            ? body.soundRepair.slice(0, 5).map((x) => ({
                at: num(x && x.at),
                trigger: clip(x && x.trigger, 60),
                slot: clip(x && x.slot, 60),
                action: clip(x && x.action, 60),
              }))
            : [],
          // 前端闹钟兜底的状态（它有没有替 Host 补过枪、最后一次检查是什么时候）
          alarmWatch: isPlainObject(body.alarmWatch)`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
