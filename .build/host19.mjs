// Host patch 18 (1.3.4)：检查更新（GitHub Releases）+ 可选一键更新（下载→校验 sha256→解包→白名单覆盖，带备份与 dryRun）
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

// 1) 更新模块本体
rep(
  'AU1 更新模块',
  `  const mdProvidersView = () => {`,
  `  // ---------------- 检查更新 / 一键更新 ----------------
  // 版本信息取自 GitHub Releases（api.github.com 在国内可直连；主站 github.com 通常需要代理）
  const MD_UPDATE_REPO = 'JiuWeiHui/dsh-maodie'
  const MD_UPDATE_ALLOW = /^(lib\\/|assets\\/|cordis\\.patch\\.yml$|README\\.md$|LICENSE$|THIRD-PARTY-NOTICES\\.md$|package\\.json$)/

  const mdUpdateCfg = () => ({
    autoCheck: !(state.update && state.update.autoCheck === false),
    autoInstall: !!(state.update && state.update.autoInstall),
  })

  const mdParseVer = (v) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((x) => parseInt(x, 10) || 0)

  // 比较版本：a>b 返回 1，a<b 返回 -1，相等 0
  const mdVerCmp = (a, b) => {
    const x = mdParseVer(a)
    const y = mdParseVer(b)
    for (let i = 0; i < 3; i++) {
      const p = x[i] || 0
      const q = y[i] || 0
      if (p !== q) return p > q ? 1 : -1
    }
    return 0
  }

  // 相对路径安全化：拒绝绝对路径、盘符、..、空段
  const mdSafeRel = (p) => {
    const clean = String(p || '')
      .replace(/\\\\/g, '/')
      .replace(/^\\.\\//, '')
    if (!clean) return null
    if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return null
    const segs = clean.split('/')
    for (const seg of segs) if (seg === '' || seg === '.' || seg === '..') return null
    return clean
  }

  // 极简 tar 解析（npm 的 .tgz = gzip + ustar tar）：只取普通文件，特殊块按长度跳过
  const mdUntarGz = async (buf) => {
    const zlib = await import('node:zlib')
    const tar = zlib.gunzipSync(buf)
    const out = []
    const readStr = (b, start, len) => {
      let end = b.indexOf(0, start)
      if (end === -1 || end > start + len) end = start + len
      return b.toString('utf8', start, end).trim()
    }
    let off = 0
    while (off + 512 <= tar.length) {
      const header = tar.subarray(off, off + 512)
      let allZero = true
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) {
          allZero = false
          break
        }
      }
      if (allZero) break
      const name = readStr(header, 0, 100)
      const size = parseInt(readStr(header, 124, 12), 8) || 0
      const type = String.fromCharCode(header[156] || 48)
      const prefix = readStr(header, 345, 155)
      const full = prefix ? prefix + '/' + name : name
      const dataStart = off + 512
      if ((type === '0' || type === '') && full) out.push({ path: full, data: tar.subarray(dataStart, dataStart + size) })
      off = dataStart + Math.ceil(size / 512) * 512
    }
    return out
  }

  const mdUpdateView = () => {
    const u = runtime.update || {}
    const cfg = mdUpdateCfg()
    let hasGit = false
    try {
      hasGit = fs.existsSync(path.join(PACKAGE_ROOT, '.git'))
    } catch (err) {
      hasGit = false
    }
    return {
      current: PLUGIN_VERSION,
      latest: u.latest || '',
      available: !!u.available,
      checkedAt: u.checkedAt || null,
      checking: !!u.checking,
      error: u.error || '',
      url: u.url || '',
      notes: u.notes || '',
      publishedAt: u.publishedAt || '',
      asset: u.asset ? { name: u.asset.name, size: u.asset.size, digest: u.asset.digest || '' } : null,
      installedAt: u.installedAt || null,
      appliedVersion: u.appliedVersion || '',
      backupDir: u.backupDir || '',
      autoCheck: cfg.autoCheck,
      autoInstall: cfg.autoInstall,
      hasGit,
      target: PACKAGE_ROOT,
    }
  }

  // 查最新 Release；顺带（仅当用户开了自动安装时）自动装
  const mdCheckUpdate = async () => {
    runtime.update = Object.assign({}, runtime.update, { checking: true })
    try {
      const res = await fetch('https://api.github.com/repos/' + MD_UPDATE_REPO + '/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-maodie/' + PLUGIN_VERSION },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      const latest = String((data && data.tag_name) || '').replace(/^v/i, '')
      const assets = (data && data.assets) || []
      const tgz = assets.find((a) => /\\.tgz$/i.test(String((a && a.name) || '')))
      const next = {
        checkedAt: Date.now(),
        checking: false,
        error: '',
        current: PLUGIN_VERSION,
        latest,
        available: !!latest && mdVerCmp(latest, PLUGIN_VERSION) > 0,
        url: (data && data.html_url) || '',
        notes: String((data && data.body) || '').slice(0, 4000),
        publishedAt: (data && data.published_at) || '',
        asset: tgz ? { name: tgz.name, size: tgz.size, url: tgz.browser_download_url, digest: tgz.digest || '' } : null,
      }
      runtime.update = next
      if (next.available && mdUpdateCfg().autoInstall) {
        const applied = await mdApplyUpdate({})
        runtime.update = Object.assign({}, runtime.update, { lastApply: applied, installedAt: applied.ok ? Date.now() : null })
      }
    } catch (err) {
      runtime.update = Object.assign({}, runtime.update, {
        checking: false,
        checkedAt: Date.now(),
        error: String((err && err.message) || err),
      })
    }
    return runtime.update
  }

  // 下载 + 校验 + 解包 + 白名单覆盖；dryRun=1 只报告要改哪些文件
  const mdApplyUpdate = async (opts) => {
    const dryRun = !!(opts && opts.dryRun)
    const u = runtime.update || {}
    if (!u.available || !u.asset || !u.asset.url) {
      return { ok: false, error: u.error ? '上次检查出错：' + u.error : '当前没有可用更新（先点「检查更新」）' }
    }
    // 安全阀：只往自己这个包里写
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
      if (pkg.name !== 'dsh-maodie') return { ok: false, error: '目标目录不像本插件（package.json.name=' + pkg.name + '），已中止' }
    } catch (err) {
      return { ok: false, error: '读不到目标目录的 package.json，已中止' }
    }
    let buf = null
    try {
      const res = await fetch(u.asset.url, {
        headers: { 'User-Agent': 'dsh-maodie/' + PLUGIN_VERSION },
        signal: AbortSignal.timeout(120000),
        redirect: 'follow',
      })
      if (!res.ok) return { ok: false, error: '下载失败 HTTP ' + res.status }
      buf = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      return { ok: false, error: '下载失败：' + String((err && err.message) || err) }
    }
    const crypto = await import('node:crypto')
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    const want = String(u.asset.digest || '').replace(/^sha256:/i, '')
    if (want && want !== sha256) {
      return { ok: false, error: '校验失败：下载内容与官方 sha256 不一致（已中止，没有改动任何文件）', sha256, expected: want }
    }
    let entries = []
    try {
      entries = await mdUntarGz(buf)
    } catch (err) {
      return { ok: false, error: '解包失败：' + String((err && err.message) || err) }
    }
    const picked = []
    for (const e of entries) {
      const rel = mdSafeRel(String(e.path || '').replace(/^package\\//, ''))
      if (!rel || !MD_UPDATE_ALLOW.test(rel)) continue
      picked.push({ path: rel, data: e.data })
    }
    if (!picked.length) return { ok: false, error: '包里没有可更新的文件（白名单没命中）' }
    const files = picked.map((p) => ({ path: p.path, bytes: p.data.length }))
    if (dryRun) {
      return { ok: true, dryRun: true, version: u.latest, sha256, files, target: PACKAGE_ROOT, note: '预演：没有改动任何文件' }
    }
    const backupDir = path.join(PACKAGE_ROOT, '.update-backup-' + PLUGIN_VERSION)
    const written = []
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      for (const p of picked) {
        const dest = path.join(PACKAGE_ROOT, p.path)
        if (fs.existsSync(dest)) {
          const bak = path.join(backupDir, p.path)
          fs.mkdirSync(path.dirname(bak), { recursive: true })
          fs.copyFileSync(dest, bak)
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, p.data)
        written.push(p.path)
      }
    } catch (err) {
      return { ok: false, error: '写入失败：' + String((err && err.message) || err) + '（旧文件备份在 ' + backupDir + '）', written }
    }
    return {
      ok: true,
      version: u.latest,
      files: written,
      backup: backupDir,
      note: '已更新 ' + written.length + ' 个文件，重启 DSH 生效',
    }
  }

  const mdProvidersView = () => {`,
)

