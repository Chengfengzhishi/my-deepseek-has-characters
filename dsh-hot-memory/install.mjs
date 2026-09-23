// install.mjs —— 把 dsh-hot-memory 装进某个 DSH profile。幂等，随时可重跑。
//
// 与 dsh-model-router/install.mjs 同一套做法（junction + patch 行 + package.json link 依赖），
// 但**有一处故意的差别**：
//   本机 2026-09-17 出过血案 —— 用脚本整文件重写 cordis.patch.yml，注释吞掉换行，
//   插件树加载失败，DSH 停在「安全带」页，一天重启 5 次。
//   所以这里**绝不动 cordis.patch.yml 的内容**：
//     · 只做一份 byte-exact 备份（copyFileSync）；
//     · 要加的那一段用标记打印出来，由人/AI 用 edit 工具做字面替换写进去；
//     · --check 用 js-yaml 真解析，断言每个 insert entry 的 name 是非空字符串；
//       断言不过 → 自动从备份回滚（恢复 patch + 摘 junction + 恢复 package.json）。
//
// 干这些事：
//   1) 建 junction：<profile>/node_modules/dsh-hot-memory -> 本目录
//   2) 备份 <profile>/cordis.patch.yml 与 <profile>/package.json（byte-exact），
//      记录路径到本目录 .install-state.json（回滚要用）
//   3) 在 <profile>/package.json 的 dependencies 里声明 "link:<本目录>"
//   4) 打印要写进 cordis.patch.yml 的那一段（--check 时做 YAML 断言）
//
// 用法：
//   node install.mjs                装到 web profile（不动 patch 内容，只打印待插入段）
//   node install.mjs --check        断言 patch / junction / 依赖 都在位（不过就自动回滚）
//   node install.mjs --write-patch  直接把本插件那一段写进 patch（发给别人时的零输入路径）
//                                   安全：写前 byte-exact 备份 → 写后 YAML 真解析 → 不过就回滚
//   node install.mjs --remove       一步回滚（恢复 patch 备份 + 摘 junction + 恢复 package.json）
//   node install.mjs --dry-run      只看会改什么
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const remove = argv.includes('--remove')
const checkOnly = argv.includes('--check')
// ★ R32（出厂化）：--write-patch = 直接把本插件那一段写进 cordis.patch.yml（发给别人时用）。
//   为什么原来不写：本机 2026-09-17 用脚本整文件重写 patch，注释吞掉换行，插件树加载失败，DSH 停在安全带页。
//   所以这条路必须带着三层保险：写前 byte-exact 备份 → 写后 YAML 真解析断言 → 断言不过立刻回滚。
//   发给别人时没人能"用 edit 工具手工插入"，所以这一步必须自动化。
const writePatchFlag = argv.includes('--write-patch')
// 位置参数（不以 - 开头）= profile 名，默认 web
const profile = argv.find((a) => !a.startsWith('-')) || 'web'

const pluginPkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
const NAME = String(pluginPkg.name || '').trim()
if (!NAME) { console.error('读不到插件名：本目录没有 package.json 或里面没有 name'); process.exit(1) }

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', profile)
const modulesDir = path.join(profileDir, 'node_modules')
const linkPath = path.join(modulesDir, NAME)
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const profilePkgPath = path.join(profileDir, 'package.json')
// ★ R32 修复（2026-09-22，沙箱实测抓到的会坑人的 bug）：
//   原先状态文件是【每个插件目录一个】.install-state.json，不区分 profile。
//   实测后果：在 profile A 装过之后，再往 profile B 装，读到的却是 A 的状态 ⇒
//     ① 以为"已经有备份了"，于是【不给 B 建备份】就直接写 B 的 patch；
//     ② 在 B 上卸载时，拿 A 的旧备份去覆盖 B 的 patch（实测把 132B 的 patch 写成 3350B 的别人家内容）。
//   改成按 profile 分开，并且不信任何 profile 对不上的状态。
const statePath = path.join(HERE, '.install-state.' + profile + '.json')
const legacyStatePath = path.join(HERE, '.install-state.json')
const LINK_SPEC = 'link:' + HERE.replace(/\\/g, '/')

