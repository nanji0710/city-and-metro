// 由我们的 54 城线网 + POI 数据生成参考项目格式的 js/data_cities.js
// 用法:
//   node tools/pipeline/build-data.mjs                 # 全部 54 城
//   node tools/pipeline/build-data.mjs --city luoyang # 单城（打印摘要，不写文件）
//   node tools/pipeline/build-data.mjs --list          # 只列城市
//
// 为什么要生成而不是手写：
//   参考项目的 data_gz.js 是 313 行手写的广州场景（27 个片区、33 处地标、几十项设施），
//   那是给一张图做的手工活。我们有 54 城，手写不可能，只能从真实数据推导。
//
// 推导规则（每条都写清来源，避免以后看不懂数字是怎么来的）：
//   regions     ← OSM 行政区（geo 里的 admin level 6 区，缺失时退回 level 8 街道）
//                 引擎 city.js:256-257 原生支持按 admin 名字匹配，不需要改引擎。
//   plans       ← 按该区内 POI 密度分档：最密的用 cbd，其次 mix，其余 res/resind。
//   centers     ← 我们的真实地铁站 POI（poi/<id>.json 的 breakdown）：
//                 life→居住密度，commercial+hub→就业密度。
//   facilities  ← 同源：hub 高的站做成 rail 枢纽，commercial 高的做成 shop。
//   landmarks   ← 留空。我们没有地标几何数据，编造会与真实地理冲突。
//   roadYears   ← 留空（道路随所在区域开放出现，2025 年开局即全部可见）。
//
// 时间：所有城市统一 2025 年开局（用户要求「只需要当前年代」）。

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CITY_DIR = join(ROOT, 'tools', 'src', 'cities')
const POI_DIR = join(ROOT, 'tools', 'src', 'poi')
const GEO_DIR = join(ROOT, 'js')
const OUT = join(ROOT, 'js', 'data_cities.js')

/** 统一开局年份：用户要求「我们只需要当前年代」 */
const START_YEAR = 2025

/**
 * 2025 年城区常住人口（万人，估算）。
 * 引擎只用到它的相对量级：`CFG.growth.popCurve` 决定全城总人口，
 * `D.centers` 决定人口在格网上的分布。数字取整到万人即可，
 * 因为城市模拟本身是「模拟」而非预测（见 dataNote）。
 */
const POP_WAN = {
  beijing: 2180, shanghai: 2480, chengdu: 2140, guangzhou: 1890, nanjing: 960,
  shenzhen: 1770, wuhan: 1370, hangzhou: 1250, chongqing: 1650, suzhou: 1290,
  zhengzhou: 1280, xian: 1300, qingdao: 1040, tianjin: 1170, ningbo: 970,
  hongkong: 750, shenyang: 920, hefei: 960, changsha: 1050, jinan: 940,
  changchun: 910, dalian: 750, fuzhou: 850, foshan: 950, kunming: 860,
  xiamen: 550, guiyang: 650, xianyang: 500, nanchang: 650, wuxi: 750,
  nanning: 900, wenzhou: 960, jinhua: 710, dongguan: 1050, changzhou: 550,
  haerbin: 990, xuzhou: 900, shijiazhuang: 1120, ziyang: 230, xuchang: 440,
  nantong: 780, shaoxing: 540, xiangtan: 290, taiyuan: 550, huhehaote: 360,
  taizhou: 670, wuhu: 380, chuzhou: 400, luoyang: 710, ezhou: 110,
  lanzhou: 440, wulumuqi: 410, aomen: 68, qingyuan: 400,
}

/** 线路配色：参考项目给了广州真实配色；其余城市用一套通用高对比色板 */
const LINE_COLORS = [
  '#e4572e', '#2f6fd0', '#f2b134', '#2a9d6e', '#c33c54', '#7d5ba6',
  '#0f8fa8', '#d9822b', '#4fa0a6', '#b36a9e', '#5b9bd5', '#8e8c13',
]

