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
  'maps', 'facility', 'city', 'metro', 'sim', 'economy', 'staff', 'incidents',
  'macro', 'game', 'milestones', 'save',
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

  // 费用结构
  const ld = g.econ.lastDay;
  check('lastDay 有 maint', ld && typeof ld.maint === 'number');
  check('lastDay 有 payroll', ld && typeof ld.payroll === 'number');
  console.log('\n  一年后：资金 ' + CM.U.fmtMoney(g.econ.funds) + '  满意度 ' + g.econ.sat.toFixed(1) + '  车站 ' + g.compiled.stations.length);
  console.log('  当日：票款 ' + CM.U.fmtMoney(ld.fare) + '  运营 ' + CM.U.fmtMoney(ld.ops) + '（其中维保 ' + CM.U.fmtMoney(ld.maint) + '、工资 ' + CM.U.fmtMoney(ld.payroll) + '）');
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
