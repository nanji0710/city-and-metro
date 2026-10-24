/* 排班与运营策略（本作独有）
 *
 * 参考项目里发车频率是引擎自己算的：sim.js 取「线路最低服务水平」与「最大断面客流
 * 所需」中的较大者，玩家只能看着。这等于把运营里最核心的那个决定（这趟车多久一班、
 * 一列挂几辆）从玩家手里拿走了 —— 建造是玩家的事，经营不是。
 *
 * 这里把两件事交回玩家：
 *   1. 高峰/平峰的发车间隔（秒）；
 *   2. 每条线的编组辆数（受站台长度约束，见 metro.js compile 里的 minCars）。
 *
 * 三条设计约束：
 *   A. 只做「改参数」，不做「替玩家算最优」。所以这里没有任何反解、没有推荐值，
 *      只有一个中性的「本线现状」读数。
 *   B. 稀疏一定会有代价，而且代价必须走引擎既有的因果链：车少了 → 满载率升高 →
 *      skim 里 crowd 项变大 → 乘客自己改走别的路 → 票款掉。绝不在这里直接扣客流，
 *      否则玩家看到「车很挤但没人少」会觉得模型坏了。
 *   C. 参数存进 net.lines[id].ops —— net 是存档的一部分，不需要额外序列化代码。
 */
