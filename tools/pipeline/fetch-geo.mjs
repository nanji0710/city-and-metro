// 抓 OSM 城市底图 → js/geo_<id>.js（直接生成参考项目的 CM.GEO 格式）
// 用法:
//   node tools/pipeline/fetch-geo.mjs                 # 全部 54 城（跳过已有）
//   node tools/pipeline/fetch-geo.mjs --city luoyang
//   node tools/pipeline/fetch-geo.mjs --city luoyang --force
//   node tools/pipeline/fetch-geo.mjs --limit 3
//
// 为什么直接产出 CM.GEO 而不是中间 json：
//   参考项目的引擎（city.js / render.js）认的就是 CM.GEO 这个结构，
//   中间多一层格式只会多一个「两边不一致」的机会。
//
// 与参考项目 geo_gz.js 的格式约定（必须逐位一致，解码器是 js/geo.js 的 Geo.dec）：
//   proj: { lon0, lat0, kx, ky }   格坐标 = (lon-lon0)*kx, (lat0-lat)*ky
//   cellM                          本图一格代表多少米（引擎所有物理量都按 CFG.CELL_M 换算）
//   roads:  [nameIdx, cls, flags, 'encoded']
//   water:  [nameIdx, widthCells, 'encoded']   线状
//           [nameIdx, 'o'+enc, 'i'+enc…]       面状
//   rail:   [nameIdx, flags, 'encoded', year?]
//   parks / reserves / woods: [nameIdx, 'o'+enc, …]
//   admin:  [level, nameIdx, 'o'+enc, …]
//   places: [[name, x, y, level], …]           已解码成格坐标（参考项目就是这么存的）
//   names:  [ '', '名字', … ]                   0 号必须是空串
//
// 坐标编码：x*64 取整 → 折线内差分 → zigzag → 每 5 位一个字符（+63）。
// 1/64 格精度；cellM=250 时约 3.9 m，cellM=700 时约 11 m —— 都远细于 15~30 m 的抽稀容差。

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CITY_DIR = join(ROOT, 'tools', 'src', 'cities')
const OUT_DIR = join(ROOT, 'js')
/** 块级磁盘缓存：Overpass 高负载时 53 城跑不完，必须能断点续跑 */
const CACHE_DIR = join(ROOT, 'tools', 'pipeline', '.geo-cache')
/** 是否忽略缓存重抓（--force 时置真） */
let FORCE = false

/*
 * Overpass 镜像池，按「实测可用性」排序。
 *
 * 2026-10-24 实测（tools/pipeline/_probe-mirror.mjs，用 out count 校验真的返回中国数据）：
 *   overpass.openstreetmap.fr   200 /  3.0s  ways=2766   ← 首选
 *   maps.mail.ru                200 / 23.1s  ways=2766
 *   overpass-api.de             200 / 31.1s  ways=2766
 *   lz4.overpass-api.de         200 / 31.1s
 *   z.overpass-api.de           200 / 31.2s
 *   overpass.osm.ch             200 /  3.7s  ways=0      ← 区域镜像，无中国数据，必须剔除
 *   kumi / private.coffee / osm.jp / nchc / openstreetmap.ru  全部超时或不可达
 *
 * 为什么 osm.ch 必须剔除：它对任何中国范围查询都返回 `{"elements": []}`，
 * 看起来「成功且很快」，实际产出 0 条道路。它混在池子里时排在首位，
 * 会把整轮抓取变成一堆空地图 —— 这比直接报错更危险。
 */
const ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

const UA = 'city-and-metro/2.1 (metro game basemap pipeline; contact: local)'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 地图目标尺寸：最大边长（格）。参考项目广州是 120×96，这里统一到 ~128 以内 */
const MAX_SIDE = 128
/** 线网在图上占比：外扩后网络约占 85%，四周留白给边缘站 */
const PAD = 1.18
/** 抽稀容差（米）。城市视图缩放下肉眼不可辨，但能砍掉一半以上顶点 */
const SIMPLIFY_M = 22
/** 单城顶点上限：超过就整体再抽稀，防止某城把仓库撑爆 */
const MAX_POINTS = 42000