const PLANS = {
  oldmix: { RES: 0.5, MIX: 0.35, COM: 0.1, INST: 0.05 },
  cbd: { COM: 0.7, MIX: 0.2, RES: 0.1 },
  mix: { RES: 0.45, MIX: 0.25, COM: 0.1, INST: 0.12, IND: 0.08 },
  res: { RES: 0.7, MIX: 0.15, COM: 0.05, INST: 0.05, IND: 0.05 },
  resind: { RES: 0.45, IND: 0.35, MIX: 0.1, COM: 0.05, INST: 0.05 },
  ind: { IND: 0.6, RES: 0.25, MIX: 0.1, COM: 0.05 },
  campus: { INST: 0.6, RES: 0.25, MIX: 0.1, COM: 0.05 },
  newtown: { RES: 0.45, MIX: 0.3, COM: 0.2, INST: 0.05 },
}

/** 把 js/geo_<id>.js 在沙箱里跑一遍，取出 CM.MAP_GEO[id] */
async function loadGeo(id) {
  const p = join(GEO_DIR, `geo_${id}.js`)
  if (!existsSync(p)) return null
  const src = await readFile(p, 'utf8')
  const sandbox = { window: { CM: {} } }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { timeout: 30000 })
  return (sandbox.window.CM.MAP_GEO || {})[id] || null
}

/** 确定性字符串哈希（同名不同城也不冲突） */
function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

/**
 * 把 admin 多边形（编码串）栅格化成「每个格属于哪个区」。
 * 引擎自己也会做一遍（city.js:232-260），但那是在游戏里；这里需要提前知道
 * 每个格归谁，才能算出各区 POI 密度、给区域挑 plan。
 */
function regionGrid(geo, W, H) {
  const dec = decodeGeo
  const idx = new Int16Array(W * H).fill(-1)
  const list = geo.admin || []
  const order = list
    .map((a, i) => ({ a, i, lvl: a[0] }))
    .sort((x, y) => y.lvl - x.lvl) // 先大区后小区：小区覆盖大区
  for (const { a, i } of order) {
    const rings = a.slice(2).filter((s) => typeof s === 'string')
    for (const ring of rings) {
      const pts = dec(ring, 1)
      fillPoly(idx, W, H, pts, i)
    }
  }
  return idx
}

/** 扫描线多边形填充（格中心测试，与引擎 Geo.fill 同语义） */
function fillPoly(idx, W, H, pts, value) {
  const n = pts.length / 2
  if (n < 3) return
  let minY = Infinity
  let maxY = -Infinity
  for (let k = 1; k < n; k += 2) {
    if (pts[k] < minY) minY = pts[k]
    if (pts[k] > maxY) maxY = pts[k]
  }
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(H - 1, Math.ceil(maxY))
  const xs = []
  for (let j = y0; j <= y1; j++) {
    const cy = j + 0.5
    xs.length = 0
    for (let k = 0; k < n; k++) {
      const ax = pts[k * 2]
      const ay = pts[k * 2 + 1]
      const bx = pts[((k + 1) % n) * 2]
      const by = pts[((k + 1) % n) * 2 + 1]
      if (ay === by) continue
      if ((cy >= ay && cy < by) || (cy >= by && cy < ay)) {
        xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax))
      }
    }
    if (!xs.length) continue
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5))
      const i1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5))
      for (let i = i0; i <= i1; i++) idx[j * W + i] = value
    }
  }
}

/** 与 js/geo.js 的 Geo.dec 完全一致 */
function decodeGeo(s, from) {
  const out = []
  let i = from || 0
  let x = 0
  let y = 0
  while (i < s.length) {
    let r = 0
    let sh = 0
    let b
    do {
      b = s.charCodeAt(i++) - 63
      r |= (b & 31) << sh
      sh += 5
    } while (b >= 32)
    x += r & 1 ? ~(r >> 1) : r >> 1
    r = 0
    sh = 0
    do {
      b = s.charCodeAt(i++) - 63
      r |= (b & 31) << sh
      sh += 5
    } while (b >= 32)
    y += r & 1 ? ~(r >> 1) : r >> 1
    out.push(x / 64, y / 64)
  }
  return out
}

