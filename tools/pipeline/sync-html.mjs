// 一次性/可重跑脚本：把 index.html 里的「地图脚本区」重建成当前 js/ 目录的真实内容。
//
// 为什么需要它：54 座城市的底图与数据各是一个 <script>，手写 108 行必然漏、必然顺序错。
// 依赖顺序是硬的：
//   1) 所有 geo_<id>.js —— 只往 CM.MAP_GEO 挂数据，无依赖
//   2) geo.js           —— 定义 CM.Geo（enc/dec/init），data_*.js 里的 enc 要用它
//   3) 所有 data_*.js   —— 往 CM.MAP_LIST 里 push 地图
//   4) maps.js          —— 读取 CM.MAP_LIST 与 CM.MAP_GEO 建立 CM.MAPS
// 所以这里按「geo_* → geo → data_* → maps」四段拼，maps.js 保持在最后。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const HTML = 'index.html'
const BEGIN = '  <!-- BEGIN MAP SCRIPTS（由 tools/pipeline/sync-html.mjs 生成，勿手改） -->'
const END = '  <!-- END MAP SCRIPTS -->'

const files = readdirSync('js')
const geoFiles = files.filter((f) => /^geo_.*\.js$/.test(f)).sort()
const dataFiles = files.filter((f) => /^data_.*\.js$/.test(f)).sort()

if (!geoFiles.length) {
  console.error('没有找到 geo_*.js，先跑 fetch-geo.mjs')
  process.exit(1)
}

const line = (f) => `  <script src="js/${f}"></script>`
const block = [
  BEGIN,
  ...geoFiles.map(line),
  line('geo.js'),
  ...dataFiles.map(line),
  line('maps.js'),
  END,
].join('\n')

let html = readFileSync(HTML, 'utf8')

if (html.includes(BEGIN) && html.includes(END)) {
  const a = html.indexOf(BEGIN)
  const b = html.indexOf(END) + END.length
  html = html.slice(0, a) + block + html.slice(b)
} else {
  // 首次：把从 geo_gz.js 起、到 maps.js 止的那一段整体替换成标记块
  const re = /\n {2}<script src="js\/geo_gz\.js"><\/script>[\s\S]*?<script src="js\/maps\.js"><\/script>/
  if (!re.test(html)) {
    console.error('index.html 里找不到地图脚本段（geo_gz.js … maps.js）')
    process.exit(1)
  }
  html = html.replace(re, '\n' + block)
}

writeFileSync(HTML, html)
console.log(`geo ${geoFiles.length} 个 / data ${dataFiles.length} 个 → ${HTML}`)

/*
 * 缺底图的检查要跳过两类文件，否则每次跑都会报两条假警报：
 *  - data_cities.js：这是 54 城聚合文件，不是城市 id，没有也不需要 geo_cities.js
 *  - data_tutorial.js：教程城青湾是虚构地图，底图直接内联在自己的 data 里
 */
const AGGREGATE = new Set(['cities', 'tutorial'])
const missing = dataFiles
  .map((f) => f.replace(/^data_/, '').replace(/\.js$/, ''))
  .filter((id) => !AGGREGATE.has(id) && !geoFiles.includes(`geo_${id}.js`))
console.log('  缺底图的城市：' + (missing.length ? missing.join(', ') : '（无）'))
