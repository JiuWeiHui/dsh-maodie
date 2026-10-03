  // ---------------- index 注入（唯一正确的入页通道） ----------------
  // 结构化注入行由 webServer 在**每次渲染 index 时**收集一遍：
  //   - 浏览器直连：frontend-static 的 fallback 渲染 index.html 时调 renderIndex()，
  //     把行渲染成真正的 <script>（head 行 = parser-blocking）
  //   - 桌面端：Electron 壳启动 Host 之后调 collectIndexInjections() 拿整张表，
  //     经 dshDesktopBoot.ready() 交回页面，由页面里的解释器逐行执行
  //     （script-src 行 = 建 <script src=…> 并 await load）
  // 行里只放 URL，脚本本体仍由 /maodie/maodie.js 路由下发：改前端不用重装插件。
  // 注意：这张表在桌面端只在 Host 启动时收集一次 → 新增/删除行要重启桌面端，
  //       但只改 scripts/前端脚本不需要（路由每次请求都重新读盘）。
  const INJECT_CACHE = {
    src: SCRIPT_SRC + '?v=' + PLUGIN_VERSION,
    enabled: true,
    rows: 0,
    lastEmitAt: 0,
    lastError: '',
  }

  const injectEnabled = () => {
    try {
      return !(state && state.security && state.security.injectMainWindow === false)
    } catch (err) {
      return true
    }
  }

  const installIndexInjector = () => {
    const src = INJECT_CACHE.src
    const handler = (table) => {
      try {
        if (!Array.isArray(table)) return
        INJECT_CACHE.enabled = injectEnabled()
        if (!INJECT_CACHE.enabled) return
        // 幂等：同一张表被重复收集时不要重复 push
        if (table.some((row) => row && row.kind === 'script-src' && row.src === src)) return
        const base = resolveWebBase()
        if (base) table.push({ kind: 'global', name: '__MAODIE_BASE__', value: base })
        // 提示性 preload：浏览器侧能提前开始下载；桌面端解释器会忽略这一行
        table.push({ kind: 'script-preload', src })
        table.push({ kind: 'script-src', placement: 'head', src })
        INJECT_CACHE.rows = table.length
        INJECT_CACHE.lastEmitAt = Date.now()
      } catch (err) {
        INJECT_CACHE.lastError = String((err && err.message) || err)
      }
    }
    const dispose = ctx.on('webserver/index-inject', handler)
    return typeof dispose === 'function' ? dispose : () => {}
  }

  // 诊断用：当前这张注入表里有没有我们那一行（Host 侧事实，与页面无关）
  const collectOurRows = () => {
    const rows = []
    try {
      if (ctx.webServer && typeof ctx.webServer.collectIndexInjections === 'function') {
        for (const row of ctx.webServer.collectIndexInjections()) {
          if (!row || typeof row !== 'object') continue
          if (row.kind === 'script-src' || row.kind === 'script-preload') {
            if (String(row.src || '').indexOf(SCRIPT_SRC) === 0) rows.push(row)
          } else if (row.kind === 'global' && row.name === '__MAODIE_BASE__') {
            rows.push(row)
          }
        }
      }
    } catch (err) {
      INJECT_CACHE.lastError = String((err && err.message) || err)
    }
    return rows
  }