/**
 * 经纬度 → 格坐标（必须与 fetch-geo.mjs 的 makeProjector 逐项一致）
 *
 * fetch-geo.mjs 里 ox = W/2 - (cx - lon0)*kx，而 lon0 就是 bbox 中心 cx，
 * 所以 ox 恒等于 W/2、oy 恒等于 H/2 —— 也就是「把 bbox 中心对齐到格网中心」。
 * 这里漏掉这两个偏移，所有 POI/车站都会落在格网左上角，
 * 表现是「城市建筑全挤在西北角、地铁线一条都不在图上」。
 */
function projector(geo) {
  const p = geo.proj
  const ox = geo.W / 2
  const oy = geo.H / 2
  return (lon, lat) => [
    +((lon - p.lon0) * p.kx + ox).toFixed(2),
    +((p.lat0 - lat) * p.ky + oy).toFixed(2),
  ]
}

async function buildCity(id) {
  const city = JSON.parse(await readFile(join(CITY_DIR, `${id}.json`), 'utf8'))
  let poi = null
  try {
    poi = JSON.parse(await readFile(join(POI_DIR, `${id}.json`), 'utf8'))
  } catch {
    poi = null
  }
  const geo = await loadGeo(id)
  if (!geo) return { id, error: '缺少 geo_<id>.js，先跑 fetch-geo.mjs' }

  const W = geo.W
  const H = geo.H
  const proj = projector(geo)
  const names = geo.names || []
  const admin = geo.admin || []

  // ---- 区域：优先用 level 6（区），没有就退到 level 8（街道）----
  const byLevel = (lvl) => admin.map((a, i) => ({ a, i })).filter(({ a }) => a[0] === lvl)
  let picked = byLevel(6)
  if (picked.length < 3) picked = byLevel(8)
  if (picked.length < 3) picked = byLevel(7)
  // 数量太多（街道级上百个）会让 region 数组爆炸，按面积取前 28 个
  const grid = regionGrid(geo, W, H)

  const cellsOf = new Map()
  for (let c = 0; c < W * H; c++) {
    const k = grid[c]
    if (k < 0) continue
    cellsOf.set(k, (cellsOf.get(k) || 0) + 1)
  }

  // POI 归属到区域：拿真实地铁站的 POI 权重投到所在格
  const poiByRegion = new Map()
  const stations = (poi && poi.stations) || []
  for (const st of stations) {
    const [x, y] = proj(st.lon, st.lat)
    const i = Math.floor(x)
    const j = Math.floor(y)
    if (i < 0 || j < 0 || i >= W || j >= H) continue
    const k = grid[j * W + i]
    if (k < 0) continue
    const cur = poiByRegion.get(k) || { life: 0, job: 0, n: 0, names: [] }
    const b = st.breakdown || {}
    cur.life += b.life || 0
    cur.job += (b.commercial || 0) + (b.hub || 0) * 0.6
    cur.n++
    cur.names.push(st.name)
    poiByRegion.set(k, cur)
  }

  // 按「POI 总量」给区域排 plan。
  // 为什么用总量而不是密度：plan 决定的是这块地的功能配比（住宅多还是写字楼多），
  // 而「哪里岗位多」是绝对量——一个 30 格的远郊区即使每格密度高，也不该盖成 CBD。
  // 密度只在最后一档用来识别「大片低密度区」→ resind（居住+工业混合）。
  const ranked = picked
    .map(({ a, i }) => {
      const cells = cellsOf.get(i) || 0
      const p = poiByRegion.get(i) || { life: 0, job: 0, n: 0 }
      return { a, i, cells, total: p.life + p.job, dens: cells ? (p.life + p.job) / cells : 0 }
    })
    .filter((r) => r.cells > 0)
    .sort((x, y) => y.total - x.total)
  if (ranked.length > 28) ranked.length = 28

  const regions = []
  const regionIndexToId = new Map()
  const usedId = new Set()
  ranked.forEach((r, rank) => {
    const rawName = names[r.a[1]] || `片区${rank + 1}`
    const name = rawName.replace(/（.*?）/g, '').trim() || `片区${rank + 1}`
    let rid = `r${rank}`
    while (usedId.has(rid)) rid += 'x'
    usedId.add(rid)
    regionIndexToId.set(r.i, rid)
    // 分档：前 10% cbd，前 35% mix，其余 res；面积大而 POI 稀的做成 resind
    const q = ranked.length > 1 ? rank / (ranked.length - 1) : 0
    let plan = 'res'
    if (q < 0.1) plan = 'cbd'
    else if (q < 0.35) plan = 'mix'
    else if (q > 0.7 && r.cells >= 8 && r.dens < 12) plan = 'resind'
    regions.push({
      id: rid,
      name,
      // 引擎 city.js:256 按 admin level 6/7 的名字匹配 district，level 8 匹配 streets。
      // 我们这里两种都可能，所以按实际层级塞对应字段。
      ...(r.a[0] === 8 ? { streets: [rawName] } : { district: [rawName] }),
      open: START_YEAR,
      plan,
    })
  })

  if (!regions.length) {
    // 兜底：没有任何行政区数据时给一个整图区域，避免 regions 为空导致
    // city.js:40 的 regions.concat 之后数组长度为 1 但 defaultRegion 也被吃掉
    regions.push({ id: 'r0', name: city.name, open: START_YEAR, plan: 'mix' })
  }

  // ---- 人口与就业中心：真实地铁站 POI 直接当中心 ----
  const topStations = stations
    .map((st) => {
      const [x, y] = proj(st.lon, st.lat)
      const b = st.breakdown || {}
      return {
        name: st.name,
        x: +x.toFixed(2),
        y: +y.toFixed(2),
        life: b.life || 0,
        job: (b.commercial || 0) + (b.hub || 0) * 1.4,
        score: st.score || 0,
      }
    })
    .filter((s) => s.x >= 0 && s.y >= 0 && s.x <= W && s.y <= H)
    .sort((a, b) => b.score - a.score)

  const maxLife = Math.max(1, ...topStations.map((s) => s.life))
  const maxJob = Math.max(1, ...topStations.map((s) => s.job))
  const centers = topStations.slice(0, 22).map((s) => ({
    x: s.x,
    y: s.y,
    // 人/km²：POI 生活类权重映射到 8000~62000
    pop: Math.round(8000 + (s.life / maxLife) * 54000),
    // 岗位/km²：商业+枢纽权重映射到 4000~58000
    jobs: Math.round(4000 + (s.job / maxJob) * 54000),
    r: +(1.6 + (s.score || 0) * 1.6).toFixed(1),
  }))
  if (!centers.length) {
    centers.push({ x: W / 2, y: H / 2, pop: 30000, jobs: 20000, r: 4 })
  }

  // ---- 设施：枢纽站做铁路接驳，最繁华的做商圈 ----
  const facilities = []
  const seen = new Set()
  for (const s of topStations) {
    const b = stations.find((x) => x.name === s.name)
    const br = (b && b.breakdown) || {}
    const fid = `f_${facilities.length}`
    if ((br.hub || 0) >= 6 && facilities.filter((f) => f.t === 'rail').length < 4 && !seen.has('rail' + s.name)) {
      seen.add('rail' + s.name)
      facilities.push({ id: fid, n: s.name + '（铁路接驳）', t: 'rail', at: [s.x, s.y], pax: [[START_YEAR, 6]] })
    } else if ((br.commercial || 0) >= 8 && facilities.filter((f) => f.t === 'shop').length < 6 && !seen.has('shop' + s.name)) {
      seen.add('shop' + s.name)
      facilities.push({ id: fid, n: s.name + '商圈', t: 'shop', at: [s.x, s.y], r: 1.4, w: 0.03 })
    }
    if (facilities.length >= 10) break
  }

  const popWan = POP_WAN[id] || 400
  const popCurve = [
    [2020, popWan * 0.94 * 1e4],
    [2025, popWan * 1e4],
    [2030, popWan * 1.03 * 1e4],
    [2040, popWan * 1.07 * 1e4],
    [2060, popWan * 1.1 * 1e4],
    [2300, popWan * 1.12 * 1e4],
  ]

  /*
   * 开局既有线网：把我们抓到的真实地铁线路原样放进去。
   *
   * 为什么必须有：参考项目里只有东京有 initialNetwork，其余地图都是「从零画第一笔」。
   * 但我们的核心资产就是 54 城的真实线网 —— 开局给玩家一座已经有地铁的城市，
   * 他接手的是「怎么把这个已经存在的网络经营好」，而不是在一张白纸上重画广州。
   * 这也和用户原始需求里「以真实城市的地铁线路图为素材来源」直接对应。
   *
   * 只取前 MAX_INIT_LINES 条、每条最多 MAX_INIT_ST 站：
   * 站太多会让开局就背上一整张网的运营成本，玩家第一周就破产，反而失去可玩性。
   * 站台规模按真实站是否换乘站推断（换乘站用 L，其余 M），
   * 这决定开局能开多大的编组 —— 玩家要扩编组就得先花钱扩站台。
   */
  const MAX_INIT_LINES = 4
  const MAX_INIT_ST = 14
  const initLines = []
  const rawLines = (city.lines || [])
    .slice()
    .sort((a, b) => (b.stationCount || 0) - (a.stationCount || 0))
    .slice(0, MAX_INIT_LINES)
  for (const ln of rawLines) {
    const sts = (ln.stations || []).slice(0, MAX_INIT_ST)
    if (sts.length < 3) continue
    const xferCount = {}
    for (const l2 of city.lines || []) for (const s2 of l2.stations || []) xferCount[s2.id] = (xferCount[s2.id] || 0) + 1
    const stations = []
    for (const st of sts) {
      const [x, y] = proj(st.lon, st.lat)
      if (x < 0 || y < 0 || x > W || y > H) continue
      stations.push([st.name, +x.toFixed(2), +y.toFixed(2), xferCount[st.id] > 1 ? 'L' : 'M', START_YEAR])
    }
    if (stations.length < 3) continue
    initLines.push({
      name: ln.name || ln.ref || '号线',
      color: ln.color || LINE_COLORS[initLines.length % LINE_COLORS.length],
      type: ln.system === 'tram' || ln.system === 'monorail' ? 'elevated' : 'underground',
      year: START_YEAR,
      stations,
    })
  }
  const initialNetwork = initLines.length
    ? {
        year: START_YEAR,
        note: `${city.name}既有地铁线网（${initLines.length} 条线，真实走向）`,
        lines: initLines,
      }
    : undefined

  const province = city.province || ''
  const isSAR = province.indexOf('特别行政区') >= 0
  /*
   * 地区筛选的取值必须落在 js/screens.js 的 REGION_ORDER 里，否则筛选条上
   * 会出现二十几个省名（北京市/上海市/四川省…），一条筛选行放不下，
   * 而且玩家找城市时想的是「大陆 / 香港 / 澳门」，不是「这城属于哪个省」。
   * 省份改放到 facts 里，需要时仍可查。
   */
  const region = province === '香港特别行政区' ? '中国香港'
    : province === '澳门特别行政区' ? '中国澳门'
      : '中国内地'

  /*
   * 初始镜头：必须对准玩家的线网，不能取格网几何中心。
   *
   * 参考项目六张地图的线网都在图幅中央，所以 main.js:103 直接
   * `{cx: CFG.W/2, cy: CFG.H/2, zoom: 18}` 就够了。我们的城市不一样：
   * 线网只占城市建成区的一小块，格网中心经常落在江面、山里或城外空地。
   * 洛阳实测就是这样 —— 镜头停在洛河正中央，玩家开局看到一片水。
   *
   * 这里先算出结果再挂到 meta 上，因为下面的 return 是对象字面量，
   * 在字面量内部引用不到「即将返回的自身」。
   */
  const places = (geo.places || []).map((p) => [p[0], p[1], p[2], p[3]])
  /*
   * 镜头优先对准「全部真实地铁站」而不是「开局既有线网」。
   *
   * 两者不是一回事：initialNetwork 只取站数最多的前 2 条线（MAX_INIT_LINES），
   * 而玩家的第一印象应该是「这座城市的轨道网在哪」，不只是那两条线。
   * 更重要的一点：大部分城市根本没有 initialNetwork（只有东京有），
   * 那时若退回 places[0] 就只剩一个点、跨度算出来是 0，zoom 会撞到下限 8 ——
   * 第一版就是这么错的，18 城的 cam.zoom 全是 8。
   */
  const allStationPts = []
  for (const st of stations) {
    const [x, y] = proj(st.lon, st.lat)
    if (x >= 0 && y >= 0 && x <= W && y <= H) allStationPts.push([x, y])
  }
  const cam = camOf({ W, H, pts: allStationPts, initialNetwork, places })

  return {
    id,
    city: city.name,
    W,
    H,
    cellM: geo.cellM,
    regions,
    centers,
    facilities,
    popWan,
    popCurve,
    isSAR,
    counts: {
      roads: (geo.roads || []).length,
      water: (geo.water || []).length,
      admin: admin.length,
      places: (geo.places || []).length,
      stations: stations.length,
    },
    data: {
      city: city.name,
      stages: [[2030, '现状网络'], [2040, '加密期']],
      stageLast: '成熟期',
      dataNote: [
        ['真实地理', 'hist', `水系、道路、铁路、公园与行政区界、地名来自 OpenStreetMap（© OpenStreetMap 贡献者，ODbL），按 ${geo.cellM} m 网格投影。`],
        ['估算', 'est', '人口与就业分布由 OpenStreetMap 兴趣点（POI）密度推算；出行率、时间价值、造价与运营费用为游戏参数。'],
        ['模拟', 'sim', '客流、拥堵与财政结果由模型推演，不代表真实交通预测。'],
      ],
      taskNote: '本图无历史任务，按自己的节奏发展。',
      // 引擎 game.js:240/269 与 metro.js:448 会读这两个字段，即使没有机场区域也必须存在
      airport: { name: '', closeYear: 1900, buildable: true },
      regions,
      defaultRegion: { id: 'outer', name: '外围地区', open: START_YEAR, plan: 'res', pop: popWan * 0.6 * 1e4 },
      plans: PLANS,
      centers,
      rural: { pop: Math.round(260 + popWan * 0.9), jobs: Math.round(60 + popWan * 0.35) },
      // 没有逐路年份数据：留空 → 道路随所在区域开放（2025 年开局即全部可见）
      roadYears: {},
      bridgeYears: {},
      bridgeDefaultYear: START_YEAR - 30,
      simRoads: [],
      landmarks: [],
      facilities,
      districtLabels: [],
      // 开局既有真实线网（见上方 initialNetwork 注释）
      initialNetwork,
      events: [{ y: START_YEAR, m: 1, tag: '现状', title: `${START_YEAR} 年的${city.name}`, desc: '从当前的城市格局开始规划轨道交通。' }],
      histTasks: [],
      lineColorsNice: LINE_COLORS,
      places: (geo.places || []).map((p) => [p[0], p[1], p[2], p[3]]),
    },
    cfg: {
      W,
      H,
      START: { y: START_YEAR, m: 1, d: 1, minute: 360 },
      // growth 必须是**完整对象**：maps.js 是 Object.assign(cfg, m.cfg) 逐键覆盖，
      // 这里只写 popCurve 会把 CFG.growth.jobsRatio 整条抹掉，city.js:102 的
      // U.interp(CFG.growth.jobsRatio, y) 就会读到 undefined 并抛 TypeError。
      // 官方 data_*.js 一律用 Object.assign({}, CM.CFG.growth, {...}) 也是这个原因。
      growth: {
        popCurve,
        histEnd: START_YEAR,
        jobsRatio: [[2020, 0.55], [2030, 0.57], [2040, 0.58]],
        metroBoostMax: 0.06,
      },
      // 2025 年开局：无历史年代偏移、单一货币
      money: { code: 'CNY', unit: '元', wan: '万元', yi: '亿元', sym: '¥' },
      econBase: START_YEAR,
      workWeek: { sat: [[2020, 0]], school: [[2020, 0]] },
      // 所有城市 2025 年同一套经济曲线，不按年代平移
      macro: 'auto',
    },
    meta: {
      name: city.name,
      province,
      region,
      tier: tierOf(city.stats.lengthKm),
      lines: city.stats.lines,
      stations: city.stats.stations,
      lengthKm: city.stats.lengthKm,
      isSAR,
      cam,
    },
  }
}

