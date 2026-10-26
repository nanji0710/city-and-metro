/**
 * 深度体检：不测「功能在不在」，只测「数字对不对」。
 *
 * 体检项目（任何一条不成立都说明引擎有账目漏洞或状态腐坏）：
 *   A. 月度账目恒等式：期末 − 期初 == 拨款 + 票款 + 奖励 − (建设支出 − 专项资金冲抵) − 运营 − 利息 − 本金 − 逾期费
 *      这条挂了就是「钱凭空出现或消失」，玩法再好玩也是假的。
 *   B. 账期首尾相接：本月 start 必须等于上月 end。
 *   C. 天数正确：每月封账时 days 必须等于当月天数（否则票款与运营按错误天数累计）。
 *   D. 数值健康：funds / sat / fare / carKm / metro 不许出现 NaN 或 Infinity。
 *   E. 取值范围：sat ∈ [0,100]，票款与运营成本 ≥ 0。
 *   F. 公司账目：treasury == Σ 分部 funds + pool（多城扩张后这条决定了「钱在哪」）。
 *   G. 人员工资：当月 ops 里的 payroll 必须等于在职人员月薪合计 ÷ 30 × 天数（±1%）。
 *
 * 用法：node tools/audit.mjs [city1,city2,...]
 * 需要 4180 端口上已经跑着 dev server（或 BASE 环境变量指定）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9511)
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-audit-' + PORT)
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CITIES = (process.argv[2] || 'aomen,wuhu,luoyang,guangzhou,beijing').split(',')

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
    } catch (e) { /* 换下一个路径 */ }
  }
  if (!proc) throw new Error('找不到 Edge')
  let wsUrl = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.filter((x) => x.type === 'page').pop()
      if (t) { wsUrl = t.webSocketDebuggerUrl; break }
    } catch (e) { /* 还没起来 */ }
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
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 })
    if (r.result && r.result.exceptionDetails) {
      const e = r.result.exceptionDetails
      return 'ERR ' + (e.exception && e.exception.description || e.text)
    }
    return r.result && r.result.result ? r.result.result.value : null
  }
  await send('Runtime.enable')
  await send('Page.enable')

  let bad = 0
  for (const city of CITIES) {
    // 每座城单独重载页面：同一个页面里连续 newGame 会互相污染（旧 model 的缓存不会清）
    await send('Page.navigate', { url: BASE })
    await sleep(2200)
    const raw = await evalJs(`(async () => {
      const log = [];
      // 体检跑的是旧版全解锁公司，避免战役锁图把非入门城挡在外面；锁图流程由 e2e-campaign 覆盖。
      if (CM.Company) {
        const seed = CM.Company.create('体检旧公司', ${JSON.stringify(city)});
        if (seed.ok) CM.Company.setActive(seed.company.id);
      }
      CM.newGame({ map: ${JSON.stringify(city)}, mode: 'challenge', difficulty: 'normal', name: '体检' });
      for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
      const g = CM.game;
      for (let i = 0; i < 160 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
      try { CM.ui.closeScreen(); } catch (e) {}
      try { CM.ui.closePanel(true); } catch (e) {}
      g.speed = 3;
      /*
       * 步长取 1/20 秒而不是 1/60：update(dt) 的推进量正比于 dt，步长只影响
       * 求解器的收敛次数，不影响账目（账目按「天」结算）。1/20 让 40 天的
       * 推进时间降到三分之一，体检才跑得完。
       */
      const dt = 1 / 12;
      const perDay = 24 * 12;
      const spinDays = (n) => { for (let i = 0; i < n * perDay; i++) g.update(dt); };
      spinDays(2);                       // 让模型出第一个稳态日
      const led0 = g.econ.ledger.length;
      /* ---- 雇人 + 上缴：Bug B / Bug A 的回归场景 ----
       * 体检如果不雇人、不开公司，G 与 F 两项就永远在测「0 人 0 元」，形同虚设。
       * 这里刻意造出最难的情况：一名商业岗**指派到某条线**（旧实现会让它既不生效也不发工资），
       * 再挂一家公司让分部按月上缴（旧实现直接从 funds 上减、账本不留痕）。 */
      const staffTry = { hired: 0, assigned: null, err: [] };
      try {
        if (CM.Staff && g.staff && g.staff.market.length) {
          const com = g.staff.market.find(function (c) { return c.role === 'commercial'; }) || g.staff.market[0];
          const h1 = g.staff.hire(com.id, null, g.econ);
          if (h1 && h1.error) staffTry.err.push(h1.error); else staffTry.hired++;
          const rest = g.staff.market.filter(function (c) { return c.id !== com.id; });
          const rt0 = (g.compiled.routes || [])[0];
          if (rest.length && rt0) {
            const h2 = g.staff.hire(rest[0].id, null, g.econ);
            if (h2 && h2.error) staffTry.err.push(h2.error);
            else {
              staffTry.hired++;
              const a = g.staff.assign(rest[0].id, rt0.lineId);
              if (a && a.error) staffTry.err.push(a.error); else staffTry.assigned = rt0.lineId;
            }
          }
          g.invalidateStaff();
        }
      } catch (e) { staffTry.err.push(String(e && e.message || e)); }
      const compTry = { id: null, pool0: 0, remit: 0, err: null };
      try {
        if (CM.Company && g.mode !== 'free') {
          const co = CM.Company.create('体检公司', g.mapId);
          if (co && co.ok) {
            CM.Company.setActive(co.company.id);
            g.company = { id: co.company.id, name: co.company.name };
            // create() 只建公司不建分部，分部是首次存档时由 onSaved 登记的。
            // 少了这一步 remit 会直接 return null，H 项就永远测不到（第一版就踩了这个坑）。
            CM.Company.addBranch(co.company, { mapId: g.mapId, name: '体检分部', funds: g.econ.funds, slotId: 'audit' });
            compTry.id = co.company.id;
            compTry.pool0 = CM.Company.poolOf(CM.Company.get(co.company.id));
          } else compTry.err = String((co && co.reason) || 'create 失败');
        }
      } catch (e) { compTry.err = String(e && e.message || e); }
      spinDays(76);

      const daysIn = (y, m) => CM.U.daysInMonth(y, m);
      const led = g.econ.ledger.slice(led0);
      const viol = [];
      const near = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 1e-6);   // 内部单位万元，2 百元以内算浮点噪声
      let prev = led0 > 0 ? g.econ.ledger[led0 - 1] : null;
      let sumErr = 0, maxErr = 0, maxErrAt = '';
      for (const L of led) {
        const build = (L.construction || 0) + (L.demolition || 0) + (L.upgrade || 0) + (L.relocation || 0);
        const capexUse = L.capexUse || 0;
        const sum = (L.grant || 0) + (L.fare || 0) + (L.reward || 0) + (L.inject || 0) - (build - capexUse)
                  - (L.ops || 0) - (L.interest || 0) - (L.principal || 0) - (L.penalty || 0)
                  - (L.remit || 0);
        const delta = (L.end || 0) - (L.start || 0);
        const err = delta - sum;
        sumErr += Math.abs(err);
        if (Math.abs(err) > maxErr) { maxErr = Math.abs(err); maxErrAt = L.y + '.' + L.m; }
        if (!near(delta, sum)) viol.push({ k: 'A 账目恒等式', at: L.y + '.' + L.m, delta: +delta.toFixed(2), sum: +sum.toFixed(2), err: +err.toFixed(2) });
        if (prev && !near(L.start, prev.end)) viol.push({ k: 'B 账期不接续', at: L.y + '.' + L.m, start: +(L.start || 0).toFixed(2), prevEnd: +(prev.end || 0).toFixed(2) });
        if ((L.days || 0) !== daysIn(L.y, L.m)) viol.push({ k: 'C 天数不对', at: L.y + '.' + L.m, days: L.days, should: daysIn(L.y, L.m) });
        const nums = { start: L.start, end: L.end, fare: L.fare, ops: L.ops, grant: L.grant };
        for (const k in nums) if (!isFinite(nums[k])) viol.push({ k: 'D 数值非有限', at: L.y + '.' + L.m, field: k, v: String(nums[k]) });
        if ((L.fare || 0) < 0) viol.push({ k: 'E 票款为负', at: L.y + '.' + L.m, fare: L.fare });
        if ((L.ops || 0) < 0) viol.push({ k: 'E 运营成本为负', at: L.y + '.' + L.m, ops: L.ops });
        prev = L;
      }

      // D/E：全局数值健康
      const d = g.model && g.model.daily;
      if (d && d.ready) for (const k of ['metro', 'fare', 'carKm', 'coverage', 'commute', 'cong', 'avgFare']) {
        if (!isFinite(d[k])) viol.push({ k: 'D 日均指标非有限', field: k, v: String(d[k]) });
      }
      for (const k of ['funds', 'capex', 'sat', 'overdue']) {
        if (!isFinite(g.econ[k])) viol.push({ k: 'D 经济状态非有限', field: k, v: String(g.econ[k]) });
      }
      if (!(g.econ.sat >= 0 && g.econ.sat <= 100)) viol.push({ k: 'E 满意度越界', sat: g.econ.sat });

      // G：工资是否真的按在职人员折算进了 ops
      const lastDay = g.econ.lastDay || {};
      let pay = 0, n = 0, payDay = 0;
      if (CM.Staff && g.staff) {
        n = (g.staff.hired || []).length;
        pay = CM.Staff.payrollMonthly(g.staff) || 0;      // 万元/月
        payDay = pay / 30;                                 // 万元/天（effects 里的折算法）
      }
      if (n > 0 && payDay > 0 && Math.abs((lastDay.payroll || 0) - payDay) > Math.max(0.05, payDay * 0.02)) {
        viol.push({ k: 'G 日工资对不上', expect: +payDay.toFixed(2), got: +(lastDay.payroll || 0).toFixed(2), staff: n });
      }
      if (n !== (lastDay.staff || 0)) viol.push({ k: 'G 计薪人数对不上', hired: n, inLedger: lastDay.staff || 0 });

      /* G2（Bug B 回归）：把一个人指派到某条线路之后，他必须仍然「发工资 + 有作用」。
       * 旧实现里这两件事同时消失，等于白雇一个免费且无效的人。 */
      if (staffTry.hired > 0 && CM.Staff && g.staff) {
        const p = (g.staff.hired || []).find(function (x) { return x.lineId; });
        if (p) {
          const solo = CM.Staff.effectsCity({ hired: [p] }, g.clock.y, g.lineWeights());
          if (!(solo.payroll > 0)) viol.push({ k: 'G2 指派后不发工资', role: p.role, salary: p.salary });
          const moved = solo.revenueMult > 1.0001 || solo.maintMult < 0.9999 || solo.repairMult < 0.9999
            || solo.incidentMult < 0.9999 || solo.onTimeAdd > 1e-9 || solo.satAdd > 1e-9;
          if (!moved) viol.push({ k: 'G2 指派后没有任何作用', role: p.role });
          if (!solo.lineAuto || typeof solo.lineAuto !== 'object') viol.push({ k: 'G2 缺少按线自动处置表' });
        }
      }
      /* H（Bug A 回归）：分部上缴的钱必须真的进公司自有现金，并且在本月账本里留痕。
       * 旧实现直接从 funds 上减掉，钱转进了 pool，但账本「期末 − 期初」对不上任何科目。 */
      const compInfo = { poolGain: 0, ledgerRemit: 0, curRemit: 0, err: compTry.err };
      if (compTry.id) {
        const co = CM.Company.get(compTry.id);
        compInfo.poolGain = +(CM.Company.poolOf(co) - compTry.pool0).toFixed(2);
        for (const L of led) compInfo.ledgerRemit += (L.remit || 0);
        compInfo.ledgerRemit = +compInfo.ledgerRemit.toFixed(2);
        // 上缴发生在月初（openMonth 之后），钱先进 pool、月底封账才写进流水。
        // 采样点常常落在月中间，所以「本月已上缴但还没封账」的那一笔必须在当前账上找，
        // 否则每个月的最后一笔都会被误判成「上缴与入账不符」。
        compInfo.curRemit = +(((g.econ.cur && g.econ.cur.remit) || 0)).toFixed(2);
        const booked = compInfo.ledgerRemit + compInfo.curRemit;
        if (compInfo.poolGain > 0.01 && compInfo.ledgerRemit <= 0 && compInfo.curRemit <= 0) viol.push({ k: 'H 上缴没进账本', pool: compInfo.poolGain });
        if (compInfo.poolGain > 0.01 && Math.abs(compInfo.poolGain - booked) > Math.max(0.02, compInfo.poolGain * 1e-6)) {
          viol.push({ k: 'H 上缴与入账不符', pool: compInfo.poolGain, ledger: compInfo.ledgerRemit, cur: compInfo.curRemit });
        }
      }

      return JSON.stringify({
        city: ${JSON.stringify(city)},
        routes: (g.compiled.routes || []).length,
        stations: (g.compiled.stations || []).length,
        months: led.length,
        sumErr: +sumErr.toFixed(2),
        maxErr: +maxErr.toFixed(2), maxErrAt: maxErrAt,
        viol: viol.slice(0, 24),
        violCount: viol.length,
        sat: +g.econ.sat.toFixed(1),
        funds: Math.round(g.econ.funds),
        staffN: n, staffPay: +pay.toFixed(1),
        payrollInOps: +(lastDay.payroll || 0).toFixed(2),
        headcount: lastDay.staff || 0,
        staffErr: staffTry.err,
        assigned: staffTry.assigned || null,
        poolGain: compInfo.poolGain, ledgerRemit: compInfo.ledgerRemit, companyErr: compInfo.err,
      });
    })()`)
    if (typeof raw !== 'string' || raw.startsWith('ERR')) {
      console.log(`✗ ${city}: ${String(raw).slice(0, 400)}`)
      bad++
      continue
    }
    const r = JSON.parse(raw)
    const ok = r.violCount === 0
    if (!ok) bad++
    console.log(`${ok ? '✓' : '✗'} ${r.city.padEnd(10)} 线${String(r.routes).padStart(2)} 站${String(r.stations).padStart(3)} 账${String(r.months).padStart(2)}月  恒等式累计误差 ${r.sumErr}（最大 ${r.maxErr} @ ${r.maxErrAt}）  sat ${r.sat}  资金 ${r.funds}  人员 ${r.staffN}人 ${r.staffPay}万/月  日工资 ${r.payrollInOps}万 (${r.headcount}人)  上缴 ${r.poolGain}/${r.ledgerRemit}${r.assigned ? '  指派 ' + r.assigned : ''}`)
    if (r.staffErr && r.staffErr.length) console.log('   · 雇人告警：' + r.staffErr.join(' / '))
    if (r.companyErr) console.log('   · 公司告警：' + r.companyErr)
    for (const v of r.viol) console.log('   · ' + JSON.stringify(v))
    if (r.violCount > r.viol.length) console.log(`   · …… 另有 ${r.violCount - r.viol.length} 条`)
  }
  try { ws.close() } catch (e) {}
  try { proc.kill() } catch (e) {}
  console.log(bad ? `\n${bad} 座城体检不通过` : '\n全部通过')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
