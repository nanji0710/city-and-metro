/* 生成全国战略地图数据：简化省界 + 54 城经纬度。
 * 这是战略层数据，不包含任何城市本地 OSM 底图。
 * 输入：tools/src/china_provinces.json（阿里 DataV 省级 GeoJSON）
 *       tools/src/cities/<id>.json（54 城中心经纬度）
 * 输出：js/data_china.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RAW = path.join(ROOT, 'tools', 'src', 'china_provinces.json')
const CITY_DIR = path.join(ROOT, 'tools', 'src', 'cities')
const OUT = path.join(ROOT, 'js', 'data_china.js')

if (!fs.existsSync(RAW)) {
  console.error('缺少 tools/_china_raw.json')
  process.exit(1)
}

// Ramer–Douglas–Peucker，按经纬度平面简化；战略图不需要街道级细节。
function rdp(points, eps) {
  if (points.length <= 4) return points
  const sq = eps * eps
  let maxD = 0, idx = 0
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1]
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i]
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const qx = ax + dx * t, qy = ay + dy * t
    const d = (px - qx) ** 2 + (py - qy) ** 2
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD <= sq) return [points[0], points[points.length - 1]]
  const left = rdp(points.slice(0, idx + 1), eps)
  const right = rdp(points.slice(idx), eps)
  return left.slice(0, -1).concat(right)
}

function cleanRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null
  // 去重相邻点；关闭环由绘制代码自己闭合
  const out = []
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue
    const q = [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]
    if (!out.length || out[out.length - 1][0] !== q[0] || out[out.length - 1][1] !== q[1]) out.push(q)
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop()
  if (out.length < 3) return null
  const simp = rdp(out, 0.035)
  return simp.length >= 3 ? simp : out
}

const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'))
const provinces = []
for (const f of raw.features || []) {
  const name = (f.properties && f.properties.name) || ''
  const g = f.geometry || {}
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
  const rings = []
  for (const poly of polys) {
    if (!Array.isArray(poly)) continue
    // 外环取 [0]；内环暂不填，战略层只要轮廓
    const ring = cleanRing(poly[0])
    if (ring) rings.push(ring)
  }
  if (rings.length) {
    provinces.push({
      name: name.replace(/(省|市|自治区|特别行政区|壮族|回族|维吾尔|藏族)/g, '').trim() || name,
      center: f.properties && f.properties.center || null,
      rings,
    })
  }
}

const cities = []
for (const file of fs.readdirSync(CITY_DIR).sort()) {
  if (!file.endsWith('.json')) continue
  const id = file.replace(/\.json$/, '')
  const c = JSON.parse(fs.readFileSync(path.join(CITY_DIR, file), 'utf8'))
  const center = c.center || (c.stats && c.stats.center)
  if (!center || center.length < 2) continue
  cities.push({
    id,
    name: c.name || id,
    province: c.province || '',
    lon: Math.round(center[0] * 10000) / 10000,
    lat: Math.round(center[1] * 10000) / 10000,
  })
}

const payload = {
  v: 1,
  source: 'DataV province boundaries + city centers from tools/src/cities',
  bounds: [73, 18, 135, 54],
  cities,
  provinces,
}
const body = "'use strict';\n// 由 tools/pipeline/build-atlas.mjs 生成；不要手改。\n(function (CM) {\n  CM.CHINA_ATLAS = " +
  JSON.stringify(payload) + ';\n})(window.CM);\n'
fs.writeFileSync(OUT, body, 'utf8')
console.log(`写入 ${OUT}：${cities.length} 城 / ${provinces.length} 省级区 / ${Math.round(body.length / 1024)} KB`)
