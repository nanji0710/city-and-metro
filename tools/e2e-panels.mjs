/**
 * 侧栏面板的横向溢出核查（17 个页面）。
 *
 * 为什么要有这一条：右侧面板是固定 368px 的抽屉（css/style.css #rightPanel），
 * 里面所有栅格只要有一列用裸 `1fr`，列宽下限就是 min-content —— 卡片里一句
 * `white-space: nowrap` 的文案就能把整行撑宽；`.p-body` 是 `overflow-y: auto`，
 * 按规范另一轴会算成 auto，于是整个面板出现横向滚动条，玩家得左右拖着看。
 * 这类问题**不会报错、不会崩**，只会让界面「用起来别扭」，靠肉眼发现太晚
 * （雇第三个人之后才暴露，因为只有那时卡片才多到触发换行）。
 *
 * 断言：
 *  1. 17 个页面都能打开
 *  2. #rightPanel 的 scrollWidth === clientWidth（面板本身不横向滚动）
 *  3. .p-body 的 scrollWidth <= clientWidth（正文不横向滚动）
 *  4. 正文里没有任何元素的右边缘越过面板内边距
 *  5. 0 console error
 *
 * 前置状态刻意造成「最挤」的样子：开广州局（4 条线）、雇 3 个人、有公司分部。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9599
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-panels')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PAGES = ['staff', 'ops', 'finance', 'company', 'line', 'station', 'multi', 'road', 'zone', 'facility', 'metric', 'date', 'tasks', 'saves', 'help', 'data', 'build']

async function main() {
  mkdirSync(PROFILE, { recursive: true })
  let proc = null
  for (const exe of EDGE) {
    try {
      proc = spawn(exe, [
        `--remote-debugging-port=${PORT}`,
        '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${PROFILE}`, '--window-size=1680,1050', 'about:blank',
      ], { stdio: 'ignore' })
      break
    } catch (e) { /* next */ }
  }
  if (!proc) throw new Error('找不到 Edge')

  let wsUrl = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.filter((x) => x.type === 'page').pop()
      if (t) { wsUrl = t.webSocketDebuggerUrl; break }
    } catch (e) { /* not ready */ }
  }
  if (!wsUrl) throw new Error('连不上 CDP')

  const ws = new WebSocket(wsUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  const errors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description || a.type).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text))
    }
  })
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result && r.result.exceptionDetails) throw new Error('页面内异常: ' + (r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text))
    return r.result && r.result.result ? r.result.result.value : null
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(2400)

  await evalJs(`(async () => {
    localStorage.clear();
    // 面板体检要直接开广州；用旧版全解锁公司绕过唯一入门图限制。
    if (CM.Company) {
      const seed = CM.Company.create('面板旧公司', 'guangzhou');
      if (seed.ok) CM.Company.setActive(seed.company.id);
    }
    CM.newGame({ map: 'guangzhou', mode: 'challenge', difficulty: 'normal', name: '面板体检' });
    for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    for (let i = 0; i < 120 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
    try { CM.ui.closeScreen(); } catch (e) {}
    try { CM.ui.closePanel(true); } catch (e) {}
    for (let k = 0; k < 3; k++) { const c = g.staff.market[k]; if (c) g.staff.hire(c.id, null, g.econ); }
    g.invalidateStaff && g.invalidateStaff(); g.rev++;
    return 'ready';
  })()`)
  await sleep(800)

  const MEASURE = (page) => `(async () => {
    try { CM.ui.openPage('${page}', null, { root: true }); }
    catch (e) { return JSON.stringify({ page: '${page}', open: false, err: String(e && e.message || e) }); }
    await new Promise(r => setTimeout(r, 600));
    const panel = document.getElementById('rightPanel');
    const body = panel && panel.querySelector('.p-body');
    if (!panel || !body) return JSON.stringify({ page: '${page}', open: false, err: 'no #rightPanel/.p-body' });
    const pr = panel.getBoundingClientRect();
    const inner = pr.right - 14; // .p-body 右侧 padding
    const bad = [];
    for (const el of body.querySelectorAll('*')) {
      const br = el.getBoundingClientRect();
      if (!br.width || br.width < 1) continue;
      const over = Math.round(br.right - inner);
      if (over > 0.5) bad.push({ t: el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0], w: Math.round(br.width), over });
    }
    bad.sort((a, b) => b.over - a.over);
    return JSON.stringify({
      page: '${page}', open: true,
      panelSW: panel.scrollWidth, panelCW: panel.clientWidth,
      bodySW: body.scrollWidth, bodyCW: body.clientWidth,
      overCount: bad.length, over: bad.slice(0, 4),
    });
  })()`

  const rows = []
  for (const page of PAGES) rows.push(JSON.parse(await evalJs(MEASURE(page))))

  let fail = 0
  for (const r of rows) {
    if (!r.open) { console.log(`✗ ${r.page.padEnd(9)} 打不开：${r.err}`); fail++; continue }
    const okPanel = r.panelSW <= r.panelCW
    const okBody = r.bodySW <= r.bodyCW
    const okOver = r.overCount === 0
    if (okPanel && okBody && okOver) {
      console.log(`✓ ${r.page.padEnd(9)} panel ${r.panelSW}/${r.panelCW}  body ${r.bodySW}/${r.bodyCW}`)
    } else {
      fail++
      console.log(`✗ ${r.page.padEnd(9)} panel ${r.panelSW}/${r.panelCW}  body ${r.bodySW}/${r.bodyCW}  over=${r.overCount}`)
      for (const o of r.over) console.log(`             +${o.over}px  ${o.t} (w=${o.w})`)
    }
  }

  if (errors.length) { fail++; console.log('✗ console error: ' + errors.slice(0, 3).join(' | ')) }
  else console.log('✓ 0 console error')

  console.log(fail ? `\n✗ ${fail} 项未通过` : `\n✓ 全部 ${rows.length} 个页面无横向溢出`)
  ws.close()
  proc.kill()
  await sleep(300)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