// ★ 2026-09-22 修复（干净环境实测抓到的、会让对方"装完打不开"的 bug）：
//   0.1.1 时代这里写的是 './node_modules/<名>/index.js?v=<mtime>' —— 用 ?v= 做 HMR 缓存击穿。
//   但 0.1.5 的 ESM 解析把 ?v= 当成【文件名的一部分】，加载器于是去找一个叫
//   "index.js?v=1790087820071" 的文件 —— 找不到。轻则插件挂不上（工具凭空消失、不报错），
//   重则整个 DSH 起不来，而且错误里【不提是哪个插件】。
//   ⇒ 0.1.5 起 name 必须是干净的路径；改完插件重启 DSH，别再指望 ?v= 热加载。
const REL_NAME = './node_modules/' + NAME + '/index.js'
const MARKER = '# ' + NAME + '（由它自己的 install.mjs 维护：junction + 这一行 + package.json 里的 link 依赖）'
const BLOCK = [
  '',
  MARKER,
  '# 源码只有一份，在 ' + HERE + '；profile 里的 ' + NAME + ' 是指向它的 junction。',
  '# 阶段 1：每轮结束把本轮对话蒸馏进 <DSH_HOME>/hot-memory/<sessionId>.md，下一轮只注入一行指针。',
  '- insert:',
  '    - id: ' + NAME,
  "      name: '" + REL_NAME + "'",
  '      # testHooks 打开才有 /hot-memory/drive 自测驱动（验收用）；平时建议改成 false。',
  '      config:',
  '        testHooks: true',
  '',
].join('\n')

// 出厂版写入内容：config 里【不写死】provider/model —— 留空 = 在对方机器上自动探测。
function patchBlockForWrite() {
  return [
    '',
    MARKER,
    '# 源码只有一份，在 ' + HERE + '；profile 里的 ' + NAME + ' 是指向它的 junction。',
    '# 每轮结束把本轮对话蒸馏进 <DSH_HOME>/hot-memory/<sessionId>.md，下一轮只注入一行指针。',
    '- insert:',
    '    - id: ' + NAME,
    "      name: '" + REL_NAME + "'",
    '      config:',
    '        testHooks: false',
    '',
  ].join('\n')
}
// 写 patch。三层保险见上面注释。返回 true/false。
function writePatch() {
  let raw = ''
  try { raw = fs.readFileSync(patchPath, 'utf8') } catch (error) { report('!', '读不到 patch：' + error.message); return false }
  const hasId = raw.includes('- id: ' + NAME)
  let next = raw
  if (hasId) {
    const line = liveNameLine(patchPath)
    if (!line) { report('!', 'patch 里有 id: ' + NAME + ' 但那一段读不到 name 行 —— 未改动'); return false }
    const want = "      name: '" + REL_NAME + "'"
    if (line.trim() === want.trim()) { report('=', 'patch 里的缓存键已经是最新的，未改动'); return true }
    next = raw.replace(line, want)
  } else {
    next = raw.replace(/[\s\n]*$/, '\n') + patchBlockForWrite()
  }
  if (dryRun) { report('~', '--dry-run：不写 patch（本来会写 ' + (hasId ? '缓存键' : '新增那一段') + '）'); return true }
  let state = readState()
  if (!state) state = {}
  // ★ 没有本 profile 的备份就当场补一个 —— 绝不允许"无备份直接写别人的 patch"。
  if (!state.patchBackup) {
    const b = backupOnce(patchPath, NAME + '-prewrite')
    if (!b) { report('!', '建不了 patch 备份（文件不存在？）—— 为安全起见不写'); return false }
    state.patchBackup = b
    state.plugin = NAME
    state.profile = profile
    state.profileDir = profileDir
    saveState(state)
  }
  fs.writeFileSync(patchPath, next, 'utf8')
  const v = assertPatch(patchPath)
  if (!v.ok) {
    report('!', '写完 YAML 断言不过（' + v.why + '）⇒ 立刻从备份回滚')
    restore(state.patchBackup, patchPath)
    const after = assertPatch(patchPath)
    report('~', '回滚后断言：' + (after.ok ? '通过（' + after.entries + ' 条 entry）' : '仍不通过：' + after.why))
    return false
  }
  report('+', (hasId ? '已更新 patch 里的缓存键' : '已把本插件那一段写进 patch') + '（YAML 断言通过，' + v.entries + ' 条 entry）')
  return true
}