/*
 * 道路等级只保留 2/3/4 三档 —— 这不是偷懒，是引擎的硬约束。
 *
 * 渲染层 `js/render.js:702` 是 `const lay = { 2: [], 3: [], 4: [] }`，
 * 后面直接 `lay[gr.cls].push(w)`；city.js:468 的道路宽度、city.js:812 的
 * 通行能力 `CFG.road.cap[cls]`（下标 0..4）也只认 0~4。
 * 参考项目广州的真实等级直方图是 `{2:6014, 3:8771, 4:4988}` —— 恰好三档。
 *
 * 所以 OSM 的七档要折叠成三档：
 *   2 = 快速路/高速（motorway, trunk）—— 只画不参与街区微循环
 *   3 = 主干道（primary, secondary）
 *   4 = 次干道/支路（tertiary, residential, living_street）
 * 折叠后道路数不会变多，但每一条都能被引擎正确画出并计入车流。
 */
const ROAD_CLASS = {
  motorway: 2,
  trunk: 2,
  primary: 3,
  secondary: 3,
  tertiary: 4,
  residential: 4,
  living_street: 4,
}

/* ---------------------------- 几何工具 ---------------------------- */

const M_PER_DEG_LAT = 110900

/** 米 → 度（经度按纬度收缩） */
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)

/** Douglas–Peucker，输入/输出都是 [x,y,x,y,…] 扁平数组 */
function simplify(flat, tol) {
  const n = flat.length / 2
  if (n <= 2) return flat
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    const ax = flat[a * 2]
    const ay = flat[a * 2 + 1]
    const bx = flat[b * 2]
    const by = flat[b * 2 + 1]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let best = -1
    let bestD = tol * tol
    for (let i = a + 1; i < b; i++) {
      const px = flat[i * 2]
      const py = flat[i * 2 + 1]
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const d = (px - (ax + dx * t)) ** 2 + (py - (ay + dy * t)) ** 2
      if (d > bestD) {
        bestD = d
        best = i
      }
    }
    if (best > 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[i * 2], flat[i * 2 + 1])
  return out
}

function decimate(flat, step) {
  if (step <= 1) return flat
  const out = []
  for (let i = 0; i < flat.length / 2; i += step) out.push(flat[i * 2], flat[i * 2 + 1])
  const n = flat.length / 2
  if ((n - 1) % step !== 0) out.push(flat[(n - 1) * 2], flat[(n - 1) * 2 + 1])
  return out
}

/** 与 js/geo.js 的 Geo.enc 逐位一致 */
function enc(pts) {
  let s = ''
  let px = 0
  let py = 0
  const put = (v) => {
    let u = v < 0 ? ~(v << 1) : v << 1
    while (u >= 32) {
      s += String.fromCharCode((32 | (u & 31)) + 63)
      u >>>= 5
    }
    s += String.fromCharCode(u + 63)
  }
  for (let k = 0; k + 1 < pts.length; k += 2) {
    const x = Math.round(pts[k] * 64)
    const y = Math.round(pts[k + 1] * 64)
    put(x - px)
    put(y - py)
    px = x
    py = y
  }
  return s
}

class NameTable {
  constructor() {
    this.list = ['']
    this.map = new Map()
  }
  idx(name) {
    if (!name) return 0
    const hit = this.map.get(name)
    if (hit !== undefined) return hit
    const i = this.list.length
    this.list.push(name)
    this.map.set(name, i)
    return i
  }
}

/* ---------------------------- Overpass ---------------------------- */

/**
 * 按格距决定抓哪几级道路。
 *
 * 为什么必须裁剪：北京线网 66×81 km，格距被拉到 870 m。这个尺度下一条 250 m 长的
 * 小区支路在图上只有 0.3 格 —— 抓回来也只是糊成一团黑，玩家分不清哪条是主干道。
 * 更糟的是 residential 级的 way 占了 Overpass 返回量的七成以上，抓它们直接把
 * 单城耗时从 2 分钟推到 25 分钟（实测北京 4×4 分块，每块 60~90 秒）。
 *
 * 所以：格越粗，只要越主干的路。
 *
 * 但阈值不能按「视觉直觉」定死 —— 实测（tools/pipeline/_probe-overpass.mjs）
 * 道路从 4 类扩到 7 类，元素量只涨 65%、耗时只涨 16%，因为 Overpass 的成本
 * 主要是一次请求的固定开销。所以只要**请求数不增加**，多抓细路几乎免费，
 * 而细路恰恰是玩家在近景下唯一能认出「这是哪条街」的东西。
 * 只有在格距粗到 800 m 以上（北京/上海/成都这种百公里级城市）才真的需要裁到主干道，
 * 因为那时一条支路只有零点几格，画出来是噪点。
 *
 * 返回值是**折叠后的等级**（2 快速路 / 3 主干道 / 4 次干道），与 ROAD_CLASS 的取值域一致。
 */
