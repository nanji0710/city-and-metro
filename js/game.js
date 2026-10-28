'use strict';
// 游戏状态与流程：时钟、日/月结算、跳月/跳年、建设草案、预测与存档序列化
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA, M = CM.Metro;

  function Game() {
    U.Emitter.call(this);
    this.speed = 0;
    this.pending = null;
    this.jumping = null;
    this.draft = null;
    this.events = [];
    this.history = [];
    this.netVersion = 0;
    this.rev = 0;            // 持久状态版本：日结算、建设、票价等变化时递增（时钟另行比较）
    this.favs = { stations: [], lines: [] };
  }
  Game.prototype = Object.create(U.Emitter.prototype);
  CM.Game = Game;
  Game.prototype.touch = function () { this.rev++; };

  /* 把难度倍率与城市轻量特性合并。城市特性不能改存档结构，
   * 只是在进入/恢复某一局时折进模型与建设报价。
   * 需求：模型 demandMult；建设：Metro 全局 buildMult。 */
  function applyCityRates(g) {
    const tr = CM.MAPS && CM.MAPS[g.mapId] && CM.MAPS[g.mapId].trait;
    const D = CM.Difficulty ? CM.Difficulty.get(g.difficulty) : null;
    const dm = D ? D.demandMult : 1;
    const bm = D ? D.buildMult : 1;
    if (g.model) g.model.demandMult = dm * (tr && tr.demand ? tr.demand : 1);
    if (M && M.setBuildMult) M.setBuildMult(bm * (tr && tr.build ? tr.build : 1));
  }

  Game.create = function (opts) {
    const g = new Game();
    g.id = U.uid('g');
    g.mapId = CM.mapId || 'gz';   // 当前地图（CM.useMap 已切换好数据）
    g.name = opts.name || ((D.city || '广州') + ' ' + CFG.START.y);
    g.mode = opts.mode;
    // 难度档位（本作独有）。free 模式（教程）不参与难度：它要展示所有玩法，
    // 任何惩罚倍率都会让新手以为「点了按钮就掉钱」。存档里由 econ.difficulty 恢复。
    g.difficulty = CM.Difficulty ? CM.Difficulty.norm(opts.difficulty || CM.Difficulty.DEFAULT_KEY) : null;
    if (g.mode === 'free') g.difficulty = 'easy';
    /*
     * 多城扩张（本作独有）：这一局属于哪家公司。opts.company 只在「进驻新城」时给，
     * 普通开局为空 —— 公司层是可选玩法，不给也完全能玩，这样基底的单局体验不被破坏。
     */
    g.company = opts.company ? { id: opts.company.id, name: opts.company.name } : null;
    g.seed = opts.seed || (CFG.START.y * 10000 + 101);
    if (opts.tutorial) g.tutorial = { step: 0, done: [], started: Date.now() };
    g.createdAt = Date.now();
    g.clock = Object.assign({}, CFG.START, opts.startClock || {});
    g.city = new CM.City();
    g.city.generate(g.seed, g.clock.y);
    g.model = new CM.Model(g.city);
    g.model.setYear(g.clock.y);
    g.model.setDayType(CM.Model.dayType(g.clock.y, g.clock.m, g.clock.d));
    // 难度 + 城市特性：客流与建设成本必须在 setNetwork / 第一次报价之前设好
    applyCityRates(g);
    g.traffic = { v: CFG.TRAFFIC_MODEL };
    g.net = M.empty();
    g.mapInit = buildInitialNetwork(g);   // 开局既有地铁（东京 1950 年等），只在新建时生成一次，随存档保存
    g.compiled = M.compile(g.net, g.city);
    g.model.setNetwork(g.compiled);
    g.econ = new CM.Economy(g.mode, g.clock.y, g.clock.m, g.difficulty, opts.startFunds);
    g.model.fare = g.econ.fare;
    g.tasks = new CM.Tasks();
    // 人员：开局给一个空队伍 + 一批候选人。开局就有市场，玩家第一眼就能看到「人是有价的」
    g.staff = CM.Staff ? new CM.Staff() : null;
    if (g.staff) g.staff.refreshMarket(CM.Staff.rngFor(g, g.clock.y, g.clock.m), g.clock.y, g.clock.m, 7);
    g.model.solveNow(2);
    g.econ.startMonth(g.clock.y, g.clock.m);
    const e0 = D.events && D.events[0];
    if (e0) g.logEvent({ tag: e0.tag || '史实', title: e0.title, desc: e0.desc });
    g.firedEvents = { 0: 1 };
    g.tasks.monthly(g).forEach(function (o) { g.logTask(o); });
    // 城市经济：真实城市开局即接入（教程不启用）；开局当月已发生的经济事件一并记录
    if (CM.Macro) for (const x of CM.Macro.create(g) || []) g.logMacroEvent(x);
    g.recordHistory();
    if (CM.Milestones) CM.Milestones.onStart(g);
    return g;
  };

  // 开局时已运营的真实地铁：直接属于玩家，不收取历史建设费；之后正常产生运营费用与票款，可改造、扩建或拆除
  function buildInitialNetwork(g) {
    const IN = D.initialNetwork; if (!IN) return null;
    const net = g.net, city = g.city, desc = [];
    for (const L of IN.lines) {
      const lid = M.newLine(net);
      if (L.color) net.lines[lid].color = L.color;
      if (L.name) net.lines[lid].name = L.name;
      let prev = null;
      for (const st of L.stations) {
        const sid = M.addStation(net, st[1], st[2], { size: st[3] || L.size || 'M', type: L.type || 'underground' }, city);
        const s = net.stations[sid]; s.name = st[0]; s.built = [st[4] || L.year || CFG.START.y, 1]; s.site = [s.x, s.y]; s.inherited = true;
        if (prev) M.addSegment(net, lid, prev, sid, [], L.type || 'underground');
        prev = sid;
      }
      desc.push(net.lines[lid].name + ' ' + L.stations[0][0] + '—' + L.stations[L.stations.length - 1][0] + '（' + L.stations.length + ' 站）');
    }
    M.normalizeLines(net);
    for (const id in net.segments) { net.segments[id].built = [IN.year || CFG.START.y, 1]; net.segments[id].inherited = true; }
    return { metro: (IN.note ? IN.note + '：' : '') + desc.join('；'), year: CFG.START.y };
  }

  Game.prototype.year = function () { return this.clock.y + (this.clock.m - 1) / 12 + (this.clock.d - 1) / 365; };
  Game.prototype.ym = function () { return U.ymIndex(this.clock.y, this.clock.m); };
  Game.prototype.logEvent = function (e) {
    e.y = e.y || this.clock.y; e.m = e.m || this.clock.m;
    this.events.push(e);
    if (this.events.length > 400) this.events.shift();
    this.emit('event', e);
  };
  // 经济事件：记入城市纪事的事件列表（史实 / 模拟），说明本城受影响的程度
  Game.prototype.logMacroEvent = function (x) {
    const ev = x.ev, f = x.f, k = f.k, neg = Math.min.apply(null, ev.lv) < 0;
    const peak = ev.lv.reduce(function (a, v) { return Math.abs(v) > Math.abs(a) ? v : a; }, 0) * k;
    const lvl = Math.abs(peak) < 0.005 ? '较小' : (Math.abs(peak) < 0.02 ? '中等' : (Math.abs(peak) < 0.045 ? '较大' : '严重'));
    const sim = ev.tag === '模拟', name = ev.title.replace(/^模拟：/, '');
    this.logEvent({ tag: ev.tag || '史实', kind: 'econ', econId: ev.id, title: (sim ? '经济（模拟）：' : '经济：') + name, desc: ev.desc + (neg ? ' 对本城经济的影响：' + lvl + '。' : ' 对本城经济的带动：' + lvl + '。') });
    this.emit('toast', { kind: neg ? 'warn' : 'info', text: sim ? '经济（模拟）：' + name : ev.y + ' 年：' + name });
    this.emit('macroEvent', x);
  };
  Game.prototype.logTask = function (o) {
    const t = o.task;
    if (o.type === 'issued') { this.logEvent({ tag: '任务', title: '新任务：' + t.title, desc: t.desc }); this.emit('toast', { kind: 'info', text: '新任务：' + t.title }); }
    else if (o.type === 'done') { this.logEvent({ tag: '任务', title: '任务完成：' + t.title, desc: this.econ.mode === 'challenge' ? '获得奖励拨款 ' + U.fmtMoney(t.reward) : '' }); this.emit('toast', { kind: 'good', text: '任务完成：' + t.title }); }
    else if (o.type === 'failed') { this.logEvent({ tag: '任务', title: '任务未完成：' + t.title, desc: this.econ.mode === 'challenge' ? '后果：未来 ' + CFG.economy.failGrantMonths + ' 个月（含本月）拨款 ×' + CFG.economy.failGrantFactor + '，满意度下降' : '自由建造模式下无后果' }); this.emit('toast', { kind: 'bad', text: '任务未完成：' + t.title }); }
  };

  // ---------------- 时钟 ----------------
  Game.prototype.setSpeed = function (s) { this.speed = s; this.emit('speed', s); };
  Game.prototype.update = function (dt) {
    const budget = CFG.perf.solverBudgetMs;
    if (this.jumping) { this.stepJump(); return; }
    if (this.pending) {
      const t0 = performance.now();
      while (this.pending && performance.now() - t0 < 6) {
        const r = this.pending.next();
        if (r.done) this.pending = null;
      }
      this.model.step(2);
      return;
    }
    if (this.speed > 0 && !this.econ.failed) {
      let mins = dt * CFG.time.speeds[this.speed - 1] / CFG.time.secPerHour * 60;
      this.clock.minute += mins;
      if (this.clock.minute >= 1440) {
        this.clock.minute -= 1440;
        if (this.clock.minute >= 1440) this.clock.minute = 0;
        if (this.endDay()) this.pending = this.monthGen();
      }
    }
    this.model.step(budget);
  };
  // 日终：按当天的日类型（工作日 / 周末）结算票款与运营费用，推进日期；返回是否跨月
  Game.prototype.dayType = function () { return CM.Model.dayType(this.clock.y, this.clock.m, this.clock.d); };
  Game.prototype.endDay = function () {
    const dt = this.dayType();
    // 人员效果：每天重算一次（人的作用随队伍变化，且工资是日结的）
    const se = this.staffEffects();
    this.econ.day(this.model.dailyFor(dt), this.compiled, this.clock.y, dt, se);
    // 突发事件：按「在途列车数 × 分钟」的概率判定。没有线长的线路，事故只能玩家亲手处置
    if (CM.Incidents) this.runIncidents(dt, se);
    this.clock.d++;
    this.rev++;
    if (this.clock.d > U.daysInMonth(this.clock.y, this.clock.m)) {
      this.clock.d = 1;
      this.econ.closeMonth();
      const f = this.econ.checkFailure(this.clock.y, this.inTransition(U.ymIndex(this.clock.y, this.clock.m) + 1));
      this.clock.m++;
      if (this.clock.m > 12) { this.clock.m = 1; this.clock.y++; }
      this.model.setDayType(this.dayType());
      if (f) this.onFailure(f);
      return true;
    }
    this.model.setDayType(this.dayType());
    this.emit('day');
    return false;
  };
  // 交通模型升级过渡期（旧存档升级当月，至该月月末结算）：满意度不因统计口径变化而下降，任务不判失败、连续进度不清零
  Game.prototype.inTransition = function (ym) { const t = this.traffic; return !!(t && t.until != null && ym <= t.until); };

  // ---------------- 人员（本作独有） ----------------
  // 每天把在编人员折算成一组系数交给结算。缓存一天，避免同一帧里多个面板重复算。
  //
  // 线路规模权重：指派到某条线的员工，效果按该线在全网运营规模中的占比折算
  // （见 staff.js 的 effectsCity）。权重用「配属列车公里 = 里程 × 编组」当代理：
  // 真正的车公里要等当天运行图算完才有，而系数必须先于结算拿到。
  Game.prototype.lineWeights = function () {
    const out = {};
    const rt = (this.compiled && this.compiled.routes) || [];
    for (const r of rt) {
      const km = (r.lenM / 1000) * (r.cars || 1);
      if (km > 0) out[r.lineId] = (out[r.lineId] || 0) + km;
    }
    return out;
  };
  Game.prototype.staffEffects = function () {
    if (!this.staff || !CM.Staff) return null;
    const key = this.clock.y + ':' + this.clock.m + ':' + this.clock.d + ':' + this.staff.hired.length;
    if (this._seKey === key) return this._seCache;
    const se = CM.Staff.effectsCity(this.staff, this.clock.y, this.lineWeights());
    this._seKey = key;
    this._seCache = se;
    return se;
  };
  // 单线视角：该线 + 城市级人员的效果（事故按线判定、面板按线解释用）
  Game.prototype.lineEffects = function (lineId) {
    if (!this.staff || !CM.Staff) return null;
    return CM.Staff.effects(this.staff, this.clock.y, { lineId: lineId });
  };
  // 这条线的专属人员是否足以自动处置事故：全线长覆盖全网，专属线长只覆盖自己那条线
  Game.prototype.lineAutoHandle = function (lineId) {
    const se = this.staffEffects();
    if (!se) return false;
    if (se.autoHandle) return true;
    return !!(se.lineAuto && lineId && se.lineAuto[lineId]);
  };
  // 改动队伍后必须让缓存失效，否则玩家刚雇的人当天不生效
  Game.prototype.invalidateStaff = function () { this._seKey = null; this._seCache = null; };

  // ---------------- 突发事件（本作独有） ----------------
  // 按「在途列车数 × 分钟」判定。没有线长的线路只能玩家亲手处置，
  // 有 line_manager 的线路自动处置但更贵更慢 —— 这是「用钱买时间」唯一的存在理由。
  Game.prototype.runIncidents = function (dt, se) {
    if (!CM.Incidents || !this.compiled) return;
    // 昨天没处置的事件先按「不处置」结算掉：玩家没点，就是默认放弃
    CM.Incidents.sweep(this);
    const r = CM.Incidents.roll(this, dt, se);
    if (r) {
      this.lastIncidents = this.lastIncidents || [];
      this.lastIncidents.push(r);
      if (this.lastIncidents.length > 12) this.lastIncidents.shift();
      this.logEvent({ tag: '突发', title: r.title, desc: r.desc });
      // 线长在线就直接处置（贵、慢，但玩家不用管）
      if (r.auto) CM.Incidents.resolve(this, r, 'auto');
      else {
        this.emit('incident', r);
        // 再补一条 toast：事故是唯一「玩家必须亲手点」的东西，
        // 只写进日志等于让它躺在日报里等人翻 —— 而它当天不处置就按放弃结算。
        this.emit('toast', { kind: 'bad', text: r.title + ' · 待处置（' + U.fmtMoney(r.cost) + '）', act: { label: '去处置', open: 'staff' } });
      }
    }
    this.syncDisruptions();
  };

  // 把「已处置事件」的运力损失汇总成 {routeId: 损失比例}，交给 sim.js 的自动配车环节读。
  // 每天结算前与每次处置后都要调一次，否则模型读到的是昨天的损失。
  Game.prototype.syncDisruptions = function () {
    if (!this.model) return;
    const map = {};
    if (CM.Incidents && this.lastIncidents) {
      for (const r of this.lastIncidents) {
        if (!r.handled || r.routeId == null) continue;
        map[r.routeId] = Math.min(0.9, (map[r.routeId] || 0) + (r.capLossApplied || 0));
      }
    }
    this.model.disrupt = map;
  };

  // 玩家亲手处置（面板上的按钮）。没处置的事件会在当日结算里按损失计。
  Game.prototype.handleIncident = function (id) {
    if (!CM.Incidents || !this.lastIncidents) return { ok: false, error: '没有待处置的事件' };
    const r = this.lastIncidents.find(function (x) { return x.id === id; });
    if (!r) return { ok: false, error: '这件事已经不在了' };
    if (r.handled) return { ok: false, error: '已经处置过了' };
    const c = CM.Incidents.resolve(this, r, 'manual');
    if (c && c.ok) { this.rev++; this.invalidateStaff(); this.emit('finance'); }
    return c;
  };
  Game.prototype.onFailure = function (f) {
    this.setSpeed(0);
    this.logEvent({ tag: '经营', title: '经营挑战失败', desc: f.reasons.join('；') });
    this.emit('failed', f);
  };

  // 月度处理（分步执行，避免画面卡顿）
  Game.prototype.monthGen = function* () {
    const y = this.clock.y, m = this.clock.m, city = this.city, model = this.model;
    // 城市更新前停止旧预测，避免分步刷新后恢复到旧需求或旧路网的计算中。
    if (this.draft) this.invalidatePrediction('城市正在更新，请在结算完成后重新计算预测');
    const yr = y + (m - 1) / 12;
    model.setYear(yr);
    // 历史事件
    D.events.forEach((e, k) => {
      if (this.firedEvents[k]) return;
      if (U.ymIndex(e.y, e.m) <= U.ymIndex(y, m)) { this.firedEvents[k] = 1; this.logEvent({ tag: e.tag, title: e.title, desc: e.desc }); this.emit('toast', { kind: 'info', text: e.y + ' 年：' + e.title }); if (CM.Milestones) CM.Milestones.onEvent(this, e, k); }
    });
    // 城市经济：1 月结算上一年 GDP 与地方财政、确定本年预算与经济周期；触发到期的经济事件（每个事件只生效一次）
    if (this.macro && CM.Macro) for (const x of CM.Macro.month(this, y, m)) this.logMacroEvent(x);
    const ef = this.macro && CM.Macro ? CM.Macro.cityFactors(this) : null;
    if (D.airport && yr >= D.airport.closeYear + 7 / 12) {
      if (city.lu.some(function (v) { return v === CM.LU.AIRPORT; })) city.closeAirport();
    }
    let roadsChanged = false;
    // 系统填海：到达年份的填海土地成陆（之后可开发与建设）
    for (const r of city.applyReclaim(y)) {
      roadsChanged = true;
      this.logEvent({ tag: r.tag || '史实', title: '填海成陆：' + r.name, desc: r.desc || '新土地将逐步开发，之后可以在此建站与铺轨。' });
      this.emit('toast', { kind: 'info', text: '填海成陆：' + r.name });
      if (CM.Milestones) CM.Milestones.onReclaim(this, r);
    }
    const before = city.roadsBuilt.slice();
    if (city.applyRoads(y)) {
      roadsChanged = true;
      const told = new Set();
      city.roadGroups.forEach((r, k) => {
        if (before[k] || !city.roadsBuilt[k] || !r.notable || !r.name || told.has(r.name) || r.cls < 2) return;
        told.add(r.name);
        this.logEvent({ tag: r.sim ? '模拟' : '史实', title: r.name + (r.sim ? '建成（模拟规划）' : '通车（参考）'), desc: '' });
      });
    }
    const lmBefore = city.landmarkOn.slice();
    city.activateLandmarks(y);
    if (CM.Milestones) CM.Milestones.onLandmarks(this, lmBefore);
    // 区域开放
    const tot = city.totals();
    for (let k = 0; k < city.regions.length; k++) {
      const rg = city.regions[k];
      if (city.regionOpen[k] || rg.open == null) continue;
      if (rg.id === 'airport' && !D.airport.buildable && yr < D.airport.closeYear + 7 / 12) continue;
      const byYear = y >= rg.open;
      // 人口提前达到门槛时可提前开放；经济繁荣时提前窗口放宽一年，衰退时门槛略为提高
      const early = rg.pop && tot.pop >= rg.pop * (ef && ef.dev < -0.03 ? 1.03 : 1) && y >= rg.open - (ef && ef.dev > 0.02 ? 4 : 3);
      if (byYear || early) {
        city.openRegion(k, y, m);
        const why = byYear ? '参考 ' + rg.open + ' 年开放' : '城市人口增长，提前开放（参考 ' + rg.open + ' 年）';
        this.logEvent({ tag: byYear ? '史实' : '模拟', title: '新区域开放：' + rg.name, desc: why + (rg.note ? '。' + rg.note : '') });
        this.emit('toast', { kind: 'info', text: '新区域开放：' + rg.name });
      }
    }
    yield;
    // 城市发展
    const acc = model.net ? model.net.acc : null;
    const econF = this.macro && CM.Macro ? CM.Macro.applyFactors(this) : null;
    const gr = city.growMonth({ year: yr, monthIndex: this.ym(), zoneAccess: model.zoneAccessNorm, cellWalk: acc ? acc.cellWalk : null, coverage: acc ? acc.coverage : 0, econ: econF });
    yield;
    if (gr.streetsChanged || roadsChanged) { if (roadsChanged) city.updateStreets(); city.buildGraphs(); yield; }
    // 编译与模型刷新分多步执行；this.compiled 与模型网络在同一步内一起替换
    const C = M.compile(this.net, city);
    yield;
    yield* model.refreshCityGen(C);
    this.compiled = C;
    if (this.macro && CM.Macro) CM.Macro.sample(this);   // 本月的岗位与交通效率（年度 GDP 取全年平均）
    yield;
    // 经营与任务：上月已封账，先开新月账本，任务奖励记入新月，最后按本月任务结果发放拨款
    // 满意度按周平均日（5 个工作日 + 2 个周末日）计算，通勤时间按工作日；升级过渡期内不因统计口径变化而下降
    this.econ.updateSatisfaction(model.daily, model, y, m, { protect: this.inTransition(this.ym()), staffSat: (this.staffEffects() || {}).satAdd || 0 });
    this.econ.openMonth(y, m);
    this.tasks.monthly(this).forEach((o) => this.logTask(o));
    // 人员：每月换一批候选人、老员工要求涨薪。放在任务之后、拨款之前，
    // 这样本月的工资账单已经包含涨薪，玩家不会「先看到拨款再被涨薪打脸」
    if (this.staff && CM.Staff) { this.staff.month(this, y, m); this.invalidateStaff(); }
    this.econ.payGrant(y, m);
    this.econ.serviceDebt(y, m);   // 债券：到期利息与本金、逾期处理（每月一次，不会重复结算）
    /*
     * 多城扩张（本作独有）：分部按月向公司金库上缴。
     * 放在拨款与债券之后 —— 只有把本月所有收入与固定支出都记完，「本月净利」才是真的，
     * 否则会出现「刚拨下来还没还利息就被抽走 35%」这种账面对不上的情况。
     */
    if (this.company && CM.Company) {
      CM.Company.remit(this, y, m);
      CM.Company.checkStarterContract(this);
      CM.Company.checkAcceptance(this);
      const co = CM.Company.active();
      if (co) CM.Company.noteMonth(co, y, m);
      CM.Company.queueSettle(this);
    }
    this.recordHistory();
    if (CM.Milestones) CM.Milestones.onMonth(this);
    if (this.draft) {
      this.draft.evalVer = -1; this.draft.compVer = -1;
      this.invalidatePrediction('城市状态已更新（' + y + '年' + m + '月），请重新计算预测');
    }
    this.emit('month', { y: y, m: m });
  };

  // ---------------- 债券融资（经营挑战） ----------------
  Game.prototype.issueBond = function (kind, term, amount) {
    if (this.jumping || this.pending) return { ok: false, error: '正在结算，请稍候再发行债券' };
    const r = this.econ.issueBond(kind, term, amount, { y: this.clock.y, m: this.clock.m, d: this.clock.d });
    if (!r.ok) return r;
    const b = r.bond, D0 = CM.Economy.BOND_DEF[kind];
    this.rev++;
    this.logEvent({ tag: '经营', title: '发行' + D0.name + ' ' + U.fmtMoney(b.amount), desc: term + ' 年期，年利率 ' + (b.rate * 100).toFixed(2) + '%，每年付息、' + (b.issued[0] + term) + '年' + b.issued[1] + '月到期还本；资金进入建设专项资金，只能用于地铁建设及改扩建。' });
    this.emit('finance');
    return r;
  };
  // 月度历史：客流、分担率与拥堵为周平均日（v1.9 起，tm: 2）；此前的记录为典型工作日口径（不重算）
  Game.prototype.recordHistory = function () {
    const d = this.model.daily || {}, dw = this.model.dailyWk || {}, de = this.model.dailyWe || {};
    const tot = this.city.totals();
    const last = this.econ.ledger[this.econ.ledger.length - 1];
    this.history.push({
      y: this.clock.y, m: this.clock.m, pop: tot.pop, jobs: tot.jobs, share: d.metroShare || 0, cong: d.cong || 1, commute: dw.commute || d.commute || 0,
      riders: d.metro || 0, sat: this.econ.sat, funds: this.econ.isFree() ? null : this.econ.funds, coverage: d.coverage || 0,
      debt: this.econ.isFree() ? null : this.econ.debtTotal(), capex: this.econ.isFree() ? null : this.econ.capex,
      fare: last ? last.fare : 0, ops: last ? last.ops : 0, grant: last ? last.grant : 0, stations: this.compiled.stations.length,
      trips: d.trips || 0, crowd: d.crowdShare || 0, ridersWk: dw.metro || 0, ridersWe: de.metro || 0, tm: CFG.TRAFFIC_MODEL,
    });
    if (this.history.length > 1200) this.history.shift();
  };

  // ---------------- 跳月 / 跳年 ----------------
  Game.prototype.startJump = function (months) {
    if (this.jumping || this.pending) return false;
    if (this.draft) this.invalidatePrediction();
    const t = U.ymIndex(this.clock.y, this.clock.m) + months;
    const ty = Math.floor(t / 12), tm = t % 12 + 1;
    const td = Math.min(this.clock.d, U.daysInMonth(ty, tm));
    const snap = this.snapshotMetrics();
    const total = Math.max(1, months * 30);
    this.jumping = { months: months, target: [ty, tm, td], from: [this.clock.y, this.clock.m, this.clock.d], snap: snap, progress: 0, total: total, gen: this.jumpGen(ty, tm, td, months, total) };
    this.prevSpeed = this.speed;
    this.speed = 0;
    this.emit('jump', this.jumping);
    return true;
  };
  Game.prototype.jumpGen = function* (ty, tm, td, months, total) {
    let n = 0;
    const tgt = U.ymIndex(ty, tm) * 32 + td;
    while (U.ymIndex(this.clock.y, this.clock.m) * 32 + this.clock.d < tgt && !this.econ.failed) {
      const crossed = this.endDay();
      n++;
      this.jumping.progress = Math.min(0.98, n / total);
      if (crossed) {
        yield* this.monthGen();
        const mi = this.ym();
        // 短跳每月两类都求解；长跳每月轮流求解工作日与周末（每类每 2 个月更新一次，与单一日类型时的更新频率相同）
        if (months <= 3 || U.ymIndex(this.clock.y, this.clock.m) * 32 + this.clock.d >= tgt) yield* this.model.solveGen(1);
        else yield* this.model.solveGen(1, [mi % 2 === 0 ? 'wd' : 'we']);
      }
      if ((n & 7) === 0) yield;
    }
    yield* this.model.solveGen(1);
  };
  Game.prototype.stepJump = function () {
    const j = this.jumping, t0 = performance.now();
    while (performance.now() - t0 < 14) {
      const r = j.gen.next();
      if (r.done) {
        this.jumping = null;
        this.speed = 0;
        this.recordHistoryIfNeeded();
        const res = { from: j.from, to: [this.clock.y, this.clock.m, this.clock.d], before: j.snap, after: this.snapshotMetrics(), failed: this.econ.failed };
        this.emit('jumpDone', res);
        return;
      }
    }
    this.emit('jumpProgress', j.progress);
  };
  Game.prototype.recordHistoryIfNeeded = function () {};
  Game.prototype.snapshotMetrics = function () {
    const d = this.model.daily || {};
    const tot = this.city.totals();
    let open = 0; for (let k = 0; k < this.city.regions.length; k++) open += this.city.regionOpen[k];
    const dw = this.model.dailyWk || {}, de = this.model.dailyWe || {};
    return { pop: tot.pop, jobs: tot.jobs, funds: this.econ.funds, capex: this.econ.capex, debt: this.econ.debtTotal(), share: d.metroShare || 0, cong: d.cong || 1, commute: dw.commute || d.commute || 0, riders: d.metro || 0, sat: this.econ.sat, regions: open, events: this.events.length, tasksDone: this.tasks.done.length, tasksFailed: this.tasks.failed.length,
      coverage: d.coverage || 0, stations: this.compiled.stations.length, fiscF: this.econ.fiscalFactor(), macroRecs: this.macro ? this.macro.rec.length : 0, ridersWk: dw.metro || 0, ridersWe: de.metro || 0 };
  };

  // ---------------- 建设草案 ----------------
  Game.prototype.ensureDraft = function () {
    if (!this.draft) {
      this.draft = { net: M.clone(this.net), undo: [], redo: [], ver: 1, evalVer: -1, eval: null, compiled: null, compVer: -1, pred: { state: 'idle' } };
      this.emit('draft');
    }
    return this.draft;
  };
  // 草案编辑：出错、抛出异常或产生不完整网络时整体回滚，不留下失效轨道
  Game.prototype.edit = function (fn) {
    const d = this.ensureDraft();
    const snap = JSON.stringify(d.net);
    let r;
    try { r = fn(d.net); } catch (e) { console.error(e); r = { error: '操作未能完成，已撤回（' + e.message + '）' }; }
    if (!(r && r.error)) { const bad = M.validate(d.net); if (bad) r = { error: '操作已撤回：' + bad }; }
    if (r && r.error) { d.net = JSON.parse(snap); return r; }
    d.undo.push(snap); if (d.undo.length > 120) d.undo.shift();
    d.redo = [];
    d.ver++;
    this.invalidatePrediction();
    this.emit('draft');
    return r || {};
  };
  // 拖动等连续编辑：开始时记一次撤销点
  Game.prototype.beginLive = function () { const d = this.ensureDraft(); d.liveSnap = JSON.stringify(d.net); };
  Game.prototype.liveEdit = function (fn) { const d = this.ensureDraft(); fn(d.net); d.ver++; this.invalidatePrediction(); this.emit('draftLive'); };
  Game.prototype.endLive = function (changed) {
    const d = this.draft; if (!d || !d.liveSnap) return;
    if (changed) { d.undo.push(d.liveSnap); if (d.undo.length > 120) d.undo.shift(); d.redo = []; }
    else d.net = JSON.parse(d.liveSnap);
    d.liveSnap = null; d.ver++; this.invalidatePrediction(); this.emit('draft');
  };
  Game.prototype.undo = function () {
    const d = this.draft; if (!d || !d.undo.length) return false;
    d.redo.push(JSON.stringify(d.net)); d.net = JSON.parse(d.undo.pop()); d.ver++;
    this.invalidatePrediction(); this.emit('draft'); return true;
  };
  Game.prototype.redo = function () {
    const d = this.draft; if (!d || !d.redo.length) return false;
    d.undo.push(JSON.stringify(d.net)); d.net = JSON.parse(d.redo.pop()); d.ver++;
    this.invalidatePrediction(); this.emit('draft'); return true;
  };
  Game.prototype.cancelDraft = function () {
    if (!this.draft) return;
    this.model.cancelPredict();
    this.draft = null;
    this.emit('draft');
  };
  Game.prototype.draftEval = function () {
    const d = this.draft; if (!d) return null;
    if (d.evalVer !== d.ver) {
      d.eval = M.evaluate(d.net, this.net, this.city, this.clock.y);
      d.evalVer = d.ver;
    }
    return d.eval;
  };
  Game.prototype.draftCompiled = function () {
    const d = this.draft; if (!d) return null;
    if (d.compVer !== d.ver) { d.compiled = M.compile(d.net, this.city); d.compVer = d.ver; }
    return d.compiled;
  };
  Game.prototype.canConfirm = function () {
    const ev = this.draftEval();
    if (!ev) return { ok: false, reason: '没有草案' };
    if (this.draft.liveSnap) return { ok: false, reason: '请先松开鼠标或结束当前拖动，再确认建设' };
    if (!ev.changed) return { ok: false, reason: '草案没有变化' };
    if (ev.conflicts.length) return { ok: false, reason: '存在 ' + ev.conflicts.length + ' 处冲突，需先解决' };
    if (!this.econ.canAffordBuild(ev.total)) return { ok: false, reason: '资金不足：需要 ' + U.fmtMoney(ev.total) + '，当前一般资金 ' + U.fmtMoney(this.econ.funds) + (this.econ.capex > 0.5 ? ' + 建设专项资金 ' + U.fmtMoney(this.econ.capex) : '') };
    if (this.jumping || this.pending) return { ok: false, reason: '正在结算，请稍候' };
    return { ok: true };
  };
  Game.prototype.confirmDraft = function () {
    const can = this.canConfirm();
    if (!can.ok) return can;
    const ev = this.draftEval(), d = this.draft;
    // 扣费（按类别记入当月收支）
    // 建设费用先从建设专项资金（债券募集）支付，不足部分用一般资金
    this.econ.spendBuild(ev.byKind, '地铁建设（' + ev.changes.add.length + ' 项新建、' + ev.changes.mod.length + ' 项修改）', { y: this.clock.y, m: this.clock.m, d: this.clock.d });
    for (const dm of ev.demolitions) this.city.demolish(dm.c, dm.frac);
    for (const id in d.net.stations) if (!this.net.stations[id]) d.net.stations[id].built = [this.clock.y, this.clock.m];
    // 新建、改建与搬迁后的位置成为新的“付费选址”，之后的免费微调以此为基准
    for (const id in d.net.stations) { const s = d.net.stations[id], o = this.net.stations[id]; if (o && !s.site) s.site = [o.x, o.y]; }
    for (const id of ev.siteReset || []) { const s = d.net.stations[id]; if (s) s.site = [s.x, s.y]; }
    for (const id in d.net.segments) if (!this.net.segments[id]) d.net.segments[id].built = [this.clock.y, this.clock.m];
    // 轨道的“已付费长度”：之后的免费小幅调整以此为基准累计
    for (const id in d.net.segments) { const v = ev.paidLen && ev.paidLen[id]; if (v != null) d.net.segments[id].paidLen = Math.round(v); }
    // 收藏：记下被拆除或改名对象的最新名称（读档后已拆除的收藏仍显示原名）
    const fv = this.favs; fv.names = fv.names || {};
    for (const id of fv.stations) { const s = d.net.stations[id] || this.net.stations[id]; if (s) fv.names[id] = s.name; }
    for (const id of fv.lines) { const L = d.net.lines[id] || this.net.lines[id]; if (L) fv.names[id] = L.name; }
    M.normalizeLines(d.net);
    for (const id in d.net.segments) d.net.segments[id].base = null;
    const summary = ev.changes.add.length + ' 项新建、' + ev.changes.mod.length + ' 项修改、' + ev.changes.del.length + ' 项拆除';
    this.net = d.net;
    this.netVersion++;
    this.rev++;
    this.compiled = M.compile(this.net, this.city);
    this.model.cancelPredict();
    // 沿线拆迁减少了人口与就业：立即重算小区人口岗位与出行需求，不等到月度结算
    if (ev.demolitions.length) { this.model.buildZones(); this.model.buildDemand(); }
    this.model.setNetwork(this.compiled);
    this.draft = null;
    this.logEvent({ tag: '建设', title: '建设完成并投入运营', desc: summary + (ev.total > 0 ? '，费用 ' + U.fmtMoney(ev.total) : '，无费用') });
    if (CM.Milestones) CM.Milestones.onNetwork(this);
    this.emit('network');
    this.emit('draft');
    this.emit('toast', { kind: 'good', text: '建设完成，已投入运营' + (ev.total > 0 ? '（' + U.fmtMoney(ev.total) + '）' : '') });
    this.emit('autosave', 'build');
    return { ok: true };
  };

  // 预测
  Game.prototype.invalidatePrediction = function (msg) {
    const d = this.draft; if (!d) return;
    d.autoVer = null;   // 票价、月份等外部条件变化时，即使草案版本没变也要允许自动重算。
    if (d.pred.state === 'running') this.model.cancelPredict();
    if (d.pred.state !== 'idle') d.pred = { state: 'stale', msg: msg || '草案已修改，预测需要重新计算', last: d.pred.result || d.pred.last };
    this.emit('prediction');
  };
  Game.prototype.requestPrediction = function () {
    const d = this.draft; if (!d) return;
    if (this.pending || this.jumping || this.model.refreshing) {
      this.invalidatePrediction('正在进行城市结算，请稍后重新计算预测');
      return;
    }
    const ev = this.draftEval();
    const C = this.draftCompiled();
    const ver = d.ver;
    const affected = Array.from(ev.affectedLines);
    const self = this;
    d.pred = { state: 'running', progress: 0, ver: ver };
    const gen = this.model.predict(C, affected, function (res) {
      if (!self.draft || self.draft.ver !== ver) return;
      res.conditions.y = self.clock.y; res.conditions.m = self.clock.m;
      self.draft.pred = { state: 'done', result: res, ver: ver };
      self.emit('prediction');
    });
    d.pred.gen = gen;
    this.emit('prediction');
  };

  // ---------------- 查询 ----------------
  Game.prototype.zoneName = function (z) {
    const m = this.model;
    const x = m.zCx[z], y = m.zCy[z];
    let best = null, bd = 1e9;
    for (const p of D.places) { const d = U.dist(x, y, p[1], p[2]); if (d < bd) { bd = d; best = p[0]; } }
    const rg = this.city.regionAt(x, y);
    return (bd < 5 ? best + '一带' : '片区') + (rg ? '（' + rg.name.replace(/（.*）/, '') + '）' : '');
  };
  // 片区早高峰拥堵：默认工作日（通勤口径）
  Game.prototype.zoneCong = function (z, dt) {
    const model = this.model, P = model.ctxs[dt === 'we' ? 'we' : 'wd'].per[0], road = model.road;
    let num = 0, den = 0;
    for (let a = 0; a < road.nA; a++) {
      if (model.arcZone[a] !== z) continue;
      const v = P.arcVol[a]; if (v <= 0) continue;
      num += v * road.arcLen[a] * (P.arcTime[a] / road.arcT0[a]); den += v * road.arcLen[a];
    }
    return den > 0 ? num / den : 1;
  };
  // 发展阶段名称：由各地图的场景数据提供（stages 为 [截止年份（不含）, 名称]，stageLast 为史料截止前的最后阶段）
  Game.prototype.stageName = function () {
    const y = this.clock.y;
    for (const s of D.stages || []) if (y < s[0]) return s[1];
    if (y <= CFG.growth.histEnd) return D.stageLast || '发展期';
    return D.fictional ? '持续发展' : '模拟未来';
  };

  // ---------------- 存档 ----------------
  Game.prototype.serialize = function () {
    return {
      meta: { gameId: this.id, name: this.name, mode: this.mode, difficulty: this.difficulty || null, company: this.company || null, seed: this.seed, createdAt: this.createdAt, gameVersion: CFG.GAME_VERSION, map: this.mapId || 'gz', mapVersion: (CM.MAPS[this.mapId || 'gz'] || {}).mapVersion || 1, scenario: (CM.MAPS[this.mapId || 'gz'] || {}).scenario || '', mapFp: (CM.MAPS[this.mapId || 'gz'] || {}).fp || '', contentFp: (CM.MAPS[this.mapId || 'gz'] || {}).contentFp || '' },
      clock: Object.assign({}, this.clock),
      city: this.city.serialize(),
      net: this.net,
      econ: this.econ.serialize(),
      tasks: this.tasks.serialize(),
      events: this.events.slice(-300),
      history: this.history.slice(-1200),
      firedEvents: this.firedEvents,
      favs: this.favs,
      tutorial: this.tutorial || null,
      milestones: this.milestones || null,
      mapInit: this.mapInit || null,
      macro: this.macro && CM.Macro ? CM.Macro.serialize(this.macro) : null,
      traffic: this.traffic || { v: CFG.TRAFFIC_MODEL },
      staff: this.staff ? this.staff.serialize() : null,
      incidents: this.lastIncidents || null,
    };
  };
  Game.restore = function (s) {
    const g = new Game();
    const m = s.meta;
    g.id = m.gameId; g.name = m.name; g.mode = m.mode; g.seed = m.seed; g.createdAt = m.createdAt;
    g.mapId = m.map || 'gz';   // 调用前 CM.useMap 已切换到该地图
    // 多城扩张：旧存档没有 company 字段，读成 null（= 独立单局），不影响任何既有逻辑
    g.company = m.company || null;
    if (s.tutorial) g.tutorial = s.tutorial;
    g.clock = Object.assign({}, s.clock);
    g.city = new CM.City();
    g.city.generate(g.seed, CFG.START.y);
    g.city.restore(s.city, g.clock.y);
    // 交通模型版本：1.8 及更早的存档为 1（典型工作日、通勤与其他两类出行），载入时升级到当前模型
    const tv = (s.traffic && s.traffic.v) || 1, upgrade = tv < CFG.TRAFFIC_MODEL;
    // 台北松山机场（v1.9 起可地下建设）：旧存档中该区域仍为未开放，读档时开放（机场照常运营，用地不开发）
    let airportOpened = null;
    if (D.airport && D.airport.buildable) {
      const k = g.city.regions.findIndex(function (r) { return r.id === 'airport'; });
      if (k >= 0 && !g.city.regionOpen[k] && g.city.regions[k].open != null && g.city.regions[k].open <= g.clock.y) { g.city.openRegion(k, g.clock.y, g.clock.m); airportOpened = g.city.regions[k]; }
    }
    g.model = new CM.Model(g.city);
    g.model.setYear(g.clock.y + (g.clock.m - 1) / 12);
    g.model.setDayType(CM.Model.dayType(g.clock.y, g.clock.m, g.clock.d));
    // 难度：从存档里恢复（1.x 与 v2.1 之前的存档没有难度字段，按 normal 兜底）
    g.difficulty = CM.Difficulty ? CM.Difficulty.norm((s.econ && s.econ.difficulty) || CM.Difficulty.DEFAULT_KEY) : null;
    if (g.mode === 'free' && CM.Difficulty) g.difficulty = 'easy';
    // 难度 + 城市特性：读档同样要先恢复客流与建设倍率
    applyCityRates(g);
    g.model.buildZones(); g.model.buildDemand();
    g.net = s.net;
    g.compiled = M.compile(g.net, g.city);
    g.model.setNetwork(g.compiled);
    g.econ = CM.Economy.restore(s.econ);
    // 难度：econ.difficulty 是权威来源（Economy 构造时已按它算好起始资金），
    // 这里把它回写到 game 上，供面板与突发事件概率读取。
    if (CM.Difficulty) { g.difficulty = CM.Difficulty.norm(g.econ.difficulty || CM.Difficulty.DEFAULT_KEY); g.econ.difficulty = g.difficulty; }
    g.model.fare = g.econ.fare;
    g.tasks = CM.Tasks.restore(s.tasks);
    // 人员：1.x 存档没有这一层，按空队伍接入（不影响原有资金与进度）
    g.staff = CM.Staff ? CM.Staff.restore(s.staff) : null;
    if (g.staff && !g.staff.market.length) g.staff.refreshMarket(CM.Staff.rngFor(g, g.clock.y, g.clock.m), g.clock.y, g.clock.m, 7);
    // 突发事件：旧存档没有这一层，按「今天还没出事」接入
    g.lastIncidents = s.incidents || [];
    g.events = s.events || []; g.history = s.history || []; g.firedEvents = s.firedEvents || {};
    g.favs = { stations: (s.favs && s.favs.stations) || [], lines: (s.favs && s.favs.lines) || [], names: (s.favs && s.favs.names) || {} };
    g.mapInit = s.mapInit || null;
    g.milestones = s.milestones || null;
    g.model.solveNow(2);
    if (CM.Milestones) CM.Milestones.backfill(g);
    // 城市经济：有数据则恢复；1.7 及更早的存档（或数据不完整）从当前状态接入，不补造过去的记录，不改变已有资金与债务。
    // 接入失败时本局不启用经济模拟，原存档不受影响
    g.macro = null;
    if (CM.Macro && CM.Macro.enabled()) {
      try { CM.Macro.attach(g, s.macro || null); }
      catch (e) {
        console.error(e);
        try { g.macro = null; CM.Macro.attach(g, null); g.macroNote = '存档中的城市经济数据无法识别，已从当前状态重新接入'; }
        catch (e2) { console.error(e2); g.macro = null; g.econ.fisc = null; g.econ.quoteFn = null; g.macroError = '城市经济数据未能初始化（' + (e2 && e2.message || e2) + '），本局暂不启用；原存档未受影响'; }
      }
      if (g.macro && !s.macro) g.macroNote = '城市经济自 ' + g.clock.y + ' 年 ' + g.clock.m + ' 月起接入：此前的经济数据未记录，不作补造';
    }
    // 交通模型升级：保留原有建设、资金、债务、历史结算与任务进度；已结算的历史不重算。升级当月设过渡保护（见 inTransition）
    if (upgrade) {
      g.traffic = { v: CFG.TRAFFIC_MODEL, from: m.gameVersion || '1.8.0', at: [g.clock.y, g.clock.m, g.clock.d], until: g.ym() + 1 };
      for (const t of g.tasks.active) if (t.type === 'ridership' && !t.basis) t.basis = 'wd';   // 进行中的客流任务沿用发布时的口径（典型工作日）
      if (g.macro && CM.Macro && CM.Macro.rebaseTE) { try { CM.Macro.rebaseTE(g); } catch (e) { console.error(e); } }
      g.logEvent({ tag: '版本', title: '交通模型升级（v' + CFG.GAME_VERSION + '）', desc: '存档来自 v' + g.traffic.from + '。居民出行改为通勤、上学、购物、医疗、旅游休闲与枢纽接驳六类，重要设施单独参与计算，工作日与周末分别模拟；地面铁路影响步行与道路通行。原有建设、资金、债务、历史结算与任务进度全部保留，此前的月度记录按旧口径（典型工作日）保存、不重算；升级当月满意度不因统计口径变化而下降，任务不判失败。' });
      g.backupFailed = s.__backupFailed || null;
      g.upgradeNote = s.__backupFailed ? '存档已在内存中升级到 v' + CFG.GAME_VERSION + ' 交通模型；升级前备份未能建立（' + s.__backupFailed + '），不会自动保存，原存档保持不变' :
        '存档已升级到 v' + CFG.GAME_VERSION + ' 交通模型（升级前的原存档已另存为「升级前备份」，可在存档列表中载入或导出）';
    } else g.traffic = Object.assign({ v: CFG.TRAFFIC_MODEL }, s.traffic);
    if (airportOpened) g.logEvent({ tag: '规则', title: '新区域开放：' + airportOpened.name, desc: (D.airport.name || '机场') + '照常运营，用地不开发；范围内可以地下设站与地下穿越（v1.9 起）。' });
    return g;
  };
})(window.CM);
