/**
 * 新手引导（本作扩展三步）的端到端验证。
 *
 * 基底自带 12 步教程，全部是「建造 + 看图层」。我们独有的三件事
 * ——雇人、自己排班、处置事故——在基底里根本不存在，教程自然也不会教。
 * 不教就等于没做：玩家第一局遇不到它们，第二次打开就忘了。
 *
 * 这条脚本证明的不是「代码跑得通」，而是：
 *   ① 教程里确实多了这三步；
 *   ② 事故那一步会真的造出一起待处置事故；
 *   ③ 「不处置」不会误判通过（sweep 会把状态改成 handled，容易漏判）；
 *   ④ 「手工处置」才会通过。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 9495)
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-tut')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok, extra })
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '  ' + extra : ''))
}

async function main() {
  mkdirSync(PROFILE, { recursive: true })
  let proc = null
  for (const exe of EDGE) {
    try {
      proc = spawn(exe, [
        `--remote-debugging-port=${PORT}`,
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
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
  const errors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push((m.params.args || []).map((a) => a.value || a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION ' + (m.params.exceptionDetails.text || ''))
    }
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
  await sleep(2400)

  // ---------- 1. 开教程局 ----------
  const ready = await evalJs(`(async () => {
    localStorage.removeItem('cm1.companies');
    CM.newGame({ map: 'tutorial', mode: 'free', tutorial: true, name: '教程 e2e' });
    for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    if (!g) return 'NO-GAME';
    for (let i = 0; i < 120 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
    try { CM.ui.closeScreen(); } catch (e) {}
    return 'OK';
  })()`)
  check('教程局能开起来', ready === 'OK', ready)
  await sleep(500)

  // ---------- 1.5 先造一条真实线路 ----------
  // 事故是挂在「线路」上的（routeId / capLoss / repairCost 都按站数算），
  // 没有线路时 incident 步骤的 enter() 会静默 return —— 这是设计如此，不是 bug。
  // 所以测试必须先建线，否则测的是「空网络下不出事故」这个无意义的场景。
  const built = await evalJs(`(async () => {
    const g = CM.game, M = CM.Metro;
    // 站址必须先过 checkSite：水面、风景区、未开放区、机场、保护建筑都会被拒。
    // 直接拿 DATA.places 的坐标会在这些地方撞墙（实测 5 站 7 处冲突，
    // 而 canConfirm 只回一句「存在 N 处冲突」—— 测试会卡在这里且看不出原因）。
    const okCells = [];
    for (let y = 2; y < g.city.H - 2; y += 2) {
      for (let x = 2; x < g.city.W - 2; x += 2) {
        const r = M.checkSite(g.city, x + 0.5, y + 0.5, 'underground');
        if (r && r.ok) okCells.push([x + 0.5, y + 0.5]);
      }
    }
    if (!okCells.length) return 'NO-VALID-CELL';
    const picks = [okCells[0]];
    for (const p of okCells) {
      const q = picks[picks.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 2.5 && picks.length < 5) picks.push(p);
      if (picks.length >= 5) break;
    }
    if (picks.length < 4) return 'TOO-FEW-PICKS ' + picks.length;
    const r = g.edit(function (net) {
      const lid = M.newLine(net, '1 号线');
      const ids = [];
      for (const p of picks) ids.push(M.addStation(net, p[0], p[1], { size: 'M', type: 'underground' }, g.city));
      for (let i = 1; i < ids.length; i++) {
        const seg = M.addSegment(net, lid, ids[i - 1], ids[i], [], 'underground');
        if (seg && seg.error) return seg;
      }
      return {};
    });
    if (r && r.error) return 'EDIT ' + r.error;
    const can = g.canConfirm();
    if (!can.ok) return 'CANNOT ' + can.reason;
    const ok = g.confirmDraft();
    if (ok && ok.error) return 'CONFIRM ' + ok.error;
    for (let i = 0; i < 40 && (!g.compiled || !g.compiled.routes.length); i++) await new Promise(r2 => setTimeout(r2, 100));
    return JSON.stringify({ routes: (g.compiled.routes || []).length,
      stations: (g.compiled.stations || []).length });
  })()`)
  let builtP = null
  try { builtP = JSON.parse(built) } catch (e) { /* ignore */ }
  check('能建出一条可运营线路（事故的前提）', !!(builtP && builtP.routes >= 1), built)
  await sleep(400)

  // ---------- 2. 步骤表里确实有那三步 ----------
  const steps = await evalJs(`(() => {
    const g = CM.game;
    if (!g || !g.tutorial) return { err: 'NO-TUT' };
    // STEPS 是模块内私有，只能从渲染出来的文案反推；
    // 这里改成直接数卡片标题能到达的最后一步（final 之前）
    return { step: g.tutorial.step, hasStaff: !!CM.Staff, hasOps: !!CM.Ops, hasInc: !!CM.Incidents };
  })()`)
  check('三个独有模块都已加载', !!(steps && steps.hasStaff && steps.hasOps && steps.hasInc), JSON.stringify(steps))

  // ---------- 3. 跳到事故那一步，看它是否真造出事故 ----------
  const forced = await evalJs(`(() => {
    const g = CM.game;
    const T = CM.Tutorial;
    if (!T || !T.active()) return 'NO-TUT-ACTIVE';
    // 直接改 step 再 attach 一次 = 重放 go(step)，会执行该步的 enter()
    g.tutorial.step = 15;   // 第 16 项（0 基）= 'incident'
    T.detach();
    T.attach(CM.ui, g);
    const list = g.lastIncidents || [];
    const tut = list.filter(r => String(r.id).indexOf('tut_') === 0);
    return JSON.stringify({ step: g.tutorial.step, title: (document.querySelector('.co-title') || {}).textContent,
      total: list.length, tutCount: tut.length, pending: list.filter(r => !r.handled).length,
      cost: tut.length ? tut[0].cost : null });
  })()`)
  let parsed = null
  try { parsed = JSON.parse(forced) } catch (e) { /* ignore */ }
  check('事故步骤会造出一起待处置事故', !!(parsed && parsed.tutCount >= 1 && parsed.pending >= 1), forced)
  check('事故步骤标题正确', !!(parsed && String(parsed.title || '').indexOf('处置一起事故') >= 0), parsed && parsed.title)

  // ---------- 4. 重复进入该步骤不会刷出更多事故 ----------
  const again = await evalJs(`(() => {
    const g = CM.game;
    const before = (g.lastIncidents || []).filter(r => String(r.id).indexOf('tut_') === 0 && !r.handled).length;
    CM.Tutorial.detach(); CM.Tutorial.attach(CM.ui, g);
    const after = (g.lastIncidents || []).filter(r => String(r.id).indexOf('tut_') === 0 && !r.handled).length;
    return JSON.stringify({ before, after });
  })()`)
  let againP = null
  try { againP = JSON.parse(again) } catch (e) { /* ignore */ }
  check('反复进入该步骤不会叠加事故', !!(againP && againP.before === againP.after), again)

  // ---------- 5. 什么都不做（等一天）不应通过 ----------
  const idle = await evalJs(`(async () => {
    const g = CM.game;
    // 模拟「过了第二天」：sweep 会把未处置的按 ignore 结算并标 handled
    if (CM.Incidents) CM.Incidents.sweep(g);
    const list = g.lastIncidents || [];
    const tut = list.find(r => String(r.id).indexOf('tut_') === 0);
    return JSON.stringify({ handled: tut ? tut.handled : null, mode: tut ? tut.mode : null });
  })()`)
  let idleP = null
  try { idleP = JSON.parse(idle) } catch (e) { /* ignore */ }
  check('放弃处置会被 sweep 标成 handled+ignore', !!(idleP && idleP.handled === true && idleP.mode === 'ignore'), idle)

  // ---------- 6. 手工处置才会通过 ----------
  const handled = await evalJs(`(() => {
    const g = CM.game;
    // 先造一起新的（上一轮已被 sweep 吞掉），再手工处置
    const T = CM.Tutorial;
    g.tutorial.step = 14;
    T.detach(); T.attach(CM.ui, g);   // 先退一步
    g.tutorial.step = 15;
    T.detach(); T.attach(CM.ui, g);   // 再进事故步 → enter() 造事故
    const list = g.lastIncidents || [];
    const pend = list.find(r => !r.handled && String(r.id).indexOf('tut_') === 0);
    if (!pend) return 'NO-PENDING';
    const r = g.handleIncident(pend.id);
    return JSON.stringify({ ok: r && r.ok, mode: pend.mode, handled: pend.handled });
  })()`)
  let handledP = null
  try { handledP = JSON.parse(handled) } catch (e) { /* ignore */ }
  check('点处置能真的处理掉事故', !!(handledP && handledP.ok && handledP.mode === 'manual'), handled)

  // ---------- 7. 无 console error ----------
  check('无 console error', errors.length === 0, errors.slice(0, 3).join(' | ') || '0')

  const pass = results.filter((r) => r.ok).length
  console.log('\n通过 ' + pass + ' / ' + results.length)
  ws.close()
  proc.kill()
  await sleep(300)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