function maxRoadClassFor(cellM) {
  /*
   * 阈值比早先收紧了一档（原 800/1000 → 现 600/900），原因是实测吞吐：
   *
   * 北京 cellM=870 时按旧阈值仍会抓 residential + living_street，而这两类
   * 在 94×111 km 的范围里有十几万条 way —— 单块返回 15 MB JSON、服务器要跑
   * 两分半，20 分钟只推进 8 块，54 城要跑几天。而降级后视觉损失几乎为零：
   * 870 m 一格时一条 6 m 宽的小区路不足 0.01 格，画出来本来就是噪点。
   *
   * 小城（cellM ≤ 600，覆盖 44 城里的绝大多数）仍然保留全部细路，
   * 因为那里一格只有 250~600 m，支路正是玩家认路的依据。
   */
  return cellM <= 600 ? 4 : cellM <= 900 ? 3 : 2
}

function buildQuery(bbox, maxCls) {
  // bbox 内部是 [minLon, minLat, maxLon, maxLat]，Overpass 要 [south, west, north, east]
  const [minLon, minLat, maxLon, maxLat] = bbox
  const bb = `${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}`
  const classes = maxCls
    ? Object.keys(ROAD_CLASS).filter((k) => ROAD_CLASS[k] <= maxCls)
    : Object.keys(ROAD_CLASS)
  const roadSel = classes.join('|')
  // 有名字的按等级抓；无名字的只补主干道（无名小路是噪声，见 processCity 里的同名判断）
  const majorSel = classes.filter((k) => ROAD_CLASS[k] <= 3).join('|') || 'primary'
  /*
   * 只保留「玩家在地图上看得见、且认得出」的图层。
   *
   * 裁掉的：
   *   landuse=forest/recreation_ground —— 渲染层（render.js:547 drawGround）根本不画，
   *   只用于 city.js 的林地覆盖率。参考项目自己的 geo_*.js 里 woods 也是几百条量级，
   *   而 OSM 中国范围内 forest 多边形动辄上万条、每条上百顶点，
   *   是单块 JSON 从 3 MB 涨到 15 MB 的最大来源。
   *
   * 保留的：道路（核心）、水系（画河道与湖）、公园（画绿地）、铁路（画既有线）、
   *   片区名（建站自动命名与 D.places）、区界（build-data.mjs 靠它切 regions，
   *   每城只有几条 relation，开销可以忽略）。
   */
  return `[out:json][timeout:180];
(
  way["highway"~"^(${roadSel})$"]["name"](${bb});
  way["highway"~"^(${majorSel})$"](${bb});
  way["waterway"~"^(river|canal)$"](${bb});
  way["natural"="water"](${bb});
  way["leisure"="park"]["name"](${bb});
  way["railway"~"^(rail|light_rail|subway)$"](${bb});
  node["place"~"^(city|town|suburb|quarter|neighbourhood|village)$"](${bb});
  relation["boundary"="administrative"]["admin_level"~"^(6|7|8)$"](${bb});
);
out geom;`
}

/**
 * 抓一块 Overpass。
 *
 * 退避策略：429/504 是限流信号，不是「这个端点坏了」。之前的实现遇到 429 只等 2.5 秒
 * 就换下一个端点，四个镜像轮流被打一遍，全都还在冷却期，于是整城失败。
 * 现在对限流单独处理：等得久（15s → 40s → 90s），并且优先重试**同一个**端点
 * （它刚刚还在工作，冷却结束就能用），而不是把所有镜像都激怒一遍。
 *
 * pin：把这一路的请求固定到某个镜像。多个 worker 并行时，如果每路都从 0 号端点开始试，
 * 四个镜像会被同时打爆（实测 3 并发直接 429）。每个 worker 认领一个镜像，
 * 相当于把 4 个独立配额用满。
 */
/*
 * 端点健康表：坏掉的镜像先歇一会儿，别让每一块都去撞一遍。
 *
 * 实测背景：osm.ch 单块 0.8 秒，而其余四个镜像全部超时（30~65 秒）。如果不做这个，
 * 每块失败后仍会挨个试那四个死镜像，单块就要白等 2 分钟 —— 而 54 城有上百块，
 * 光是等死镜像就能把整个流水线拖到几小时。
 *
 * 冷却时长分级：连接失败（DNS/拒绝）说明是真的不可达，冷却 20 分钟；
 * 502/504/超时可能只是临时过载，冷却 5 分钟。
 */
const endpointCooldown = new Map()

