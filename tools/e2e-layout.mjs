/* 多分辨率布局回归：顶栏、全国图在常见窗口尺寸下不能溢出或互相重叠。
 * 覆盖 1920 → 390 共 12 档宽度，以及「界面大小」缩放 1.15 / 0.9。
 * 用法：node tools/e2e-layout.mjs（需要 4180 端口上的 dev server） */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 9533)
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-layout')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let fails = 0
const check = (name, ok, extra) => { if (!ok) fails++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')) }

mkdirSync(PROFILE, { recursive: true })
const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu', '--disable-extensions',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${PROFILE}`, '--window-size=1680,1050',
  'about:blank',
], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 60; i++) {
  await sleep(250)
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const t = l.filter(x => x.type === 'page').pop(); if (t) { wsUrl = t.webSocketDebuggerUrl; break } } catch (e) {}
}
if (!wsUrl) throw new Error('连不上 CDP')
const ws = new WebSocket(wsUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map(); const errors = []
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push((m.params.args || []).map(a => a.value || a.description).join(' '))
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION ' + (m.params.exceptionDetails.text || ''))
})
const send = (method, params) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
const evalJs = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result && r.result.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text)
  return r.result && r.result.result ? r.result.result.value : null
}
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE }); await sleep(2800)
for (let i = 0; i < 80 && !(await evalJs('!!window.CM')); i++) await sleep(100)

// 开一局温州战役（带第一份合同，顶栏目标胶囊可见），保证测的是真实游戏 HUD。
const start = await evalJs(`(async () => {
  localStorage.clear();
  CM.Atlas.open(); await new Promise(r=>setTimeout(r,350));
  const btn = Array.from(document.querySelectorAll('#atlas button')).find(b => (b.innerText||'').includes('开始新手战役'));
  btn.click();
  for (let i=0;i<300&&!CM.game;i++) await new Promise(r=>setTimeout(r,100));
  for (let i=0;i<120&&CM.game&&(!CM.game.city.roadGroups||!CM.game.city.roadGroups.length||CM.game.pending);i++) await new Promise(r=>setTimeout(r,200));
  CM.Tutorial.detach(true);
  await new Promise(r=>setTimeout(r,500));
  return JSON.stringify({ map: CM.game && CM.game.mapId });
})()`)
check('温州战役开局', start && start.indexOf('wenzhou') >= 0, start)

