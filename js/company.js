/* 城轨公司 · 多城扩张（本作独有）
 *
 * 基底的一局 = 一张地图。城市之间没有任何关系：你在广州赚的钱带不到杭州，
 * 你在广州失败也不会影响任何东西。于是「先做小城、攒钱、再进城」这条
 * 我们想要的成长链根本不存在 —— 每局都是一次性的独立挑战。
 *
 * 这里加一层「公司」：
 *   - 一家公司可以同时持有多座城市的分部，每个分部仍是一局完整的地图（各存各的档）；
 *   - 公司有统一的金库。分部赚的钱按月结进金库，进驻新城市要付「接入费」；
 *   - 破产只砸掉那一个分部，公司还在，但金库里的钱没了。
 *
 * 三条设计约束：
 *   A. 不重写经济。每个分部的 econ.funds 仍然是它自己的钱，金库只是「分部之间转账」
 *      的一个账本 —— 这样基底的拨款、债券、破产判定全部原样有效，不会因为加了公司层
 *      而出现「两套账互相打架」。
 *   B. 公司状态放 localStorage 而不是塞进某个分部的存档里。理由：分部可以被删除、
 *      可以破产，而公司必须活得比任何一个分部久。
 *   C. 任何一步失败都要能被玩家看见。切城、进驻、转账全部返回 { ok, error }。
 */