function endpointReady(ep, now) {
  const until = endpointCooldown.get(ep) || 0
  return until <= now
}

function markEndpoint(ep, hard) {
  endpointCooldown.set(ep, Date.now() + (hard ? 20 * 60_000 : 5 * 60_000))
}

function markEndpointOk(ep) {
  endpointCooldown.delete(ep)
}

async function fetchOverpass(query, label, pin) {
  const preferred = pin == null ? null : ENDPOINTS[pin % ENDPOINTS.length]
  const now = Date.now()
  // 首选项永远排第一（哪怕在冷却中）：pin 是并发分摊用的，把某一路钉死在一个镜像上
  // 才能吃满它自己的配额；冷却只影响「兜底顺序」。
  const rest = ENDPOINTS.filter((ep) => ep !== preferred)
  const order = (preferred ? [preferred] : []).concat(
    rest.filter((ep) => endpointReady(ep, now)),
    // 全在冷却里时也得试，否则整城直接失败
    rest.filter((ep) => !endpointReady(ep, now)),
  )
  let lastErr
  let sawEmpty = false
  // 3 轮而不是 5 轮：每轮已经会试遍所有端点，轮次太多只会把时间耗在死镜像上。
  for (let round = 0; round < 3; round++) {
    for (const endpoint of order) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': UA,
            Accept: 'application/json',
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(180_000),
        })
        if (!res.ok) {
          const limited = res.status === 429 || res.status === 504 || res.status === 503 || res.status === 502
          const e = new Error(`HTTP ${res.status}`)
          e.limited = limited
          throw e
        }
        const json = await res.json()
        if (!Array.isArray(json.elements)) throw new Error('no elements')
        /*
         * 空结果是「这个镜像没有这块数据」的信号，不是成功。
         *
         * 区域镜像（如 overpass.osm.ch 只有瑞士）对任何中国范围查询都返回
         * `{"elements": []}`，状态码 200、耗时 3 秒，看起来完美。若不在这里拦住，
         * 整轮抓取会产出一堆 0 KB 的空地图，而且缓存里还会留下一堆空块。
         *
         * 但不能直接判失败：整块落在海面上时本来就是空的（香港、厦门都有这种块）。
         * 所以先记一笔「这一块所有端点都说空」，全部端点都空才认账。
         */
        if (json.elements.length === 0) {
          sawEmpty = true
          console.log(`    · ${new URL(endpoint).host} 返回空（可能是区域镜像）`)
          continue
        }
        markEndpointOk(endpoint)
        return json
      } catch (err) {
        lastErr = err
        const host = new URL(endpoint).host
        console.log(`    ! ${host} ${err.message}`)
        // 只有「连不上」才判硬故障；超时与 5xx 都可能只是临时过载
        const hard = err.name === 'TypeError' || /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(err.message || '')
        markEndpoint(endpoint, hard)
        // 限流退避：等 30s / 90s / 180s。非限流错误不睡 —— 换下一个端点更有意义
        if (err.limited) await sleep([30_000, 90_000, 180_000][Math.min(round, 2)])
      }
    }
    if (round < 2) await sleep(round === 0 ? 10_000 : 30_000)
  }
  // 所有端点都返回空 → 这一块本来就没人烟（海面 / 山区），返回空元素集而不是报错。
  // 这样整城不会因为一个空块而失败，也不会把空块当成错误反复重试。
  if (sawEmpty) return { elements: [] }
  throw lastErr ?? new Error('all endpoints failed')
}

/**
 * 分块抓取。
 *
 * 为什么必须分块：北京线网 66×81 km，一次性 `way[...](bbox)` 会让 Overpass 扫过
 * 上万个 way，服务器 300 秒内返回不了（实测四个镜像全部 abort）。切成 2×2 或 3×3
 * 后每块的数据量降到单城量级，总墙钟时间反而更短，而且某一块失败只重试那一块。
 * 重叠 6% 是为了避免跨块的道路被切断在接缝处。
 *
 * 块级磁盘缓存（tools/pipeline/.geo-cache/<city>/<j>-<i>.json）：
 * Overpass 的公网镜像在高负载时段「6 km 见方的小查询都要 35~75 秒、33 km 见方的中等查询
 * 直接 504」。这意味着 53 城不可能一口气跑完，中途一定会被打断。
 * 把每块结果落盘后，重跑只补缺的块 —— 否则每次都从头开始，永远跑不完。
 * 缓存只按「城市 + 块号」命名，不带查询参数；改了查询要 --force 清缓存。
 */
