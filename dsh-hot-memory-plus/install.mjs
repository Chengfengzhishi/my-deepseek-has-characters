// install.mjs —— 把一个 DSH 插件装进某个 profile。幂等，随时可重跑。
//
// 放在插件目录下就能用：插件名从同目录的 package.json 读，脚本本身不用改。
//
// 干三件事：
//   1) 建 junction：<profile>/node_modules/<name>  ->  本目录
//      cordis 加载器只在 profile 的解析路径上找插件，所以必须有这个「落点在 profile 里」的入口。
//   2) 往 <profile>/cordis.patch.yml 写/更新 insert 行，name 用
//      './node_modules/<name>/index.js?v=<index.js 的 mtime>'
//      ESM 模块缓存按 URL 走 —— 所以**改完 index.js 重跑一次本脚本就会热加载**，不用重启 DSH。
//   3) 在 <profile>/package.json 的 dependencies 里声明 "link:<本目录>"
//      —— 不声明的话，哪天跑一次 pnpm install（比如 dsh plugin ... add）会把 junction 当垃圾清掉，
//         插件就凭空消失了。这一步是防这个的。
//
// 用法：
//   node install.mjs                装到 web profile
//   node install.mjs standard       装到别的 profile
//   node install.mjs --remove       卸载（三样一起撤）
//   node install.mjs --dry-run      只看会改什么，不落盘
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const remove = argv.includes('--remove')
const profile = argv.find((a) => !a.startsWith('-')) || 'web'

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法：node install.mjs [profile名] [--remove] [--dry-run]')
  console.log('  profile 默认 web。安装需要能写 <DSH_HOME>/profiles/<profile>。')
  process.exit(0)
}

const pluginPkgPath = path.join(HERE, 'package.json')
let pluginPkg = {}
try { pluginPkg = JSON.parse(fs.readFileSync(pluginPkgPath, 'utf8')) } catch { /* 下面会报 */ }
const NAME = String(pluginPkg.name || '').trim()
if (!NAME) {
  console.error('读不到插件名：本目录没有 package.json，或里面没有 name 字段。')
  process.exit(1)
}

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', profile)
const modulesDir = path.join(profileDir, 'node_modules')
const linkPath = path.join(modulesDir, NAME)
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const profilePkgPath = path.join(profileDir, 'package.json')

// 缓存键 = index.js 的 mtime。改了源码重跑一次就换键 → 热加载，不用记「把 v 加一位」。
function cacheKey() {
  try { return String(Math.floor(fs.statSync(path.join(HERE, 'index.js')).mtimeMs)) } catch { return String(Date.now()) }
}
const LINK_SPEC = 'link:' + HERE.replace(/\\/g, '/')
const REL_NAME = './node_modules/' + NAME + '/index.js?v=' + cacheKey()
const MARKER = '# ' + NAME + '（由它自己的 install.mjs 维护：junction + 这一行 + package.json 里的 link 依赖）'
const BLOCK = [
  '',
  MARKER,
  '# 源码只有一份，在 ' + HERE + '；profile 里的 ' + NAME + ' 是指向它的 junction。',
  '- insert:',
  '    - id: ' + NAME,
  "      name: '" + REL_NAME + "'",
  '',
].join('\n')

