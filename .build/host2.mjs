// Host patch 2 (1.2.1):
//   - one-time, recorded self-heal for an inconsistent sound config
//     ("提醒里声音是开的，但没有任何启用且勾了素材的槽位绑在 turn.end / alarm.fire 上")
//   - nudge connected pages on SSE connect so a Host version bump auto-reloads them
//   - diag exposes the heal result
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

// ---------------------------------------------------------------- H1 version
rep('H1 version', `const PLUGIN_VERSION = '1.2.0'`, `const PLUGIN_VERSION = '1.2.1'`)

// ---------------------------------------------------------------- H2 runtime field
rep(
  'H2 runtime soundHeal',
  `    helloCount: 0,
    lastHello: null,`,
  `    helloCount: 0,
    lastHello: null,
    soundHeal: null,`,
)

// ---------------------------------------------------------------- H3 heal function
rep(
  'H3 heal function',
  `      const hasAlarm = slots.some((s) => s && s.enabled !== false && s.trigger === 'alarm.fire' && Array.isArray(s.sounds) && s.sounds.length > 0)
      if (!hasAlarm) out.push('没有任何可用槽位绑定 alarm.fire → 闹钟不会有声音')
    } catch (err) {
      /* 忽略 */
    }
    return out
  }`,
  `      const hasAlarm = slots.some((s) => s && s.enabled !== false && s.trigger === 'alarm.fire' && Array.isArray(s.sounds) && s.sounds.length > 0)
      if (!hasAlarm) out.push('没有任何可用槽位绑定 alarm.fire → 闹钟不会有声音')
    } catch (err) {
      /* 忽略 */
    }
    return out
  }

  // 声音自愈（每个触发器只做一次，记录在 state.meta.soundAutoHealed 里）。
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
      const done = isPlainObject(meta.soundAutoHealed) ? meta.soundAutoHealed : (meta.soundAutoHealed = {})
      const defaultPool = BUILTIN_SOUNDS.filter((s) => /mp3$/i.test(String(s.file || ''))).map((s) => s.id)
      const pool = defaultPool.length > 0 ? defaultPool : ['builtin:hiss']

      const wants = []
      const te = state.notify && state.notify.turnEnd
      if (te && te.enabled !== false && te.sound !== false) wants.push('turn.end')
      const hasEnabledAlarm = (Array.isArray(state.alarms) ? state.alarms : []).some((a) => a && a.enabled !== false)
      if (hasEnabledAlarm) wants.push('alarm.fire')

      for (const trigger of wants) {
        if (done[trigger]) continue
        const usable = slots.some(
          (s) => s && s.enabled !== false && s.trigger === trigger && Array.isArray(s.sounds) && s.sounds.length > 0,
        )
        if (usable) continue
        const candidates = slots.filter((s) => s && s.trigger === trigger)
        if (candidates.length > 0) {
          for (const s of candidates) {
            let fixed = false
            if (!Array.isArray(s.sounds) || s.sounds.length === 0) {
              s.sounds = pool.slice()
              fixed = true
            }
            if (s.enabled === false) {
              s.enabled = true
              fixed = true
            }
            if (fixed) {
              done[trigger] = Date.now()
              result.healed.push({ trigger, slot: s.id, name: s.name, pool: (s.sounds || []).length, filledPool: true })
              break
            }
          }
        } else {
          const id = 'slot-auto-' + String(trigger).replace(/[^a-z0-9]/gi, '-')
          slots.push({
            id,
            name: trigger === 'turn.end' ? '任务完成音（自动补）' : '闹钟音（自动补）',
            trigger,
            sounds: pool.slice(),
            strategy: 'random',
            loop: trigger === 'alarm.fire',
            cooldownMs: trigger === 'turn.end' ? 3000 : 0,
            enabled: true,
          })
          done[trigger] = Date.now()
          result.healed.push({ trigger, slot: id, name: '自动补的默认槽位', pool: pool.length, created: true })
        }
      }

      if (result.healed.length > 0) {
        meta.updatedAt = Date.now()
        saveState()
        try {
          console.log('[maodie] 声音配置自愈：' + JSON.stringify(result.healed))
        } catch (err) {
          /* 忽略 */
        }
      }
    } catch (err) {
      result.error = String((err && err.message) || err)
    }
    return result
  }`,
)

// ---------------------------------------------------------------- H4 call it on mount
rep(
  'H4 call heal',
  `    // 会话花费跨 Host 重启保留（同一个会话接着算），换会话时自动重置
    runtime.session = (runtime.ledger && runtime.ledger.session) || null
    probeNative()`,
  `    // 会话花费跨 Host 重启保留（同一个会话接着算），换会话时自动重置
    runtime.session = (runtime.ledger && runtime.ledger.session) || null
    probeNative()
    // 「提醒里开了声音但没有任何槽位能出声」这种矛盾配置，修一次并记下来
    runtime.soundHeal = healSilentTriggers()`,
)

// ---------------------------------------------------------------- H5 SSE connect nudges a state refresh
rep(
  'H5 sse connect nudge',
  `        res.write('retry: 3000\\n\\n')
        res.write(\`data: \${JSON.stringify({ type: 'hello', at: Date.now() })}\\n\\n\`)
        runtime.sseClients.add(res)`,
  `        res.write('retry: 3000\\n\\n')
        res.write(\`data: \${JSON.stringify({ type: 'hello', at: Date.now() })}\\n\\n\`)
        runtime.sseClients.add(res)
        // 新连上来的页面立刻对一次状态：Host 模块热重载（版本变了）时，
        // 老前端会因此重新拉 init.json、发现版本不一致、自动刷新页面。
        publishEvent({ type: 'state', data: { at: Date.now() } }, false)`,
)

// ---------------------------------------------------------------- H6 diag exposes the heal
rep(
  'H6 diag soundHeal',
  `          // ④ 配置层面的「为什么不出声」
          soundWarnings: soundWarnings(),`,
  `          // ④ 配置层面的「为什么不出声」
          soundWarnings: soundWarnings(),
          // 启动时自动修过的声音配置（每个触发器最多一次）
          soundHeal: runtime.soundHeal,`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
