// mount 回归：检查更新 / dryRun 预演 / sha 校验 / 白名单与路径穿越 / 真实写入（在临时目录里做）
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')

const p = path.join(ROOT, 'test', 'mount.test.mjs')
let s = fs.readFileSync(p, 'utf8')
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

// 1) 造 tgz 的工具 + 更新相关的可变桩
rep(
  'AV1 造包工具与桩变量',
  `const realFetch = globalThis.fetch
let fetchCalls = []`,
  `const realFetch = globalThis.fetch
let fetchCalls = []
// —— 造一个最小可用的 npm 包（tgz = gzip + ustar tar），给"检查更新/一键更新"测试用 ——
function tarEntry(name, data) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\\0', 100, 'ascii')
  header.write('0000000\\0', 108, 'ascii')
  header.write('0000000\\0', 116, 'ascii')
  header.write(data.length.toString(8).padStart(11, '0') + '\\0', 124, 'ascii')
  header.write('00000000000\\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  header.write(sum.toString(8).padStart(6, '0') + '\\0 ', 148, 'ascii')
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  Buffer.from(data).copy(body)
  return Buffer.concat([header, body])
}
function makeTgz(entries) {
  const parts = entries.map(([n, d]) => tarEntry(n, d))
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]))
}
// 更新检查的桩：改这几个变量即可模拟不同场景
let latestTag = 'v9.9.9'
let assetDigest = ''
let assetBytes = null`,
)

rep(
  'AV2 引入 zlib/crypto',
  `import { fileURLToPath, pathToFileURL } from 'node:url'`,
  `import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import nodeCrypto from 'node:crypto'`,
)

// 2) fetch 桩加两个分支
rep(
  'AV3 fetch 桩分支',
  `  if (u.includes('example.test/notjson')) {`,
  `  if (u.includes('api.github.com/repos/JiuWeiHui/dsh-maodie/releases/latest')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: latestTag,
        html_url: 'https://github.com/JiuWeiHui/dsh-maodie/releases/tag/' + latestTag,
        body: '## 测试版\\n- 新增某功能',
        published_at: '2026-10-03T00:00:00Z',
        assets: assetBytes
          ? [
              {
                name: 'dsh-maodie-9.9.9.tgz',
                size: assetBytes.length,
                browser_download_url: 'https://example.test/upd.tgz',
                digest: assetDigest,
              },
            ]
          : [],
      }),
    }
  }
  if (u.includes('example.test/upd.tgz')) {
    return { ok: true, status: 200, arrayBuffer: async () => assetBytes }
  }
  if (u.includes('example.test/notjson')) {`,
)