/**
 * 由一组格坐标点算初始镜头。
 *
 * @param {{W:number,H:number,pts:number[][],initialNetwork:any,places:any[]}} b
 */
function camOf(b) {
  let pts = b.pts || []
  // 没有真实地铁站（极少数小城 POI 缺失）时退回既有线网，再退回最高等级片区
  if (!pts.length) {
    for (const ln of (b.initialNetwork && b.initialNetwork.lines) || []) {
      for (const st of ln.stations || []) pts.push([st[1], st[2]])
    }
  }
  if (!pts.length) {
    const places = b.places || []
    if (places.length) pts.push([places[0][1], places[0][2]])
  }
  if (!pts.length) return { cx: b.W / 2, cy: b.H / 2, zoom: 18 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const spanX = Math.max(2, maxX - minX)
  const spanY = Math.max(2, maxY - minY)
  /*
   * zoom 的语义（js/render.js）：世界坐标 × zoom = 屏幕像素。
   *
   * 但默认视图是 2.5D 等轴投影，世界坐标不是直接映到屏幕的：
   * ISO = [0.7071, -0.7071, 0.3536, 0.3536]，一个 w×h 的矩形在屏幕上变成
   * 宽 (w+h)×0.7071×zoom、高 (w+h)×0.3536×zoom 的菱形。
   * 所以按「线网格数跨度」算 zoom 是错的 —— 第一版就是这么写的，
   * 南京 68×128 的图算出 zoom 7.1，开局整座城只占屏幕中间一小块菱形。
   *
   * 正确做法：让线网在屏幕上占约 85% 视口。视口按 1680×1050 估（减去两侧浮层后约 1428×890）。
   *   宽约束：1428 / ((spanX+spanY) × 0.7071)
   *   高约束： 890 / ((spanX+spanY) × 0.3536)
   * 取小者，化简后宽约束更紧 ⇒ zoom = 2020 / (spanX+spanY)。
   *
   * 夹在 [6, 30]：低于 6 街道糊成一团，高于 30 只剩几个街区、看不出线网形状。
   */
  const zoom = Math.max(6, Math.min(30, 2020 / (spanX + spanY)))
  return { cx: +((minX + maxX) / 2).toFixed(2), cy: +((minY + maxY) / 2).toFixed(2), zoom: +zoom.toFixed(1) }
}

function tierOf(km) {
  if (km >= 400) return 1
  if (km >= 150) return 2
  if (km >= 60) return 3
  return 4
}

const TIER_NAME = { 1: '超大线网', 2: '大型线网', 3: '中型线网', 4: '小型线网' }
const TIER_DIFF = { 1: 4, 2: 3, 3: 2, 4: 1 }

/** 生成单个城市的 JS 片段（写进 data_cities.js） */
function emit(b) {
  const m = b.meta
  const facts = [
    ['范围', `${((b.W * b.cellM) / 1000).toFixed(0)} km × ${((b.H * b.cellM) / 1000).toFixed(0)} km`],
    ['起始', `${START_YEAR} 年`],
    ['人口', `约 ${Math.round(b.popWan)} 万`],
    ['现状线网', `${m.lines} 条线 · ${m.stations} 站 · ${Math.round(m.lengthKm)} km`],
    ['所在地', m.province],
    ['货币', '人民币（元）'],
  ]
  const lines = [
    `  // ── ${b.city}（${b.id}）${b.W}×${b.H} 格 × ${b.cellM} m ──`,
    `  reg({`,
    `    id: ${JSON.stringify(b.id)},`,
    `    name: ${JSON.stringify(b.city)},`,
    `    title: ${JSON.stringify(`${b.city} · ${START_YEAR}`)},`,
    `    sub: ${JSON.stringify(`真实地理 · ${TIER_NAME[m.tier]} · 人民币`)},`,
    `    region: ${JSON.stringify(m.region)},`,
    `    tagline: ${JSON.stringify(`${m.lines} 条线、${m.stations} 座站的现状网络，等你重排`)} ,`,
    `    difficulty: ${TIER_DIFF[m.tier]},`,
    `    tags: ${JSON.stringify([TIER_NAME[m.tier], `${m.stations} 站`, `${Math.round(m.lengthKm)} km`])},`,
    `    intro: ${JSON.stringify(`${START_YEAR} 年的${b.city}已经有 ${m.lines} 条地铁线、${m.stations} 座车站。你要在这张真实的城市底图上重新规划线路、加密网络、控制成本。`)},`,
    `    features: ${JSON.stringify([
      ['map', '真实城市底图', `道路、水系、铁路与片区边界来自 OpenStreetMap，按 ${b.cellM} m 网格`],
      ['people', 'POI 推算的人口与就业', `用 ${b.counts.stations} 座真实车站周边的兴趣点密度推算客流分布`],
      ['train', '现状线网规模', `${m.lines} 条线 · ${m.stations} 站 · ${Math.round(m.lengthKm)} km（作为难度参考）`],
    ])},`,
    `    highlights: [[${START_YEAR}, '从现状网络开始']],`,
    `    facts: ${JSON.stringify(facts)},`,
    `    modes: ['challenge', 'free'],`,
    `    kind: 'real',`,
    `    mapVersion: 1,`,
    `    scenario: ${JSON.stringify(`${b.id}-${START_YEAR}`)},`,
    `    cam: ${JSON.stringify(m.cam)},`,
    `    cfg: ${JSON.stringify(b.cfg)},`,
    `    data: ${JSON.stringify(b.data)},`,
    `  });`,
  ]
  return lines.join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const only = args.indexOf('--city') >= 0 ? args[args.indexOf('--city') + 1] : null
  const list = args.includes('--list')

  let files = (await readdir(CITY_DIR)).filter((f) => f.endsWith('.json') && f !== 'index.json')
  if (only) files = files.filter((f) => f === `${only}.json`)
  files.sort()

  if (list) {
    for (const f of files) console.log(f.replace('.json', ''))
    return
  }

  const built = []
  const failed = []
  for (const f of files) {
    const id = f.replace('.json', '')
    try {
      const b = await buildCity(id)
      if (b.error) {
        failed.push(`${id}: ${b.error}`)
        continue
      }
      built.push(b)
      if (only) {
        console.log(JSON.stringify({ id: b.id, W: b.W, H: b.H, cellM: b.cellM, regions: b.regions.length, centers: b.centers.length, facilities: b.facilities.length, counts: b.counts }, null, 1))
        console.log('regions:', b.regions.map((r) => r.name + '/' + r.plan).join(', '))
      }
    } catch (err) {
      failed.push(`${id}: ${err.message}`)
    }
  }

  if (only) {
    if (failed.length) console.log('失败:', failed.join('; '))
    return
  }

  // 排序：难度高的在后（地图选择页由易到难）
  built.sort((a, b) => a.meta.tier - b.meta.tier || a.id.localeCompare(b.id))

  const head = [
    "'use strict';",
    '// 由 tools/pipeline/build-data.mjs 生成，请勿手改。',
    '// 数据来源：我们的 54 城真实线网（tools/src/cities）+ OSM 兴趣点（tools/src/poi）',
    '//           + OpenStreetMap 底图（js/geo_<id>.js，© OpenStreetMap 贡献者，ODbL）。',
    `// 统一 ${START_YEAR} 年开局。城市数：${built.length}。`,
    '(function (CM) {',
    '  const LIST = (CM.MAP_LIST = CM.MAP_LIST || []);',
    '  const reg = function (m) { LIST.push(m); };',
    '',
  ].join('\n')
  const body = built.map(emit).join('\n\n')
  const tail = '\n})(window.CM);\n'
  await writeFile(OUT, head + body + tail, 'utf8')

  const kb = ((head + body + tail).length / 1024).toFixed(0)
  console.log(`写入 ${OUT}：${built.length} 城 → ${kb} KB`)
  if (failed.length) {
    console.log(`跳过 ${failed.length} 城：`)
    for (const f of failed) console.log('  - ' + f)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
