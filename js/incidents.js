/* 城轨公司 · 突发事件系统（本作独有）
 *
 * 参考项目里地铁是一条永远不会坏的传送带：建好线、车自动排、乘客自动来。
 * 这让「运营」退化成「建造」，玩家建完之后只剩看数字。
 *
 * 这里加进第四条成本曲线（前三条是建造、运营、债券利息）：意外。
 *
 * 三条设计约束（都是从之前的版本踩出来的）：
 *
 * 1. 概率必须跟「列车数 × 时间」挂钩，不能跟「天」挂钩。
 *    按天算是拍脑袋，玩家看不出为什么昨天没事今天连炸三次；
 *    按列车·分钟算是可解释的 —— 车多、车老、人挤，就是更容易出事。
 *
 * 2. 维修费必须按线路规模缩放。
 *    固定 45 万在 30 站的干线上是毛毛雨，在 6 站的起步线上是灭顶之灾，
 *    那会让「开局」变成掷骰子而不是经营。
 *
 * 3. 有 line_manager 的线路自动处置，但更贵更慢。
 *    这是人员体系存在的唯一理由：钱买时间。如果自动处置又便宜又快，
 *    玩家就再也不会亲手点按钮，线长就成了纯增益道具。
 */
(function (CM) {
  'use strict';
  const U = CM.U, CFG = CM.CFG;

  // 四级事件。base 是「一辆车在一条 14 站的标准线上」的基准维修费（万元），
  // 实际费用再乘线路规模系数，见 repairCostFor()。
  const LEVELS = [
    {
      lv: 1, key: 'train', name: '单列车故障', weight: 0.60,
      base: 8, minutes: [10, 15], satHit: 4, capLoss: 0.06,
      desc: '一列车在区间内失去牵引，需要清客退出服务',
    },
    {
      lv: 2, key: 'section', name: '区间中断', weight: 0.25,
      base: 20, minutes: [10, 30], satHit: 9, capLoss: 0.18,
      desc: '一段区间双向中断，列车只能折返运行',
    },
    {
      lv: 3, key: 'line', name: '整线降速', weight: 0.12,
      base: 45, minutes: [15, 45], satHit: 16, capLoss: 0.34,
      desc: '信号或供电故障，全线限速运行',
    },
    {
      lv: 4, key: 'hub', name: '枢纽瘫痪', weight: 0.03,
      base: 80, minutes: [20, 60], satHit: 26, capLoss: 0.55,
      desc: '换乘枢纽出事，波及同城其它线路',
    },
  ];
  const LEVEL_BY_LV = {};
  for (const L of LEVELS) LEVEL_BY_LV[L.lv] = L;

  // 每列车每分钟的基础事故概率。
  //
  // 设计文档 v0.2 给的是 0.005%~0.02%，按 0.01% 算出来是
  // 「首线 4 车 0.43 起/日、全网 24 车 2.6 起/日」。数字本身没错，
  // 但那是按现实地铁的「列车·分钟」体量推的，放进一个 1 天 = 60 秒的游戏里
  // 就变成「开局每隔一天就出一次事」，玩家会把它当背景噪音而不是决策。
  //
  // 所以这里取 0.002%，得到：4 车约 0.09 起/日（十天一次，够意外）、
  // 24 车约 0.52 起/日（两天一次，够紧张）。这是「游戏手感优先」的取舍。
  const PER_TRAIN_MINUTE = 0.00002;
  // 自动处置的代价：更贵、更慢。手工处置要玩家真的点一下，所以便宜且快。
  const AUTO_COST_MULT = 1.35;
  const AUTO_MIN_MULT = 1.5;
  // 手工处置的费用折扣（玩家自己上手，省下的是「叫外援」的钱）
  const MANUAL_COST_MULT = 0.75;
  // 一天按多少运营分钟算。18 小时服务时长 × 60。
  const DAY_MINUTES = (CFG.ops && CFG.ops.serviceHours ? CFG.ops.serviceHours : 18) * 60;

  // 线路规模系数：14 站是标准线，6 站的小线维修费只有 0.43 倍，30 站的干线到 2 倍封顶。
  // 下限 0.35 是为了让再小的线也有点痛感 —— 完全不痛的事件等于没做。
  function sizeFactor(nStations) {
    const n = Math.max(1, nStations | 0);
    return Math.max(0.35, Math.min(2, n / 14));
  }

  function repairCostFor(level, nStations, auto) {
    const f = sizeFactor(nStations) * (auto ? AUTO_COST_MULT : MANUAL_COST_MULT);
    return Math.round(level.base * f * 100) / 100;
  }

  // 事故概率：车多、车老、人挤、没人管，都更容易出事
  function incidentMultOf(g, se) {
    let m = 1;
    const comp = g.compiled;
    if (comp && comp.routes) {
      let trains = 0;
      for (const rt of comp.routes) trains += rt.cars || 0;
      // 车队规模本身不放大事故率（那是线性重复），但超过 30 列之后调度复杂度开始上升
      if (trains > 30) m *= 1 + Math.min(0.5, (trains - 30) * 0.02);
    }
    if (se && se.incidentMult) m *= se.incidentMult;
    return m;
  }

  // 当天在途列车数（用于概率）
  function trainCount(g) {
    const comp = g.compiled;
    if (!comp || !comp.routes) return 0;
    let n = 0;
    for (const rt of comp.routes) n += rt.cars || 0;
    return n;
  }

  // 等级抽取：基础权重 L1 60% / L2 25% / L3 12% / L4 3%。
  // upBias = 1 时把轻事件的概率往重事件挪一点（车多的线网出事往往不是小毛病）。
  function pickLevel(rng, upBias) {
    const r = rng();
    let acc = 0;
    for (const L of LEVELS) {
      let w = L.weight;
      if (upBias) w = L.lv <= 2 ? w * 0.72 : w * 1.55;
      acc += w;
      if (r < acc) return L;
    }
    return LEVELS[0];
  }

  function pickRoute(g, rng) {
    const comp = g.compiled;
    if (!comp || !comp.routes || !comp.routes.length) return null;
    return comp.routes[Math.floor(rng() * comp.routes.length) % comp.routes.length];
  }

  let seq = 0;

  // 一天判定一次。返回事件对象，或 null（绝大多数天是 null）。
  //
  // 这里刻意不做「一天多次」：一天最多一次，是为了让日报里的事件能被读完，
  // 而不是变成一串刷屏的红字。
  // 概率按「当天至少出一起」算：1 - e^(-期望次数)，再封顶 0.55。
  // 封顶的理由：期望次数超过 0.8 之后，事件就从「意外」变成「日常」，
  // 玩家会开始无视日报，那这个系统的教育作用就没了。
  function roll(g, dt, se) {
    const trains = trainCount(g);
    if (trains <= 0) return null;
    const mult = incidentMultOf(g, se);
    const expected = PER_TRAIN_MINUTE * trains * DAY_MINUTES * mult;
    const p = Math.min(0.55, 1 - Math.exp(-expected));
    const rng = CM.Staff.rng(((g.seed || 1) * 7919 + g.clock.y * 10000 + g.clock.m * 100 + g.clock.d) >>> 0);
    if (rng() >= p) return null;

    // 期望次数高说明车队大，出事往往不是小毛病：把概率往重事件挪
    const lv = pickLevel(rng, expected > 0.8 ? 1 : 0);
    const rt = pickRoute(g, rng);
    const auto = !!(se && se.autoHandle);
    const nSt = rt ? rt.stIdx.length : 14;
    const mins = Math.round(lv.minutes[0] + (lv.minutes[1] - lv.minutes[0]) * rng());
    const dur = auto ? Math.round(mins * AUTO_MIN_MULT) : mins;
    const cost = repairCostFor(lv, nSt, auto);

    const lineName = rt ? (rt.line.name || (rt.label || '线路')) : '全网';
    seq++;
    return {
      id: 'i' + g.clock.y + g.clock.m + g.clock.d + '_' + seq,
      lv: lv.lv, key: lv.key,
      title: 'L' + lv.lv + ' · ' + lv.name + '（' + lineName + '）',
      desc: lv.desc + '。影响 ' + dur + ' 分钟，维修 ' + U.fmtMoney(cost) + '。' + (auto ? '线长已自动处置（加急，费用更高）' : '没有线长，需要你亲手处置'),
      routeId: rt ? rt.id : null,
      lineId: rt ? rt.lineId : null,
      lineName: lineName,
      minutes: dur,
      cost: cost,
      satHit: lv.satHit,
      capLoss: lv.capLoss,
      auto: auto,
      handled: false,
      day: g.clock.d,
    };
  }

  // 处置：扣维修费、扣满意度、给当天的运力打折。
  // mode: 'manual' 玩家亲手处置 / 'auto' 线长自动处置 / 'ignore' 不处置（损失放大）
  function resolve(g, inc, mode) {
    if (!inc || inc.handled) return { ok: false, error: '这件事已经处理过了' };
    const econ = g.econ;
    const m = mode || (inc.auto ? 'auto' : 'manual');
    let cost = inc.cost, sat = inc.satHit, cap = inc.capLoss;

    if (m === 'ignore') {
      // 不处置：省下维修费，但运力损失和满意度打击放大
      cost = 0; sat *= 1.5; cap = Math.min(1, cap * 1.6);
    } else if (m === 'manual') {
      // 手工处置比自动便宜（玩家自己上手），但要玩家真的点一下
      cost = Math.round(cost * (MANUAL_COST_MULT / AUTO_COST_MULT) * 100) / 100;
    }

    if (cost > 0) econ.spend('ops', cost);
    inc.handled = true;
    inc.mode = m;
    inc.costPaid = cost;
    inc.capLossApplied = cap;
    if (sat) econ.mods.push({ kind: 'sat', delta: -sat, reason: '事故：' + inc.title, until: U.ymIndex(g.clock.y, g.clock.m) });
    // 运力损失不在这里直接扣钱：写进模型的 disrupt 表，让客流模型自己算出少卖了多少票。
    // 直接扣票款玩家会问「凭什么」，让他看到「今天这条线只开出 66% 的车」才讲得通。
    if (g.syncDisruptions) g.syncDisruptions();
    return { ok: true, cost: cost, sat: sat, cap: cap, mode: m };
  }

  // 每天开始时清掉昨天未处置的事件（它们已经通过 ignore 结算过了）
  // 玩家不点按钮就是默认放弃：省了维修费，但运力与满意度损失放大。
  function sweep(g) {
    if (!g.lastIncidents) return;
    for (const r of g.lastIncidents) if (!r.handled) resolve(g, r, 'ignore');
  }

  // 当天所有未处置事件的运力损失合计，供模型读取
  function disruptionOf(g, routeId) {
    let c = 0;
    if (!g.lastIncidents) return 0;
    for (const r of g.lastIncidents) {
      if (!r.handled || r.mode === 'ignore') continue;
      if (routeId != null && r.routeId !== routeId) continue;
      c += r.capLossApplied || 0;
    }
    return Math.min(0.9, c);
  }

  CM.Incidents = {
    LEVELS: LEVELS, LEVEL_BY_LV: LEVEL_BY_LV,
    PER_TRAIN_MINUTE: PER_TRAIN_MINUTE,
    DAY_MINUTES: DAY_MINUTES,
    sizeFactor: sizeFactor, repairCostFor: repairCostFor,
    trainCount: trainCount, incidentMultOf: incidentMultOf,
    roll: roll, resolve: resolve, sweep: sweep, disruptionOf: disruptionOf,
  };
})(window.CM);