// 3) 新增 [26]
rep(
  'AV4 新增 [26]',
  `// ---------------------------------------------------------------- 收尾
globalThis.fetch = realFetch`,
  `console.log('\\n[26] 检查更新 + 一键更新（预演 / 校验 / 白名单 / 真实写入）')
{
  const tgz = makeTgz([
    ['package/lib/index.js', '// fake new lib'],
    ['package/assets/maodie.js', '// fake new front'],
    ['package/cordis.patch.yml', '- insert: []'],
    ['package/README.md', '# fake readme'],
    ['package/test/mount.test.mjs', '// 不该被更新'],
    ['package/.build/secret.mjs', '// 不该被更新'],
    ['package/../evil.js', '// 路径穿越，必须被拒'],
  ])
  assetBytes = tgz
  const goodDigest = 'sha256:' + nodeCrypto.createHash('sha256').update(tgz).digest('hex')
  assetDigest = goodDigest
  latestTag = 'v9.9.9'

  const view0 = (await callRoute('/maodie/update.json')).json()
  check('update.json 给出当前版本', view0.update.current === '1.3.3', JSON.stringify(view0.update).slice(0, 120))
  check('默认自动检查开、自动安装关', view0.update.autoCheck === true && view0.update.autoInstall === false, JSON.stringify({ a: view0.update.autoCheck, b: view0.update.autoInstall }))

  const chk = (await callRoute('/maodie/update-check.json')).json()
  check('检查更新：发现新版本', chk.update.available === true && chk.update.latest === '9.9.9', JSON.stringify(chk.raw))
  check('检查更新：带资产与说明', !!(chk.update.asset && chk.update.asset.name === 'dsh-maodie-9.9.9.tgz') && chk.update.notes.indexOf('测试版') !== -1, JSON.stringify(chk.update.asset))
  check('检查更新：记录时间戳', typeof chk.update.checkedAt === 'number' && chk.update.checkedAt > 0)
  check('检查更新：暴露 Release 地址', String(chk.update.url).indexOf('/releases/tag/v9.9.9') !== -1, chk.update.url)

  // 预演：只报告，不动磁盘
  const dry = (await callRoute('/maodie/update-apply.json', 'POST', { dryRun: true })).json()
  const paths = (dry.files || []).map((f) => f.path)
  check('预演成功并列出文件', dry.ok === true && dry.dryRun === true && paths.length >= 4, JSON.stringify(paths))
  check('预演：白名单内的都在', ['lib/index.js', 'assets/maodie.js', 'cordis.patch.yml', 'README.md'].every((x) => paths.indexOf(x) !== -1), JSON.stringify(paths))
  check('预演：测试与开发文件被排除', paths.indexOf('test/mount.test.mjs') === -1 && paths.every((x) => x.indexOf('.build') === -1), JSON.stringify(paths))
  check('预演：路径穿越被拒', paths.every((x) => x.indexOf('..') === -1) && paths.every((x) => !x.startsWith('/')), JSON.stringify(paths))
  check('预演：算出下载内容的 sha256', dry.sha256 === goodDigest.replace('sha256:', ''), String(dry.sha256))

  // sha 不一致 → 中止且不改文件
  const realIndex = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8')
  assetDigest = 'sha256:' + 'f'.repeat(64)
  const bad = (await callRoute('/maodie/update-apply.json', 'POST', {})).json()
  check('sha 不一致时拒绝安装', bad.ok === false && String(bad.error).indexOf('校验失败') !== -1, JSON.stringify(bad.error))
  check('sha 不一致时没动任何文件', fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8') === realIndex)
  assetDigest = goodDigest

  // 版本比较
  latestTag = 'v1.3.3'
  check('同版本不算更新', (await callRoute('/maodie/update-check.json')).json().update.available === false)
  latestTag = 'v1.3.2'
  check('更低版本不算更新', (await callRoute('/maodie/update-check.json')).json().update.available === false)
  latestTag = 'v1.3.5'
  check('更高版本才算更新', (await callRoute('/maodie/update-check.json')).json().update.available === true)
  latestTag = 'v9.9.9'
  await callRoute('/maodie/update-check.json')

  // 真实写入：改到临时目录里做（同时验证备份、白名单、排除项）
  const tmpTarget = path.join(tmp, 'plugin-target')
  fs.mkdirSync(path.join(tmpTarget, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(tmpTarget, 'package.json'), JSON.stringify({ name: 'dsh-maodie', version: '1.3.3' }))
  fs.writeFileSync(path.join(tmpTarget, 'lib', 'index.js'), '// OLD lib')
  process.env.MAODIE_UPDATE_TARGET = tmpTarget
  const applied = (await callRoute('/maodie/update-apply.json', 'POST', {})).json()
  delete process.env.MAODIE_UPDATE_TARGET
  check('执行更新成功', applied.ok === true && String(applied.version) === '9.9.9', JSON.stringify({ ok: applied.ok, v: applied.version, err: applied.error }))
  check('新内容写进去了', fs.readFileSync(path.join(tmpTarget, 'lib', 'index.js'), 'utf8').indexOf('fake new lib') !== -1)
  check('新生效文件也写了', fs.readFileSync(path.join(tmpTarget, 'assets', 'maodie.js'), 'utf8').indexOf('fake new front') !== -1)
  check('旧文件被备份', fs.existsSync(path.join(tmpTarget, '.update-backup-1.3.3', 'lib', 'index.js')) && fs.readFileSync(path.join(tmpTarget, '.update-backup-1.3.3', 'lib', 'index.js'), 'utf8') === '// OLD lib')
  check('测试与开发文件没被写进去', !fs.existsSync(path.join(tmpTarget, 'test')) && !fs.existsSync(path.join(tmpTarget, '.build')))
  check('路径穿越文件没被写出去', !fs.existsSync(path.join(tmp, 'evil.js')))
  check('提示重启生效', String(applied.note).indexOf('重启') !== -1, applied.note)
  check('更新状态里带上已安装版本', (await callRoute('/maodie/update.json')).json().update.latest === '9.9.9')

  // 自动检查可以关
  await callRoute('/maodie/state.json', 'POST', { state: { update: { autoCheck: false, autoInstall: false } } })
  check('自动检查可关闭', (await callRoute('/maodie/update.json')).json().update.autoCheck === false)
  await callRoute('/maodie/state.json', 'POST', { state: { update: { autoCheck: true, autoInstall: false } } })

  // 目标目录不像本插件时拒绝写入
  const bogus = path.join(tmp, 'bogus')
  fs.mkdirSync(bogus, { recursive: true })
  fs.writeFileSync(path.join(bogus, 'package.json'), JSON.stringify({ name: 'something-else' }))
  process.env.MAODIE_UPDATE_TARGET = bogus
  const refused = (await callRoute('/maodie/update-apply.json', 'POST', {})).json()
  delete process.env.MAODIE_UPDATE_TARGET
  check('目标目录不对时拒绝更新', refused.ok === false && String(refused.error).indexOf('不像本插件') !== -1, JSON.stringify(refused.error))
}

// ---------------------------------------------------------------- 收尾
globalThis.fetch = realFetch`,
)

fs.writeFileSync(p, s.split('\n').join(eol))
console.log('written test/mount.test.mjs')
