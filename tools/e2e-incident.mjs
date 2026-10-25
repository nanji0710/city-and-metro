/**
 * 突发事件的端到端验证：真的能在浏览器里触发、显示、并且处置。
 *
 * 为什么必须实测而不是只看引擎断言：
 * simcheck 只证明「概率模型算得对」，证明不了「玩家在界面上看得见、点得动」。
 * 事故是唯一一条「必须玩家亲手点」的玩法，UI 不通就等于没做。
 *
 * 覆盖四条路径：
 *   1. 手动处置：面板出现待处置行 → 点「处置」→ 钱扣了、状态变 handled
 *   2. 自动处置：雇线长后 se.autoHandle 为真，自动处置比手工贵（这是「用钱买时间」的定价依据）
 *   3. 顶栏红点：待处置时人员按钮带 warn-dot
 *   4. toast 动作：引擎 emit 的是 { label, open }，UI 要把它变成可点按钮并真的打开面板
 *
 * 用法：node tools/e2e-incident.mjs        （CITY=guangzhou 默认）
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9487
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const CITY = process.env.CITY || 'guangzhou'
const PROFILE = join(ROOT, 'tools', '.edge-incident')
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
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text)
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '))
    }
  })
  const send = (method, params) => new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result && r.result.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text || JSON.stringify(r.result.exceptionDetails) }
    }
    return r.result && r.result.result ? r.result.result.value : null
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(2000)

  // 开局
  const boot = await evalJs(`(async () => {
    CM.newGame({ map: ${JSON.stringify(CITY)}, mode: 'challenge', difficulty: 'normal', name: '事故试验局' });
    for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    if (!g) return 'NO-GAME';
    for (let i = 0; i < 80 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
    return 'OK routes=' + ((g.compiled && g.compiled.routes) || []).length;
  })()`)
  console.log('boot:', JSON.stringify(boot))
  if (boot === 'NO-GAME' || (typeof boot === 'string' && boot.indexOf('NO-GAME') >= 0)) {
    console.log('开局失败'); ws.close(); proc.kill(); process.exit(1)
  }

  // 强制造一起 L2 事故（真实概率下要等很多天才出一次，测试不能靠等）
  const forced = await evalJs(`(() => {
    const g = CM.game;
    const rt = g.compiled.routes[0];
    const I = CM.Incidents;
    const lv = I.LEVEL_BY_LV[2];
    const inc = {
      id: 'inc_test_1', lv: 2, key: lv.key, title: 'L2 · ' + lv.name + '（' + rt.line.name + '）',
      desc: '测试：区间中断',
      routeId: rt.id, lineId: rt.lineId, lineName: rt.line.name,
      minutes: 20, satHit: lv.satHit, capLoss: lv.capLoss,
      cost: I.repairCostFor(lv, rt.stIdx.length, false),
      auto: false, handled: false, day: g.clock.d,
    };
    g.lastIncidents = g.lastIncidents || [];
    g.lastIncidents.push(inc);
    g.syncDisruptions();
    g.emit('incident', inc);
    return 'FORCED cost=' + inc.cost;
  })()`)
  console.log('force:', JSON.stringify(forced))

  // 打开人员面板，看事故卡片
  const panel = await evalJs(`(() => {
    try { CM.ui.closeScreen(); } catch (e) {}
    try { CM.ui.closePanel(true); } catch (e) {}
    CM.ui.openTop('staff');
    return 'OPEN';
  })()`)
  console.log('panel:', JSON.stringify(panel))
  await sleep(1200)
  // updateTop 是每帧跑的，但 headless 下 rAF 可能被节流，强制刷一次再读红点
  await evalJs(`(() => { try { CM.ui.updateTop(); } catch (e) {} return 'TICK'; })()`)
  await sleep(300)

  const view = await evalJs(`(() => {
    const el = document.querySelector('#rightPanel') || document.body;
    const txt = (el.innerText || '').replace(/\\s+/g, ' ');
    const rows = [...document.querySelectorAll('.ps-inc-row')].map(e => (e.innerText||'').replace(/\\s+/g,' ').trim());
    const btns = [...document.querySelectorAll('.ps-inc-row button')].map(e => (e.innerText||'').trim());
    // 顶栏红点：hbtn 是 class，按钮靠 data-tip 区分，没有 .hbtns 这个选择器
    const staffBtn = [...document.querySelectorAll('.hbtn')].find(e => (e.getAttribute('data-tip')||'').indexOf('人员') >= 0);
    return {
      hasIncidentSection: txt.indexOf('最近的事故') >= 0,
      rows, btns,
      staffBtnFound: !!staffBtn,
      warnDot: staffBtn ? staffBtn.classList.contains('warn-dot') : null,
    };
  })()`)
  console.log('view:', JSON.stringify(view, null, 2))

  // 点「处置」
  const before = await evalJs(`(() => { const g = CM.game; return { funds: Math.round(g.econ.funds), pending: (g.lastIncidents||[]).filter(r => !r.handled).length }; })()`)
  const click = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.ps-inc-row button')].find(e => (e.innerText||'').indexOf('处置') >= 0);
    if (!b) return 'NO-BTN';
    b.click();
    return 'CLICK';
  })()`)
  await sleep(1500)
  const after = await evalJs(`(() => { const g = CM.game; return { funds: Math.round(g.econ.funds), pending: (g.lastIncidents||[]).filter(r => !r.handled).length, handled: (g.lastIncidents||[]).filter(r => r.handled).length }; })()`)
  console.log('click:', JSON.stringify(click))
  console.log('before:', JSON.stringify(before))
  console.log('after :', JSON.stringify(after))

  // 自动处置路径：挂一个线长，再强制一起事故，应当自动 handled 且更贵
  const auto = await evalJs(`(() => {
    const g = CM.game;
    const cand = g.staff.market.find(c => c.role === 'line_manager');
    if (!cand) return 'NO-MANAGER-IN-MARKET';
    const r = g.staff.hire(cand.id, null, g.econ);
    if (!r || r.ok === false) return 'HIRE-FAIL ' + (r && r.error);
    g.invalidateStaff();
    const se = g.staffEffects();
    if (!se || !se.autoHandle) return 'NO-AUTOHANDLE';
    const rt = g.compiled.routes[0];
    const I = CM.Incidents;
    const lv = I.LEVEL_BY_LV[1];
    const manualCost = I.repairCostFor(lv, rt.stIdx.length, false);
    const autoCost = I.repairCostFor(lv, rt.stIdx.length, true);
    const inc = { id: 'inc_test_2', lv: 1, key: lv.key, title: 'L1 · ' + lv.name + '（' + rt.line.name + '）',
      desc: '测试：自动处置', routeId: rt.id, lineId: rt.lineId, lineName: rt.line.name,
      minutes: 12, satHit: lv.satHit, capLoss: lv.capLoss,
      cost: autoCost, auto: true, handled: false, day: g.clock.d };
    const resolved = I.resolve(g, inc, 'auto');
    return 'AUTO ok=' + (resolved && resolved.ok) + ' handled=' + inc.handled
      + ' manualCost=' + manualCost + ' autoCost=' + autoCost + ' paid=' + (resolved && resolved.cost);
  })()`)
  console.log('auto:', JSON.stringify(auto))

  // toast 的「去处置」动作：引擎 emit 的是 { label, open }，UI 侧要把它变成可点的按钮。
  // 这条路径最容易断（引擎不能传函数，UI 要认 open 键），必须实测。
  const toastAct = await evalJs(`(async () => {
    const g = CM.game;
    try { CM.ui.closePanel(true); } catch (e) {}
    g.emit('toast', { kind: 'bad', text: 'TEST 事故待处置', act: { label: '去处置', open: 'staff' } });
    await new Promise(r => setTimeout(r, 400));
    const t = [...document.querySelectorAll('.toast')].find(e => (e.innerText||'').indexOf('TEST 事故待处置') >= 0);
    if (!t) return 'NO-TOAST';
    const b = t.querySelector('.toast-act');
    if (!b) return 'NO-ACT-BTN';
    b.click();
    await new Promise(r => setTimeout(r, 900));
    const title = (document.querySelector('#rightPanel .p-title') || {}).textContent || '';
    return 'ACT ok btn=' + (b.innerText||'').trim() + ' panelTitle=' + title.trim();
  })()`)
  console.log('toastAct:', JSON.stringify(toastAct))

  // ── 断言（不只看日志：失败必须以非 0 退出，否则这个脚本形同虚设）──
  const fails = []
  const expect = (label, cond, extra) => {
    if (cond) console.log('  ✓ ' + label + (extra !== undefined ? '  ' + extra : ''))
    else { console.log('  ✗ ' + label + (extra !== undefined ? '  ' + extra : '')); fails.push(label) }
  }
  console.log('\n断言：')
  expect('开局有可运营线路', typeof boot === 'string' && boot.indexOf('routes=') >= 0 && !/routes=0$/.test(boot), boot)
  expect('事故能写进 lastIncidents', typeof forced === 'string' && forced.indexOf('FORCED') === 0, forced)
  expect('人员面板有「最近的事故」区块', view && view.hasIncidentSection === true)
  expect('待处置行渲染出处置按钮', view && view.btns && view.btns.length === 1 && view.btns[0].indexOf('处置') >= 0, view && view.btns && view.btns[0])
  expect('顶栏人员按钮出现红点', view && view.warnDot === true)
  expect('点处置后状态变 handled', after && after.pending === 0 && after.handled === 1, JSON.stringify(after))
  expect('点处置真的扣了钱', before && after && after.funds < before.funds, (before && before.funds) + ' → ' + (after && after.funds))
  expect('雇线长后进入自动处置', typeof auto === 'string' && auto.indexOf('AUTO ok=true') === 0, auto)
  expect('自动处置比手工贵（用钱买时间）', /manualCost=([\d.]+).*autoCost=([\d.]+)/.test(auto || '')
    && (() => { const m = /manualCost=([\d.]+).*autoCost=([\d.]+)/.exec(auto); return Number(m[2]) > Number(m[1]) })(), auto)
  expect('toast 动作按钮可点并打开人员面板', typeof toastAct === 'string' && toastAct.indexOf('ACT ok') === 0 && toastAct.indexOf('panelTitle=人员') >= 0, toastAct)
  expect('无 console error', errors.length === 0, errors.length ? errors[0].slice(0, 120) : '0')

  console.log(fails.length ? `\n失败 ${fails.length} 项：` + fails.join('、') : '\n全部通过。')
  ws.close()
  proc.kill()
  await sleep(300)
  process.exit(fails.length ? 1 : 0)
  process.exit(errors.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