const said = []
const report = (kind, text) => said.push('  [' + kind + '] ' + text)

function readState() {
  try {
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (st && st.profile && st.profile !== profile) return null   // 不是本 profile 的状态，一律不认
    return st
  } catch { return null }
}
// 老版本留下的全局状态文件：只警告，绝不拿来用（它可能是别的 profile 的）。
function warnLegacyState() {
  if (fs.existsSync(legacyStatePath)) {
    report('!', '发现旧版全局状态文件 ' + legacyStatePath + '（不区分 profile，可能是别处的）—— 本脚本不读它，可自行删除')
  }
}
function saveState(state) { if (!dryRun) fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8') }

// 原子写（别人的文件也一样：先写临时文件再 rename，绝不就地截断）
function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}
function backupOnce(file, tag) {
  if (dryRun || !fs.existsSync(file)) return null
  const copy = file + '.bak-' + tag + '-' + Date.now()
  fs.copyFileSync(file, copy)
  report('+', '先备份：' + copy)
  return copy
}

// ===== 1) junction =====
function installJunction() {
  if (!fs.existsSync(profileDir)) { report('!', 'profile 目录不存在：' + profileDir); return false }
  if (!dryRun) fs.mkdirSync(modulesDir, { recursive: true })
  if (fs.existsSync(linkPath)) {
    let target = ''
    try { target = String(fs.readlinkSync(linkPath)) } catch { target = '(不是链接，是个真目录)' }
    if (path.resolve(target) === path.resolve(HERE)) { report('=', 'junction 已就位：' + linkPath); return true }
    report('!', linkPath + ' 已存在，指向 ' + target + ' —— 没动它。要换成当前目录请先手动删掉。')
    return false
  }
  if (!dryRun) fs.symlinkSync(HERE, linkPath, 'junction')
  report('+', '建 junction：' + linkPath + '  ->  ' + HERE)
  return true
}
function removeJunction() {
  if (!fs.existsSync(linkPath)) { report('=', 'junction 本来就不在'); return }
  try { if (!dryRun) fs.unlinkSync(linkPath); report('-', '删掉 junction：' + linkPath) }
  catch (error) { report('!', '删 junction 失败（手动删也行）：' + error.message) }
}

// ===== 2) profile package.json 的 link 依赖 =====
function readProfilePkg() { try { return JSON.parse(fs.readFileSync(profilePkgPath, 'utf8')) } catch { return null } }
function upsertDep() {
  const data = readProfilePkg()
  if (!data) { report('!', '读不到 ' + profilePkgPath + '，跳过依赖声明'); return null }
  const deps = Object.assign({}, data.dependencies || {})
  if (deps[NAME] === LINK_SPEC) { report('=', 'package.json 里已经声明了 ' + NAME + ' 的 link 依赖'); return null }
  const backup = backupOnce(profilePkgPath, NAME)
  deps[NAME] = LINK_SPEC
  data.dependencies = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]))
  if (!dryRun) writeAtomic(profilePkgPath, JSON.stringify(data, null, 2) + '\n')
  report('+', '在 profile 的 package.json 里声明 "' + LINK_SPEC + '"（防 pnpm install 清掉 junction）')
  return backup
}
function removeDep() {
  const data = readProfilePkg()
  if (!data || !data.dependencies || !(NAME in data.dependencies)) { report('=', 'package.json 里本来就没声明 ' + NAME); return }
  delete data.dependencies[NAME]
  if (!dryRun) writeAtomic(profilePkgPath, JSON.stringify(data, null, 2) + '\n')
  report('-', '从 profile 的 package.json 里摘掉 ' + NAME + ' 依赖')
}