const SIZES = [[1920, 1080], [1680, 1050], [1600, 900], [1440, 900], [1366, 768], [1280, 800], [1152, 864], [1024, 768], [960, 640], [900, 600], [800, 600], [760, 900], [390, 844]]
for (const [w, h] of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(420)
  const r = JSON.parse(await evalJs(`(() => {
    const rect = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width) }; };
    const hit = (a, b) => !(a.r <= b.x + 1 || b.r <= a.x + 1 || a.b <= b.y + 1 || b.b <= a.y + 1);
    const top = document.getElementById('hudTop');
    const vw = innerWidth;
    const items = Array.from(top.children).filter(e => !e.classList.contains('hidden') && e.getBoundingClientRect().width > 0)
      .map(e => ({ cls: e.className.replace(/\\s+/g, '.'), ...rect(e) }));
    const overlaps = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (hit(items[i], items[j])) overlaps.push(items[i].cls + '×' + items[j].cls);
    const outside = items.filter(x => x.r > vw + 1 || x.x < -1).map(x => x.cls + '@' + x.r);
    const m = top.querySelector('.cluster.metrics');
    // 资金胶囊是指标栏里的第一个 .pill（日期胶囊也在 .pill 之列，必须限定在 metrics 内找）。
    const money = m ? m.querySelector('.pill') : null;
    const mr = m ? m.getBoundingClientRect() : null, pr = money ? money.getBoundingClientRect() : null;
    return JSON.stringify({
      barOver: top.scrollWidth > top.clientWidth + 1,
      overlaps: overlaps, outside: outside,
      moneyVisible: !!(mr && pr && pr.width > 4 && pr.right <= mr.right + 1),
    });
  })()`))
  check(w + '×' + h + ' 顶栏不溢出', r.barOver === false, r)
  check(w + '×' + h + ' 顶栏不重叠/不出屏', r.overlaps.length === 0 && r.outside.length === 0, r)
  check(w + '×' + h + ' 资金胶囊可见', r.moneyVisible === true, r)
  // 全国图：顶栏条不出屏、各行控件不重叠
  const a = JSON.parse(await evalJs(`(async () => {
    CM.Atlas.open(); await new Promise(r=>setTimeout(r,380));
    const rect = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
    const hit = (a2, b2) => !(a2.r <= b2.x + 1 || b2.r <= a2.x + 1 || a2.b <= b2.y + 1 || b2.b <= a2.y + 1);
    const bar = document.querySelector('.atlas-bar');
    const parts = bar ? Array.from(bar.children).filter(e => e.getBoundingClientRect().width > 0).map(e => ({ cls: e.className.replace(/\\s+/g,'.'), ...rect(e) })) : [];
    const over = [];
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (hit(parts[i], parts[j])) over.push(parts[i].cls + '×' + parts[j].cls);
    const outside = parts.filter(x => x.r > innerWidth + 1 || x.x < -1).map(x => x.cls);
    CM.Atlas.close(); await new Promise(r=>setTimeout(r,150));
    return JSON.stringify({ over: over, outside: outside, parts: parts.length });
  })()`))
  check(w + '×' + h + ' 全国图顶栏不重叠/不出屏', a.parts > 0 && a.over.length === 0 && a.outside.length === 0, a)
  // 结算进度条不能压在底部建设工具栏上
  const sp = JSON.parse(await evalJs(`(async () => {
    if (!CM.SettleUI) return JSON.stringify({ skip: true });
    CM.SettleUI.show(3); await new Promise(r=>setTimeout(r,80));
    const rect = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
    const bar = document.getElementById('settle-progress');
    const tb = document.getElementById('toolbar');
    const out = { show: !!(bar && !bar.classList.contains('hidden')), bar: bar ? rect(bar) : null, tb: tb ? rect(tb) : null };
    const hit = (a2, b2) => !(a2.r <= b2.x + 1 || b2.r <= a2.x + 1 || a2.b <= b2.y + 1 || b2.b <= a2.y + 1);
    out.overlap = out.show && out.tb ? hit(out.bar, out.tb) : false;
    CM.SettleUI.hide(0);
    return JSON.stringify(out);
  })()`))
  check(w + '×' + h + ' 结算条不压建设工具栏', sp.skip === true || sp.overlap === false, sp)
}

// 界面大小：大字号会把有效宽度变小，资金胶囊仍必须可见
for (const scale of [1.15, 0.9]) {
  await evalJs(`CM.Settings.set('uiScale', ${scale})`)
  for (const [w, h] of [[1366, 768], [1024, 768]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(450)
    const r = JSON.parse(await evalJs(`(() => {
      const top = document.getElementById('hudTop');
      const m = top.querySelector('.cluster.metrics');
      const pill = m ? m.querySelector('.pill') : null;
      const mr = m.getBoundingClientRect(), pr = pill.getBoundingClientRect();
      return JSON.stringify({ over: top.scrollWidth > top.clientWidth + 1, moneyVisible: pr.width > 4 && pr.right <= mr.right + 1 });
    })()`))
    check('界面大小 ' + scale + ' · ' + w + '×' + h + ' 不溢出且资金可见', r.over === false && r.moneyVisible === true, r)
  }
}
await evalJs(`CM.Settings.set('uiScale', 1)`)

if (errors.length) { fails++; console.log('  ✗ console errors  ' + JSON.stringify(errors.slice(0, 3))) } else check('全程 0 console error', true)
console.log('\n' + (fails ? ('✗ ' + fails + ' 项失败') : '全部通过'))
proc.kill()
process.exit(fails ? 1 : 0)
