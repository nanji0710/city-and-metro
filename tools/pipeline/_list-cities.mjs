// 把 data_cities.js 里注册的城市 id 全部列出来。
// 为什么要单独一个脚本：PowerShell 会把 node -e 里的正则当自己的语法解析并报一堆语法错，
// 所以凡是带正则的一次性分析一律写成文件。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(ROOT, 'js', 'data_cities.js'), 'utf8')
const ids = []
const re = /^\s{4}id:\s*"([a-z]+)"/gm
let m
while ((m = re.exec(src)) !== null) ids.push(m[1])

const order = /CM\.MAP_ORDER\s*=\s*(\[[^\]]*\])/.exec(src)
console.log('cities=' + ids.length)
console.log(ids.join(' '))
if (order) console.log('MAP_ORDER in data: ' + order[1])
