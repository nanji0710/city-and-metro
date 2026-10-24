/**
 * 探针：找可用的 Overpass 镜像，且必须**真的返回中国数据**。
 *
 * 用法：node tools/pipeline/_probe-mirror.mjs
 *
 * 教训（2026-10-24）：上一版探针只判断响应里有没有 "elements" 字样，
 * 而空结果同样长这样：{"elements": []}。于是把瑞士区域镜像 overpass.osm.ch
 * 判成了「可用」，实际它对中国查询一律返回空 —— 白跑了一整轮抓取。
 * 现在用 `out count;` 并校验 count 节点里的 ways 数 > 0。
 */
const Q =
  '[out:json][timeout:60];way[highway~"^(primary|secondary|tertiary)$"](34.60,112.32,34.70,112.50);out count;'

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.osm.nalis.io/api/interpreter',
]

/** 从 out count 的响应里取 ways 数量；拿不到就返回 -1 */
function waysCount(txt) {
  try {
    const j = JSON.parse(txt)
    const tags = j.elements && j.elements[0] && j.elements[0].tags
    if (tags && tags.ways != null) return Number(tags.ways)
    return -1
  } catch {
    return -1
  }
}

const t0 = Date.now()
const results = await Promise.all(
  MIRRORS.map(async (ep) => {
    const t = Date.now()
    try {
      const r = await fetch(ep, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(Q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'city-and-metro/2.1' },
        signal: AbortSignal.timeout(45000),
      })
      const txt = await r.text()
      const ways = waysCount(txt)
      return {
        ep,
        ok: r.status === 200 && ways > 0,
        status: r.status,
        sec: ((Date.now() - t) / 1000).toFixed(1),
        ways,
        head: txt.slice(0, 70).replace(/\s+/g, ' '),
      }
    } catch (e) {
      return { ep, ok: false, status: 0, sec: ((Date.now() - t) / 1000).toFixed(1), ways: -1, head: 'ERR ' + e.message.slice(0, 50) }
    }
  })
)

results.sort((a, b) => Number(b.ok) - Number(a.ok) || Number(a.sec) - Number(b.sec))
for (const r of results) {
  console.log(
    (r.ok ? '✅' : '❌'),
    r.ep.split('/')[2].padEnd(32),
    String(r.status).padEnd(4),
    r.sec.padStart(6) + 's',
    'ways=' + String(r.ways).padStart(5),
    r.head,
  )
}
const good = results.filter((r) => r.ok)
console.log('总耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's', '｜可用镜像', good.length)
if (good.length) console.log('建议 ENDPOINTS 首位：', good[0].ep)