// ===== 3) YAML 断言（真解析，不靠正则）=====
// ★ R32（出厂化）：js-yaml 在别人机器上不一定解析得到。
//   实测：在一个干净的 profile 上（没有 node_modules）整个安装会因为
//   "Cannot find module 'js-yaml'" 而失败并回滚 —— 安全网是好的，但爹装不上。
//   js-yaml 只是更强的校验手段，不该成为装不上的原因。所以：
//     先试几个位置拿 js-yaml（真解析）；都拿不到就退回内置的"够用"检查，并明确告警。
let usedFallbackYaml = false
function builtinYamlLoad(text) {
  // 只做"够用"的结构检查。判据（比真解析弱，但抓的是真正会出事的两种）：
  //   ① 每条 insert 条目必须有非空 name（空 name 会让插件树加载失败）
  //   ② - insert: 必须至少带一条条目
  // 归属规则：name: 归给"当前最近的那个还没名字的对象"（先 insert 条目，再顶层条目）——
  //   我第一版按缩进猜，结果把顶层条目的 name 当成了非法写法，整份解析直接失败。
  const lines = String(text).split(/\r?\n/)
  const out = []
  let cur = null, curEntry = null
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const l = raw.replace(/\s+$/, '')
    if (!l.trim() || /^\s*#/.test(l)) continue
    if (/^-\s*insert:\s*$/.test(l)) { cur = { insert: [] }; out.push(cur); curEntry = null; continue }
    const mTop = /^-\s*id:\s*(.+?)\s*$/.exec(l)
    if (mTop) { cur = { id: mTop[1] }; out.push(cur); curEntry = null; continue }
    const mEntry = /^\s+-\s*id:\s*(.+?)\s*$/.exec(l)
    if (mEntry) {
      if (!cur || !cur.insert) throw new Error('第 ' + (i + 1) + ' 行：insert 条目出现在 insert: 之外')
      curEntry = { id: mEntry[1], name: '' }
      cur.insert.push(curEntry)
      continue
    }
    const mName = /^\s*name:\s*(.+?)\s*$/.exec(l)
    if (mName) {
      const v = mName[1].replace(/^['"]|['"]$/g, '')
      if (curEntry && !curEntry.name) curEntry.name = v
      else if (cur) cur.name = v
      continue
    }
    // 其它写法（config: 及它的子项等）一律放过：内置检查只管上面那两条判据。
  }
  for (const it of out) {
    if (!it.insert) continue
    if (!it.insert.length) throw new Error('有一条 - insert: 底下一条条目都没有')
    for (const e of it.insert) if (!e.name) throw new Error('insert 条目 name 是空的（id=' + e.id + '）')
  }
  return out
}
function loadYaml(text) {
  const roots = [profileDir, home, HERE, process.cwd()]
  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, '__resolve_probe__.js'))
      const yaml = req('js-yaml')
      if (yaml && typeof yaml.load === 'function') return yaml.load(text)
    } catch { /* 换下一个位置 */ }
  }
  if (!usedFallbackYaml) {
    usedFallbackYaml = true
    report('~', '找不到 js-yaml —— 本次改用内置的"够用"检查（能抓结构损坏与空 name；不如真解析严格）')
  }
  return builtinYamlLoad(text)
}
function assertPatch(file) {
  const raw = fs.readFileSync(file, 'utf8')
  let doc
  try { doc = loadYaml(raw) } catch (error) { return { ok: false, why: 'YAML 解析失败：' + error.message } }
  if (!Array.isArray(doc)) return { ok: false, why: '顶层不是数组（解析成 ' + (doc === null ? 'null' : typeof doc) + '）' }
  const entries = []
  for (const item of doc) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.insert)) continue
    for (const entry of item.insert) entries.push(entry)
  }
  if (!entries.length) return { ok: false, why: '一条 insert entry 都没解析出来' }
  const bad = entries.filter((e) => !e || typeof e.name !== 'string' || !e.name.trim())
  if (bad.length) return { ok: false, why: bad.length + ' 条 entry 的 name 不是非空字符串', entries: entries.length, bad: bad }
  const mine = entries.filter((e) => e.id === NAME)
  return { ok: true, entries: entries.length, mine: mine.length, ids: entries.map((e) => e.id) }
}
// 从现场文件里读「本插件那一段的 name 行」——自证口径：从落盘的文件重新解析，不看变量。
function liveNameLine(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    const idLine = lines.findIndex((l) => l.trim() === '- id: ' + NAME)
    if (idLine === -1) return ''
    for (let i = idLine + 1; i < lines.length; i += 1) {
      if (/^\s*-\s*id:/.test(lines[i]) || /^- insert:/.test(lines[i])) break
      if (/^\s*name:/.test(lines[i])) return lines[i].trim()
    }
    return ''
  } catch { return '' }
}
function restore(from, to) {
  if (!from || !fs.existsSync(from)) { report('!', '没有可用的备份：' + from); return false }
  fs.copyFileSync(from, to)
  return true
}
function rollback(reason) {
  console.error('  断言不通过：' + reason + ' → 自动回滚')
  const state = readState() || {}
  if (state.patchBackup) restore(state.patchBackup, patchPath)
  if (state.profilePkgBackup) restore(state.profilePkgBackup, profilePkgPath)
  removeJunction()
  const after = (() => { try { return assertPatch(patchPath) } catch (error) { return { ok: false, why: error.message } } })()
  console.error('  回滚后 patch 断言：' + (after.ok ? '通过（' + after.entries + ' 条 entry）' : '仍然不通过：' + after.why))
  process.exitCode = 1
}

