/**
 * 事故 toast 的可见性核查。
 *
 * 为什么要单独查：e2e-incident 证明了「toast 里的按钮能点」，
 * 但那是用 querySelector 找到的 —— 元素存在不等于玩家看得见。
 * 事故是唯一必须玩家亲手处置的玩法，toast 若被浮层压住或被裁到屏幕外，
 * 这条通道就等于不存在。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9491
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-toast')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  mkdirSync(PROFILE, { recursive: true })
  let proc = null
  for (const exe of EDGE) {
    try {
      proc = spawn(exe, [
        `--remote-debugging-port=${PORT}`,
        '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${PROFILE}`, '--window-size=1680,1050',
        '--allow-file-access-from-files', 'about:blank',
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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params) => new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result && r.result.exceptionDetails) return 'ERR ' + r.result.exceptionDetails.text
    return r.result && r.result.result ? r.result.result.value : null
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(2200)

  await evalJs(`(async () => {
    CM.newGame({ map: 'guangzhou', mode: 'challenge', difficulty: 'normal', name: 'toast 核查' });
    for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    for (let i = 0; i < 80 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
    try { CM.ui.closeScreen(); } catch (e) {}
    return 'READY';
  })()`)
  await sleep(600)

  await evalJs(`(() => {
    const g = CM.game;
    g.emit('toast', { kind: 'bad', text: 'L4 · 枢纽瘫痪 · 待处置（80 万元）', act: { label: '去处置', open: 'staff' } });
    return 'EMIT';
  })()`)
  await sleep(700)

  const MEASURE = `(() => {
    // 页面上可能同时挂着别的 toast（暂停提示等），必须按文本挑出我们这一条，
    // 否则量到的是别人的几何 —— 第一版就是这样量到「游戏已暂停」的。
    const all = [...document.querySelectorAll('.toast')];
    const t = all.find(e => (e.innerText || '').indexOf('枢纽瘫痪') >= 0);
    if (!t) return { found: false, sawToasts: all.map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30)) };
    const r = t.getBoundingClientRect();
    const s = getComputedStyle(t);
    // 命中最上层元素：如果 toast 被别的浮层盖住，elementFromPoint 会返回别人
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(cx, cy);
    const inside = top && (t === top || t.contains(top));
    const panel = document.querySelector('#rightPanel');
    const pr = panel ? panel.getBoundingClientRect() : null;
    const panelOpen = panel ? !panel.classList.contains('hidden') && panel.getBoundingClientRect().width > 0 : false;
    // toast 与右侧面板是否相交（相交且被压在下面 = 玩家点不到）
    let overlapPanel = false;
    if (pr && panelOpen) overlapPanel = !(r.right < pr.left || r.left > pr.right || r.bottom < pr.top || r.top > pr.bottom);
    return {
      found: true,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      opacity: s.opacity, visibility: s.visibility, zIndex: s.zIndex, display: s.display,
      inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      hitOnTop: inside,
      hitTag: top ? (top.tagName + '.' + (top.className || '').toString().slice(0, 40)) : null,
      text: (t.innerText || '').replace(/\\s+/g, ' ').trim(),
      hasAct: !!t.querySelector('.toast-act'),
      actLabel: (() => { const b = t.querySelector('.toast-act'); return b ? (b.innerText || '').trim() : null; })(),
      panelOpen: panelOpen,
      overlapPanel: overlapPanel,
    };
  })()`

  const before = await evalJs(MEASURE)

  // 真正的事故现场是「面板已经打开」——此时 toast 最可能被面板压住。
  // 只测没开面板的状态等于测了一个玩家看不到的场景。
  await evalJs(`(() => { try { CM.ui.openTop('staff'); } catch (e) {} return 'PANEL'; })()`)
  await sleep(900)
  const after = await evalJs(MEASURE)

  console.log('--- 面板关闭 ---')
  console.log(JSON.stringify(before, null, 2))
  console.log('--- 面板打开 ---')
  console.log(JSON.stringify(after, null, 2))

  const ok = after.found && after.inViewport && after.hitOnTop && after.opacity === '1' && after.hasAct
  console.log(ok ? '✓ toast 在面板打开时仍可见可点' : '✗ toast 在面板打开时不可见/被遮挡')
  process.exitCode = ok ? 0 : 1

  ws.close()
  proc.kill()
  await sleep(300)
  process.exit(process.exitCode || 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
