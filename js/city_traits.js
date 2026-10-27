'use strict';

/* 54 座 2025 城市的轻量特性。
 *
 * 目标不是做一套新的城市系统，而是让每座城在同一个引擎上有一个可感知的
 * 偏置：客流、建设成本、任务奖励。数值控制在 ±8% 内，避免破坏市值平衡。
 * 所有效果都会显示在选图卡片/详情与公司地图列表里。
 */
(function (CM) {
  const KINDS = {
    capital: {
      name: '行政中心',
      desc: '行政、总部与通勤需求稳定，任务回报略高；核心区施工也更贵。',
      demand: 1.02, build: 1.03, reward: 1.03,
      fx: '客流 +2% · 建设成本 +3% · 任务奖励 +3%',
    },
    port: {
      name: '港城外向',
      desc: '港口与外贸带来更强的外向客流，滨海和跨江工程成本更高。',
      demand: 1.04, build: 1.05, reward: 1.0,
      fx: '客流 +4% · 建设成本 +5%',
    },
    historic: {
      name: '历史文旅',
      desc: '老城与文旅客流带来更高任务回报，但历史城区施工更受限制。',
      demand: 1.01, build: 1.04, reward: 1.06,
      fx: '客流 +1% · 建设成本 +4% · 任务奖励 +6%',
    },
    industry: {
      name: '工业通勤',
      desc: '工业与制造业通勤更集中，土地与施工略便宜，但任务奖励偏低。',
      demand: 1.05, build: 0.97, reward: 0.98,
      fx: '客流 +5% · 建设成本 −3% · 任务奖励 −2%',
    },
    terrain: {
      name: '山河地形',
      desc: '山河与狭长地形推高建设成本，但走廊客流更稳定，任务回报略高。',
      demand: 0.99, build: 1.08, reward: 1.04,
      fx: '客流 −1% · 建设成本 +8% · 任务奖励 +4%',
    },
    hub: {
      name: '铁路枢纽',
      desc: '铁路与跨城换乘客流更强，枢纽工程略贵，任务回报略高。',
      demand: 1.03, build: 1.02, reward: 1.03,
      fx: '客流 +3% · 建设成本 +2% · 任务奖励 +3%',
    },
    delta: {
      name: '水网都会',
      desc: '水网、多中心与软土地层带来更强客流，也让桥隧建设更贵。',
      demand: 1.03, build: 1.04, reward: 1.0,
      fx: '客流 +3% · 建设成本 +4%',
    },
    campus: {
      name: '科教新城',
      desc: '高校、科研与青年岗位带来稳定客流，任务回报更高。',
      demand: 1.02, build: 1.01, reward: 1.05,
      fx: '客流 +2% · 建设成本 +1% · 任务奖励 +5%',
    },
  };

  const BY_CITY = {
    beijing: 'capital',
    chengdu: 'delta',
    chongqing: 'terrain',
    guangzhou: 'delta',
    hangzhou: 'historic',
    nanjing: 'historic',
    qingdao: 'port',
    shanghai: 'port',
    shenzhen: 'port',
    suzhou: 'delta',
    wuhan: 'hub',
    xian: 'historic',
    zhengzhou: 'hub',
    changchun: 'industry',
    changsha: 'hub',
    dalian: 'port',
    foshan: 'industry',
    fuzhou: 'port',
    hefei: 'campus',
    hongkong: 'port',
    jinan: 'hub',
    kunming: 'terrain',
    ningbo: 'port',
    shenyang: 'industry',
    tianjin: 'port',
    xiamen: 'port',
    changzhou: 'delta',
    dongguan: 'industry',
    guiyang: 'terrain',
    haerbin: 'hub',
    jinhua: 'delta',
    nanchang: 'hub',
    nanning: 'delta',
    shijiazhuang: 'hub',
    wenzhou: 'port',
    wuxi: 'delta',
    xianyang: 'historic',
    xuchang: 'industry',
    xuzhou: 'hub',
    aomen: 'port',
    chuzhou: 'industry',
    ezhou: 'industry',
    huhehaote: 'terrain',
    lanzhou: 'terrain',
    luoyang: 'historic',
    nantong: 'port',
    qingyuan: 'terrain',
    shaoxing: 'historic',
    taiyuan: 'terrain',
    taizhou: 'port',
    wuhu: 'delta',
    wulumuqi: 'terrain',
    xiangtan: 'industry',
    ziyang: 'industry',
  };

  const out = {};
  for (const id in BY_CITY) {
    const kind = KINDS[BY_CITY[id]];
    out[id] = {
      key: BY_CITY[id],
      name: kind.name,
      desc: kind.desc,
      demand: kind.demand,
      build: kind.build,
      reward: kind.reward,
      fx: kind.fx,
    };
  }
  CM.CITY_TRAITS = out;
})(window.CM);
