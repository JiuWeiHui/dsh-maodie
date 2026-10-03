// 前端 patch 14 (1.3.4)：设置→关于 的更新面板（版本显示、检查/立即更新、自动检查与自动安装开关、说明摘要、发布页链接）
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

rep(
  'AX1 关于页的更新面板',
  `    pane.appendChild(row('检查更新', button('检查', '', function () {
      alert('尚未配置仓库地址。把插件传到 GitHub 后，在 package.json 的 repository 字段填写仓库地址，这里就能检查更新了。')
    }), '仓库地址以后从 package.json 读取，不硬编码'))`,
  `    // —— 更新（版本来自 Host 读的 GitHub Releases）——
    var up = (status && status.update) || null
    var ubox = el('div', 'md-about')
    ubox.appendChild(el('div', 'md-about-title', '更新'))
    if (!up) {
      ubox.appendChild(el('div', 'md-dim', '宿主还没上报更新信息（重启 DSH 后就会出现）'))
    } else {
      ubox.appendChild(row('当前版本', el('span', 'md-v', String(up.current || '?'))))
      ubox.appendChild(
        row(
          '最新版本',
          el('span', 'md-v', up.latest ? up.latest + (up.available ? '（可更新）' : '（已是最新）') : '未检查'),
        ),
      )
      ubox.appendChild(
        el(
          'div',
          'md-dim',
          '最后检查：' +
            (up.checkedAt ? new Date(up.checkedAt).toLocaleString() : '还没检查过') +
            (up.error ? ' · 上次出错：' + up.error : '') +
            (up.checking ? ' · 正在检查…' : ''),
        ),
      )
      if (up.available) {
        var note = String(up.notes || '')
          .replace(/[#*\`>]/g, '')
          .replace(/\\s+/g, ' ')
          .trim()
        if (note) ubox.appendChild(el('div', 'md-dim', '更新说明：' + note.slice(0, 180) + (note.length > 180 ? '…' : '')))
        if (up.asset) {
          ubox.appendChild(
            el(
              'div',
              'md-dim',
              '安装包：' + up.asset.name + '（' + Math.round(((up.asset.size || 0) / 1048576) * 10) / 10 + ' MB' + (up.asset.digest ? '，带官方 sha256' : '') + '）',
            ),
          )
        }
      }
      if (up.installedAt) {
        ubox.appendChild(
          el('div', 'md-dim', '✅ 已更新到 ' + (up.appliedVersion || up.latest) + '（' + new Date(up.installedAt).toLocaleString() + '）· 重启 DSH 生效'),
        )
        if (up.backupDir) ubox.appendChild(el('div', 'md-dim', '旧文件备份：' + up.backupDir))
      }
      var urow = el('div', 'md-row')
      var checkBtn = button(up.checking ? '检查中…' : '检查更新', 'md-btn-mini', function () {
        checkBtn.textContent = '检查中…'
        json(api('/update-check.json'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) {
            if (r && r.update) {
              if (!status) status = {}
              status.update = r.update
            }
            renderAboutPane()
          })
          .catch(function (err) {
            checkBtn.textContent = '检查更新'
            alert('检查更新失败：' + String((err && err.message) || err))
          })
      })
      urow.appendChild(checkBtn)
      if (up.available) {
        urow.appendChild(
          button('立即更新', 'md-btn-mini', function () {
            var btn = this
            btn.textContent = '准备中…'
            json(api('/update-apply.json'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dryRun: true }),
            })
              .then(function (dry) {
                if (!dry || !dry.ok) {
                  btn.textContent = '立即更新'
                  alert('更新预演失败：' + ((dry && dry.error) || '未知错误'))
                  return null
                }
                var list = (dry.files || [])
                  .map(function (f) {
                    return '　' + f.path
                  })
                  .join('\\n')
                if (!window.confirm('将更新 ' + list.split('\\n').length + ' 个文件到 ' + dry.version + '：\\n' + list + '\\n\\n旧文件会先备份到插件目录下。继续？')) {
                  btn.textContent = '立即更新'
                  return null
                }
                btn.textContent = '下载中…'
                return json(api('/update-apply.json'), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                }).then(function (r) {
                  if (r && r.ok) alert('已更新到 ' + r.version + '：' + (r.note || '') + '\\n备份：' + r.backup)
                  else alert('更新失败：' + ((r && r.error) || '未知错误'))
                  return refreshStatus().then(function () {
                    renderAboutPane()
                  })
                })
              })
              .catch(function (err) {
                btn.textContent = '立即更新'
                alert('更新失败：' + String((err && err.message) || err))
              })
          }),
        )
      }
      if (up.url) {
        urow.appendChild(
          button('打开发布页', 'md-btn-mini', function () {
            try {
              window.open(up.url, '_blank')
            } catch (err) {
              alert(up.url)
            }
          }),
        )
      }
      ubox.appendChild(urow)
      ubox.appendChild(
        row(
          '自动检查更新',
          checkbox(up.autoCheck !== false, function (v) {
            if (!state.update) state.update = {}
            state.update.autoCheck = v
            persist()
          }),
          '启动后查一次 + 每 6 小时一次',
        ),
      )
      ubox.appendChild(
        row(
          '自动下载并安装',
          checkbox(up.autoInstall === true, function (v) {
            if (!state.update) state.update = {}
            state.update.autoInstall = v
            persist()
          }),
          '默认关；开启后检查到新版本会直接装上（仍需重启 DSH 生效）',
        ),
      )
      ubox.appendChild(
        el(
          'div',
          'md-dim',
          '更新目标：' +
            (up.target || '?') +
            (up.hasGit ? '　⚠️ 这是 git 工作区：更新会改动 lib/ 与 assets/，想还原用 git checkout .' : ''),
        ),
      )
    }
    pane.appendChild(ubox)`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