(function (CM) {
  'use strict';
  const U = CM.U, CFG = CM.CFG;

  const Ops = {};
  CM.Ops = Ops;

  /* 发车间隔的物理边界。
   * 下限 120 秒 = CFG.metro.fMax(30 列/小时) 对应的间隔，即信号系统能做到的最密；
   * 上限 1800 秒 = 半小时一班，再稀就不像地铁了，而且玩家会看不出车在动。 */
  Ops.MIN_HEADWAY_SEC = Math.round(3600 / CFG.metro.fMax);
  Ops.MAX_HEADWAY_SEC = 1800;

  /* 调度策略：在玩家设的基准间隔上再乘一个系数。
   * 为什么要有这一层而不是只让玩家填一个数：高峰和平峰的取舍是「同一份车队怎么分配」，
   * 用一个策略概括比让玩家逐时段填四个数更容易理解，也更容易在面板上做成一排按钮。 */
  Ops.POLICIES = [
    { key: 'fixed', name: '固定班次', peak: 1.00, off: 1.00, desc: '高峰平峰一个节奏，最好理解' },
    { key: 'peak_first', name: '保高峰', peak: 0.82, off: 1.30, desc: '车都压在早晚高峰，平峰拉长间隔' },
    { key: 'service', name: '服务优先', peak: 0.80, off: 0.80, desc: '全线加密，等车时间短但车公里成本高' },
    { key: 'conserve', name: '节能优先', peak: 1.28, off: 1.28, desc: '全线拉长间隔，省电省维保但会挤' },
  ];
  Ops.POLICY_BY_KEY = {};
  for (const p of Ops.POLICIES) Ops.POLICY_BY_KEY[p.key] = p;
  Ops.DEFAULT_POLICY = 'fixed';

  /* 一条线没被玩家改过时的默认间隔（秒）。
   * 取 360 秒（6 分钟）：这是国内城区线平峰的常见量级，也是玩家一眼能判断「密不密」的刻度。
   * 不按线路长度自动推 —— 自动推等于替玩家做决定，而这正是我们要还回去的东西。 */
  Ops.DEFAULT_PEAK_SEC = 240;
  Ops.DEFAULT_OFF_SEC = 420;

  function clampHw(v, dflt) {
    if (typeof v !== 'number' || !isFinite(v) || v <= 0) return dflt;
    return U.clamp(Math.round(v), Ops.MIN_HEADWAY_SEC, Ops.MAX_HEADWAY_SEC);
  }

  /* 读出某条线的排班设置，缺失字段一律落回默认值。
   * 读档路径上会出现旧存档（那时还没有 ops 字段），所以这里必须容错而不是抛错。 */
  Ops.get = function (line) {
    const o = (line && line.ops) || {};
    return {
      peakHeadwaySec: clampHw(o.peakHeadwaySec, Ops.DEFAULT_PEAK_SEC),
      offHeadwaySec: clampHw(o.offHeadwaySec, Ops.DEFAULT_OFF_SEC),
      policy: Ops.POLICY_BY_KEY[o.policy] ? o.policy : Ops.DEFAULT_POLICY,
      cars: typeof o.cars === 'number' && o.cars > 0 ? Math.round(o.cars) : 0,   // 0 = 跟随站台长度
      manual: !!o.manual,   // 玩家是否动过手；false 时引擎仍按自己的算法跑（老存档与新手期）
    };
  };

  /* 写回设置。返回 { ok, error } —— 面板要把错误显示出来，
   * 静默失败会让玩家以为按钮坏了。 */
  Ops.set = function (g, lineId, patch) {
    if (!g || !g.net || !g.net.lines[lineId]) return { ok: false, error: '这条线不在了' };
    const line = g.net.lines[lineId];
    const cur = Ops.get(line);
    const next = Object.assign({}, cur, patch || {});
    next.peakHeadwaySec = clampHw(next.peakHeadwaySec, Ops.DEFAULT_PEAK_SEC);
    next.offHeadwaySec = clampHw(next.offHeadwaySec, Ops.DEFAULT_OFF_SEC);
    if (!Ops.POLICY_BY_KEY[next.policy]) next.policy = Ops.DEFAULT_POLICY;
    next.manual = true;
    line.ops = next;
    if (g.touch) g.touch();
    if (g.rev !== undefined) g.rev++;
    return { ok: true, ops: next };
  };

  /* 恢复成引擎自动排班。玩家在「我想让电脑先跑着」和「我要自己调」之间能来回切换，
   * 而不是一旦动过就再也回不去。 */
  Ops.auto = function (g, lineId) {
    if (!g || !g.net || !g.net.lines[lineId]) return { ok: false, error: '这条线不在了' };
    delete g.net.lines[lineId].ops;
    if (g.touch) g.touch();
    if (g.rev !== undefined) g.rev++;
    return { ok: true };
  };

  /* 某个时段该开多少列/小时。返回 0 表示「交给引擎自己算」。
   * p 是 CFG.periods 的下标：0=AM 早高峰、1=MD 日间平峰、2=PM 晚高峰、3=EV 夜间。 */
  Ops.freqFor = function (rt, p, line) {
    const o = Ops.get(line);
    if (!o.manual) return 0;
    const pol = Ops.POLICY_BY_KEY[o.policy];
    const isPeak = p === 0 || p === 2;
    const base = isPeak ? o.peakHeadwaySec : o.offHeadwaySec;
    const hw = base * (isPeak ? pol.peak : pol.off);
    const f = 3600 / Math.max(Ops.MIN_HEADWAY_SEC, hw);
    return U.clamp(f, 1, CFG.metro.fMax);
  };

  /* 这条线在玩家设置下需要几列车（往返周转）。
   * 只用于面板展示「按这个间隔要几列车」，不参与模拟 —— 模拟里车数是玩家买的车，
   * 间隔是玩家定的间隔，两者对不上时由满载率去惩罚，而不是由引擎偷偷补车。 */
  Ops.trainsNeeded = function (rt, headwaySec) {
    if (!rt || !rt.cycleSec || !headwaySec) return 0;
    return Math.max(1, Math.ceil(rt.cycleSec / headwaySec));
  };

  /* 面板读数：给定一条已编译的 route，算出玩家当前设置下的高峰运力与拥挤预判。
   * 全部用引擎同一套公式，保证面板数字与结算一致（这是玩家信任的基础）。 */
  Ops.preview = function (rt, line, p) {
    const o = Ops.get(line);
    const f = Ops.freqFor(rt, p, line);
    const auto = CM.Model && CM.Model.serviceFloor ? CM.Model.serviceFloor(rt, p) : 0;
    const freq = f > 0 ? f : auto;
    const capPerHour = freq * rt.cap;
    return {
      ops: o,
      freq: freq,
      autoFreq: auto,
      headwaySec: freq > 0 ? 3600 / freq : 0,
      capPerHour: capPerHour,
      trains: Ops.trainsNeeded(rt, freq > 0 ? 3600 / freq : 0),
      manual: o.manual,
    };
  };

  Ops.policyName = function (key) {
    const p = Ops.POLICY_BY_KEY[key];
    return p ? p.name : '固定班次';
  };

  /* 人类可读的间隔：90 秒 / 6 分 30 秒 / 12 分钟。面板上到处要用。 */
  Ops.fmtHeadway = function (sec) {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60), r = s % 60;
    return r ? m + ' 分 ' + r + ' 秒' : m + ' 分钟';
  };
})(window.CM);
