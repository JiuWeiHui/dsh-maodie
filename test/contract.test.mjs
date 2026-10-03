// ============================================================================
// 耄耋 —— 前后端一致性测试（静态检查，不需要浏览器）
// ============================================================================
// 前端跑在渲染进程里，Node 测不到 DOM，所以这里做的是"契约检查"：
//   1. 前端请求的每个 /maodie 路由，宿主必须真的注册了
//   2. 前端用到的触发器 id，宿主必须真的声明了
//   3. 前端引用的每个函数/变量都有定义（防止改名漏改）
//   4. 关键交互（点破掐音、拖动、缩放、裁剪导出 WAV）确实存在
//
// 运行：node test/contract.test.mjs
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const front = fs.readFileSync(path.join(root, 'assets', 'maodie.js'), 'utf8')
const host = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')

let passed = 0
let failed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log('  \u2713 ' + name)
  } else {
    failed += 1
    failures.push(name + (detail ? ' — ' + detail : ''))
    console.log('  \u2717 ' + name + (detail ? ' — ' + detail : ''))
  }
}

console.log('\n=== 耄耋 · 前后端契约测试 ===\n')

console.log('[1] 前端请求的宿主路由必须都存在')
{
  // 收集宿主注册的路径
  const hostPaths = new Set()
  const re = /path:\s*ROUTE_BASE\s*\+\s*'([^']+)'/g
  let m
  while ((m = re.exec(host)) !== null) hostPaths.add(m[1])
  // 还有前端脚本路由
  const scriptRe = /path:\s*ROUTE_BASE\s*\+\s*'\/maodie\.js'/
  check('宿主注册了前端脚本路由', scriptRe.test(host))

  // 收集前端用到的路径（api('...') —— 统一走基址，桌面端 dsh-app:// 下必需）
  const usedPaths = new Set()
  const useRe = /api\('([^']+)'\)/g
  while ((m = useRe.exec(front)) !== null) {
    // 去掉查询串
    let p = m[1]
    const q = p.indexOf('?')
    if (q !== -1) p = p.slice(0, q)
    if (p.indexOf('http') === 0) continue
    usedPaths.add(p)
  }
  check('前端确实在请求路由', usedPaths.size >= 6, 'count=' + usedPaths.size)
  check('前端统一走基址拼接', /function api\(path\)/.test(front) && /API_BASE/.test(front))
  check('请求都带 credentials（数据路由需要会话 cookie）', /credentials: 'include'/.test(front))
  for (const p of usedPaths) {
    if (p === '/maodie.js') continue
    check('宿主提供 ' + p, hostPaths.has(p), Array.from(hostPaths).join(', '))
  }
}

console.log('\n[2] 触发器 id 必须一一对应')
{
  const hostTriggers = new Set()
  const re = /id:\s*'([a-z]+\.[a-zA-Z]+)',\s*name:/g
  let m
  while ((m = re.exec(host)) !== null) hostTriggers.add(m[1])
  check('宿主声明了 8 个触发器', hostTriggers.size === 8, 'count=' + hostTriggers.size + ' -> ' + Array.from(hostTriggers).join(','))

  const usedTriggers = new Set()
  const useRe = /fireTrigger\('([^']+)'/g
  while ((m = useRe.exec(front)) !== null) usedTriggers.add(m[1])
  for (const t of usedTriggers) {
    check('宿主声明了触发器 ' + t, hostTriggers.has(t))
  }
  // 默认槽位绑定的触发器也必须存在
  const slotRe = /trigger:\s*'([a-z]+\.[a-zA-Z]+)'/g
  while ((m = slotRe.exec(host)) !== null) {
    check('默认槽位触发器 ' + m[1] + ' 存在', hostTriggers.has(m[1]))
  }
}

console.log('\n[3] 前端调用的页面内函数都有定义')
{
  const named = [
    'applyAppearance',
    'positionCatImg',
    'recomputeGeom',
    'setPose',
    'buildCat',
    'bindCatEvents',
    'showBubble',
    'popBubble',
    'closeBubble',
    'singleHiss',
    'tripleHit',
    'shakeCat',
    'handleCatTap',
    'explode',
    'ensureFx',
    'resizeFx',
    'fxTick',
    'fireTrigger',
    'slotFor',
    'pickSound',
    'playSound',
    'stopAllAudio',
    'audioContext',
    'soundUrl',
    'startTitleFlash',
    'stopTitleFlash',
    'webNotify',
    'requestNotifyPermission',
    'openSettings',
    'selectTab',
    'renderAllPanes',
    'renderLookPane',
    'renderAudioPane',
    'renderNotifyPane',
    'renderPeakPane',
    'renderAboutPane',
    'slotCard',
    'row',
    'checkbox',
    'numberInput',
    'textInput',
    'rangeInput',
    'button',
    'openCropper',
    'encodeWav',
    'pickAndCrop',
    'runTurnEndDelivery',
    'connectEvents',
    'refreshStatus',
    'startPolling',
    'checkAlerts',
    'injectStyle',
    'bootUp',
    'persist',
    'savePosition',
    'applyFlipOnly',
    'bubbleData',
    'fmtDuration',
    'fmtMoney',
    'fmtTokens',
    'clamp',
    'json',
    'deepMerge',
    'uid',
    'el',
    'css',
    'bjKey',
  ]
  const missing = []
  for (const name of named) {
    const declared =
      new RegExp('function\\s+' + name + '\\s*\\(').test(front) ||
      new RegExp('var\\s+' + name + '\\s*=').test(front)
    if (!declared) missing.push(name)
  }
  check('全部 ' + named.length + ' 个函数都有定义', missing.length === 0, missing.join(', '))
}