console.log((dryRun ? '== 演练（不落盘）' : remove ? '== 卸载/回滚' : checkOnly ? '== 检查' : '== 安装') + ' ' + NAME + ' ==')
console.log('  profile：' + profileDir)
console.log('  源码：' + HERE)

try {
  if (remove) {
    const state = readState() || {}
    if (state.patchBackup) {
      if (restore(state.patchBackup, patchPath)) report('-', 'cordis.patch.yml 已从备份恢复：' + state.patchBackup)
    } else report('!', '.install-state.json 里没有 patch 备份记录 —— 请手动删掉 patch 里 id: ' + NAME + ' 那一段')
    if (state.profilePkgBackup) { if (restore(state.profilePkgBackup, profilePkgPath)) report('-', 'profile package.json 已从备份恢复：' + state.profilePkgBackup) }
    else removeDep()
    removeJunction()
    if (!dryRun && fs.existsSync(statePath)) fs.unlinkSync(statePath)
    for (const line of said) console.log(line)
    // ★ R32 修复：卸载成功后本插件那段本来就没了，再拿"有没有 insert entry"当判据必然报假失败
    //   （实测：回滚逐字节回到原始 132B，却因为 0 条 insert entry 而退出码 1）。
    //   卸载该验的是两件事：YAML 还能解析 + 本插件那段确实不在了。
    let yamlOk = true, yamlWhy = ''
    try { const doc = loadYaml(fs.readFileSync(patchPath, 'utf8')); yamlOk = Array.isArray(doc) || (doc && typeof doc === 'object') }
    catch (error) { yamlOk = false; yamlWhy = String(error && error.message ? error.message : error) }
    const gone = !fs.readFileSync(patchPath, 'utf8').includes('- id: ' + NAME)
    console.log('  回滚后：YAML 可解析=' + yamlOk + ' · 本插件那一段已移除=' + gone + (yamlWhy ? ' · ' + yamlWhy : ''))
    process.exit(yamlOk && gone ? 0 : 1)
  }

  if (checkOnly) {
    const verdict = assertPatch(patchPath)
    console.log('  [YAML] 每条 insert entry 的 name 非空：' + (verdict.ok ? '通过' : '不通过 —— ' + verdict.why))
    if (!verdict.ok) { rollback(verdict.why); process.exit(1) }
    const inPatch = fs.readFileSync(patchPath, 'utf8').includes('- id: ' + NAME)
    console.log('  [patch] 有 ' + NAME + ' 那一段：' + (inPatch ? '是' : '否'))
    console.log('  [entry] 现场 name 行：' + (liveNameLine(patchPath) || '(没找到)'))
    const dep = (readProfilePkg() || {}).dependencies || {}
    console.log('  [dep] package.json link 依赖：' + (dep[NAME] === LINK_SPEC ? '是' : String(dep[NAME] || '否')))
    const entryOk = fs.existsSync(path.join(linkPath, 'index.js'))
    console.log('  [entry] junction 里能读到 index.js：' + (entryOk ? '是' : '否'))
    if (!inPatch || dep[NAME] !== LINK_SPEC || !entryOk) { rollback('现场检查不齐（patch/依赖/junction）'); process.exit(1) }
    console.log('  全部通过。')
    process.exit(0)
  }

  // 安装
  warnLegacyState()
  const previous = readState() || {}
  const state = Object.assign({}, previous, { plugin: NAME, profile: profile, profileDir: profileDir, patchPath: patchPath, profilePkgPath: profilePkgPath, linkPath: linkPath, relName: REL_NAME, at: new Date().toISOString() })
  if (!dryRun && !previous.patchBackup) state.patchBackup = backupOnce(patchPath, NAME) || null
  if (!dryRun && !previous.profilePkgBackup) state.profilePkgBackup = backupOnce(profilePkgPath, NAME) || null
  installJunction()
  const depBackup = upsertDep()
  if (depBackup && !state.profilePkgBackup) state.profilePkgBackup = depBackup
  saveState(state)
  for (const line of said) console.log(line)
  const raw = fs.readFileSync(patchPath, 'utf8')
  const already = raw.includes('- id: ' + NAME)
  console.log('')
  if (writePatchFlag) {
    const ok = writePatch()
    for (const line of said.splice(0)) console.log(line)
    if (!ok) process.exitCode = 1
  } else if (already) {
    console.log('  cordis.patch.yml 里已经有 id: ' + NAME + ' 那一段了，没有动它。')
    console.log('  要更新缓存键（改完 index.js 让它热加载）就把那一行的 name 换成：')
    console.log("      name: '" + REL_NAME + "'")
  } else {
    console.log('  == 下面这一段要用 edit 工具「字面替换」写进 ' + patchPath + '（本脚本不写 patch 内容）==')
    console.log('<<<PATCH_BLOCK_BEGIN')
    console.log(BLOCK.replace(/\n$/, ''))
    console.log('PATCH_BLOCK_END>>>')
    console.log('  做法：把文件最后一行原样复制过来当 old_string，old_string + 上面那一段当 new_string，')
    console.log('  用 edit 工具写；写完跑 node install.mjs --check 做 YAML 断言。')
  }
  const verdict = assertPatch(patchPath)
  console.log('  [YAML] 当前 patch 每条 insert entry 的 name 非空：' + (verdict.ok ? '通过（' + verdict.entries + ' 条 entry）' : '不通过 —— ' + verdict.why))
} catch (error) {
  console.error('  失败：' + (error && error.message ? error.message : error))
  process.exitCode = 1
}