const said = []
function report(kind, text) { said.push('  [' + kind + '] ' + text) }
// 动别人的文件之前先留一份现场（每个文件每次运行最多备份一次）。
const backedUp = new Set()
function backup(file) {
  if (dryRun || backedUp.has(file)) return
  backedUp.add(file)
  try {
    if (!fs.existsSync(file)) return
    const copy = file + '.bak-' + NAME + '-' + Date.now()
    fs.copyFileSync(file, copy)
    report('+', '先备份：' + copy)
  } catch (error) { report('!', '备份失败（继续，但你要知道没备份）：' + error.message) }
}
function writeFile(file, text) {
  if (dryRun) return
  backup(file)
  // 原子写：先写临时文件再 rename 覆盖，**不要就地截断+写**。
  // 踩过的坑：就地 writeFileSync 有时不会让 DSH 的 cordis.patch.yml 监听器认为文件变了，
  // 于是插件热加载静默不生效 —— 你改了源码、以为生效了，跑的其实还是旧模块
  // （实测：同一份新内容用 edit 写进去会生效，用 writeFileSync 写进去不生效）。
  // rename 的事件是确定的，代价为零。
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

// ---------- 1) junction ----------
function installJunction() {
  if (!fs.existsSync(profileDir)) return false
  if (!dryRun) fs.mkdirSync(modulesDir, { recursive: true })
  if (fs.existsSync(linkPath)) {
    let target = ''
    try { target = String(fs.readlinkSync(linkPath)) } catch { target = '(不是链接，是个真目录)' }
    if (target === HERE) { report('=', 'junction 已就位：' + linkPath); return true }
    report('!', linkPath + ' 已存在，指向 ' + target + ' —— 没有动它。要换成当前目录请先手动删掉。')
    return false
  }
  if (!dryRun) fs.symlinkSync(HERE, linkPath, 'junction')
  report('+', '建 junction：' + linkPath + '  ->  ' + HERE)
  return true
}
function removeJunction() {
  if (!fs.existsSync(linkPath)) { report('=', 'junction 本来就不在'); return }
  if (!dryRun) { try { fs.unlinkSync(linkPath) } catch (error) { report('!', '删 junction 失败（手动删也行）：' + error.message); return } }
  report('-', '删掉 junction：' + linkPath)
}

// ---------- 2) cordis.patch.yml ----------
function upsertPatchRow() {
  const raw = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
  const lines = raw.split(/\r?\n/)
  let idLine = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '- id: ' + NAME) { idLine = i; break }
  }
  if (idLine === -1) {
    // 走同一套原子写（就地 append 同样有「监听器可能不认」的问题）
    writeFile(patchPath, raw + BLOCK)
    report('+', '往 cordis.patch.yml 追加一段 insert（id: ' + NAME + '）')
    return
  }
  // 已有这一段：只更新它下面的 name 行（保持缩进），不影响别的插入项。
  for (let i = idLine + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*-\s*id:/.test(line) || /^- insert:/.test(line)) break
    if (/^\s*name:\s/.test(line)) {
      const next = line.replace(/^(\s*)name:.*$/, "$1name: '" + REL_NAME + "'")
      if (next === line) { report('=', 'cordis.patch.yml 的 name 行已经是最新的'); return }
      lines[i] = next
      writeFile(patchPath, lines.join('\n'))
      report('~', '更新 cordis.patch.yml 里的 name（换成新的缓存键 → 会热加载）')
      return
    }
  }
  report('!', '找到了 id: ' + NAME + ' 但没找到它的 name 行，没敢乱改 —— 请看 ' + patchPath)
}
function removePatchRow() {
  let raw = ''
  try { raw = fs.readFileSync(patchPath, 'utf8') } catch { report('=', 'cordis.patch.yml 不在'); return }
  if (!raw.includes('- id: ' + NAME)) { report('=', 'cordis.patch.yml 里本来就没有 ' + NAME); return }
  const lines = raw.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    // 从 MARKER 注释行起，连续吃掉：注释行 / 空行 / "- insert:" / "- id: <自己>" / "name:" 一行
    if (lines[i].trim() === MARKER) {
      let j = i + 1
      while (j < lines.length) {
        const line = lines[j]
        if (line.trim() === '' || line.trim().startsWith('#')) { j += 1; continue }
        if (line.trim() === '- insert:') { j += 1; continue }
        if (line.trim() === '- id: ' + NAME) { j += 1; continue }
        if (/^\s*name:/.test(line)) { j += 1; break }
        break
      }
      i = j - 1
      continue
    }
    out.push(lines[i])
  }
  let next = out.join('\n')
  if (next.includes('- id: ' + NAME)) {
    // 兜底（MARKER 注释被人改过时）：按 "- insert: + id 行 + 可选注释 + name 行" 整段摘掉。
    // 小心：否定字符类里写 [^\r?\n] 会把问号也排除掉（? 在类里是字面量），
    // 于是含 "?v=" 的 name 行会被截断、留下半行残渣 —— 这个坑真踩过。用 [^\n]。
    next = next.replace(new RegExp('- insert:\\s*\\r?\\n\\s*- id: ' + NAME + '[^\\n]*\\r?\\n(?:\\s*#[^\\n]*\\r?\\n)*\\s*name:[^\\n]*\\r?\\n?'), '')
  }
  next = next.replace(/\n{3,}/g, '\n\n')
  writeFile(patchPath, next)
  report('-', '从 cordis.patch.yml 摘掉 ' + NAME + ' 那一段')
}