// 2) 路由
rep(
  'AU2 更新路由',
  `    // —— 路由：投递某个闹钟（前端兜底用；同一分钟只投一次，不会重复响）——`,
  `    // —— 路由：查看更新状态 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/update.json',
      handler: (req, res) => sendJson(res, 200, { ok: true, update: mdUpdateView() }),
    })

    // —— 路由：立刻检查更新 ——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/update-check.json',
      handler: async (req, res) => {
        const r = await mdCheckUpdate()
        sendJson(res, 200, { ok: true, update: mdUpdateView(), raw: { latest: r.latest, available: !!r.available } })
      },
    })

    // —— 路由：执行更新（body { dryRun: true } 只预演）——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/update-apply.json',
      handler: async (req, res) => {
        const body = await readBody(req, 1 << 16)
        const dryRun = !!(body && body.dryRun)
        const r = await mdApplyUpdate({ dryRun })
        sendJson(res, 200, Object.assign({ ok: !!r.ok }, r, { update: mdUpdateView() }))
      },
    })

    // —— 路由：投递某个闹钟（前端兜底用；同一分钟只投一次，不会重复响）——`,
)

// 3) 启动时自动检查 + 每 6 小时一次
rep(
  'AU3 启动与定时检查',
  `    mdSyncModelSelection()
    mdRefreshCustomBalances().catch(() => {})`,
  `    mdSyncModelSelection()
    mdRefreshCustomBalances().catch(() => {})
    // 检查更新：启动时一次 + 每 6 小时一次（可在 设置→关于 关掉自动检查）
    if (mdUpdateCfg().autoCheck) mdCheckUpdate().catch(() => {})
    every('update', 6 * 3600 * 1000, () => {
      if (mdUpdateCfg().autoCheck) mdCheckUpdate().catch(() => {})
    })`,
)