async function fetchTiled(bbox, label, maxCls, pin) {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const lat0 = (minLat + maxLat) / 2
  const spanXm = (maxLon - minLon) * mPerDegLon(lat0)
  const spanYm = (maxLat - minLat) * M_PER_DEG_LAT
  const maxSpan = Math.max(spanXm, spanYm)
  // 单块目标 45 km 见方，最多 3×3。
  //
  // 阈值是实测定出来的（tools/pipeline/_probe-overpass.mjs / _probe-overpass3.mjs）：
  //   6 km 见方 · 只 primary 级      → 398 elements / 33.9s
  //   33 km 见方 · 5 级道路         → 9492 elements / 31.8s（成功过一次）
  //   33 km 见方 · 5 级道路         → 504 超时（后续多次）
  // 关键发现：6 km 和 33 km 的耗时几乎一样（34s vs 32s）—— Overpass 的成本几乎全在
  // 「一次请求的固定开销」上，数据量本身影响很小。
  // 所以块越小请求数越多、总时间越长；块太大会撞 300s 超时。
  // 45 km 见方约是已验证可用的 33 km 的 1.9 倍面积，留了余量。
  //
  // 结果：44 个小城（跨度 < 45 km）只需 1 次请求，只有十来个大城才切块。
  let n = Math.max(1, Math.min(5, Math.ceil(maxSpan / 22000)))
  const seen = new Set()
  const elements = []
  const ox = (maxLon - minLon) * 0.06
  const oy = (maxLat - minLat) * 0.06
  if (n > 1) console.log(`     分 ${n}×${n} 块抓取（带磁盘缓存）`)
  const cacheDir = join(CACHE_DIR, label)
  await mkdir(cacheDir, { recursive: true })
  let fromCache = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = minLon + ((maxLon - minLon) * i) / n - ox
      const x1 = minLon + ((maxLon - minLon) * (i + 1)) / n + ox
      const y0 = minLat + ((maxLat - minLat) * j) / n - oy
      const y1 = minLat + ((maxLat - minLat) * (j + 1)) / n + oy
      const tile = [Math.max(minLon, x0), Math.max(minLat, y0), Math.min(maxLon, x1), Math.min(maxLat, y1)]
      const cf = join(cacheDir, `${j}-${i}.json`)
      let json = null
      if (!FORCE) {
        try {
          json = JSON.parse(await readFile(cf, 'utf8'))
          fromCache++
        } catch {
          json = null
        }
      }
      if (!json) {
        json = await fetchOverpass(buildQuery(tile, maxCls), `${label} ${j}-${i}`, pin)
        await writeFile(cf, JSON.stringify(json))
      }
      for (const el of json.elements) {
        const key = el.type + ':' + el.id
        if (seen.has(key)) continue
        seen.add(key)
        elements.push(el)
      }
      console.log(`     tile ${j}-${i}: ${json.elements.length}（累计 ${elements.length}）`)
      // 块间隔 400 ms：osm.ch 单块 <1 s，原来 1.5 s 的等待让「块数」直接乘到墙钟上。
      // 留一点点间隔只是不想把连发打成突发流量。
      await sleep(400)
    }
  }
  if (fromCache) console.log(`     ${fromCache}/${n * n} 块来自缓存`)
  return { elements }
}

/* ---------------------------- 主流程 ---------------------------- */

/** 城市线网的地理包围盒（外扩 8%） */
function cityBBox(city) {
  const lons = []
  const lats = []
  for (const line of city.lines ?? []) {
    for (const st of line.stations ?? []) {
      if (typeof st.lon !== 'number' || typeof st.lat !== 'number') continue
      lons.push(st.lon)
      lats.push(st.lat)
    }
    for (const p of line.track ?? []) {
      if (typeof p?.[0] !== 'number') continue
      lons.push(p[0])
      lats.push(p[1])
    }
  }
  if (!lons.length) return null
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const padLon = Math.max(0.008, (maxLon - minLon) * 0.08)
  const padLat = Math.max(0.008, (maxLat - minLat) * 0.08)
  return [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat]
}

/**
 * 按城市实际尺度决定「一格多少米」与格网尺寸。
 *
 * 为什么不是固定 250 m：参考项目只覆盖城市核心区（广州 30×24 km = 120×96 格）。
 * 我们的 54 城里有北京（线网 66×81 km）这种，固定 250 m 会得到 264×324 格 =
 * 8.5 万个交通小区，模拟与渲染都撑不住。所以让大城放大格距，格网始终不超过 128 边。
 *
 * 代价是不同城市一格代表的米数不同 —— 这没问题，因为一局只玩一张图，
 * 引擎所有物理量都从 CFG.CELL_M 读，切换地图时一起换掉即可。
 */