// ---------- 3) profile package.json 的 link 依赖 ----------
function readProfilePkg() {
  try { return JSON.parse(fs.readFileSync(profilePkgPath, 'utf8')) } catch { return null }
}
function upsertDep() {
  const data = readProfilePkg()
  if (!data) { report('!', '读不到 ' + profilePkgPath + '，跳过依赖声明（这一步是防 pnpm 清掉 junction 的）'); return }
  const deps = Object.assign({}, data.dependencies || {})
  if (deps[NAME] === LINK_SPEC) { report('=', 'package.json 里已经声明了 ' + NAME + ' 的 link 依赖'); return }
  deps[NAME] = LINK_SPEC
  data.dependencies = Object.fromEntries(Object.keys(deps).sort().map((key) => [key, deps[key]]))
  writeFile(profilePkgPath, JSON.stringify(data, null, 2) + '\n')
  report('+', '在 profile 的 package.json 里声明 "link:' + HERE.replace(/\\/g, '/') + '"（防 pnpm install 清掉它）')
}
function removeDep() {
  const data = readProfilePkg()
  if (!data || !data.dependencies || !(NAME in data.dependencies)) { report('=', 'package.json 里本来就没声明 ' + NAME); return }
  delete data.dependencies[NAME]
  writeFile(profilePkgPath, JSON.stringify(data, null, 2) + '\n')
  report('-', '从 profile 的 package.json 里摘掉 ' + NAME + ' 依赖')
}

// ---------- 汇总 ----------
function verify() {
  const entryOk = fs.existsSync(path.join(linkPath, 'index.js'))
  const rowOk = (() => { try { return fs.readFileSync(patchPath, 'utf8').includes('- id: ' + NAME) } catch { return false } })()
  const dep = (readProfilePkg() || {}).dependencies || {}
  console.log('')
  console.log('  插件入口可读：' + (entryOk ? '是' : '否') + '   ' + path.join(linkPath, 'index.js'))
  console.log('  patch 里有它：' + (rowOk ? '是' : '否') + '   ' + REL_NAME)
  console.log('  已声明 link 依赖：' + (dep[NAME] === LINK_SPEC ? '是' : (dep[NAME] || '否')))
  console.log('  cordis 热监听 cordis.patch.yml：改完 index.js 重跑本脚本即可热加载；看不到就重启一次 DSH。')
  if (!entryOk || !rowOk) process.exitCode = 1
}

console.log((dryRun ? '== 演练（不落盘）' : remove ? '== 卸载' : '== 安装') + ' ' + NAME + ' ==')
console.log('  profile：' + profileDir)
console.log('  源码：' + HERE)
try {
  if (remove) { removeJunction(); removePatchRow(); removeDep() }
  else { installJunction(); upsertPatchRow(); upsertDep() }
  for (const line of said) console.log(line)
  if (!dryRun) verify()
} catch (error) {
  console.error('')
  console.error('  失败：' + (error && error.message ? error.message : error))
  console.error('  如果报「访问被拒绝 / EACCES / EPERM」：profile 目录在工作区之外，')
  console.error('  DSH 会话里跑要给这条命令提权，或者直接在 DSH 外面双击本目录的 .cmd。')
  process.exitCode = 1
}