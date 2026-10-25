/* 在 Node 里跑参考项目的模拟内核，用来验数值，不用开浏览器。
 *
 * 参考项目是纯静态全局命名空间脚本，没有模块系统，所以这里用 vm 造一个
 * 假的 window，把 js/*.js 按 index.html 的顺序灌进去。
 *
 * 用法：
 *   node tools/simcheck.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = [
  'util', 'config', 'news', 'geo_gz', 'geo', 'data_gz', 'data_tutorial',
  'geo_hz', 'data_hz', 'geo_hk', 'data_hk', 'geo_tk', 'data_tk', 'geo_tp', 'data_tp',
  'maps', 'facility', 'city', 'metro', 'sim', 'economy', 'difficulty', 'ops', 'staff', 'incidents',
  'macro', 'game', 'milestones', 'save', 'company',
];

const sandbox = {
  console,
  Math, Date, JSON, Object, Array, Number, String, Boolean, Set, Map,
  Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array,
  isFinite, isNaN, parseInt, parseFloat,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout: () => 0, clearTimeout: () => {},
  performance: { now: () => Date.now() },
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  },
  document: {
    createElement: () => ({ getContext: () => null, style: {}, appendChild() {}, addEventListener() {} }),
    addEventListener() {}, querySelector: () => null, documentElement: { dataset: {} },
    body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
  },
  navigator: { userAgent: 'node' },
  indexedDB: undefined,
  // 参考项目用 btoa/atob 打包 TypedArray（城市序列化）。Node 22+ 有全局版，但 vm 沙箱里拿不到，手动补上
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
for (const name of ORDER) {
  const src = readFileSync(join(ROOT, 'js', name + '.js'), 'utf8');
  try {
    vm.runInContext(src, ctx, { filename: name + '.js' });
  } catch (e) {
    console.error('加载失败：' + name + '.js → ' + e.message);
    process.exit(1);
  }
}

const CM = sandbox.CM;
if (!CM) { console.error('CM 未注册'); process.exit(1); }

const ok = [], bad = [];
function check(label, cond, extra) {
  (cond ? ok : bad).push(label + (extra ? '  ' + extra : ''));
}

// ---------- 1. 模块注册 ----------
check('CM.Staff 已注册', !!CM.Staff);
check('CM.Incidents 已注册', !!CM.Incidents);
check('六角色', CM.Staff && Object.keys(CM.Staff.ROLE_BY_KEY).length === 6, String(CM.Staff && Object.keys(CM.Staff.ROLE_BY_KEY).length));
check('五等级', CM.Staff && CM.Staff.LEVELS.length === 5);
check('十四特性', CM.Staff && CM.Staff.TRAITS.length === 14, String(CM.Staff && CM.Staff.TRAITS.length));
check('四级事件', CM.Incidents && CM.Incidents.LEVELS.length === 4);

// ---------- 2. 工资与签约费 ----------
if (CM.Staff) {
  const y = 1990;
  const s1 = CM.Staff.salaryOf('line_manager', 1, y, []);
  const s5 = CM.Staff.salaryOf('line_manager', 5, y, []);
  const sd = CM.Staff.salaryOf('driver', 1, y, []);
  check('线长月薪 > 司机月薪', s1 > sd, s1.toFixed(2) + ' vs ' + sd.toFixed(2));
  check('五级月薪是初级的 2 倍以上', s5 > s1 * 2, s1.toFixed(2) + ' → ' + s5.toFixed(2));
  const y2020 = CM.Staff.salaryOf('line_manager', 1, 2020, []);
  check('工资随年份通胀上涨', y2020 > s1 * 1.5, s1.toFixed(2) + ' → ' + y2020.toFixed(2));
  const f1 = CM.Staff.signingFeeOf('line_manager', 1, y, []);
  check('签约费 > 月薪', f1 > s1, f1.toFixed(2) + ' vs ' + s1.toFixed(2));
}

// ---------- 3. 市场生成与确定性 ----------
if (CM.Staff) {
  const st = new CM.Staff();
  const rngA = CM.Staff.rngFor({ seed: 12345 }, 1990, 1);
  st.refreshMarket(rngA, 1990, 1, 7);
  check('市场生成 7 人', st.market.length === 7, String(st.market.length));
  const names = st.market.map(c => c.name);
  check('候选人名字不重复', new Set(names).size === names.length, names.join(','));

  const st2 = new CM.Staff();
  st2.refreshMarket(CM.Staff.rngFor({ seed: 12345 }, 1990, 1), 1990, 1, 7);
  check('同 seed 同月市场一致', JSON.stringify(st2.market.map(c => c.name)) === JSON.stringify(names));

  const st3 = new CM.Staff();
  st3.refreshMarket(CM.Staff.rngFor({ seed: 999 }, 1990, 1), 1990, 1, 7);
  check('不同 seed 市场不同', JSON.stringify(st3.market.map(c => c.name)) !== JSON.stringify(names));
}

// ---------- 4. 雇佣 / 效果 / 解雇 ----------
if (CM.Staff) {
  const st = new CM.Staff();
  st.refreshMarket(CM.Staff.rngFor({ seed: 7 }, 1990, 1), 1990, 1, 7);
  const econ = { spent: 0, spend(k, v) { this.spent += v; return true; }, canAfford() { return true; }, isFree() { return false; } };
  const cand = st.market[0];
  const r = st.hire(cand.id, null, econ);
  check('雇佣成功', r && r.ok !== false && st.hired.length === 1, JSON.stringify(r && r.error || 'ok'));
  check('雇佣扣签约费', econ.spent > 0, econ.spent.toFixed(2));

  const e0 = CM.Staff.effects(st, 1990);
  check('效果里有 payroll', e0.payroll > 0, e0.payroll.toFixed(4));
  check('效果里 headcount = 1', e0.headcount === 1);

  const before = st.hired.length;
  st.fire(st.hired[0].id, econ);
  check('解雇生效', st.hired.length === before - 1, String(st.hired.length));

  // 线长 → autoHandle
  const st4 = new CM.Staff();
  st4.hired.push({ id: 'x1', role: 'line_manager', name: '甲', level: 3, salary: 6, efficiency: 0.83, loyalty: 70, lineId: null, traits: [], hiredAt: 0 });
  const e4 = CM.Staff.effects(st4, 1990);
  check('线长提供 autoHandle', e4.autoHandle === true);
  // 检修 → maintMult < 1
  const st5 = new CM.Staff();
  st5.hired.push({ id: 'x2', role: 'maintainer', name: '乙', level: 3, salary: 4, efficiency: 0.83, loyalty: 70, lineId: null, traits: [], hiredAt: 0 });
  const e5 = CM.Staff.effects(st5, 1990);
  check('检修降低维保成本', e5.maintMult < 1, e5.maintMult.toFixed(3));
  // 商业 → revenueMult > 1
  const st6 = new CM.Staff();
  st6.hired.push({ id: 'x3', role: 'commercial', name: '丙', level: 3, salary: 5, efficiency: 0.83, loyalty: 70, lineId: null, traits: [], hiredAt: 0 });
  const e6 = CM.Staff.effects(st6, 1990);
  check('商业提升收入', e6.revenueMult > 1, e6.revenueMult.toFixed(3));
}

// ---------- 5. 事件概率与维修费 ----------
if (CM.Incidents) {
  const I = CM.Incidents;
  check('6 站维修费 < 14 站', I.repairCostFor(I.LEVEL_BY_LV[3], 6, false) < I.repairCostFor(I.LEVEL_BY_LV[3], 14, false));
  check('自动处置更贵', I.repairCostFor(I.LEVEL_BY_LV[3], 14, true) > I.repairCostFor(I.LEVEL_BY_LV[3], 14, false));
  check('规模下限 0.35', Math.abs(I.sizeFactor(2) - 0.35) < 1e-9);
  check('规模上限 2', Math.abs(I.sizeFactor(200) - 2) < 1e-9);

  // 4 列车一天的事故率
  const fakeG = { seed: 1, clock: { y: 1990, m: 1, d: 1 }, compiled: { routes: [{ cars: 4 }] } };
  const rate = I.PER_TRAIN_MINUTE * 4 * I.DAY_MINUTES;
  const p = 1 - Math.exp(-rate);
  check('4 列车日事故概率在 3%~15%', p > 0.03 && p < 0.15, (p * 100).toFixed(2) + '%');
  // 24 列车
  const fakeG2 = { seed: 1, clock: { y: 1990, m: 1, d: 1 }, compiled: { routes: Array.from({ length: 4 }, () => ({ cars: 6 })) } };
  const p2 = 1 - Math.exp(-I.PER_TRAIN_MINUTE * 24 * I.DAY_MINUTES);
  check('24 列车日事故概率在 25%~60%', p2 > 0.25 && p2 < 0.60, (p2 * 100).toFixed(2) + '%');

  // 事件等级分布
  const rng = CM.Staff.rng(42);
  const cnt = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let i = 0; i < 20000; i++) {
    const r = rng();
    let a = 0, lv = 1;
    for (const L of I.LEVELS) { a += L.weight; if (r < a) { lv = L.lv; break; } }
    cnt[lv]++;
  }
  const pct1 = cnt[1] / 20000, pct4 = cnt[4] / 20000;
  check('L1 占比约 60%', Math.abs(pct1 - 0.60) < 0.03, (pct1 * 100).toFixed(1) + '%');
  check('L4 占比约 3%', Math.abs(pct4 - 0.03) < 0.015, (pct4 * 100).toFixed(1) + '%');

  // roll 的实际触发率：模拟 4 列车跑 365 天，看有多少天出事
  let fired = 0, days = 0;
  for (let d = 1; d <= 365; d++) {
    const gg = {
      seed: 20261024, clock: { y: 1990, m: 1, d: d },
      compiled: { routes: [{ id: 'r1', lineId: 'l1', cars: 4, stIdx: new Array(14).fill(0), line: { name: '1 号线' }, label: '1 号线' }] },
    };
    if (I.roll(gg, 'wd', null)) fired++;
    days++;
  }
  const rate365 = fired / days;
  check('4 列车一年触发率在 5%~20%', rate365 > 0.05 && rate365 < 0.20, (rate365 * 100).toFixed(1) + '%（' + fired + '/' + days + ' 天）');

  // 人员两个「加性/乘性」效果必须真的落进事故对象里（v3.0.1 前它们只在面板上显示）
  // 用同一个 gg 与同一组 se 的 incidentMult，保证 rng 流与概率判断一致，只让被检效果不同。
  {
    const base = { incidentMult: 1, onTimeAdd: 0, repairMult: 1 };
    const buff = { incidentMult: 1, onTimeAdd: 0.10, repairMult: 0.80 };
    let ia = null, ib = null;
    for (let d = 1; d <= 60 && !(ia && ib); d++) {
      const gg = {
        seed: 20261024, clock: { y: 1990, m: 1, d: d },
        compiled: { routes: [{ id: 'r1', lineId: 'l1', cars: 4, stIdx: new Array(14).fill(0), line: { name: '1 号线' }, label: '1 号线' }] },
      };
      const a = I.roll(gg, 'wd', base);
      const b = I.roll(gg, 'wd', buff);
      if (a && b) { ia = a; ib = b; }
    }
    check('repairMult<1 时维修费真的更低', !!(ia && ib) && ib.cost < ia.cost,
      ia && ib ? ia.cost.toFixed(2) + ' → ' + ib.cost.toFixed(2) + ' 万元' : '未抽到事件');
    check('onTimeAdd>0 时事故影响时长真的更短', !!(ia && ib) && ib.minutes < ia.minutes,
      ia && ib ? ia.minutes + ' → ' + ib.minutes + ' 分钟' : '未抽到事件');
  }
}

// ---------- 6. 真实一局：跑 365 天 ----------
{
  const mapId = 'gz';
  if (CM.useMap) CM.useMap(mapId);
  CM.mapId = mapId;
  let g = null;
  try {
    g = CM.Game.create({ mode: 'free', seed: 20261024, mapId });
  } catch (e) {
    console.error('Game.create 失败：' + e.message + '\n' + (e.stack || ''));
    process.exit(1);
  }
  check('开局有 staff', !!g.staff);
  check('开局市场非空', g.staff && g.staff.market.length > 0, String(g.staff && g.staff.market.length));

  const se0 = g.staffEffects();
  check('staffEffects 返回对象', !!se0);
  check('开局 payroll = 0', se0 && se0.payroll === 0);

  // 雇一个线长
  const econ = g.econ;
  if (g.staff && g.staff.market.length) {
    // 直接把钱给足，避免 free 模式的 canAfford 干扰
    const before = g.staff.hired.length;
    g.staff.hire(g.staff.market[0].id, null, econ);
    g.invalidateStaff();
    const se1 = g.staffEffects();
    check('雇人后 payroll > 0', se1 && se1.payroll > 0, se1 && se1.payroll.toFixed(4));
    check('雇人后 headcount = 1', se1 && se1.headcount === 1, String(se1 && se1.headcount));
  }

  // 跑一年
  let incidents = 0, days = 0;
  const startFunds = g.econ.funds;
  for (let i = 0; i < 365; i++) {
    g.clock.minute = 0;
    try { g.endDay(); } catch (e) { console.error('第 ' + (i + 1) + ' 天结算崩了：' + e.message + '\n' + (e.stack || '')); process.exit(1); }
    days++;
    if (g.lastIncidents) incidents = Math.max(incidents, g.lastIncidents.length);
  }
  check('365 天全部结算成功', days === 365, String(days));
  // 注意：free 模式没有建线，车队为 0，一年内不会出事故 —— 这是正确行为，不是 bug。
  // 触发率已在前面用「4 列车跑 365 天」单独验证过。

  const seEnd = g.staffEffects();
  check('年底 payroll 仍在', seEnd && seEnd.payroll > 0, seEnd && seEnd.payroll.toFixed(4));

  // 存档往返
  const ser = g.serialize();
  check('存档含 staff', !!ser.staff);
  check('存档含 incidents', ser.incidents !== undefined);
  const st2 = CM.Staff.restore(ser.staff);
  check('人员存档往返无损', JSON.stringify(st2.serialize()) === JSON.stringify(ser.staff));

  // ---------- 难度档位（本作独有） ----------
  console.log('\n[难度档位]');
  const mkDiff = function (key) {
    // challenge 模式才会读难度算起始资金；free 模式资金无限，测不出差异
    if (CM.useMap) CM.useMap('gz');
    CM.mapId = 'gz';
    return CM.Game.create({ mode: 'challenge', seed: 20261024, mapId: 'gz', difficulty: key });
  };
  const DK = CM.Difficulty.keys();
  check('难度四档', DK.length === 4, DK.join('/'));
  // 起始资金必须随档位单调递减：见习 > 标准 > 白手 > 硬核
  const fundsOf = DK.map(function (k) { return CM.Difficulty.startFundsOf(k); });
  let mono = true;
  for (let i = 1; i < fundsOf.length; i++) if (!(fundsOf[i] < fundsOf[i - 1])) mono = false;
  check('起始资金按档位递减', mono, fundsOf.join(' / '));
  check('标准档 = 基底原值', fundsOf[1] === CM.CFG.economy.startFunds, String(fundsOf[1]));
  // 客流倍率必须真的改到出行率上（而不是只改票款）
  const dg = mkDiff('brutal');
  const eg = mkDiff('easy');
  const rHard = dg.model.tripRates(2025)[0], rEasy = eg.model.tripRates(2025)[0];
  check('客流倍率进入出行率', rEasy > rHard, '易 ' + rEasy.toFixed(5) + ' > 难 ' + rHard.toFixed(5));
  // 起始资金真的按难度扣到 econ 上
  check('起始资金真的按档位', eg.econ.funds > dg.econ.funds, Math.round(eg.econ.funds) + ' > ' + Math.round(dg.econ.funds));
  // 事故倍率
  check('事故倍率随难度递增', CM.Incidents.incidentMultOf(dg, null) > CM.Incidents.incidentMultOf(eg, null),
    CM.Incidents.incidentMultOf(eg, null).toFixed(2) + ' → ' + CM.Incidents.incidentMultOf(dg, null).toFixed(2));
  // 建设成本倍率
  CM.Metro.setBuildMult(CM.Difficulty.get('easy').buildMult);
  const cEasy = CM.Metro.stationCost('underground', 'M', 2025);
  CM.Metro.setBuildMult(CM.Difficulty.get('brutal').buildMult);
  const cHard = CM.Metro.stationCost('underground', 'M', 2025);
  CM.Metro.setBuildMult(1);
  check('建设成本倍率生效', cHard > cEasy, '易 ' + cEasy.toFixed(0) + ' < 难 ' + cHard.toFixed(0));
  // 存档往返：难度必须跟着 econ 一起回来
  const serHard = dg.serialize();
  check('存档带难度', serHard.econ && serHard.econ.difficulty === 'brutal', serHard.econ && serHard.econ.difficulty);
  const eRestored = CM.Economy.restore(serHard.econ);
  check('难度存档往返无损', eRestored.difficulty === 'brutal' && Math.round(eRestored.funds) === Math.round(dg.econ.funds),
    eRestored.difficulty + ' / ' + Math.round(eRestored.funds));
  // 未知难度必须落回 normal 而不是抛错（读档路径抛错 = 存档作废）
  check('非法难度回落 normal', CM.Difficulty.norm('nonsense') === 'normal' && CM.Difficulty.norm(undefined) === 'normal');
  // 现场复位：mkDiff 里调过 useMap 把全局底图切走了，这里切回广州并清掉模块级建设倍率。
  // 不要重新赋值 g —— 上面的 365 天断言与下面的费用结构读的是同一个 g。
  if (CM.useMap) CM.useMap('gz');
  CM.mapId = 'gz';
  CM.Metro.setBuildMult(1);

  // ---------- 排班与运营策略（本作独有） ----------
  console.log('\n[排班]');
  {
    const og = CM.Game.create({ mode: 'free', seed: 20261024, mapId: 'gz' });
    const net = og.net;
    const lid = CM.Metro.newLine(net, '测试线');
    const a = CM.Metro.addStation(net, 20, 20, { size: 'M', type: 'underground' }, og.city);
    const b = CM.Metro.addStation(net, 24, 20, { size: 'M', type: 'underground' }, og.city);
    CM.Metro.addSegment(net, lid, net.stations[a].id, net.stations[b].id, [], 'underground');
    // 新线默认交给引擎自动排班（老存档与新手期也是这条路，所以必须验）
    check('默认不接管排班', CM.Ops.get(net.lines[lid]).manual === false, 'manual=false');
    const set1 = CM.Ops.set(og, lid, { peakHeadwaySec: 180, offHeadwaySec: 600, policy: 'peak_first' });
    check('排班写入成功', set1.ok, set1.ok ? 'ok' : String(set1.error));
    const got = CM.Ops.get(og.net.lines[lid]);
    check('排班往返一致', got.peakHeadwaySec === 180 && got.offHeadwaySec === 600 && got.policy === 'peak_first',
      got.peakHeadwaySec + '/' + got.offHeadwaySec + '/' + got.policy);
    // 间隔夹取：低于信号极限与高于半小时都要被夹住，而不是抛错或原样存进去
    CM.Ops.set(og, lid, { peakHeadwaySec: 5, offHeadwaySec: 99999 });
    const cl = CM.Ops.get(og.net.lines[lid]);
    check('间隔被夹到物理边界', cl.peakHeadwaySec === CM.Ops.MIN_HEADWAY_SEC && cl.offHeadwaySec === CM.Ops.MAX_HEADWAY_SEC,
      cl.peakHeadwaySec + '~' + cl.offHeadwaySec);
    // 策略必须真的改变频率：保高峰在高峰更密、在平峰更疏
    CM.Ops.set(og, lid, { peakHeadwaySec: 240, offHeadwaySec: 240, policy: 'peak_first' });
    const fakeRt = { cycleSec: 3600, cap: 1440 };
    const fPeak = CM.Ops.freqFor(fakeRt, 0, og.net.lines[lid]);
    const fOff = CM.Ops.freqFor(fakeRt, 1, og.net.lines[lid]);
    check('保高峰：高峰比平峰密', fPeak > fOff, fPeak.toFixed(2) + ' > ' + fOff.toFixed(2));
    // 恢复自动排班
    CM.Ops.auto(og, lid);
    check('可恢复自动排班', CM.Ops.get(og.net.lines[lid]).manual === false);
    check('恢复后 freqFor 返回 0', CM.Ops.freqFor(fakeRt, 0, og.net.lines[lid]) === 0);
    // 存档：ops 存在 net.lines 上，随 net 一起存，不需要额外字段
    CM.Ops.set(og, lid, { peakHeadwaySec: 200, offHeadwaySec: 500, policy: 'service' });
    const serOps = og.serialize();
    const savedOps = serOps.net && serOps.net.lines[lid] && serOps.net.lines[lid].ops;
    check('排班随 net 进存档', !!savedOps && savedOps.peakHeadwaySec === 200, savedOps ? JSON.stringify(savedOps) : 'none');
  }

  // 费用结构
  const ld = g.econ.lastDay;
  check('lastDay 有 maint', ld && typeof ld.maint === 'number');
  check('lastDay 有 payroll', ld && typeof ld.payroll === 'number');
  console.log('\n  一年后：资金 ' + CM.U.fmtMoney(g.econ.funds) + '  满意度 ' + g.econ.sat.toFixed(1) + '  车站 ' + g.compiled.stations.length);
  console.log('  当日：票款 ' + CM.U.fmtMoney(ld.fare) + '  运营 ' + CM.U.fmtMoney(ld.ops) + '（其中维保 ' + CM.U.fmtMoney(ld.maint) + '、工资 ' + CM.U.fmtMoney(ld.payroll) + '）');
}

// ---------- 多城扩张（本作独有） ----------
if (CM.Company) {
  const CO = CM.Company;
  // 从干净状态开始，避免上一次运行留下的公司影响断言
  for (const c of CO.all()) CO.remove(c.id);
  const cr = CO.create('测试公司', 'gz');
  check('公司可以创建', cr.ok && !!cr.company, cr.error || '');
  const co = cr.company;
  CO.setActive(co.id);
  check('新公司没有分部', co.branches.length === 0);
  check('空公司金库为 0', CO.treasury(co) === 0);

  CO.addBranch(co, { mapId: 'gz', name: '广州分部', funds: 500000 });
  check('分部可以登记', CO.branchOf(co, 'gz') !== null);
  check('金库 = 分部现金合计', Math.round(CO.treasury(co)) === 500000);

  const fee = CO.accessFee('hz');
  check('进驻费按难度档位定价', fee > 0 && CO.accessFee('aomen') <= fee, 'hz=' + fee + ' aomen=' + CO.accessFee('aomen'));

  const chk1 = CO.canJoin(co, 'hz', 'gz');
  check('进驻资格按付款分部账判断', chk1.ok === true, chk1.reason || '');
  const chk2 = CO.canJoin(co, 'hz', 'nosuchcity');
  check('付款分部不存在时不放行', chk2.ok === false, chk2.reason || '');

  const jo = CO.joinOpts(co, 'hz', 'normal', null, 'gz');
  check('进驻参数可生成', jo.ok === true, jo.error || '');
  check('启动金不超过标准开局资金', jo.startFunds <= CM.Difficulty.startFundsOf('normal'), String(jo.startFunds));

  // 扣费：接入费 + 启动金都必须真的从付款分部划走，不能凭空印钱
  const before = CO.branchOf(co, 'gz').funds;
  const pay = CO.payAccess(co, 'gz', jo.fee, jo.startFunds);
  const after = CO.branchOf(co, 'gz').funds;
  check('进驻扣费从付款分部划走', pay.ok && Math.round(before - after) === Math.round(jo.fee + jo.startFunds), (before - after).toFixed(0) + ' vs ' + (jo.fee + jo.startFunds).toFixed(0));

  // 账上不够时必须拒绝，而不是把余额扣成负数
  CO.updateBranch(co, 'gz', { funds: 10 });
  const pay2 = CO.payAccess(co, 'gz', 30000, 0);
  check('钱不够时拒绝进驻', pay2.ok === false && CO.branchOf(co, 'gz').funds === 10, pay2.error || '');

  // 分部上缴：净利为正才抽，亏损月不抽。
  // 上缴额按「上一个已结算月份」算 —— monthGen 里 openMonth 已经把 cur 换成空账，
  // 此刻读 cur 只能读到本月刚发的拨款，所以引擎用 econ.lastClosed()。
  CO.updateBranch(co, 'gz', { funds: 400000 });
  const pool0 = CO.poolOf(CO.get(co.id));
  // 公司层用到的 econ 桩：必须跟真 Economy 的方法面对齐。
  // remit 现在走 spend('remit', …) 记账，桩里少一个 spend 就会 TypeError。
  const econStub = (funds, last) => ({
    isFree: () => false, funds: funds, spent: {}, last: last,
    spend(k, v) { this.spent[k] = (this.spent[k] || 0) + v; this.funds -= v; },
    lastClosed: () => last,
  });
  const fakeG = {
    mapId: 'gz', company: { id: co.id, name: co.name }, clock: { y: 2025, m: 3 },
    econ: econStub(400000, { fare: 100000, ops: 40000 }),
  };
  const rm = CO.remit(fakeG, 2025, 3);
  const expect = (100000 - 40000) * CO.REMIT_RATE;
  check('分部按月按净利上缴', rm && Math.abs(rm.paid - expect) < 1, rm ? rm.paid.toFixed(1) + ' vs ' + expect.toFixed(1) : 'null');
  // 关键回归：上缴的钱必须落到公司自有资金上，不能凭空蒸发（旧实现就是扣完没人收）
  check('上缴的钱进入公司自有资金', Math.abs(CO.poolOf(CO.get(co.id)) - (pool0 + expect)) < 1,
    CO.poolOf(CO.get(co.id)).toFixed(1) + ' vs ' + (pool0 + expect).toFixed(1));
  // 记账：上缴必须走 econ.spend('remit', …) 落进本月账本，否则「期末 − 期初」对不上任何科目
  check('上缴走 spend 落账（remit 科目）', Math.abs((fakeG.econ.spent.remit || 0) - expect) < 1,
    (fakeG.econ.spent.remit || 0).toFixed(1) + ' vs ' + expect.toFixed(1));
  const fakeG2 = {
    mapId: 'gz', company: { id: co.id, name: co.name }, clock: { y: 2025, m: 4 },
    econ: econStub(400000, { fare: 10000, ops: 90000 }),
  };
  const rm2 = CO.remit(fakeG2, 2025, 4);
  check('亏损月不抽成', rm2 && rm2.paid === 0, rm2 ? String(rm2.paid) : 'null');

  // 公司自有资金必须真的能花出去，否则 pool 只是另一种死账
  const fakeG3 = {
    mapId: 'gz', company: { id: co.id, name: co.name }, clock: { y: 2025, m: 5 },
    econ: econStub(400000, { fare: 200000, ops: 0 }),
  };
  CO.remit(fakeG3, 2025, 5);                       // 再缴 70000，pool 累积到能付得起最低档接入费
  CO.updateBranch(co, 'gz', { funds: 0 });         // 分部账清空，只剩公司自有资金
  const poolNow = CO.poolOf(CO.get(co.id));
  const avail = CO.available(CO.get(co.id), 'gz');
  check('可动用额 = 分部现金 + 公司自有资金', Math.abs(avail - poolNow) < 1, avail.toFixed(1) + ' vs ' + poolNow.toFixed(1));
  const feeA = CO.accessFee('aomen');
  const canA = CO.canJoin(CO.get(co.id), 'aomen', 'gz');
  check('分部没钱但公司有钱时仍可进驻', canA.ok === (poolNow >= feeA), canA.reason || '');
  if (poolNow >= feeA) {
    const pA = CO.payAccess(CO.get(co.id), 'gz', feeA, 0);
    check('分部账空时进驻费从公司自有资金扣', pA.ok && pA.fromBranch === 0 && Math.abs(pA.fromPool - feeA) < 1,
      pA.ok ? ('branch=' + pA.fromBranch + ' pool=' + pA.fromPool) : pA.error);
    check('扣完公司自有资金相应减少', Math.abs(CO.poolOf(CO.get(co.id)) - (poolNow - feeA)) < 1);
  }

  // 破产分部不拖垮公司：只把该分部标停运
  const c2 = CO.get(co.id);
  CO.updateBranch(c2, 'gz', { failed: true });
  check('分部破产只标停运', CO.get(co.id).branches.length >= 1 && CO.branchOf(CO.get(co.id), 'gz').failed === true);

  for (const c of CO.all()) CO.remove(c.id);
  check('公司可清理', CO.all().length === 0);
} else {
  check('CM.Company 已注册', false);
}

// ---------- 汇总 ----------
console.log('\n通过 ' + ok.length + ' 项：');
for (const s of ok) console.log('  ✓ ' + s);
if (bad.length) {
  console.log('\n失败 ' + bad.length + ' 项：');
  for (const s of bad) console.log('  ✗ ' + s);
  process.exit(1);
}
console.log('\n全部通过。');