function gridOf(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const lat0 = (minLat + maxLat) / 2
  const lon0 = (minLon + maxLon) / 2
  const spanXm = (maxLon - minLon) * mPerDegLon(lat0)
  const spanYm = (maxLat - minLat) * M_PER_DEG_LAT
  // cellM 要含 PAD，否则 PAD 一乘就超出 MAX_SIDE
  const cellM = Math.max(250, Math.ceil((Math.max(spanXm, spanYm) * PAD) / MAX_SIDE / 10) * 10)
  // W/H 必须是 ZONE(4) 的整数倍。引擎 sim.js:349 用 CFG.W / CFG.ZONE 算交通小区数
  // （this.Z = this.ZW * this.ZH），不是整数倍时 Z 变成小数，
  // computeAccess 里 new Array(NZ) 会抛 RangeError: Invalid array length。
  // 参考项目六张图的格网（120×96 / 112×88 / 80×80 / 104×88 / 96×88 / 48×40）也都是 4 的倍数。
  const zone = 4
  const W = Math.max(24, Math.ceil((spanXm * PAD) / cellM / zone) * zone)
  const H = Math.max(24, Math.ceil((spanYm * PAD) / cellM / zone) * zone)
  // kx/ky：每度经纬度对应多少格
  const kx = mPerDegLon(lat0) / cellM
  const ky = M_PER_DEG_LAT / cellM
  return { lon0, lat0, kx, ky, cellM, W, H }
}

/** 经纬度 → 格坐标 */
function makeProjector(g, bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const cx = (minLon + maxLon) / 2
  const cy = (minLat + maxLat) / 2
  const ox = g.W / 2 - (cx - g.lon0) * g.kx
  const oy = g.H / 2 + (g.lat0 - cy) * g.ky
  return (lon, lat) => [(lon - g.lon0) * g.kx + ox, (g.lat0 - lat) * g.ky + oy]
}

function geomToFlat(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 2) return null
  const out = []
  for (const p of geometry) {
    if (typeof p?.lon !== 'number' || typeof p?.lat !== 'number') continue
    out.push(p.lon, p.lat)
  }
  return out.length >= 4 ? out : null
}

/** 由 way/relation 的 geometry 拆出所有折线（relation 的每条 member 是一条） */
function ringsOf(el) {
  const rings = []
  if (el.type === 'way') {
    const f = geomToFlat(el.geometry)
    if (f) rings.push(f)
    return rings
  }
  if (el.type === 'relation') {
    for (const m of el.members ?? []) {
      if (m.type !== 'way') continue
      const f = geomToFlat(m.geometry)
      if (f) rings.push(f)
    }
  }
  return rings
}

