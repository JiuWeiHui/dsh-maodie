// 把本地 profile 的安装从 maodie 改名到 dsh-maodie（与打包后的模块名一致）
// 动的东西：junction 名、profile package.json 的依赖键与 bundles 列表、pnpm-lock 的键
// 全部先备份；旧的 maodie junction 先留着（零风险），验证通过后再删。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PLUGIN = 'C:\\Users\\rennanchuan\\Desktop\\dsh-maodie'
const profile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const nm = path.join(profile, 'node_modules')

function backup(file) {
  const p = path.join(profile, file)
  if (!fs.existsSync(p)) return
  const b = p + '.bak-rename'
  if (!fs.existsSync(b)) {
    fs.copyFileSync(p, b)
    console.log('  备份 ' + file + ' -> ' + file + '.bak-rename')
  } else {
    console.log('  备份已存在，跳过 ' + file)
  }
}

console.log('=== 1) 备份 ===')
backup('package.json')
backup('pnpm-lock.yaml')

console.log('=== 2) 新建 junction node_modules/dsh-maodie ===')
const link = path.join(nm, 'dsh-maodie')
if (fs.existsSync(link)) {
  console.log('  已存在，跳过')
} else {
  execFileSync('cmd', ['/c', 'mklink', '/J', link, PLUGIN], { stdio: 'inherit' })
  console.log('  建好 -> ' + PLUGIN)
}

console.log('=== 3) profile package.json：依赖键 + bundles ===')
const pjPath = path.join(profile, 'package.json')
const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
if (pj.dependencies && pj.dependencies.maodie) {
  pj.dependencies['dsh-maodie'] = pj.dependencies.maodie
  delete pj.dependencies.maodie
  console.log('  dependencies.maodie -> dsh-maodie')
}
const bundles = (pj.dsh && pj.dsh.profile && pj.dsh.profile.bundles) || []
const idx = bundles.indexOf('maodie')
if (idx !== -1) {
  bundles[idx] = 'dsh-maodie'
  console.log('  bundles[' + idx + ']: maodie -> dsh-maodie')
}
fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n')
console.log('  写入完成')

console.log('=== 4) pnpm-lock.yaml 的键 ===')
const lockPath = path.join(profile, 'pnpm-lock.yaml')
let lock = fs.readFileSync(lockPath, 'utf8')
const before = lock
lock = lock.split('\n  maodie:\n').join('\n  dsh-maodie:\n')
if (lock !== before) {
  fs.writeFileSync(lockPath, lock)
  console.log('  锁文件键已改')
} else {
  console.log('  （锁文件里没有 maodie: 这个键，跳过）')
}

console.log('=== 5) 结果 ===')
console.log(fs.readFileSync(pjPath, 'utf8'))
console.log('node_modules 里的链接：')
for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
  if (e.name === 'maodie' || e.name === 'dsh-maodie') {
    const full = path.join(nm, e.name)
    console.log('  ' + e.name + ' -> ' + (fs.realpathSync(full) || '?'))
  }
}
