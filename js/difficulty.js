/*
 * 难度档位（本作独有）
 * ============================================================================
 *
 * 基底只有两个 mode：'free'（资金不限）与 'challenge'（经营挑战），
 * 且两者除了「有没有钱」之外完全一样 —— 开局资金、拨款、事故、客流都不区分。
 *
 * 这里加进四档难度，并且**只调玩家控制不了的那一部分**：
 *
 *   - 起始资金        —— 玩家开局无法改变
 *   - 拨款系数        —— 城市财政给的，玩家无法改变
 *   - 客流系数        —— 城市规模决定的，玩家无法改变
 *   - 事故系数        —— 概率，玩家无法改变
 *   - 建设成本系数    —— 地价决定的，玩家无法改变
 *
 * 明确**不给运营成本乘数**。运营成本（车公里、站务、人工工资）是玩家
 * 能通过配车、间隔、雇人直接控制的，再乘一个难度系数会产生
 * 「我明明算对了却还是亏」的不可解释亏损 —— 玩家会认为是 bug 而不是难度。
 *
 * 存档：难度存在 `g.difficulty`，随 Game.serialize() 一起存；旧档没有这个字段，
 * 读档时按 'normal' 兜底（不能按 'brutal' 兜底，那会让老存档突然变难）。
 */
(function (CM) {
  'use strict';

  const U = CM.U, CFG = CM.CFG;

  /*
   * 四档。倍率全部以 normal = 1.0 为基准。
   *
   * startFundsMult 只作用于 challenge 模式的 CFG.economy.startFunds；
   * free 模式资金无限，不受影响。
   */
  const LEVELS = [
    {
      key: 'easy', name: '见习调度', stars: 1, color: 'b-teal',
      desc: '资金宽裕、客流稳定、事故稀少。适合第一次接触本作。',
      startFundsMult: 1.8,
      grantMult: 1.25,
      demandMult: 1.10,
      incidentMult: 0.6,
      buildMult: 0.9,
    },
    {
      key: 'normal', name: '标准运营', stars: 2, color: 'b-blue',
      desc: '基底原始数值。一座真实城市的正常经营压力。',
      startFundsMult: 1.0,
      grantMult: 1.0,
      demandMult: 1.0,
      incidentMult: 1.0,
      buildMult: 1.0,
    },
    {
      key: 'hard', name: '白手起家', stars: 3, color: 'b-orange',
      desc: '启动资金紧张，客流偏弱，事故偏多。每一笔建设都要算回本期。',
      startFundsMult: 0.62,
      grantMult: 0.85,
      demandMult: 0.92,
      incidentMult: 1.35,
      buildMult: 1.12,
    },
    {
      key: 'brutal', name: '硬核闯关', stars: 4, color: 'b-red',
      desc: '启动资金极少，事故频繁。开局能活过第一年就算成功。',
      startFundsMult: 0.4,
      grantMult: 0.7,
      demandMult: 0.85,
      incidentMult: 1.7,
      buildMult: 1.28,
    },
  ];

  const BY_KEY = {};
  for (const L of LEVELS) BY_KEY[L.key] = L;

  const DEFAULT_KEY = 'normal';

  function get(key) {
    return BY_KEY[key] || BY_KEY[DEFAULT_KEY];
  }

  function keys() {
    return LEVELS.map(function (L) { return L.key; });
  }

  /*
   * 从游戏对象取当前档位。读档恢复的旧档没有 g.difficulty，
   * 这里统一兜底成 normal，避免老存档被静默改成硬核。
   */
  function of(g) {
    return get(g && g.difficulty);
  }

  /* 起始资金：按档位缩放 challenge 模式的初始资金 */
  function startFundsOf(key) {
    return Math.round(CFG.economy.startFunds * get(key).startFundsMult);
  }

  /*
   * 把任意输入收敛成合法 key。存档、URL 参数、旧版面板都可能塞进来
   * undefined / null / 拼错的字符串，全部落回 normal 而不是抛错 ——
   * 读档路径上抛错等于存档作废，代价远大于「难度悄悄变成标准」。
   */
  function norm(key) {
    return BY_KEY[key] ? key : DEFAULT_KEY;
  }

  /* 星级展示用（地图卡片/存档列表） */
  function label(key) {
    const L = get(key);
    return L.name + ' ' + '★'.repeat(L.stars);
  }

  CM.Difficulty = {
    LEVELS: LEVELS,
    BY_KEY: BY_KEY,
    DEFAULT_KEY: DEFAULT_KEY,
    get: get,
    keys: keys,
    of: of,
    norm: norm,
    startFundsOf: startFundsOf,
    label: label,
  };
})(window.CM);
