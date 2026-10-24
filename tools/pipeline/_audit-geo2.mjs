// 列出每城的 cellM 与当前抓到的道路等级分布，找出「被裁得太狠」的城市。
//
// 背景：fetch-geo.mjs 会按 cellM 裁剪道路等级以控制抓取耗时。
// 但实测发现 cellM>900 的城市（上海/成都/南京…）被裁到只剩 motorway+trunk，
// 底图上几乎看不到街道，和「真实城市底图」这个卖点直接冲突。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const ROOT = process.cwd()
const dir = join(ROOT, 'js')
const files = readdirSync(dir).filter((f) => /^geo_.*\.js$/.test(f)).sort()

const rows = []
for (const f of files) {
  const id = f.replace(/^geo_/, '').replace(/\.js$/, '')
  const src = readFileSync(join(dir, f), 'utf8')
  const CM = {}
  vm.runInNewContext(src, { window: { CM }, CM, console })
  const g = (CM.MAP_GEO || {})[id] || CM.GEO
  if (!g || !g.cellM) continue // 官方五图（gz/hz/hk/tk/tp）格式不同，跳过
  const cls = {}
  for (const r of g.roads || []) cls[r[1]] = (cls[r[1]] || 0) + 1
  rows.push({ id, cellM: g.cellM, W: g.W, H: g.H, roads: (g.roads || []).length, cls })
}

rows.sort((a, b) => b.cellM - a.cellM)
console.log('cellM  W×H       roads  cls2  cls3  cls4')
for (const r of rows) {
  const flag = !r.cls['4'] && !r.cls['3'] ? '  ← 只剩快速路' : ''
  console.log(
    String(r.cellM).padStart(5),
    `${String(r.W).padStart(3)}x${String(r.H).padEnd(3)}`,
    String(r.roads).padStart(6),
    String(r.cls['2'] || 0).padStart(5),
    String(r.cls['3'] || 0).padStart(5),
    String(r.cls['4'] || 0).padStart(5),
    r.id + flag
  )
}

// 判据只看「有没有主干道（cls3）」。cls4（支路）是按 cellM 有意裁剪的：
// maxRoadClassFor 对 cellM>900 的城市返回 3，本来就不该有 cls4，
// 用「缺 cls4」当缺陷会把设计意图误报成 bug（上一版就误报了 17 城）。
const sparse = rows.filter((r) => !r.cls['3'])
console.log('\n只剩快速路的城市（' + sparse.length + '）：' + (sparse.length ? sparse.map((r) => r.id).join(', ') : '（无）'))
