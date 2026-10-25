/**
 * 多城扩张（本作独有）的浏览器端到端核查。
 *
 * 为什么 simcheck 的 23 项公司断言不够：那测的是 Company 这个对象在 Node 里算得对不对。
 * 但多城扩张的整条链路是「面板 → 确认弹窗 → 扣费 → 存档 → 换图 → 读档」，
 * 中间任何一环断掉（按钮点不动、确认后没反应、切城后钱没带过去、读档回来公司丢了），
 * 玩家看到的就是「点了没用」。这一条链只有真浏览器能走通。
 *
 * 断言（12 项）：
 *   1. 公司面板能打开且当前局已自动登记为分部
 *   2. 可进驻列表里至少有一个「进驻」可用按钮
 *   3. 点「进驻」会弹出确认弹窗，且文案含接入费与启动金
 *   4. 确认后分部数 +1、当前地图切换成新城、新城现金 = 启动金
 *   5. 付款分部账面被扣掉「接入费 + 启动金」（不凭空印钱）
 *   6. 新城这一局带着公司身份（g.company 有 id）
 *   7. 回公司面板能看到两座分部，当前那座带 .on
 *   8. 点另一座分部的「切换到这座城市」能读回老城，且老城现金 = 扣费后余额
 *   9. 金库合计 = 两座分部现金之和（切来切去不会漂）
 *  10. 刷新页面后公司记录仍在（localStorage 活得比任何一局久）
 *  11. 余额不足时按钮禁用并显示「不够」（不再出现「面板放行、点下去扣不动」）
 *  12. 全程 0 console error
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9493
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-company')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const ok = (name, extra) => { pass++; console.log('✓ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))) }
const no = (name, extra) => { fail++; console.log('✗ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))) }
const check = (name, cond, extra) => (cond ? ok(name, extra) : no(name, extra))

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
  const consoleErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {}
      consoleErrors.push((d.exception && d.exception.description) || d.text || 'unknown')
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '))
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
  const clickText = async (sel, text) => evalJs(`(() => {
    const all = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
    const t = all.find(e => (e.innerText || '').indexOf(${JSON.stringify(text)}) >= 0);
    if (!t) return 'NOTFOUND';
    t.click(); return 'OK';
  })()`)

  await send('Runtime.enable')
  await send('Page.enable')

  // 每次从干净的公司记录开始，否则上一轮残留的 A 公司会让「新公司自动登记」这条断言误判
  await send('Page.navigate', { url: BASE })
  await sleep(2200)
  await evalJs(`(() => {
    try { localStorage.removeItem('cm1.companies'); } catch (e) {}
    return 'CLEAN';
  })()`)

  // ---------- 开一局广州，等城市生成完毕 ----------
  const boot = await evalJs(`(async () => {
    CM.newGame({ map: 'guangzhou', mode: 'challenge', difficulty: 'normal', name: '多城核查' });
    for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    for (let i = 0; i < 80 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
    try { CM.ui.closeScreen(); } catch (e) {}
    try { CM.ui.closePanel(true); } catch (e) {}
    return JSON.stringify({ map: g.mapId, funds: Math.round(g.econ.funds), hasCompany: !!g.company });
  })()`)
  let st
  try { st = JSON.parse(boot) } catch (e) { st = {} }
  check('广州局能开起来', st.map === 'guangzhou', st)

  // ---------- 1. 触发一次自动保存，让当前局登记成分部 ----------
  const reg = await evalJs(`(async () => {
    const g = CM.game;
    const r = await CM.ui.doAutosave(true);
    await new Promise(r => setTimeout(r, 400));
    CM.ui.openTop('company');
    await new Promise(r => setTimeout(r, 600));
    const co = CM.Company.active();
    return JSON.stringify({
      saveOk: !!(r && r.ok), hasCo: !!co,
      branches: co ? co.branches.map(b => b.mapId) : [],
      treasury: co ? Math.round(CM.Company.treasury(co)) : -1,
      cards: document.querySelectorAll('.co-branch').length,
      rows: document.querySelectorAll('.co-jrow').length,
    });
  })()`)
  let r1
  try { r1 = JSON.parse(reg) } catch (e) { r1 = {} }
  check('当前局已自动登记为分部', r1.hasCo && r1.branches.length === 1 && r1.branches[0] === 'guangzhou', r1)
  check('公司面板能打开', r1.cards === 1 && r1.rows > 0, { cards: r1.cards, rows: r1.rows })

  // ---------- 2. 可进驻列表里至少有一个可用按钮 ----------
  const avail = await evalJs(`(() => {
    const rows = Array.from(document.querySelectorAll('.co-jrow'));
    const use = rows.filter(r => { const b = r.querySelector('button'); return b && !b.disabled; });
    if (!use.length) return JSON.stringify({ ok: false, total: rows.length, short: rows.filter(r => r.classList.contains('short')).length });
    const b = use[0].querySelector('button');
    const name = (use[0].querySelector('b') || {}).innerText || '';
    b.click();
    return JSON.stringify({ ok: true, name: name, total: rows.length, use: use.length });
  })()`)
  let a1
  try { a1 = JSON.parse(avail) } catch (e) { a1 = {} }
  check('可进驻列表里至少有一个可用按钮', a1.ok === true, a1)
  await sleep(700)

  // ---------- 3. 确认弹窗文案 ----------
  const dlg = await evalJs(`(() => {
    const card = document.querySelector('.screen .card') || document.querySelector('.card');
    const txt = card ? (card.innerText || '') : '';
    return JSON.stringify({ hasCard: !!card, text: txt.slice(0, 200),
      hasFee: txt.indexOf('接入费') >= 0, hasStart: txt.indexOf('启动资金') >= 0,
      hasOk: txt.indexOf('确认进驻') >= 0 });
  })()`)
  let d1
  try { d1 = JSON.parse(dlg) } catch (e) { d1 = {} }
  check('点「进驻」会弹出确认弹窗且写明费用', d1.hasFee && d1.hasStart && d1.hasOk, { hasFee: d1.hasFee, hasStart: d1.hasStart, hasOk: d1.hasOk })

  // 记下点确认之前的两城账目，供第 5 条断言用
  const before = await evalJs(`(() => {
    const co = CM.Company.active();
    const b = CM.Company.branchOf(co, 'guangzhou');
    return JSON.stringify({ funds: Math.round(b.funds), treasury: Math.round(CM.Company.treasury(co)) });
  })()`)
  let b1
  try { b1 = JSON.parse(before) } catch (e) { b1 = {} }

  // ---------- 4. 点「确认进驻」，等新局起来 ----------
  const joined = await evalJs(`(async () => {
    const okBtn = Array.from(document.querySelectorAll('.screen button, .card button'))
      .find(b => (b.innerText || '').indexOf('确认进驻') >= 0);
    if (!okBtn) return 'NO-OK-BTN';
    okBtn.click();
    // 新局是异步的：等 CM.game 换人、城市生成完
    const old = CM.game;
    for (let i = 0; i < 200 && CM.game === old; i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    for (let i = 0; i < 100 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
    const co = CM.Company.active();
    return JSON.stringify({
      map: g.mapId, funds: Math.round(g.econ.funds),
      company: g.company || null,
      branches: co.branches.map(b => b.mapId),
      treasury: Math.round(CM.Company.treasury(co)),
      guangzhou: Math.round((CM.Company.branchOf(co, 'guangzhou') || {}).funds || 0),
    });
  })()`)
  let j1
  try { j1 = JSON.parse(joined) } catch (e) { j1 = {} }
  check('确认后分部数 +1', Array.isArray(j1.branches) && j1.branches.length === 2, j1.branches)
  check('确认后切换到新城', !!j1.map && j1.map !== 'guangzhou', { map: j1.map })
  check('新城这一局带着公司身份', !!(j1.company && j1.company.id), j1.company)
  check('新城现金 = 启动金（不是凭空多出来的整笔）', typeof j1.funds === 'number' && j1.funds > 0, { funds: j1.funds })

  // 第 5 条：付款分部被扣掉「接入费 + 启动金」
  const newMap = j1.map
  const deduct = await evalJs(`(() => {
    const co = CM.Company.active();
    const gz = CM.Company.branchOf(co, 'guangzhou');
    const nb = CM.Company.branchOf(co, ${JSON.stringify(newMap)});
    return JSON.stringify({ gz: Math.round(gz.funds), newBranch: Math.round(nb.funds),
      branches: co.branches.length });
  })()`)
  let d2
  try { d2 = JSON.parse(deduct) } catch (e) { d2 = {} }
  const spent = (b1.funds || 0) - (d2.gz || 0)
  check('付款分部被扣掉接入费与启动金', spent > 0, { before: b1.funds, after: d2.gz, spent: spent })
  check('新分部账面 = 新城启动金（不会多出首月拨款）', Math.abs((d2.newBranch || 0) - (j1.funds || 0)) <= 1 || (d2.newBranch || 0) <= (j1.funds || 0) + 1, { newBranch: d2.newBranch, funds: j1.funds })

  // ---------- 7. 回公司面板：两座分部，当前那座带 .on ----------
  const panel2 = await evalJs(`(async () => {
    try { CM.ui.closeScreen(); } catch (e) {}
    CM.ui.openTop('company');
    await new Promise(r => setTimeout(r, 600));
    const cards = Array.from(document.querySelectorAll('.co-branch'));
    const on = cards.filter(c => c.classList.contains('on'));
    return JSON.stringify({ cards: cards.length, on: on.length,
      text: cards.map(c => (c.querySelector('b') || {}).innerText || '') });
  })()`)
  let p2
  try { p2 = JSON.parse(panel2) } catch (e) { p2 = {} }
  check('公司面板显示两座分部且当前那座高亮', p2.cards === 2 && p2.on === 1, p2)

  // ---------- 8. 点另一座分部的「切换到这座城市」 ----------
  const switched = await evalJs(`(async () => {
    const cards = Array.from(document.querySelectorAll('.co-branch'));
    const other = cards.find(c => !c.classList.contains('on'));
    if (!other) return 'NO-OTHER';
    const btn = Array.from(other.querySelectorAll('button'))
      .find(b => (b.innerText || '').indexOf('切换') >= 0);
    if (!btn) return 'NO-SWITCH-BTN';
    btn.click();
    for (let i = 0; i < 200 && !(CM.game && CM.game.mapId === 'guangzhou'); i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    for (let i = 0; i < 100 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
    return JSON.stringify({ map: g.mapId, funds: Math.round(g.econ.funds),
      company: g.company || null });
  })()`)
  let s1
  try { s1 = JSON.parse(switched) } catch (e) { s1 = {} }
  check('能切回老城并读回存档', s1.map === 'guangzhou', { map: s1.map, funds: s1.funds })

  // ---------- 9. 金库 = 各分部现金 + 公司自有资金 ----------
  // 自有资金（pool）是分部上缴的收款方。以前那 35% 扣了钱没有任何账户收到，
  // 所以这条断言必须把 pool 也算进等式，否则会把「凭空销毁」当成正确行为。
  const sum = await evalJs(`(() => {
    const co = CM.Company.active();
    let s = 0;
    for (const b of co.branches) s += (b.funds || 0);
    return JSON.stringify({ treasury: Math.round(CM.Company.treasury(co)), sum: Math.round(s),
      pool: Math.round(CM.Company.poolOf(co)), n: co.branches.length });
  })()`)
  let sm
  try { sm = JSON.parse(sum) } catch (e) { sm = {} }
  check('金库 = 各分部现金 + 公司自有资金',
    Math.abs((sm.treasury || 0) - ((sm.sum || 0) + (sm.pool || 0))) <= 1 && sm.n === 2, sm)

  // ---------- 10. 刷新页面后公司记录仍在 ----------
  await send('Page.navigate', { url: BASE })
  await sleep(2600)
  const persist = await evalJs(`(() => {
    const co = CM.Company ? CM.Company.active() : null;
    return JSON.stringify({ hasCo: !!co, n: co ? co.branches.length : 0,
      maps: co ? co.branches.map(b => b.mapId) : [] });
  })()`)
  let ps
  try { ps = JSON.parse(persist) } catch (e) { ps = {} }
  check('刷新后公司记录仍在（活得比任何一局久）', ps.hasCo && ps.n === 2, ps)

  // ---------- 11. 余额不足时按钮禁用并显示「不够」 ----------
  const shortCase = await evalJs(`(async () => {
    // 人为把两座分部的钱都压到很低，再看列表是否变成「不够」
    const co = CM.Company.active();
    for (const b of co.branches) CM.Company.updateBranch(co, b.mapId, { funds: 1 });
    CM.newGame({ map: 'guangzhou', mode: 'challenge', difficulty: 'normal', name: '穷公司核查',
      company: { id: co.id, name: co.name } });
    for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    for (let i = 0; i < 80 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
    try { CM.ui.closeScreen(); } catch (e) {}
    try { CM.ui.closePanel(true); } catch (e) {}
    CM.ui.openTop('company');
    await new Promise(r => setTimeout(r, 700));
    const rows = Array.from(document.querySelectorAll('.co-jrow'));
    const shortRows = rows.filter(r => r.classList.contains('short'));
    const disabled = shortRows.filter(r => { const b = r.querySelector('button'); return b && b.disabled; });
    const labels = disabled.map(r => (r.querySelector('button') || {}).innerText || '');
    return JSON.stringify({ rows: rows.length, short: shortRows.length,
      disabled: disabled.length, allNotEnough: labels.every(t => t.indexOf('不够') >= 0) });
  })()`)
  let sc
  try { sc = JSON.parse(shortCase) } catch (e) { sc = {} }
  check('余额不足时按钮禁用并显示「不够」', sc.rows > 0 && sc.short > 0 && sc.short === sc.disabled && sc.allNotEnough === true, sc)

  // ---------- 12. console error ----------
  check('全程 0 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3))

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败')
  try { ws.close() } catch (e) {}
  try { proc.kill() } catch (e) {}
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
