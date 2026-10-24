/**
 * 探针：打印 js/data_cities.js 里每个城市的 id / 规模 / 初始镜头，
 * 用来确认 build-data.mjs 生成的 cam 是否合理（对准线网、zoom 落在可用区间）。
 *
 * 用法：node tools/pipeline/_inspect-data.mjs
 *
 * 为什么写成文件而不是 node -e：PowerShell 会把内联脚本里的正则
 * （尤其含 [ ] ( ) 的）当成自己的语法解析，报一堆「缺少 ]」的错。
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const src = readFileSync('js/data_cities.js', 'utf8')
const sandbox = { window: {} }
sandbox.window.CM = { MAP_LIST: [] }
createContext(sandbox)
runInContext(src, sandbox)

const list = sandbox.window.CM.MAP_LIST || []
console.log('城市数', list.length)
console.log('id'.padEnd(12), 'W×H'.padEnd(10), 'cam')
for (const m of list) {
  const c = m.cam || {}
  const cam = c.cx == null ? '（缺）' : `cx=${c.cx} cy=${c.cy} zoom=${c.zoom}`
  console.log(String(m.id).padEnd(12), `${m.cfg.W}×${m.cfg.H}`.padEnd(10), cam)
}

const zooms = list.map((m) => (m.cam || {}).zoom).filter((z) => typeof z === 'number')
if (zooms.length) {
  const min = Math.min(...zooms)
  const max = Math.max(...zooms)
  const avg = zooms.reduce((a, b) => a + b, 0) / zooms.length
  console.log(`\nzoom 区间 ${min.toFixed(1)} ~ ${max.toFixed(1)}，均值 ${avg.toFixed(1)}`)
  const atFloor = zooms.filter((z) => z <= 6.01).length
  if (atFloor) console.log(`⚠ ${atFloor} 个城市 zoom 撞到下限 6（跨度过大，可能线网铺满整图）`)
}