// 4) status / diag 暴露
rep('AU4 status 暴露 update', `        modelCtx: runtime.modelCtx,`, `        modelCtx: runtime.modelCtx,\n        update: mdUpdateView(),`)
rep('AU5 diag 暴露 update', `        usage: mdUsageView(),`, `        usage: mdUsageView(),\n        update: mdUpdateView(),`)

// 5) diag 手动钩子
rep(
  'AU6 diag 钩子',
  `        // ?refreshBalances=1 立刻把所有自定义余额来源刷一遍
        try {
          if (/[?&]refreshBalances=1/.test(req.url || '')) await mdRefreshCustomBalances()
        } catch (err) {
          runtime.timerErrors.manualBalances = String((err && err.message) || err)
        }`,
  `        // ?refreshBalances=1 立刻把所有自定义余额来源刷一遍
        try {
          if (/[?&]refreshBalances=1/.test(req.url || '')) await mdRefreshCustomBalances()
        } catch (err) {
          runtime.timerErrors.manualBalances = String((err && err.message) || err)
        }
        // ?checkUpdate=1 立刻检查更新；?applyUpdate=dryRun 预演一次更新（都不改文件）
        try {
          if (/[?&]checkUpdate=1/.test(req.url || '')) await mdCheckUpdate()
        } catch (err) {
          runtime.timerErrors.manualUpdate = String((err && err.message) || err)
        }
        try {
          if (/[?&]applyUpdate=/.test(req.url || '')) runtime.lastApplyDryRun = await mdApplyUpdate({ dryRun: true })
        } catch (err) {
          runtime.timerErrors.manualApply = String((err && err.message) || err)
        }`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
