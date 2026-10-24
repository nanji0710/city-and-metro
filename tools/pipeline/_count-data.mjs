// 统计 data_cities.js 里注册了多少城、有没有缺大城。
// 写成文件而不是 node -e，因为 PowerShell 会把内联正则里的括号当成自己的语法。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const s = readFileSync(join(ROOT, 'js', 'data_cities.js'), 'utf8')
const ids = [...s.matchAll(/^\s*id: "([a-z0-9_]+)"/gm)].map((m) => m[1])
console.log('data_cities 城数:', ids.length)

const target = JSON.parse(readFileSync(join(ROOT, 'tools', 'src', 'index.json'), 'utf8')).map((c) => c.id)
const missing = target.filter((id) => !ids.includes(id))
console.log('目标城数:', target.length)
console.log('缺失:', missing.length ? missing.join(', ') : '无')