async function processCity(cityPath, force, pin) {
  const city = JSON.parse(await readFile(cityPath, 'utf8'))
  const outPath = join(OUT_DIR, `geo_${city.id}.js`)
  if (!force && existsSync(outPath)) {
    console.log(`  = ${city.id} 已有，跳过`)
    return
  }
  const bbox = cityBBox(city)
  if (!bbox) {
    console.log(`  - ${city.id} 无站点，跳过`)
    return
  }
  const g = gridOf(bbox)
  const proj = makeProjector(g, bbox)
  const tolDeg = SIMPLIFY_M / Math.min(mPerDegLon(g.lat0), M_PER_DEG_LAT)

  console.log(
    `  → ${city.id} ${city.name}: ${g.W}×${g.H} 格 × ${g.cellM} m = ` +
      `${((g.W * g.cellM) / 1000).toFixed(0)}×${((g.H * g.cellM) / 1000).toFixed(0)} km`,
  )
  const maxCls = maxRoadClassFor(g.cellM)
  const json = await fetchTiled(bbox, city.id, maxCls, pin)
  console.log(`     elements: ${json.elements.length}（道路等级 ≤ ${maxCls}）`)

  const names = new NameTable()
  const roads = []
  const water = []
  const parks = []
  const reserves = []
  const woods = []
  const rail = []
  const places = []
  const admin = []
  let points = 0

  // 经纬度扁平数组 → 格坐标扁平数组，并抽稀
  const toCells = (flat, tol = tolDeg) => {
    const out = []
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const [x, y] = proj(flat[i], flat[i + 1])
      out.push(x, y)
    }
    return simplify(out, tol)
  }

  for (const el of json.elements) {
    const tags = el.tags ?? {}

    if (el.type === 'node' && tags.place) {
      if (typeof el.lon === 'number' && typeof el.lat === 'number') {
        const [x, y] = proj(el.lon, el.lat)
        const lvl = tags.place === 'city' ? 4 : tags.place === 'town' ? 3 : tags.place === 'village' ? 1 : 2
        places.push([tags.name ?? '', +x.toFixed(2), +y.toFixed(2), lvl])
      }
      continue
    }

    if (tags.boundary === 'administrative' && el.type === 'relation') {
      const rings = ringsOf(el)
      if (!rings.length) continue
      const name = tags.name ?? ''
      if (!name) continue
      const row = [Number(tags.admin_level) || 6, names.idx(name)]
      for (const r of rings) {
        const c = toCells(r, tolDeg * 2)
        if (c.length < 6) continue
        row.push('o' + enc(c))
        points += c.length / 2
      }
      if (row.length > 2) admin.push(row)
      continue
    }

    if (el.type !== 'way') continue
    const flat = geomToFlat(el.geometry)
    if (!flat) continue

    if (tags.highway) {
      const cls = ROAD_CLASS[tags.highway]
      if (!cls) continue
      const name = tags.name ?? ''
      // 无名小路不画：画出来是无信息的噪声（折叠后 4 级 = 次干道及以下）
      if (!name && cls >= 4) continue
      const c = toCells(flat)
      if (c.length < 4) continue
      points += c.length / 2
      let flags = 0
      if (tags.bridge && tags.bridge !== 'no') flags |= 1
      if (tags.tunnel && tags.tunnel !== 'no') flags |= 2
      roads.push([names.idx(name), cls, flags, enc(c)])
      continue
    }
    if (tags.waterway) {
      const c = toCells(flat)
      if (c.length < 4) continue
      points += c.length / 2
      water.push([names.idx(tags.name ?? ''), 0.9, enc(c)])
      continue
    }
    if (tags.natural === 'water') {
      const c = toCells(flat)
      if (c.length < 6) continue
      points += c.length / 2
      water.push([names.idx(tags.name ?? ''), 'o' + enc(c)])
      continue
    }
    if (tags.leisure === 'park') {
      const c = toCells(flat)
      if (c.length < 6) continue
      points += c.length / 2
      parks.push([names.idx(tags.name ?? ''), 'o' + enc(c)])
      continue
    }
    if (tags.landuse === 'forest') {
      const c = toCells(flat)
      if (c.length < 6) continue
      points += c.length / 2
      woods.push([names.idx(tags.name ?? ''), 'o' + enc(c)])
      continue
    }
    if (tags.landuse === 'recreation_ground') {
      const c = toCells(flat)
      if (c.length < 6) continue
      points += c.length / 2
      reserves.push([names.idx(tags.name ?? ''), 'o' + enc(c)])
      continue
    }
    if (tags.railway) {
      const c = toCells(flat)
      if (c.length < 4) continue
      points += c.length / 2
      let flags = 0
      if (tags.tunnel && tags.tunnel !== 'no') flags |= 2
      if (tags.highspeed === 'yes') flags |= 16
      rail.push([names.idx(tags.name ?? ''), flags, enc(c)])
    }
  }

  let step = 1
  while (points / step > MAX_POINTS) step++
  if (step > 1) {
    console.log(`      顶点 ${points} 超限，按 1/${step} 抽稀`)
    for (const r of roads) r[3] = enc(decimate(dec(r[3]), step))
    for (const w of water) if (typeof w[1] === 'number') w[2] = enc(decimate(dec(w[2]), step))
    for (const p of parks) p[1] = 'o' + enc(decimate(dec(p[1], 1), step))
    for (const p of woods) p[1] = 'o' + enc(decimate(dec(p[1], 1), step))
    for (const p of reserves) p[1] = 'o' + enc(decimate(dec(p[1], 1), step))
  }

  const GEO = {
    proj: {
      lon0: +g.lon0.toFixed(5),
      lat0: +g.lat0.toFixed(5),
      kx: +g.kx.toFixed(3),
      ky: +g.ky.toFixed(3),
    },
    cellM: g.cellM,
    W: g.W,
    H: g.H,
    water,
    roads,
    streets: '',
    rail,
    parks,
    reserves,
    woods,
    admin,
    places,
    names: names.list,
  }

  const body =
    "'use strict';\n" +
    '// 由 OpenStreetMap 数据生成（© OpenStreetMap 贡献者，ODbL）。\n' +
    `// ${city.name}：${g.W}×${g.H} 格，每格 ${g.cellM} m，覆盖 ` +
    `${((g.W * g.cellM) / 1000).toFixed(1)}×${((g.H * g.cellM) / 1000).toFixed(1)} km。\n` +
    '// 折线为增量编码，1/64 格精度；解码器见 js/geo.js 的 Geo.dec。\n' +
    '(function (CM) {\n' +
    '  CM.MAP_GEO = CM.MAP_GEO || {};\n' +
    `  CM.MAP_GEO[${JSON.stringify(city.id)}] = ${JSON.stringify(GEO)};\n` +
    '})(window.CM);\n'

  await writeFile(outPath, body, 'utf8')
  const kb = (body.length / 1024).toFixed(0)
  console.log(
    `      道路 ${roads.length} / 水系 ${water.length} / 公园 ${parks.length} / 林地 ${woods.length} / ` +
      `铁路 ${rail.length} / 区界 ${admin.length} / 片区 ${places.length} → ${kb} KB`,
  )
}

