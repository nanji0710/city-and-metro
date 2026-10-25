'use strict';
// 人员雇佣体系（本作独有）
//
// 为什么要有这一层：
//   参考项目里地铁的运营成本只有「车公里成本 + 站务日成本」两项，班次由引擎按客流自动配车，
//   玩家建完线就只能看着数字走。我们要让「人」成为第三条成本曲线，并且是玩家可以直接干预的那条：
//     · 不雇人 → 线路照跑，但事故只能你亲手点，事故损失全额吃下；
//     · 雇线长 → 事故自动处置，代价是更贵更慢的维修费（用钱买时间）；
//     · 雇调度 → 事故影响时长与事故概率下降；
//     · 雇检修 → 维保费用下降、车龄增长变慢；
//     · 雇站务 → 车站满意度上升（间接抬客流）；
//     · 雇商务 → 广告与商业收入上升。
//   所以人员不是「买了就变强」的增益道具，而是「把不可控风险换成可预期工资」的交易。
//
// 设计约束（踩过的坑，不要重犯）：
//   1. 工资必须进 Economy.day() 的日结算，而不是月底一次性扣 —— 月底扣会掩盖「这个月养了几个人」，
//      玩家在月中看到的日净利是假的。
//   2. 人的效率不能直接乘到票款上。票款是客流 × 票价，客流由 Logit 选择决定；
//      人的作用要作用在「服务属性」上（准点、拥挤、事故），让模型自己算出客流变化。
//   3. 存档必须能无损往返：全部是纯数据（无函数、无 class 实例），随 Game.serialize() 一起存。
(function (CM) {
  const U = CM.U;

  // ======================== 角色 ========================
  // base：该角色在「城市中位工资」基础上的倍率。地铁是技术密集行业，司机与调度要持证，线长要管一条线。
  // eff：把该角色的人均效率（0.72~0.90）映射到实际效果的系数，见 ROLE_EFFECT。
  const ROLES = [
    {
      key: 'line_manager', name: '线长', icon: 'shield', base: 2.1, signing: 6,
      desc: '管一条线的日常运营。线路出事故时自动处置，不用你亲手点，但维修走加急流程，更贵也更慢。',
      effect: '自动处置事故 · 满意度 +',
    },
    {
      key: 'dispatcher', name: '行车调度', icon: 'clock', base: 1.5, signing: 2.6,
      desc: '盯运行图。事故影响时长缩短，事故概率下降。线路越多越值钱，只跑一条线时基本看不出来。',
      effect: '事故时长 − · 事故率 −',
    },
    {
      key: 'driver', name: '列车司机', icon: 'train', base: 1.2, signing: 1.3,
      desc: '按图行车。事故影响时长小幅缩短，事故概率小幅下降。车多时是刚需，车少时可以省。',
      effect: '事故时长 − · 事故率 −',
    },
    {
      key: 'maintainer', name: '车辆检修', icon: 'hammer', base: 1.3, signing: 1.5,
      desc: '日常检修。维保费用下降，车辆老化变慢，事故概率明显下降。',
      effect: '维保费 − · 车龄增长 − · 事故率 −',
    },
    {
      key: 'station_staff', name: '站务员', icon: 'people', base: 1.0, signing: 0.9,
      desc: '站厅站台值守。车站满意度上升，间接抬客流。按车站数量摊，站多时开销大。',
      effect: '满意度 +',
    },
    {
      key: 'commercial', name: '客运商业', icon: 'bag', base: 1.35, signing: 1.9,
      desc: '广告与站内商业。广告收入上升。客流越大越值钱。',
      effect: '广告收入 +',
    },
  ];
  const ROLE_BY_KEY = {};
  for (const r of ROLES) ROLE_BY_KEY[r.key] = r;

  // 等级：1~5 级。效率是「人均产出」，工资与签约费随等级上升，但工资涨得比效率慢一点，
  // 所以高等级是「贵但划算」—— 这是玩家会自己算出来的结论，不用我们教。
  const LEVELS = [
    { lv: 1, name: '见习', eff: 0.72, salary: 1.00, fee: 1.0 },
    { lv: 2, name: '熟练', eff: 0.78, salary: 1.22, fee: 1.6 },
    { lv: 3, name: '资深', eff: 0.83, salary: 1.50, fee: 2.4 },
    { lv: 4, name: '骨干', eff: 0.87, salary: 1.85, fee: 3.5 },
    { lv: 5, name: '专家', eff: 0.90, salary: 2.30, fee: 5.0 },
  ];

  // 特性：每个候选人 0~2 条。key 决定它挂到哪个效果上，value 是强度。
  // 全部用「乘法修正」而不是「加法加成」，因为加法在后期会失控。
  const TRAITS = [
    { key: 'incident', name: '老练', text: '事故概率 −12%', value: 0.88 },
    { key: 'incident', name: '稳手', text: '事故概率 −8%', value: 0.92 },
    { key: 'incident', name: '冒失', text: '事故概率 +15%', value: 1.15 },
    { key: 'onTime', name: '守时', text: '事故影响时长 −2.5%', value: 0.025 },
    { key: 'onTime', name: '拖沓', text: '事故影响时长 +2%', value: -0.02 },
    { key: 'cost', name: '会算账', text: '该角色相关成本 −10%', value: 0.90 },
    { key: 'cost', name: '大手大脚', text: '该角色相关成本 +12%', value: 1.12 },
    { key: 'sat', name: '热心', text: '满意度 +4', value: 4 },
    { key: 'sat', name: '冷淡', text: '满意度 −3', value: -3 },
    { key: 'revenue', name: '会做生意', text: '广告与商业收入 +10%', value: 1.10 },
    { key: 'salary', name: '要求高', text: '工资 +15%', value: 1.15 },
    { key: 'salary', name: '务实', text: '工资 −10%', value: 0.90 },
    { key: 'loyalty', name: '踏实', text: '忠诚度衰减更慢', value: 0.5 },
    { key: 'repair', name: '会修', text: '维修费 −15%', value: 0.85 },
  ];

  const NAMES_SURNAME = '王李张刘陈杨黄赵周吴徐孙马朱胡林郭何高罗郑梁谢宋唐许韩冯邓曹彭曾萧田董潘袁蔡蒋余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';
  const NAMES_GIVEN = ['伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '秀英', '霞', '平', '刚', '桂英', '建国', '志强', '文', '晨', '宇', '婷', '浩', '雨欣', '子涵', '思远', '嘉怡', '若彤'];

  // ======================== 工具 ========================
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }

  function randomName(rng) {
    const s = NAMES_SURNAME[Math.floor(rng() * NAMES_SURNAME.length) % NAMES_SURNAME.length];
    const g = pick(rng, NAMES_GIVEN);
    return s + g;
  }

  // 中位工资：随年份涨（用参考项目同一套价格指数，保证与其他成本同步膨胀）
  function wageIndex(year) { return U.priceIndex(year, 0.045, CM.CFG.econBase || 1990); }

  // 一个岗位的年薪基准（万元）：角色倍率 × 城市中位 × 年份指数
  // 5 万元/年 是「1990 年一名地铁职工」的量级，与参考项目 ops.carKmCost 的口径（万元）一致
  const BASE_WAGE = 5;

  function salaryOf(roleKey, level, year, traits) {
    const role = ROLE_BY_KEY[roleKey];
    const L = LEVELS[Math.max(0, Math.min(4, (level | 0) - 1))];
    let s = BASE_WAGE * role.base * L.salary * wageIndex(year) / 12;   // 万元/月
    for (const t of traits || []) if (t.key === 'salary') s *= t.value;
    return s;
  }

  function signingFeeOf(roleKey, level, year, traits) {
    const role = ROLE_BY_KEY[roleKey];
    const L = LEVELS[Math.max(0, Math.min(4, (level | 0) - 1))];
    let s = BASE_WAGE * role.signing * L.fee * wageIndex(year);
    for (const t of traits || []) if (t.key === 'salary') s *= t.value;
    return s;
  }

  // ======================== 候选人市场 ========================
  function makeCandidate(rng, roleKey, year, opts) {
    opts = opts || {};
    const role = ROLE_BY_KEY[roleKey] || ROLES[0];
    // 等级分布：低等级多、高等级少。开局给玩家看到的是「便宜的菜鸟」与「贵的高手」并存
    const roll = rng();
    const lv = roll < 0.34 ? 1 : roll < 0.62 ? 2 : roll < 0.83 ? 3 : roll < 0.96 ? 4 : 5;
    const traits = [];
    const n = rng() < 0.30 ? 0 : (rng() < 0.72 ? 1 : 2);
    const pool = TRAITS.slice();
    for (let i = 0; i < n && pool.length; i++) {
      const k = Math.floor(rng() * pool.length);
      traits.push(pool[k]);
      pool.splice(k, 1);
    }
    const salary = salaryOf(roleKey, lv, year, traits);
    const fee = signingFeeOf(roleKey, lv, year, traits);
    return {
      id: 'c' + (opts.seq || Math.floor(rng() * 1e9).toString(36)),
      role: roleKey,
      name: opts.name || randomName(rng),
      level: lv,
      salary: Math.round(salary * 100) / 100,     // 万元/月
      signingFee: Math.round(fee * 100) / 100,    // 万元（一次性）
      traits: traits.map(function (t) { return { key: t.key, name: t.name, text: t.text, value: t.value }; }),
      expiresAt: (opts.expiresAt || 0),           // 年*12+月 的月序号，到期后从市场移除
      lineId: null,
    };
  }

  // ======================== 状态 ========================
  function Staff() {
    this.hired = [];        // 已雇佣的人
    this.market = [];       // 人才市场
    this.seq = 1;
    this.refreshAt = null;  // 上次刷新市场的月序号
    this.autoManage = false; // 「托管」：让线长按默认策略自动调班次（本作独有）
  }
  CM.Staff = Staff;

  Staff.prototype.serialize = function () {
    return { hired: this.hired, market: this.market, seq: this.seq, refreshAt: this.refreshAt, autoManage: this.autoManage };
  };
  Staff.restore = function (s) {
    const st = new Staff();
    if (!s) return st;
    st.hired = s.hired || [];
    st.market = s.market || [];
    st.seq = s.seq || 1;
    st.refreshAt = s.refreshAt || null;
    st.autoManage = !!s.autoManage;
    return st;
  };

  // 月序号：与参考项目的 U.ymIndex 同口径，用于到期判定
  function ym(y, m) { return y * 12 + (m - 1); }

  // 每月刷新市场：固定 6 个岗位各 1~2 人，过期的人被替换。
  // 为什么要每月换人：人才市场如果常驻，玩家会「等最好的那个」，永远不下手；
  // 有到期日才会形成「现在这个够用了吗」的决策。
  Staff.prototype.refreshMarket = function (rng, y, m, slots) {
    const cur = ym(y, m);
    this.market = this.market.filter(function (c) { return c.expiresAt > cur; });
    const target = slots || 7;
    let guard = 0;
    while (this.market.length < target && guard++ < 40) {
      const role = ROLES[Math.floor(rng() * ROLES.length)];
      const c = makeCandidate(rng, role.key, y, { seq: this.seq++, expiresAt: cur + 3 });
      this.market.push(c);
    }
    this.refreshAt = cur;
  };

  // ======================== 效果汇总 ========================
  // 把「这个城市里所有在编人员」折算成一组可乘到模型上的系数。
  // lineId 为 null 的人算「城市级」（例如管全网调度的调度员）；指定了 lineId 的只作用于该线。
  //
  // 返回：
  //   incidentMult  事故概率乘数（<1 更好）
  //   onTimeAdd     准点加成：折算成事故影响时长的缩短比例（见 incidents.js 的 roll）
  //   satAdd        满意度加值（直接加到 0~100 的满意度上）
  //   repairMult    维修费乘数
  //   maintMult     维保成本乘数
  //   revenueMult   广告与商业收入乘数
  //   autoHandle    是否有线长在线（事故自动处置）
  //   payroll       每日工资总额（万元/天）
  //   headcount     在编人数
  function effects(staff, year, opts) {
    opts = opts || {};
    const lineId = opts.lineId || null;
    const out = {
      incidentMult: 1, onTimeAdd: 0, satAdd: 0, repairMult: 1, maintMult: 1, revenueMult: 1,
      autoHandle: false, payroll: 0, headcount: 0, roles: {},
      // 哪些线路有「专属线长」：事故自动处置按线判定（见 incidents.js 的 roll）
      lineAuto: {},
    };
    if (!staff) return out;
    for (const p of staff.hired) {
      const role = ROLE_BY_KEY[p.role];
      if (!role) continue;
      const L = LEVELS[Math.max(0, Math.min(4, (p.level | 0) - 1))];
      const w = L.eff;
      /* 效果归属：未指派 = 全网；指派了线路 = 只作用于那条线。
       *
       * 旧实现把「指派了线路」的人整个 continue 掉，于是他们既不产生任何效果、
       * 也不进 payroll —— 指派一个线长等于白雇一个免费且无效的人，这是本轮体检
       * 抓出来的真 bug。现在工资与人数一律照发（钱不管组织架构），
       * 效果则按归属计入；派到线路的人由 effectsCity() 按线路规模折算进全网。 */
      const mine = !p.lineId || (lineId && p.lineId === lineId);
      if (!lineId) {
        // 工资只有城市级汇总算一次，否则逐线求和会重复发钱
        out.headcount++;
        out.roles[p.role] = (out.roles[p.role] || 0) + 1;
        out.payroll += (p.salary || 0) / 30;   // 万元/月 ÷ 30 = 万元/天
      }
      if (p.role === 'line_manager' && p.lineId) out.lineAuto[p.lineId] = true;
      if (!mine) continue;
      for (const t of p.traits || []) {
        if (t.key === 'incident') out.incidentMult *= t.value;
        if (t.key === 'onTime') out.onTimeAdd += t.value;
        if (t.key === 'sat') out.satAdd += t.value;
        if (t.key === 'repair') out.repairMult *= t.value;
        if (t.key === 'revenue') out.revenueMult *= t.value;
      }
      switch (p.role) {
        case 'line_manager':
          out.autoHandle = true;
          out.satAdd += 6 * w;
          break;
        case 'dispatcher':
          out.incidentMult *= 1 - 0.08 * w;
          out.onTimeAdd += 0.06 * w;
          break;
        case 'driver':
          out.incidentMult *= 1 - 0.05 * w;
          out.onTimeAdd += 0.015 * w;
          break;
        case 'maintainer':
          out.incidentMult *= 1 - 0.15 * w;
          out.maintMult *= 1 - 0.22 * w;
          out.repairMult *= 1 - 0.10 * w;
          break;
        case 'station_staff':
          out.satAdd += 4 * w;
          break;
        case 'commercial':
          out.revenueMult *= 1 + 0.28 * w;
          break;
      }
    }
    // 人多了要有管理层：超过 8 人时，人均效率被稀释（不是惩罚，是「管不过来」）
    if (out.headcount > 8) {
      const dilute = 1 - Math.min(0.25, (out.headcount - 8) * 0.02);
      out.onTimeAdd *= dilute;
      out.satAdd *= dilute;
    }
    out.payroll = Math.round(out.payroll * 10000) / 10000;
    return out;
  }
  Staff.effects = effects;

  /* 全网效果：城市级人员 + 各线专属人员，按线路规模折算成一组系数。
   *
   * 为什么需要这一层：effects() 是「一个作用域」的汇总，而玩家可以把某个人
   * 指派到一条线（面板上的「负责线路」下拉框）。指派的意义是「专责」：
   * 他的人只盯这一条线，所以效果要按这条线的运营规模折算进全网，
   * 而不是直接消失（旧实现就是直接消失，见 effects() 里的注释）。
   *
   * weights：{ lineId: 规模占比 }，由 Game.lineWeights() 按配属列车公里算出。
   * 加权方式：
   *   乘性系数（事故率/维保/维修/收入）按占比线性混合 ——
   *     m = m_city × Σ share_i × (m_line_i / m_city)
   *   加性系数（准点、满意度）按占比加权平均增量。
   * 这样「把检修派到干线」比「派到支线」更值钱，下拉框才是个真决策。
   */
  function effectsCity(staff, year, weights) {
    const out = effects(staff, year, { lineId: null });
    if (!staff || !staff.hired.length) return out;
    // 有哪些线挂了专属人员
    const ids = [];
    for (const p of staff.hired) if (p.lineId && ids.indexOf(p.lineId) < 0) ids.push(p.lineId);
    if (!ids.length) return out;
    const share = {}, res = {};
    let tot = 0;
    for (const id of ids) { const w = Math.max(0, (weights && weights[id]) || 0); share[id] = w; tot += w; }
    if (tot <= 0) {
      // 规模信息不可用（线路刚拆光/权重没传）：按平均分摊，避免「派了人却没效果」
      for (const id of ids) share[id] = 1 / ids.length;
    } else {
      for (const id of ids) share[id] = share[id] / tot;
    }
    for (const id of ids) res[id] = effects(staff, year, { lineId: id });
    const MUL = ['incidentMult', 'repairMult', 'maintMult', 'revenueMult'];
    for (const k of MUL) {
      const base = out[k] || 1;
      let mix = 0;
      for (const id of ids) mix += share[id] * ((res[id][k] || 1) / base);
      out[k] = base * mix;
    }
    const ADD = ['onTimeAdd', 'satAdd'];
    for (const k of ADD) {
      let mix = 0;
      for (const id of ids) mix += share[id] * ((res[id][k] || 0) - out[k]);
      out[k] = out[k] + mix;
    }
    // 专属线长：把「哪些线能自动处置」交给 incidents 按线判断
    // （逐线明细 res[] 已经按规模占比混进上面的乘性/加性系数，不再单独挂到 out 上）
    for (const id of ids) {
      if (res[id].autoHandle && res[id].lineAuto[id]) out.lineAuto[id] = true;
    }
    return out;
  }
  Staff.effectsCity = effectsCity;

  // 工资合计（万元/月），用于面板显示
  function payrollMonthly(staff) {
    let s = 0;
    if (staff) for (const p of staff.hired) s += p.salary || 0;
    return s;
  }
  Staff.payrollMonthly = payrollMonthly;

  // ======================== 雇佣与解雇 ========================
  Staff.prototype.hire = function (candId, lineId, econ) {
    const i = this.market.findIndex(function (c) { return c.id === candId; });
    if (i < 0) return { error: '这个候选人已经不在了' };
    const c = this.market[i];
    if (econ && !econ.isFree()) {
      if (!econ.canAfford(c.signingFee)) return { error: '资金不足：签约费需要 ' + U.fmtMoney(c.signingFee) };
      econ.spend('ops', c.signingFee);
    }
    this.market.splice(i, 1);
    const p = Object.assign({}, c, { lineId: lineId || null, hiredAt: null });
    this.hired.push(p);
    return { ok: true, person: p };
  };

  Staff.prototype.fire = function (personId, econ) {
    const i = this.hired.findIndex(function (p) { return p.id === personId; });
    if (i < 0) return { error: '没有这个人' };
    const p = this.hired[i];
    // 解约金：半个月工资。没有代价的解雇会让玩家每小时重排一次阵容，人员就没有「承诺」的意味了
    const fee = (p.salary || 0) / 2;
    if (econ && !econ.isFree()) {
      if (!econ.canAfford(fee)) return { error: '资金不足：解约金需要 ' + U.fmtMoney(fee) };
      if (fee > 0.5) econ.spend('ops', fee);
    }
    this.hired.splice(i, 1);
    return { ok: true, fee: fee };
  };

  Staff.prototype.assign = function (personId, lineId) {
    const p = this.hired.find(function (x) { return x.id === personId; });
    if (!p) return { error: '没有这个人' };
    p.lineId = lineId || null;
    return { ok: true };
  };

  // ======================== 每月维护 ========================
  // 工资在这里不扣（工资走日结算），这里只做：市场刷新、忠诚度、涨薪诉求。
  Staff.prototype.month = function (g, y, m) {
    const rng = CM.Staff.rngFor(g, y, m);
    this.refreshMarket(rng, y, m, 7);
    const notes = [];
    for (const p of this.hired) {
      p.tenure = (p.tenure || 0) + 1;
      // 每年 1 月：老员工要求涨薪（在编满 2 年才提）
      if (m === 1 && p.tenure >= 24) {
        const raise = 1 + 0.06 + rng() * 0.05;
        p.salary = Math.round(p.salary * raise * 100) / 100;
        notes.push(p.name + ' 要求涨薪，月薪调整为 ' + U.fmtMoney(p.salary));
      }
    }
    return notes;
  };

  // 市场刷新用的确定性随机：同一年月 + 同一局 seed 必须得到同一批人，
  // 否则读档后市场会变，玩家会以为自己记错了。
  //
  // 注意：U.RNG 是对象（.next()），本文件内部一律按 rng() 函数调用，
  // 所以这里包一层可调用函数，别直接返回 RNG 实例。
  function rngFn(seed) {
    const r = new U.RNG(seed);
    return function () { return r.next(); };
  }
  Staff.rng = rngFn;
  Staff.rngFor = function (g, y, m) {
    const seed = ((g && g.seed ? g.seed : 1) * 31 + y * 12 + m) >>> 0;
    return rngFn(seed);
  };

  // ======================== 供 UI 用的元数据 ========================
  Staff.ROLES = ROLES;
  Staff.ROLE_BY_KEY = ROLE_BY_KEY;
  Staff.LEVELS = LEVELS;
  Staff.TRAITS = TRAITS;
  Staff.levelName = function (lv) {
    const L = LEVELS[Math.max(0, Math.min(4, (lv | 0) - 1))];
    return L ? L.name : '—';
  };
  Staff.roleName = function (k) {
    const r = ROLE_BY_KEY[k];
    return r ? r.name : k;
  };
  // 工资与签约费：面板要显示「雇这个人每月多少钱」，必须能从外面算，
  // 不能只藏在 makeCandidate 里 —— 否则 UI 只能显示候选人身上带的那个数，
  // 玩家换等级、换年份就看不到价格怎么变的。
  Staff.salaryOf = salaryOf;
  Staff.signingFeeOf = signingFeeOf;
  Staff.wageIndex = wageIndex;
})(window.CM);
