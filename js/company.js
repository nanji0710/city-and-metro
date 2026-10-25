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

  Company.create = function (name, homeMapId) {
    const c = {
      id: U.uid('co'),
      name: (name || '').trim() || '城轨公司',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      /* 公司层自有现金（pool）。以前这里是个从不被读取的 treasury:0 字段，
       * 而 Company.treasury() 其实是「各分部 funds 之和」—— 于是分部的上缴
       * 扣了钱却没有任何账户收到，35% 的净利凭空消失（见 remit 的注释）。
       * 现在 pool 是真的账：分部上缴进 pool，进驻新城可以从 pool 出钱。 */
      pool: 0,
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
   * 两处旧实现的错，都在这里修掉：
   * 1) 原来读 g.econ.cur 当「本月净利」，但 monthGen 里 openMonth 已经把 cur
   *    换成一张新的空账，此刻读到的只有刚发的拨款 —— 于是「上缴 35% 净利」
   *    实际变成了「上缴 35% 拨款」。改用 lastClosed()，即上一个真正结算完的月份。
   * 2) 原来从 econ.funds 扣掉之后没有任何账户收到（Company.treasury 只是各分部之和），
   *    这 35% 是凭空销毁的。现在转入公司自有现金 pool，一分不少。 */
  Company.remit = function (g, y, m) {
    const c0 = Company.active();
    if (!c0 || !g || !g.company || g.company.id !== c0.id) return null;
    // 先读一份存储里的最新记录再改：直接改 c0 再走 updateBranch 的话，
    // fresh() 会读到旧副本，刚加上去的 pool 会被覆盖掉。
    const c = Company.fresh(c0) || c0;
    const b = Company.branchOf(c, g.mapId);
    if (!b) return null;
    if (g.econ.isFree()) return null;
    // 上缴额按「上月净利」而不是余额：亏损的月份不该继续抽钱，那等于惩罚经营失败的城市
    const last = g.econ.lastClosed ? g.econ.lastClosed() : null;
    let net = 0;
    if (last) {
      net = (last.fare || 0) + (last.grant || 0) + (last.reward || 0)
        - (last.ops || 0) - (last.construction || 0) - (last.demolition || 0)
        - (last.upgrade || 0) - (last.relocation || 0) - (last.interest || 0) - (last.penalty || 0);
    }
    let paid = 0;
    if (net > 0) {
      const want = net * REMIT_RATE;
      const can = Math.min(want, Math.max(0, g.econ.funds));
      if (can > 0.01) {
        g.econ.funds -= can;
        paid = can;
        c.pool = Company.poolOf(c) + paid;   // 收款方：公司自有现金
        c.updatedAt = nowIso();
      }
    }
    // 在同一个最新副本上一起改分部与 pool，再一次性存盘 —— 分两次走
    // updateBranch 的话，第二次会从存储里再解析一份，把 pool 的增量冲掉。
    b.funds = g.econ.funds;
    b.lastRemit = { y: y, m: m, amount: paid };
    Company.commit(c0, c);
    return { paid: paid, branch: Company.branchOf(c, g.mapId), pool: Company.poolOf(c) };
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