function dec(s, from) {
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

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const args = process.argv.slice(2)
  const limitIdx = args.indexOf('--limit')
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity
  const cityIdx = args.indexOf('--city')
  const onlyCity = cityIdx >= 0 ? args[cityIdx + 1] : null
  const force = args.includes('--force')
  FORCE = force

  let files = (await readdir(CITY_DIR)).filter((f) => f.endsWith('.json') && f !== 'index.json')
  if (onlyCity) files = files.filter((f) => f === `${onlyCity}.json`)
  /*
   * 小城优先 —— 这个顺序是实测逼出来的，不是随手排的。
   *
   * 原设计「大城优先」的理由是「慢的先启动，整体墙钟更短」。实测推翻了它：
   * 北京 3×3 分块时中心块（1-1，天安门一带）单块要跑十几分钟甚至超时，
   * 而它一旦卡住，整个 worker 就堵在那里，后面 44 个只需一次请求的小城
   * 一个都发不出去 —— 20 分钟下来只推进了 8 块。
   *
   * 反过来先跑小城：单城 1 次请求、10~40 秒出结果，一小时能把 44 座城的地图
   * 全部落地，剩下的十来个百公里级大城再慢慢啃。玩家能先看到「54 城里 44 城
   * 已经能玩」，而不是「一张都没好」。
   */
  const sizes = new Map()
  for (const f of files) sizes.set(f, (await stat(join(CITY_DIR, f))).size)
  files.sort((a, b) => sizes.get(a) - sizes.get(b))

  // 并发度：Overpass 每个镜像对同一 IP 有独立配额。
  // 实测 3 并发 → 四个镜像两分钟内全部 429/502/504，之后连单请求都被拒（IP 级限流，
  // 换镜像也没用，因为配额是按 IP 算的）。所以默认单并发，用 --jobs 才手动放开。
  const jobsIdx = args.indexOf('--jobs')
  const jobs = jobsIdx >= 0 ? Math.max(1, Number(args[jobsIdx + 1]) || 1) : 1
  const queue = files.slice(0, Number.isFinite(limit) ? limit : files.length)
  let n = 0
  let cursor = 0

  async function worker(tag) {
    /*
     * 不再把每个 worker 钉到不同镜像上。
     *
     * 原设计假设「四个镜像都健康，各吃一份配额」。实测只有 osm.ch 可用，
     * 于是 worker 2 会被钉到 ENDPOINTS[1]（overpass-api.de，502），开局就白等一轮。
     * 现在统一从 0 号端点开始，坏镜像由 endpointCooldown 记住并排到最后，
     * 并发度靠 --jobs 控制，配额冲突靠限流退避处理。
     */
    void tag
    for (;;) {
      const i = cursor++
      if (i >= queue.length) return
      const f = queue[i]
      try {
        await processCity(join(CITY_DIR, f), force, null)
        n++
        console.log(`  [${n}/${queue.length}] 已完成`)
      } catch (err) {
        console.log(`  ✗ ${f}: ${err.message}`)
      }
      // 城与城之间停 2 秒：osm.ch 单块不到 1 秒，停太久纯属浪费墙钟时间；
      // 仍要停一下，避免连续大城把镜像的分钟级配额打满。
      await sleep(2000)
    }
  }

  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, (_, k) => worker(k + 1)))
  console.log(`完成 ${n} 城`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