console.log('\n[4] 关键交互存在')
{
  check('点破气泡会掐断音效', /function popBubble[\s\S]{0,900}stopAllAudio\(TAG\.notify\)/.test(front) && /function popBubble[\s\S]{0,900}stopAllAudio\(TAG\.click\)/.test(front))
  check('循环播放的音也会被先停掉（避免叠加）', /if \(!loop\) stopAllAudio\(TAG\.notify\)/.test(front))
  check('闹钟气泡显示自定义文字', /function showAlarmBubble/.test(front) && /extraText: head \+ when/.test(front))
  check('事件流处理 alarm / turn-end', /payload\.type === 'alarm'/.test(front) && /payload\.type === 'turn-end'/.test(front))
  check('拖动：pointerdown/move/up 三件套', /root\.addEventListener\('pointerdown'/.test(front) && /root\.addEventListener\('pointermove'/.test(front) && /root\.addEventListener\('pointerup'/.test(front))
  check('拖动后保存位置', /savePosition\(\)/.test(front))
  check('滚轮缩放', /addEventListener\(\s*'wheel'/.test(front))
  check('缩放范围限制在 0.3–3.5', /clamp\([^)]*0\.3,\s*3\.5\)/.test(front))
  check('右键打开设置', /addEventListener\('contextmenu'/.test(front) && /openSettings\(\)/.test(front))
  check('三连击判定存在', /cat\.clicks\s*>=\s*3/.test(front))
  check('三连击使用哈气图（不额外要攻击图）', /function tripleHit[\s\S]{0,200}setPose\('hiss'/.test(front))
  check('粒子爆炸用 canvas', /createRadialGradient/.test(front) && /md-fx/.test(front))
}

console.log('\n[5] 音频裁剪器能力齐全')
{
  check('波形绘制', /function drawWave/.test(front))
  check('峰值分桶', /function peakBuckets/.test(front))
  check('缩放波形（含滚轮）', /function applyZoom/.test(front) && /addEventListener\(\s*'wheel'[\s\S]{0,400}applyZoom/.test(front))
  check('双边界拖动条', /md-dual-thumb/.test(front) && /function dualDrag/.test(front))
  check('毫秒级数字输入', /startNum\.step = '0\.001'/.test(front) && /endNum\.step = '0\.001'/.test(front))
  check('选区循环试听', /srcNode\.loop = true/.test(front) && /loopStart/.test(front) && /loopEnd/.test(front))
  check('首尾淡入淡出（可开关）', /cfg\.fadeEnabled === false \? 0/.test(front) && /fadeEnabled/.test(front))
  check('音量归一化', /cfg\.normalize === true/.test(front) && /0\.891 \/ peak/.test(front))
  check('自动去首尾静音', /silenceBtn\.addEventListener/.test(front) && /threshold = 0\.012/.test(front))
  check('导出 16-bit PCM WAV（手写 RIFF）', /function encodeWav/.test(front) && /writeStr\(0, 'RIFF'\)/.test(front) && /setInt16/.test(front))
  check('导出后上传到宿主', /upload-sound\.json/.test(front))
}

console.log('\n[6] 图片对齐与动画')
{
  check('按 alpha 包围盒定义了两张图', /bboxW: 1051, bboxH: 1853/.test(front) && /bboxW: 1015, bboxH: 1607/.test(front))
  check('几何在 JS 里算成像素（不依赖 CSS 单位混算）', /function recomputeGeom/.test(front) && /style\.width = Math\.round\(geom\.wpx\)/.test(front))
  check('摇晃动画（三连击）', /@keyframes mdShake/.test(front) && /md-shake/.test(front))
  check('气泡分两层错时浮现（啵出感）', /md-bubble-shape/.test(front) && /md-bubble-body/.test(front) && /transition:opacity \.16s ease \.10s/.test(front))
  check('气泡带小尾巴', /md-bubble-shape::after/.test(front))
  check('贴左水平翻转', /data-flip/.test(front) && /scaleX\(-1\)/.test(front))
}

console.log('\n[7] 前端不硬编码宿主内部路径')
{
  check('前端没有出现 ~/.dsh 之类的写死路径', !/\.dsh[\\/]/.test(front))
  check('前端不引用 whale', !/whale/i.test(front))
  check('前端没有 GitHub 仓库写死地址', !/github\.com\//i.test(front))
}

console.log('\n=== 结果：' + passed + ' 通过 / ' + failed + ' 失败 ===')
if (failures.length) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  - ' + f))
}
process.exit(failed === 0 ? 0 : 1)
