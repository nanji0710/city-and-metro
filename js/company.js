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

  /* 进驻费按城市档位（maps.js 里 mp.difficulty 1~4）定价，单位万元。
   * 定价思路：第一座城免费（就是开局那局），之后每多一座城的门槛按档位陡增 ——
   * 因为大城市本身客流盘子就大，进驻费低的话「先攒钱直接跳北京」会成为唯一最优解，
   * 而小城经营就没人玩了。 */
  const ACCESS_FEE = { 1: 30000, 2: 80000, 3: 160000, 4: 280000 };

  /* 分部每月往金库上缴的比例。
   * 为什么不 100%：分部自己也要留运营现金，全抽走会让玩家每次切回老城都先吃一次现金荒。
   * 为什么不 0：那样公司层就没有存在感，金库永远是空的，进驻费永远付不起。 */
  const REMIT_RATE = 0.35;

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

  Company.accessFee = function (mapId) {
    const mp = CM.MAPS && CM.MAPS[mapId];
    const d = mp ? (mp.difficulty || 2) : 2;
    return ACCESS_FEE[d] || ACCESS_FEE[2];
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

  Company.create = function (name, homeMapId) {
    const c = {
      id: U.uid('co'),
      name: (name || '').trim() || '城轨公司',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      treasury: 0,
      branches: [],
      home: homeMapId || null,
    };
    const r = Company.save(c);
    return r.ok ? { ok: true, company: c } : r;
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

  /* 金库 = 各家分部账面现金之和。
   * 不做成「一个独立的数字」是因为那样必须处理「分部有钱但金库没钱」的两套账，
   * 而玩家在面板上看到的钱必须和他在那个城市里看到的钱是同一笔。 */
  Company.treasury = function (c) {
    if (!c) return 0;
    let t = 0;
    for (const b of c.branches) t += (typeof b.funds === 'number' ? b.funds : 0);
    return t;
  };

  Company.addBranch = function (c, br) {
    if (!c) return { ok: false, error: '公司不存在' };
    const old = Company.branchOf(c, br.mapId);
    if (old) return { ok: true, branch: old, existed: true };
    const b = {
      mapId: br.mapId,
      name: br.name || (CM.MAPS[br.mapId] && CM.MAPS[br.mapId].name) || br.mapId,
      joinedAt: nowIso(),
      funds: typeof br.funds === 'number' ? br.funds : 0,
      slotId: br.slotId || null,
      failed: false,
    };
    c.branches.push(b);
    const r = Company.save(c);
    return r.ok ? { ok: true, branch: b } : r;
  };

  Company.updateBranch = function (c, mapId, patch) {
    const b = Company.branchOf(c, mapId);
    if (!b) return { ok: false, error: '这个城市还没有分部' };
    Object.assign(b, patch || {});
    const r = Company.save(c);
    return r.ok ? { ok: true, branch: b } : r;
  };

  Company.dropBranch = function (c, mapId) {
    if (!c) return { ok: false, error: '公司不存在' };
    c.branches = c.branches.filter(function (b) { return b.mapId !== mapId; });
    const r = Company.save(c);
    return r.ok ? { ok: true } : r;
  };

  /* 能不能进驻某城。返回 { ok, fee, have, short, reason }。
   * have 取的是**付款分部自己的账**，不是金库合计 —— 进驻费是从某一座城的账上扣的，
   * 拿合计去判「买得起」会出现「面板说能进，点下去却扣不动」的假绿灯。
   * payerMapId 缺省时退回金库合计，方便没有具体付款方时做能力评估。 */
  Company.canJoin = function (c, mapId, payerMapId) {
    if (!c) return { ok: false, reason: '还没有公司' };
    if (Company.branchOf(c, mapId)) return { ok: false, reason: '已经进驻过这座城市了' };
    const fee = Company.accessFee(mapId);
    let have;
    if (payerMapId) {
      const pb = Company.branchOf(c, payerMapId);
      // 显式指定了付款分部却找不到：这是调用方的错，不能退回金库合计蒙混过关 ——
      // 否则「面板放行、扣费时报分部不存在」会在玩家点确认的那一刻才炸
      if (!pb) return { ok: false, reason: '付款分部不存在' };
      have = typeof pb.funds === 'number' ? pb.funds : 0;
    } else {
      have = Company.treasury(c);
    }
    if (have < fee) {
      return { ok: false, fee: fee, have: have, short: fee - have, reason: '这座城的账上还差 ' + U.fmtMoney(fee - have) };
    }
    return { ok: true, fee: fee, have: have };
  };

  /* 分部每月上缴。由 game.js 的 monthGen 调用。
   * 从 econ.funds 直接扣 —— 这是唯一一处「分部与金库之间真实的钱移动」，
   * 扣完立刻写回公司记录，这样即便玩家不切城也不会丢账。 */
  Company.remit = function (g, y, m) {
    const c = Company.active();
    if (!c || !g || !g.company || g.company.id !== c.id) return null;
    const b = Company.branchOf(c, g.mapId);
    if (!b) return null;
    if (g.econ.isFree()) return null;
    // 上缴额按「本月净利」而不是余额：亏损的月份不该继续抽钱，那等于惩罚经营失败的城市
    const cur = g.econ.cur || {};
    const net = (cur.fare || 0) + (cur.grant || 0) + (cur.reward || 0)
      - (cur.ops || 0) - (cur.construction || 0) - (cur.demolition || 0)
      - (cur.upgrade || 0) - (cur.relocation || 0) - (cur.interest || 0) - (cur.penalty || 0);
    let paid = 0;
    if (net > 0) {
      const want = net * REMIT_RATE;
      const can = Math.min(want, Math.max(0, g.econ.funds));
      if (can > 0.01) { g.econ.funds -= can; paid = can; }
    }
    Company.updateBranch(c, g.mapId, { funds: g.econ.funds, lastRemit: { y: y, m: m, amount: paid } });
    return { paid: paid, branch: Company.branchOf(c, g.mapId) };
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
    const b = Company.branchOf(c, payerMapId);
    if (!b) return { ok: false, error: '付款分部不存在' };
    const need = (fee || 0) + (startFunds || 0);
    if ((b.funds || 0) < need) return { ok: false, error: '这个分部账上不够（需要 ' + U.fmtMoney(need) + '）' };
    Company.updateBranch(c, payerMapId, { funds: b.funds - need });
    return { ok: true, branch: Company.branchOf(c, payerMapId) };
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
