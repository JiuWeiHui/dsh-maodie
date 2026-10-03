// 修 AC4 锚点：status 路由是 async 且带 refresh 判断，锚 sendJson 那一段
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), '.build', 'host18.mjs')
let s = fs.readFileSync(p, 'utf8')
const a = `rep(
  'AC4 status 时同步选择',
  \`      handler: (req, res) => {
        const alarms = alarmSchedule()
        const out = {\`,
  \`      handler: (req, res) => {
        // 每次状态轮询都对齐一次「当前供应商/模型」——这样在模型列表里一切换，
        // 气泡与「用量」页最多 30 秒就跟着换成那家的余额与消耗（不用等下一轮对话）
        mdSyncModelSelection()
        const alarms = alarmSchedule()
        const out = {\`,
)`
const b = `rep(
  'AC4 status 时同步选择',
  \`        sendJson(res, 200, {
          ok: true,
          peak: peakInfo(),\`,
  \`        // 每次状态轮询都对齐一次「当前供应商/模型」——这样在模型列表里一切换，
        // 气泡与「用量」页最多 30 秒就跟着换成那家的余额与消耗（不用等下一轮对话）
        mdSyncModelSelection()
        sendJson(res, 200, {
          ok: true,
          peak: peakInfo(),\`,
)`
if (s.indexOf(a) === -1) {
  console.error('锚点没找到')
  process.exit(1)
}
fs.writeFileSync(p, s.split(a).join(b))
console.log('ok  AC4 锚点已修正')