(function (CM) {
  'use strict';
  const U = CM.U, CFG = CM.CFG;

  const KEY = CFG.saves.prefix + 'companies';
  const VER = 1;

  /* 旧版公司的进驻费（legacy 兼容）。战役模式不再走这条路，改用公司池解锁费。 */
  const ACCESS_FEE = { 1: 30000, 2: 80000, 3: 160000, 4: 280000 };

  /* 战役模式：只保留一张入门图。
   * 温州是唯一的初始地图；其余 53 张真实城市（含广州）全部锁定，
   * 必须靠局内经营赚出的公司池解锁。
   * 自由建造模式不受这里影响。 */
  const STARTERS = ['wenzhou'];
  const STARTER_META = {
    wenzhou: { tier: 'entry', difficultyKey: 'easy', trait: '浙南首段', desc: '只接管一条真实线路的前 4 站，适合第一次熟悉排班、票款与公司账；其余城市都要靠公司池解锁。' },
  };

  /* 解锁费（万元）：最低 8 亿，最高 20 亿；不按“进驻费”重复收。 */
  const UNLOCK_FEE = { 1: 80000, 2: 100000, 3: 150000, 4: 200000 };
  /* 新分部启动金（万元）：由公司池出，不再使用难度标准 30 亿。
   * 第一张图解锁 + 启动 = 10 亿；5 亿初始池 + 7 亿合同 = 12 亿，
   * 首次扩张后仍留 2 亿作为紧急救援余量。 */
  const START_FUNDS = { 1: 20000, 2: 30000, 3: 40000, 4: 50000 };
  const CAMPAIGN_POOL = 50000;   // 公司开办资金 5 亿

  /* 战役第一份公司合同：在起点城新增 3 站，公司池一次性奖励 7 亿。 */
  const STARTER_CONTRACT = { addStations: 3, reward: 70000 };

  function initialStations(mapId) {
    const mp = CM.MAPS && CM.MAPS[mapId];
    const net = mp && mp.data && mp.data.initialNetwork;
    if (!net || !net.lines) return 0;
    let n = 0;
    for (const ln of net.lines) n += (ln.stations || []).length;
    return n;
  }

  function contractOfCampaign(camp) {
    if (!camp || camp.legacy) return null;
    if (camp.contract) return camp.contract;
    const base = initialStations(camp.starterMapId);
    return {
      goal: 'stations', baseline: base, target: base + STARTER_CONTRACT.addStations,
      reward: STARTER_CONTRACT.reward, done: false,
    };
  }

  /* 分部每月往金库上缴的比例。
   * 30% 归公司，70% 留在本地；本地现金只能用于当前地图。
   * 上缴按“上月已封账经营现金流”计算，见 remit()。 */
  const REMIT_RATE = 0.30;

  function readAll() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { return {}; }
    if (!raw) return {};
    try {
      const o = JSON.parse(raw);
      if (!o || o.v !== VER || !o.list) return {};
      return o.list;
    } catch (e) { return {}; }
  }

  function writeAll(list) {
    try { localStorage.setItem(KEY, JSON.stringify({ v: VER, list: list })); return true; }
    catch (e) { return false; }
  }

  function nowIso() { return new Date().toISOString(); }

  const Company = {};
  CM.Company = Company;

  Company.ACCESS_FEE = ACCESS_FEE;
  Company.REMIT_RATE = REMIT_RATE;
  Company.STARTERS = STARTERS.slice();
  Company.STARTER_META = STARTER_META;
  Company.UNLOCK_FEE = UNLOCK_FEE;
  Company.START_FUNDS = START_FUNDS;
  Company.CAMPAIGN_POOL = CAMPAIGN_POOL;
  Company.STARTER_CONTRACT = STARTER_CONTRACT;
  Company.settling = false;
  Company._settleTimer = null;

  Company.accessFee = function (mapId) {
    const mp = CM.MAPS && CM.MAPS[mapId];
    const d = mp ? (mp.difficulty || 2) : 2;
    return ACCESS_FEE[d] || ACCESS_FEE[2];
  };

  Company.unlockFee = function (mapId) {
    const mp = CM.MAPS && CM.MAPS[mapId];
    const d = mp ? (mp.difficulty || 2) : 2;
    return UNLOCK_FEE[d] || UNLOCK_FEE[2];
  };
  Company.startFundsFor = function (mapId) {
    const mp = CM.MAPS && CM.MAPS[mapId];
    const d = mp ? (mp.difficulty || 2) : 2;
    return START_FUNDS[d] || START_FUNDS[2];
  };
  Company.isStarter = function (mapId) { return STARTERS.indexOf(mapId) >= 0; };

  /* 第一份公司合同的状态。g 可选：传入当前局时附带已建站数。 */
  Company.contractOf = function (c, g) {
    const camp = Company.campaignOf(c);
    const ct = contractOfCampaign(camp);
    if (!ct) return null;
    const stations = g && g.mapId === camp.starterMapId ? Object.keys(g.net.stations || {}).length : null;
    return {
      goal: ct.goal, baseline: ct.baseline, target: ct.target, reward: ct.reward,
      done: !!ct.done, claimedAt: ct.claimedAt || null, starterMapId: camp.starterMapId,
      stations: stations, progress: stations == null ? null : Math.min(stations, ct.target),
    };
  };

  /* 月度检查：门槛达到时把奖励直接打进公司池，不经过本地现金。 */
  Company.checkStarterContract = function (g) {
    const c0 = Company.active();
    if (!c0 || !g || !g.company || g.company.id !== c0.id) return null;
    const c = Company.fresh(c0) || c0;
    const camp = Company.campaignOf(c);
    const ct = contractOfCampaign(camp);
    if (!ct || ct.done || g.mapId !== camp.starterMapId) return null;
    const stations = Object.keys(g.net.stations || {}).length;
    if (stations < ct.target) return null;
    c.pool = Company.poolOf(c) + ct.reward;
    c.campaign = Object.assign({}, camp, {
      contract: Object.assign({}, ct, { done: true, claimedAt: nowIso() }),
    });
    c.updatedAt = nowIso();
    const r = Company.commit(c0, c);
    if (!r.ok) return null;
    const msg = '第一份公司合同完成：公司池 +' + U.fmtMoney(ct.reward);
    if (g.logEvent) g.logEvent({ tag: '公司', title: msg, desc: '在「' + (CM.MAPS[g.mapId] && CM.MAPS[g.mapId].name || g.mapId) + '」新增 ' + STARTER_CONTRACT.addStations + ' 站' });
    if (g.emit) g.emit('toast', { kind: 'good', text: msg });
    return { ok: true, reward: ct.reward, pool: Company.poolOf(c) };
  };

  Company.all = function () {
    const list = readAll();
    return Object.keys(list).map(function (k) { return list[k]; })
      .sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
  };

  Company.get = function (id) {
    if (!id) return null;
    return readAll()[id] || null;
  };

  Company.save = function (c) {
    if (!c || !c.id) return { ok: false, error: '公司不存在' };
    const list = readAll();
    c.updatedAt = nowIso();
    list[c.id] = c;
    if (!writeAll(list)) return { ok: false, error: '写入失败：浏览器存储不可用（无痕模式或空间已满）' };
    return { ok: true, company: c };
  };

  /* 取一份**存储里的当前记录**。save() 是把整个对象覆盖回去的，
   * 调用方手里只要拿着过期副本（比如 Company.create 的返回值），
   * 后加的字段就会被旧值抹掉 —— 公司自有资金 pool 就是这么被清零过的。
   * 所有写操作都先从存储取一次，再改、再存。 */
  Company.fresh = function (c) {
    if (!c || !c.id) return c || null;
    return readAll()[c.id] || c;
  };

  /* 存盘，并把结果同步回调用方手里的那个对象。
   * 写操作都改成「读最新 → 改 → 存」，如果不同步回去，调用方拿着的旧引用
   * 就再也看不到自己刚做的改动（分支、资金全都对不上）。 */
  Company.commit = function (c, cur) {
    const r = Company.save(cur);
    if (r.ok && c && c !== cur) Object.assign(c, cur);
    return r;
  };

  Company.create = function (name, homeMapId, opts) {
    const homeStart = (CM.MAPS[homeMapId] && CM.MAPS[homeMapId].cfg.START) || CM.CFG.START;
    const campaign = opts && opts.campaign ? {
      version: 1,
      starterMapId: homeMapId,
      unlocked: STARTERS.concat(homeMapId ? [homeMapId] : []).filter(function (v, i, a) { return a.indexOf(v) === i; }),
      legacy: false,
      bankrupt: false,
      ym: { y: homeStart.y, m: homeStart.m },
      createdAt: nowIso(),
    } : null;
    const c = {
      id: U.uid('co'),
      name: (name || '').trim() || '城轨公司',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      /* 公司层自有现金（pool）：分部上缴进 pool，解锁地图与注资从 pool 出。
       * 战役开局给 5 亿开办资金；普通/旧公司仍为 0。 */
      pool: (opts && typeof opts.pool === 'number' && isFinite(opts.pool)) ? Math.max(0, Math.round(opts.pool)) : 0,
      branches: [],
      home: homeMapId || null,
      campaign: campaign,
    };
    if (campaign) c.campaign.contract = contractOfCampaign({ ...campaign, starterMapId: homeMapId });
    const r = Company.save(c);
    return r.ok ? { ok: true, company: c } : r;
  };

  /* 战役入口：只能从唯一入门图温州开始。旧公司（没有 campaign）走 legacy，不锁图。 */
  Company.startCampaign = function (name, starterMapId) {
    if (!Company.isStarter(starterMapId)) return { ok: false, error: '战役只能从入门图温州开始' };
    return Company.create(name, starterMapId, { campaign: true, pool: CAMPAIGN_POOL });
  };

  /* 旧公司兼容：没有 campaign 字段 = 旧版全解锁公司。
   * 返回一个只读视图，不写存储；真正解锁/迁移发生在 unlock()。 */
  Company.campaignOf = function (c) {
    if (!c) return null;
    if (c.campaign) return c.campaign;
    return { version: 0, legacy: true, unlocked: CM.MAP_ORDER ? CM.MAP_ORDER.slice() : [], bankrupt: false };
  };

  /* 战役统一月份。所有分部的后台补结算都以这个月份为目标；
   * 旧战役没有 ym 时退回入门地图起始年月。 */
  Company.campaignClock = function (c) {
    const camp = Company.campaignOf(c);
    if (!camp || camp.legacy) return null;
    if (camp.ym && typeof camp.ym.y === 'number' && typeof camp.ym.m === 'number') return { y: camp.ym.y, m: camp.ym.m };
    const mp = CM.MAPS[camp.starterMapId];
    const st = (mp && mp.cfg.START) || CM.CFG.START;
    return { y: st.y, m: st.m };
  };

  /* 当前活跃分部跨月时推进战役月份。只前进，不回退。 */
  Company.noteMonth = function (c, y, m) {
    const co = Company.fresh(c) || c;
    const camp = Company.campaignOf(co);
    if (!camp || camp.legacy) return;
    const target = y * 12 + m;
    const clock = Company.campaignClock(co);
    const cur = clock ? clock.y * 12 + clock.m : 0;
    if (target <= cur) return;
    camp.ym = { y: y, m: m };
    co.updatedAt = nowIso();
    Company.commit(c, co);
  };

  /* 打开公司面板 / 当前分部月结后调用。真正的重活在 settleInactive 里，
   * 这里只负责避开正在跳月或正在结算的时间点。 */
  Company.queueSettle = function (g) {
    if (!g || !g.company || Company.settling || Company._settleTimer) return;
    const co = Company.active();
    const camp = co ? Company.campaignOf(co) : null;
    if (!camp || camp.legacy) return;
    Company._settleTimer = setTimeout(function () {
      Company._settleTimer = null;
      if (!g || !g.company || Company.settling) return;
      if (g.jumping || g.pending) { Company.queueSettle(g); return; }
      const p = Company.settleInactive(g);
      if (p && p.catch) p.catch(function (e) { console.warn('后台分部结算失败', e); });
    }, 120);
  };

  /* 后台补结算：对每个落后于战役月份的分部，恢复它的存档，按真实月结推进，
   * 写回它自己的存档，然后恢复当前地图。整个过程暂停当前局的时钟。
   * 这是“真实经营”，不是按最近一个月估算。 */
  Company.settleInactive = function (g) {
    return Promise.resolve().then(function () {
      const co0 = Company.active();
      if (!co0 || !g || !g.company || g.company.id !== co0.id) return { ok: false, skipped: true };
      const camp = Company.campaignOf(co0);
      if (!camp || camp.legacy) return { ok: false, skipped: true };
      if (Company.settling) return { ok: false, skipped: true };
      const clock = Company.campaignClock(co0) || { y: g.clock.y, m: g.clock.m };
      const targetYm = clock.y * 12 + clock.m;
      const activeMap = g.mapId;
      const co = Company.fresh(co0) || co0;
      const list = (co.branches || []).filter(function (b) {
        return b && b.slotId && !b.failed && b.mapId !== activeMap;
      });
      if (!list.length) return { ok: true, changed: 0, target: clock };
      const prevSpeed = g.speed;
      g.speed = 0;
      Company.settling = true;
      let changed = 0, failed = 0;
      let p = Promise.resolve();
      list.forEach(function (b) {
        p = p.then(function () {
          return CM.Save.load(b.slotId).then(function (payload) {
            const from = payload && payload.clock ? payload.clock.y * 12 + payload.clock.m : targetYm;
            const months = targetYm - from;
            if (months <= 0) return null;
            const load = (CM.MAPS[b.mapId] && !CM.MAPS[b.mapId].geo && CM.loadGeo) ? CM.loadGeo(b.mapId) : Promise.resolve();
            return load.then(function () {
              CM.useMap(b.mapId);
              const ga = CM.Game.restore(payload);
              ga.startJump(months);
              let n = 0;
              while (ga.jumping && n++ < 6000) ga.stepJump();
              const saveP = CM.Save.save(ga, 'auto', { slotId: b.slotId, label: '自动存档' });
              CM.useMap(activeMap);
              if (ga.econ && ga.econ.failed) {
                failed++;
                Company.updateBranch(co0, b.mapId, { failed: true });
              }
              changed++;
              return saveP;
            });
          });
        }).catch(function (e) {
          console.warn('分部结算跳过：' + b.mapId, e);
        });
      });
      return p.then(function () {
        return { ok: true, changed: changed, failed: failed, target: clock };
      }).finally(function () {
        Company.settling = false;
        try { CM.useMap(activeMap); } catch (e) { /* 地图恢复失败时保留当前图 */ }
        g.speed = prevSpeed;
      });
    });
  };

  Company.isUnlocked = function (c, mapId) {
    if (!mapId) return false;
    const mp = CM.MAPS && CM.MAPS[mapId];
    if (mp && (mp.tutorial || mp.kind === 'fictional')) return true;
    const camp = Company.campaignOf(c);
    if (!camp || camp.legacy) return true;
    return camp.unlocked.indexOf(mapId) >= 0;
  };

  /* 地图是否可以开始：自由模式永远可以；经营挑战必须已解锁。
   * 没有公司时只允许入门图温州，用来创建战役。 */
  Company.canStartMap = function (c, mapId, mode) {
    const mp = CM.MAPS && CM.MAPS[mapId];
    if (!mp) return false;
    if (mode === 'free' || mp.tutorial) return true;
    if (!c) return STARTERS.indexOf(mapId) >= 0;
    const camp = Company.campaignOf(c);
    if (!camp || camp.legacy) return true;
    return camp.unlocked.indexOf(mapId) >= 0 || STARTERS.indexOf(mapId) >= 0;
  };

  /* 战役级破产：所有已解锁地图都已有分部且全部停运，公司池又低于最低救援额。
   * 还有未进驻的已解锁地图时不算破产 —— 玩家还能开新分部。 */
  Company.campaignOver = function (c) {
    const camp = Company.campaignOf(c);
    if (!camp || camp.legacy || camp.bankrupt) return false;
    const unlocked = camp.unlocked || [];
    if (!unlocked.length) return false;
    if (unlocked.some(function (id) { return !Company.branchOf(c, id); })) return false;
    if (c.branches.some(function (b) { return !b.failed; })) return false;
    return (c.pool || 0) < 20000;
  };

  Company.unlockMap = function (c, mapId) {
    const co = Company.fresh(c);
    if (!co) return { ok: false, error: '公司不存在' };
    const camp = Company.campaignOf(co);
    if (!camp || camp.legacy) return { ok: false, error: '旧公司不参与锁图' };
    if (!CM.MAPS[mapId] || CM.MAPS[mapId].tutorial || CM.MAPS[mapId].kind === 'fictional') {
      return { ok: false, error: '这张地图不能解锁' };
    }
    if (camp.unlocked.indexOf(mapId) >= 0) return { ok: false, error: '这座城市已经解锁' };
    const fee = Company.unlockFee(mapId);
    if ((co.pool || 0) < fee) return { ok: false, error: '公司池不足（解锁费 ' + U.fmtMoney(fee) + '）' };
    co.pool = (co.pool || 0) - fee;
    co.campaign = {
      version: 1,
      starterMapId: camp.starterMapId || co.home || null,
      unlocked: camp.unlocked.concat([mapId]),
      legacy: false,
      bankrupt: false,
      createdAt: camp.createdAt || nowIso(),
    };
    co.updatedAt = nowIso();
    const r = Company.commit(c, co);
    return r.ok ? { ok: true, fee: fee, company: co } : { ok: false, error: r.error || '写入失败' };
  };

  Company.remove = function (id) {
    const list = readAll();
    if (!list[id]) return { ok: false, error: '公司不存在' };
    delete list[id];
    return writeAll(list) ? { ok: true } : { ok: false, error: '写入失败' };
  };

  /* 当前正在玩的那家公司。存一个「活跃 id」，让刷新页面后还能回到同一家公司。 */
  const ACTIVE = CFG.saves.prefix + 'companyActive';
  Company.activeId = function () {
    try { return localStorage.getItem(ACTIVE) || null; } catch (e) { return null; }
  };
  Company.setActive = function (id) {
    try { if (id) localStorage.setItem(ACTIVE, id); else localStorage.removeItem(ACTIVE); return true; }
    catch (e) { return false; }
  };
  Company.active = function () {
    const id = Company.activeId();
    return id ? Company.get(id) : null;
  };

  Company.branchOf = function (c, mapId) {
    if (!c) return null;
    for (const b of c.branches) if (b.mapId === mapId) return b;
    return null;
  };

  /* 公司自有现金。老存档没有这个字段，一律按 0 处理（不迁移、不补发）。 */
  Company.poolOf = function (c) {
    return c && typeof c.pool === 'number' && isFinite(c.pool) ? c.pool : 0;
  };

  /* 金库 = 各分部账面现金 + 公司自有现金 pool。
   * 不做成「只记一个总数」是因为玩家在面板上看到的钱必须和他在那座城市里
   * 看到的钱是同一笔；而 pool 是分部之外的第二处真实账户（上缴所得），
   * 它必须能被指出「钱到底在哪」，否则又会重演「扣了钱但没有收款方」。 */
  Company.treasury = function (c) {
    if (!c) return 0;
    let t = Company.poolOf(c);
    for (const b of c.branches) t += (typeof b.funds === 'number' ? b.funds : 0);
    return t;
  };

  /* 给定付款方时**真正可以动用的钱**：该分部账面 + 公司 pool。
   * canJoin 与 payAccess 必须用同一个函数算，否则会重现
   * 「面板说能进、点下去扣不动」的假绿灯。 */
  Company.available = function (c, payerMapId) {
    if (!c) return 0;
    if (!payerMapId) return Company.treasury(c);
    const pb = Company.branchOf(c, payerMapId);
    if (!pb) return 0;
    return (typeof pb.funds === 'number' ? pb.funds : 0) + Company.poolOf(c);
  };

  Company.addBranch = function (c, br) {
    if (!c) return { ok: false, error: '公司不存在' };
    const cur = Company.fresh(c);
    if (!cur) return { ok: false, error: '公司不存在' };
    const old = Company.branchOf(cur, br.mapId);
    if (old) return { ok: true, branch: old, existed: true };
    const b = {
      mapId: br.mapId,
      name: br.name || (CM.MAPS[br.mapId] && CM.MAPS[br.mapId].name) || br.mapId,
      joinedAt: nowIso(),
      funds: typeof br.funds === 'number' ? br.funds : 0,
      slotId: br.slotId || null,
      failed: false,
    };
    cur.branches.push(b);
    const r = Company.commit(c, cur);
    return r.ok ? { ok: true, branch: b } : r;
  };

  Company.updateBranch = function (c, mapId, patch) {
    const cur = Company.fresh(c);
    if (!cur) return { ok: false, error: '公司不存在' };
    const b = Company.branchOf(cur, mapId);
    if (!b) return { ok: false, error: '这个城市还没有分部' };
    Object.assign(b, patch || {});
    const r = Company.commit(c, cur);
    return r.ok ? { ok: true, branch: b } : r;
  };

  Company.dropBranch = function (c, mapId) {
    if (!c) return { ok: false, error: '公司不存在' };
    const cur = Company.fresh(c);
    if (!cur) return { ok: false, error: '公司不存在' };
    cur.branches = cur.branches.filter(function (b) { return b.mapId !== mapId; });
    const r = Company.commit(c, cur);
    return r.ok ? { ok: true } : r;
  };

  /* 能不能进驻某城。返回 { ok, fee, have, short, reason }。
   * have 取的是**付款分部真正能动的钱** = 该分部账面 + 公司自有现金 pool。
   * 仍不接受「金库合计」冒充付款能力：进驻费是从某一个分部起扣的，
   * 拿合计去判「买得起」会出现「面板说能进，点下去却扣不动」的假绿灯。
   * payerMapId 缺省时退回金库合计，方便没有具体付款方时做能力评估。 */
  Company.canJoin = function (c, mapId, payerMapId) {
    if (!c) return { ok: false, reason: '还没有公司' };
    const mp = CM.MAPS && CM.MAPS[mapId];
    if (!mp) return { ok: false, reason: '地图不存在' };
    if (mp.tutorial || mp.kind === 'fictional') return { ok: false, reason: '这张地图不支持公司扩张' };
    /* 基底五张年代图（广州 1990、杭州 2000、香港 1970、台北 1990、东京 1950）
     * 仍留在 CM.MAPS 里给开局背景与旧存档用，但不在选图页列出；
     * 公司扩张也只面向青湾以外的 54 座 2025 城市。这里统一拦住，
     * 面板遗漏过滤时也不会让玩家点进去开出另一套年代/货币。 */
    if (CM.HIDDEN_MAPS && CM.HIDDEN_MAPS.indexOf(mapId) >= 0) {
      return { ok: false, reason: '这张地图不在多城扩张范围内' };
    }
    if (Company.branchOf(c, mapId)) return { ok: false, reason: '已经进驻过这座城市了' };
    const fee = Company.accessFee(mapId);
    let have;
    if (payerMapId) {
      // 显式指定了付款分部却找不到：这是调用方的错，不能退回金库合计蒙混过关 ——
      // 否则「面板放行、扣费时报分部不存在」会在玩家点确认的那一刻才炸
      if (!Company.branchOf(c, payerMapId)) return { ok: false, reason: '付款分部不存在' };
      have = Company.available(c, payerMapId);
    } else {
      have = Company.treasury(c);
    }
    if (have < fee) {
      return { ok: false, fee: fee, have: have, short: fee - have, reason: '可动用的钱还差 ' + U.fmtMoney(fee - have) };
    }
    return { ok: true, fee: fee, have: have };
  };

  /* 分部每月上缴。由 game.js 的 monthGen 调用。
   * 三处旧实现的教训仍然保留：
   * 1) 只读 lastClosed()，不读当前未封账的 cur；
   * 2) 收款方必须是公司自有现金 pool，不能让钱凭空消失；
   * 3) 必须走 spend('remit', ...)，让账本和资金流水都能对上。 */
  Company.remit = function (g, y, m) {
    const c0 = Company.active();
    if (!c0 || !g || !g.company || g.company.id !== c0.id) return null;
    // 先读一份存储里的最新记录再改：直接改 c0 再走 updateBranch 的话，
    // fresh() 会读到旧副本，刚加上去的 pool 会被覆盖掉。
    const c = Company.fresh(c0) || c0;
    const b = Company.branchOf(c, g.mapId);
    if (!b) return null;
    if (g.econ.isFree()) return null;

    /* 30% 分成口径：上月已封账的**经营现金流**，不是会计净利。
     * - 不含财政拨款：地方补贴留在本地；
     * - 不含建设/改造支出：扩张期不把公司池抽干；
     * - 保留 2 个月运营成本作为本地安全垫。
     * 这样既能给公司池稳定收入，也不会把正在扩张的分部抽成负现金。 */
    const last = g.econ.lastClosed ? g.econ.lastClosed() : null;
    let net = 0;
    if (last) {
      net = (last.fare || 0) + (last.reward || 0)
        - (last.ops || 0) - (last.interest || 0)
        - (last.principal || 0) - (last.penalty || 0);
    }
    const reserve = last ? 2 * (last.ops || 0) : 0;
    let paid = 0;
    if (net > 0) {
      const want = net * REMIT_RATE;
      const can = Math.min(want, Math.max(0, g.econ.funds - reserve));
      if (can > 0.01) {
        g.econ.spend('remit', can);           // 记账（本月 remit 科目 + 资金流水）
        paid = can;
        c.pool = Company.poolOf(c) + paid;    // 收款方：公司自有现金
        c.updatedAt = nowIso();
      }
    }
    // 在同一个最新副本上一起改分部与 pool，再一次性存盘 —— 分两次走
    // updateBranch 的话，第二次会从存储里再解析一份，把 pool 的增量冲掉。
    b.funds = g.econ.funds;
    b.lastRemit = { y: y, m: m, amount: paid };
    b.lastOps = last ? (last.ops || 0) : 0;
    const ym = y * 12 + m;
    b.profits = (b.profits || []).filter(function (p) { return p && p.ym >= ym - 11; });
    b.profits.push({ ym: ym, net: net, paid: paid });
    if (b.profits.length > 12) b.profits.splice(0, b.profits.length - 12);
    Company.commit(c0, c);
    return { paid: paid, branch: Company.branchOf(c, g.mapId), pool: Company.poolOf(c) };
  };

  /* 公司面板用：按当前本地账本预测下次月结能上缴多少，以及为什么是 0。
   * 不写存储，只读 lastClosed()，与 remit() 使用同一组口径。 */
  Company.remitPreview = function (g) {
    const c0 = Company.active();
    if (!c0 || !g || !g.company || g.company.id !== c0.id) return null;
    const c = Company.fresh(c0) || c0;
    if (!Company.branchOf(c, g.mapId)) return null;
    const last = g.econ.lastClosed ? g.econ.lastClosed() : null;
    if (!last) {
      return { net: 0, want: 0, can: 0, reserve: 0, reason: '本月还没有完整账期，月结后才计算。' };
    }
    const net = (last.fare || 0) + (last.reward || 0)
      - (last.ops || 0) - (last.interest || 0)
      - (last.principal || 0) - (last.penalty || 0);
    const reserve = 2 * (last.ops || 0);
    const want = Math.max(0, net * REMIT_RATE);
    const can = Math.max(0, Math.min(want, g.econ.funds - reserve));
    let reason = '按上月经营现金流的 30% 预计上缴。';
    if (net <= 0) reason = '上月经营现金流为负（票款 + 奖励 − 运营 − 利息 − 本金 − 罚款），公司池本次不会增加。';
    else if (can <= 0.01) reason = '上月有正经营现金流，但本地现金低于 2 个月运营成本，暂不上缴。';
    return { net: net, want: want, can: can, reserve: reserve, reason: reason };
  };

  /* 公司向当前分部注资。
   * 只允许注入当前正在玩的这一局：其它分部的存档不在内存里，直接改 localStorage
   * 会在下一次 onSaved 时被存档里的旧现金覆盖，等于钱凭空消失。
   *
   * 上限分两种，且都按 12 个月滚动扣减：
   * - 发展注资：过去 12 个月正利润之和的 50%；
   * - 紧急救援：3 个月运营成本（至少 2 亿），用于破产前救急。
   * 没有历史记录的新分部不能靠“发展注资”拿到钱，必须有救援额度。 */
  Company.injectCap = function (c, mapId, y, m) {
    const b = Company.branchOf(c, mapId);
    if (!b) return { dev: 0, rescue: 0, cap: 0, lastOps: 0, yearProfit: 0, usedDev: 0, usedRescue: 0 };
    let yearProfit = 0;
    for (const p of (b.profits || [])) if (p && p.net > 0) yearProfit += p.net;
    const lastOps = b.lastOps || 0;
    const ym = (y && m) ? y * 12 + m : null;
    const hist = (b.injects || []).filter(function (x) { return x && (ym == null || x.ym >= ym - 11); });
    let usedDev = 0, usedRescue = 0;
    for (const x of hist) { if (x.rescue) usedRescue += x.amount || 0; else usedDev += x.amount || 0; }
    const dev = Math.max(0, 0.5 * yearProfit - usedDev);
    const rescue = Math.max(0, Math.max(3 * lastOps, 20000) - usedRescue);
    return { dev: dev, rescue: rescue, cap: Math.max(dev, rescue), lastOps: lastOps, yearProfit: yearProfit, usedDev: usedDev, usedRescue: usedRescue };
  };

  Company.inject = function (g, amount, rescue) {
    const c0 = Company.active();
    if (!c0 || !g || !g.company || g.company.id !== c0.id) return { ok: false, error: '没有对应的公司' };
    if (!g.mapId) return { ok: false, error: '当前没有分部' };
    if (g.econ.isFree()) return { ok: false, error: '自由建造模式不参与公司注资' };
    const c = Company.fresh(c0) || c0;
    const b = Company.branchOf(c, g.mapId);
    if (!b) return { ok: false, error: '当前城市还没有登记为分部' };
    const amt = Math.round(Number(amount) || 0);
    if (amt <= 0) return { ok: false, error: '注资金额必须大于 0' };
    const caps = Company.injectCap(c, g.mapId, g.clock.y, g.clock.m);
    const cap = rescue ? caps.rescue : caps.dev;
    if (amt > cap + 1e-6) return { ok: false, error: '注资超过上限（可用 ' + U.fmtMoney(cap) + '）', cap: cap };
    if ((c.pool || 0) < amt) return { ok: false, error: '公司池不足（可用 ' + U.fmtMoney(c.pool || 0) + '）' };
    c.pool = (c.pool || 0) - amt;
    b.funds = (b.funds || 0) + amt;
    b.injected = (b.injected || 0) + amt;
    const ym = g.clock.y * 12 + g.clock.m;
    b.injects = (b.injects || []).filter(function (x) { return x && x.ym >= ym - 11; });
    b.injects.push({ ym: ym, amount: amt, rescue: !!rescue });
    c.updatedAt = nowIso();
    g.econ.income('inject', amt);
    g.econ.log('inject', amt, 'gen', '公司注资', { y: g.clock.y, m: g.clock.m, d: 1 });
    if (g.logEvent) g.logEvent({ tag: '公司', title: '公司注资 ' + U.fmtMoney(amt), desc: '从公司池划入当前分部' });
    const r = Company.commit(c0, c);
    if (!r.ok) return { ok: false, error: r.error || '写入失败' };
    return { ok: true, amount: amt, cap: cap, company: c };
  };

  /* 把当前这一局的现金写回公司记录。切城、退城、存档前都要调。 */
  Company.syncFunds = function (g) {
    if (!g || !g.company) return null;
    const c = Company.get(g.company.id);
    if (!c) return null;
    const b = Company.branchOf(c, g.mapId);
    if (!b) return null;
    const funds = g.econ && !g.econ.isFree() ? g.econ.funds : b.funds;
    Company.updateBranch(c, g.mapId, { funds: funds, failed: !!(g.econ && g.econ.failed) });
    return Company.get(g.company.id);
  };

  /* 存档落盘后调用：自动登记分部、同步现金、记住槽位。
   * 为什么挂在存档之后而不是开局时：玩家可能开一局玩两分钟就退，那一局不该占一个分部名额；
   * 而只要落过盘，这座城市就真的「在经营」了，必须出现在公司账上。 */
  Company.onSaved = function (g, slotId) {
    if (!g || !g.mapId) return null;
    if (g.mode === 'free') return null;                 // 教程局不进公司账
    let c = g.company && Company.get(g.company.id);
    if (!c) {
      // 没有公司的普通开局：自动建一家，主城就是当前这张图。
      // 不弹「请先创建公司」—— 玩家没有主动要求公司玩法，不该被拦一步。
      c = Company.active();
      if (!c) {
        const r = Company.create((g.name || '城轨公司') + ' 公司', g.mapId);
        if (!r.ok) return null;
        c = r.company;
        Company.setActive(c.id);
      }
      g.company = { id: c.id, name: c.name };
    }
    if (!Company.branchOf(c, g.mapId)) {
      Company.addBranch(c, { mapId: g.mapId, name: (CM.MAPS[g.mapId] && CM.MAPS[g.mapId].name || g.mapId) + '分部', funds: g.econ ? g.econ.funds : 0 });
    }
    Company.updateBranch(c, g.mapId, {
      funds: g.econ && !g.econ.isFree() ? g.econ.funds : 0,
      failed: !!(g.econ && g.econ.failed),
      slotId: slotId || (Company.branchOf(c, g.mapId) || {}).slotId || null,
      day: g.clock ? (g.clock.y + '-' + g.clock.m + '-' + g.clock.d) : null,
    });
    return Company.get(c.id);
  };

  /* 进驻新城：从金库扣接入费，再登记分部。
   * 扣费必须真的从某个分部账上划走（金库是合计值，不是一个能单独扣的数字），
   * 所以指定 payerMapId —— 默认从当前在玩的那座城市出钱。
   * 新城启动金同样是「从老城转过去的」，不是凭空印出来的：
   * 否则多城玩法会变成「每进一城白拿一笔启动金」，越扩张越有钱，经济直接失衡。 */
  Company.payAccess = function (c, payerMapId, fee, startFunds) {
    if (!c) return { ok: false, error: '公司不存在' };
    const co = Company.fresh(c);
    if (!co) return { ok: false, error: '公司不存在' };
    const b = Company.branchOf(co, payerMapId);
    if (!b) return { ok: false, error: '付款分部不存在' };
    const need = (fee || 0) + (startFunds || 0);
    const avail = Company.available(co, payerMapId);
    if (avail < need) return { ok: false, error: '可动用的钱不够（需要 ' + U.fmtMoney(need) + '）' };
    // 先扣分部自己的账，不够的部分再从公司自有资金出 —— 顺序固定，
    // 与 canJoin 用同一个 available()，保证「面板放行的就一定扣得动」。
    const fromBranch = Math.min(need, Math.max(0, b.funds || 0));
    const fromPool = need - fromBranch;
    b.funds = (b.funds || 0) - fromBranch;
    co.pool = Company.poolOf(co) - fromPool;
    Company.commit(c, co);
    return { ok: true, branch: Company.branchOf(Company.fresh(co), payerMapId), fromBranch: fromBranch, fromPool: fromPool };
  };

  /* 生成一局「进驻新城」的开局参数。
   * 新城启动金来自付款分部扣掉接入费之后的余额，上限 = 该城标准开局资金。 */
  Company.joinOpts = function (c, mapId, difficulty, baseName, payerMapId) {
    const chk = Company.canJoin(c, mapId, payerMapId);
    if (!chk.ok) return { ok: false, error: chk.reason };
    const mp = CM.MAPS[mapId];
    if (!mp) return { ok: false, error: '地图不存在' };
    const std = CM.Difficulty ? CM.Difficulty.startFundsOf(difficulty) : (mp.cfg.economy.startFunds || 0);
    /*
     * 新城启动金不是印出来的，是从老城账上划过去的：
     * 能拿到的上限 = 扣掉接入费之后付款分部还剩多少，且不超过该城标准开局资金。
     * 若允许「凭空给启动金」，多城玩法会变成「每进一城白拿一笔」，
     * 扩张本身就是印钞机，经济模型直接失效。
     */
    const left = Math.max(0, chk.have - chk.fee);
    const start = Math.min(std, left);
    return {
      ok: true,
      fee: chk.fee,
      startFunds: start,
      opts: {
        map: mapId,
        mode: 'challenge',
        difficulty: difficulty,
        name: baseName || ('分部 · ' + mp.name),
        company: { id: c.id, name: c.name },
        startFunds: start,
        accessFee: chk.fee,
      },
    };
  };

  Company.fmtFee = function (mapId) {
    return U.fmtMoney(Company.accessFee(mapId));
  };
})(window.CM);
