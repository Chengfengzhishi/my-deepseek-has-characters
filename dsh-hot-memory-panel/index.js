// dsh-hot-memory-panel —— 「热记忆」只读查看面板 + 人工指导落盘
//
// 用户诉求（原话）：**「看见 + 能人为指导」**，不是好看。
// 所以这一页的头号判据是：**能不能一眼看出哪个会话的哪块记忆有问题。**
//
// ===== 边界（两条硬红线，都是因为 dsh-hot-memory 正被另一个会话改）=====
// ① 只读消费它的 JSON API：GET /hot-memory（列表 + 探针）、GET /hot-memory/file?id=<sessionId>（单份正文）。
//    不 import 它的模块、不读它的内部状态、**不写它的任何产物**（<DSH_HOME>/hot-memory/*.md 一个字节都不碰）。
//    ⚠️ 现场事实：/hot-memory/file 的参数名是 id，不是 session（session= 会 400「缺 id」）。
//       这是从它的源码 + 实测 200 确认的，不是猜的。
// ② 人工指导写进**本插件自己的目录**：<插件目录>/data/guidance/<sessionId>.md（只追加）。
//
// ===== 判据：页面上的红/黄，每一条都能追到一条规则 =====
//   E1  empty        记忆正文为空
//   E2  nosection    一个 "## " 分区都没有（本体写的是分区结构，这份不是）
//   E3  std-miss     缺标准分区 —— **是否算「标准」由语料自己决定**（该分区在 >=60% 的会话里出现才算），
//                    覆盖率不够就跳过。理由：本体正在做「主题分区」改造，硬编码分区名会让新格式全变红（假警报）。
//   E4  sec-empty    某个分区正文为空（写了标题没写内容）
//   E5  sec-ph       分区正文只有占位（- 无 / 待补充 / TODO / TBD）—— **只作知情**。
//                    理由（现场实测）：60 份记忆里 E5 命中 75 次，绝大多数是「未决问题：（无）」这种
//                    正常写法；把它算黄，44/60 个会话全变黄，真正的 2 个超限就被埋了。
//   E5b hollow       一半以上分区是空的/只有占位（记忆基本是空壳）—— 这才是要处理的那个
//   E6  oversize     文件字节 > maxMemoryBytes（超上限会被本体截断 ⇒ 记忆被吃掉一截）
//   E6b sec-fat      单个分区就超过整份上限（分布本身有问题）
//   E6c near-limit   已达上限的 80% 以上（快被截断）
//   E7  stale        **正在跑**的会话，记忆太久没更新（本体每轮结束都在蒸馏 ⇒ 它卡住了）
//   E7n idle-stale   在线但空闲、记忆有点旧（没人跟它说话就不会有新的一轮，正常，只作知情）
//   E7i stale-off    离线会话的老记忆（归档，只做提示，不算问题）
//   E8  no-meta      缺「更新：」元信息行（看不出这份是什么时候、第几轮写的）
//   E9  dup-section  同名分区出现多次
//   E10 gd-pending   下过人工指导、但那之后记忆没再更新过（指导没落进记忆 —— 弱证据）
//   E11 wiring       接线状态（R24）：指导**双写** —— ① 契约位置 <DSH_HOME>/hot-memory/_guidance/<id>.md
//                    （本体要读的那份）② 面板副本 data/guidance/<id>.md。
//                    页面上显示的是**从现场解析出来的**状态，判据链三条：
//                      a. 契约文件在不在（磁盘事实）
//                      b. GET /hot-memory/guidance 的状态码（本体上线后才是 200）
//                      c. 该路由返回的 JSON 里有没有这个会话、报了几条（形状未知 ⇒ 容错解析）
//                    只有 a+b+c 都成立才显示「已接线 · 已读」；本体没上线就显示「本体未就绪」+ 状态码。
//   E11b copy-only   有指导但契约位置没有（历史条目）→ 本体读不到，要重新下发一次补写过去
//
// 另外两条自证口径（页面上直接并排显示）：
//   · 对账：磁盘 .md 份数 / API memories 份数 / 本页列出份数 —— 三个数并排，差多少写多少
//   · 字节对账：头部 + Σ分区 与 文件字节 必须相等（分区是按原文字节切片的，不相等就说明中途被改过）
//
// ===== 零依赖红线 =====
// profile 用 junction 链到本目录，node 从这里往上找不到 node_modules；解析失败会让 cordis 插件树
// 整体抛错、DSH 起不来。所以只用 node: 内置模块，apply 全程 try/catch，所有失败都降级成页面上的红字。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-hot-memory-panel'
// ★ R27：webServer 必须是【硬依赖】——开机时它还没就绪，软取 ctx.get('webServer') 会静默跳过，
//   表现就是"热加载能挂上路由、真重启后 /hot-memory-panel 变 404"（2026-09-22 实测 pid 4712，
//   面板自己的 state.json 写着 routesOk:false，而同一宿主的 dsh-hot-memory / dsh-bell 都写了 webServer 所以没事）。
export const inject = ['tools', 'webServer']

const PLUGIN_ID = 'dsh-hot-memory-panel'
const VERSION = '0.2.0'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  // 数据来源：只用它的两个只读接口
  apiBase: '',                       // 留空 = 用 webServer 自己的端口（兜底 3080）
  probePath: '/hot-memory',
  filePath: '/hot-memory/file',
  hotMemoryDir: '',                  // 留空 = <DSH_HOME>/hot-memory（只读 + 只用来对账/兜底）
  // 自己的东西（指导文件）只写这里，绝不写进热记忆目录
  dataDir: '',                       // 留空 = <插件目录>/data
  // 判据参数
  standardSections: ['当前目标', '已确认事实', '未决问题', '关键文件路径', '最近决策'],
  standardCoverageFloor: 0.6,
  staleHoursOnline: 6,
  staleHoursOffline: 72,
  oversizeWarnRatio: 0.8,
  // 运行参数
  maxSessions: 300,
  fetchTimeoutMs: 4000,
  concurrency: 6,
  refreshSeconds: 15,
  guidanceContractNote: 'R24 契约：指导双写 —— 契约位置由 dsh-hot-memory 读取，面板副本供自身独立工作',
  // 接线契约（B 侧写、A 侧读）：<DSH_HOME>/hot-memory/_guidance/<sessionId>.md
  // 依据：<工作区>\_指挥台\_scratch\接线方案-人工指导.md:29-31（路径 / 格式沿用 / UTF-8 追加写）
  guidanceMirrorDir: '',
  wiringProbeCacheMs: 5000,
  title: '热记忆面板 · 大烧货专区',
  dedupeSeconds: 60,
}

// ===== 小工具 =====
function log() { try { console.log('[' + PLUGIN_ID + ']', ...arguments) } catch { /* 忽略 */ } }
function warn() { try { console.warn('[' + PLUGIN_ID + ']', ...arguments) } catch { /* 忽略 */ } }
function errText(error) { return error && error.message ? String(error.message) : String(error) }
function homeDir() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : path.join(os.homedir(), '.dsh')
}
function nowIso() { return new Date().toISOString() }
function pad2(n) { return (n < 10 ? '0' : '') + n }
function localNow(d) {
  const t = d || new Date()
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) + ' ' +
    pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds())
}
function shortId(id) { return String(id || '').replace(/^session-/, '').slice(0, 8) }
// 记忆文件名有的带 session- 前缀、有的不带（历史格式），归一化后才能和活会话对上
function normId(id) { return String(id || '').replace(/^session-/, '').toLowerCase() }
function safeName(id) { return String(id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) }
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function byteLen(s) { return Buffer.byteLength(String(s == null ? '' : s), 'utf8') }
function humanBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  return (v / 1024).toFixed(2) + ' KB'
}
function humanAge(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 60000) return Math.round(n / 1000) + ' 秒'
  if (n < 3600000) return Math.round(n / 60000) + ' 分钟'
  if (n < 86400000) return (n / 3600000).toFixed(1) + ' 小时'
  return (n / 86400000).toFixed(1) + ' 天'
}
function oneLiner(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) : s
}
function hashKey(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ } }
// 原子写：先写临时文件再 rename（rename 的变更事件是确定的，cordis/监听器一定认）
function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

// ===== 路径 =====
function memoryDir(cfg) {
  return cfg.hotMemoryDir && String(cfg.hotMemoryDir).trim()
    ? String(cfg.hotMemoryDir).trim()
    : path.join(homeDir(), 'hot-memory')
}
function memoryPath(cfg, sessionId) { return path.join(memoryDir(cfg), safeName(sessionId) + '.md') }
function dataDir(cfg) {
  return cfg.dataDir && String(cfg.dataDir).trim() ? String(cfg.dataDir).trim() : path.join(HERE, 'data')
}
function guidanceDir(cfg) { return path.join(dataDir(cfg), 'guidance') }
function guidanceFile(cfg, sessionId) { return path.join(guidanceDir(cfg), safeName(sessionId) + '.md') }
// 契约位置（本体将要读的位置）：<DSH_HOME>/hot-memory/_guidance/<sessionId>.md
function guidanceMirrorDir(cfg) {
  return cfg.guidanceMirrorDir && String(cfg.guidanceMirrorDir).trim()
    ? String(cfg.guidanceMirrorDir).trim()
    : path.join(memoryDir(cfg), '_guidance')
}
function guidanceMirrorFile(cfg, sessionId) { return path.join(guidanceMirrorDir(cfg), safeName(sessionId) + '.md') }
// 硬要求：指导**绝不许**写进任何会话的热记忆文件本体（<memoryDir>/<id>.md）。写之前先把这件事拦住。
function mirrorGuard(cfg, sessionId) {
  const dir = path.resolve(guidanceMirrorDir(cfg))
  if (dir === path.resolve(memoryDir(cfg))) return '契约位置不能就是记忆目录本身（否则会写进会话记忆）'
  const file = path.resolve(path.join(dir, safeName(sessionId) + '.md'))
  if (file === path.resolve(memoryPath(cfg, sessionId))) return '契约文件与热记忆文件同址（' + file + '），拒绝写'
  if (path.dirname(file) !== dir) return '契约文件名越界：' + file
  return ''
}

// ===== 解析：把一份记忆切成「头部 + 分区」，字节数按**原文切片**算（不靠重新拼接，避免 CRLF 误差）=====
function parseMemory(text) {
  const src = String(text == null ? '' : text)
  const total = byteLen(src)
  const re = /^##[ \t]+(.+?)[ \t]*$/gm
  const marks = []
  let m
  while ((m = re.exec(src)) !== null) marks.push({ title: m[1].trim(), start: m.index })
  const headText = marks.length ? src.slice(0, marks[0].start) : src
  const sections = []
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length
    const body = src.slice(marks[i].start, end)
    const lines = body.split(/\r?\n/)
    lines.shift() // 去掉 "## 标题" 那一行
    const content = lines.filter((l) => String(l).trim() !== '')
    const bullets = content.filter((l) => /^\s{0,2}[-*+]\s+\S/.test(l))
    const phRe = /^([-*+]\s*)?[（(]?\s*(无|暂无|没有|none|n\/a|待补充|待定|待办|todo|tbd)\s*[）)]?[。.！!]*$/i
    const placeholderOnly = content.length > 0 && content.every((l) => phRe.test(String(l).replace(/^\s{0,2}[-*+]\s+/, '')))
    sections.push({
      title: marks[i].title,
      bytes: byteLen(body),
      lines: content.length,
      bullets: bullets.length,
      empty: content.length === 0,
      placeholderOnly: placeholderOnly,
      placeholderSample: placeholderOnly ? oneLiner(content[0], 40) : '',
      text: content.slice(0, 12).join('\n'),
    })
  }
  const meta = String(headText).match(/更新[：:]\s*([^·\r\n]+)/)
  const round = String(headText).match(/第\s*(\d+)\s*轮/)
  const model = String(headText).match(/蒸馏\s*([^\s·]+)/)
  return {
    total,
    headBytes: byteLen(headText),
    headText: String(headText).trim(),
    sectionsBytes: sections.reduce((a, s) => a + s.bytes, 0),
    sections: sections,
    sectionTitles: sections.map((s) => s.title),
    updatedText: meta ? String(meta[1]).trim() : '',
    round: round ? Number(round[1]) : 0,
    model: model ? String(model[1]) : '',
  }
}

// 投喂区（本体 R22 的固定第 6 节）**不占 maxMemoryBytes 预算** —— 这是从本体源码读到的事实：
//   dsh-hot-memory/index.js:731「第 6 节由代码拼装、追加在蒸馏部分之后（不占 maxMemoryBytes 预算）」。
//   ⇒ 拿**整份文件**去比 2048 B 会是误报（实测把 4329 B / 9323 B 两份额度正常的记忆判成了红）。
//   本体的预算只管「蒸馏部分」＝ 头部 + 非投喂分区。判据按这个口径算。
const FEED_TITLE_RE = /中枢投喂|不参与蒸馏/
function isFeedTitle(title) { return FEED_TITLE_RE.test(String(title || '')) }
function splitBudget(parsed) {
  let feedBytes = 0
  let distilledBytes = parsed.headBytes
  let feedSections = 0
  for (const sec of parsed.sections) {
    if (isFeedTitle(sec.title)) { feedBytes += sec.bytes; feedSections += 1 }
    else distilledBytes += sec.bytes
  }
  return { feedBytes: feedBytes, distilledBytes: distilledBytes, feedSections: feedSections }
}

// ===== 语料自校准：哪些分区算「标准」由现场决定，不由我硬编码 =====
function buildCorpus(sessions, cfg) {
  const withSecs = sessions.filter((s) => s.sections.length > 0)
  const n = withSecs.length || 1
  const coverage = {}
  for (const t of cfg.standardSections) {
    coverage[t] = withSecs.filter((s) => s.sectionTitles.indexOf(t) !== -1).length / n
  }
  const tally = new Map()
  for (const s of withSecs) for (const t of s.sectionTitles) tally.set(t, (tally.get(t) || 0) + 1)
  const top = Array.from(tally.entries())
    .sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 12)
    .map((pair) => ({ title: pair[0], count: pair[1], ratio: pair[1] / n }))
  return { total: sessions.length, withSections: withSecs.length, coverage: coverage, top: top }
}

// ===== 规则引擎：每个会话一份 issues =====
function judgeSession(s, corpus, cfg, limitBytes) {
  const issues = []
  const add = (level, code, text) => issues.push({ level: level, code: code, text: text })
  const text = String(s.text || '')
  if (!text.trim()) {
    add('bad', 'E1', '记忆正文是空的（文件 ' + s.bytes + ' B，但读不到正文）' + (s.error ? ' · 取内容时报错：' + s.error : ''))
  } else {
    if (!s.sections.length) add('bad', 'E2', '一个 “## ” 分区都没有 —— 这不是分区结构的记忆，本页看不出它记了什么')
    if (s.duplicateSections.length) add('warn', 'E9', '同名分区出现多次：' + s.duplicateSections.join('、'))
    for (const sec of s.sections) {
      if (isFeedTitle(sec.title)) continue   // 投喂区不占预算、也不是蒸馏产物，不参与分区体检
      if (sec.empty) add('warn', 'E4', '分区「' + sec.title + '」是空的（写了标题没写内容）')
      else if (sec.placeholderOnly) add('info', 'E5', '分区「' + sec.title + '」只有占位（' + sec.placeholderSample + '）—— 像「未决问题：（无）」这种是正常写法，只作知情')
      if (limitBytes > 0 && sec.bytes > limitBytes) {
        add('warn', 'E6b', '单个分区「' + sec.title + '」就 ' + sec.bytes + ' B，超过整份预算 ' + limitBytes + ' B')
      }
    }
    const contentSections = s.sections.filter((x) => !isFeedTitle(x.title))
    const hollow = contentSections.filter((x) => x.empty || x.placeholderOnly).length
    if (contentSections.length >= 3 && hollow / contentSections.length >= 0.5) {
      add('warn', 'E5b', '这个会话 ' + hollow + '/' + contentSections.length + ' 个分区是空的或只有占位 —— 记忆基本是空壳')
    }
    if (s.feedBytes > 0) {
      add('info', 'E6f', '投喂区 ' + s.feedBytes + ' B（**不占** ' + limitBytes + ' B 预算 —— 本体 index.js:731 说它由 feedMaxLines/feedExpireRounds 管，所以不算超限）')
    }
    const miss = []
    for (const t of cfg.standardSections) {
      if (s.sectionTitles.indexOf(t) !== -1) continue
      const cov = corpus.coverage[t] || 0
      if (cov >= cfg.standardCoverageFloor) miss.push(t + '（' + Math.round(cov * 100) + '% 的会话有）')
    }
    if (miss.length) add(miss.length >= 2 ? 'bad' : 'warn', 'E3', '缺标准分区：' + miss.join('、'))
    if (!s.updatedText) add('warn', 'E8', '缺「更新：」元信息行（看不出这份是什么时候、第几轮写的）')
    if (s.reconcileDiff !== 0) {
      add('warn', 'E12', '字节对账不平：头部 ' + s.reconcile.head + ' + 分区 ' + s.reconcile.sections +
        ' − 文件 ' + s.reconcile.file + ' = ' + s.reconcileDiff + ' B（多半是取内容时文件正好被改了）')
    }
  }
  // 预算只看**蒸馏部分**（整份文件含投喂区，投喂区不占预算）
  const budgeted = Number.isFinite(s.distilledBytes) ? s.distilledBytes : s.bytes
  if (limitBytes > 0) {
    if (budgeted > limitBytes) {
      add('bad', 'E6', '蒸馏部分 ' + budgeted + ' B > 上限 ' + limitBytes + ' B（整份 ' + s.bytes + ' B，其中投喂区 ' +
        s.feedBytes + ' B 不占预算）—— 超预算会被本体截断，记忆会被吃掉一截')
    } else if (budgeted >= limitBytes * cfg.oversizeWarnRatio) {
      add('warn', 'E6c', '蒸馏部分 ' + budgeted + ' B 已达预算 ' + limitBytes + ' B 的 ' +
        Math.round((budgeted / limitBytes) * 100) + '%（快被截断）')
    }
  }
  if (s.liveStatus === 'running') {
    if (s.ageHours > cfg.staleHoursOnline) {
      add('bad', 'E7', '这个会话**正在跑**，但记忆 ' + humanAge(s.ageMs) + '没更新 —— 本体每轮结束都会蒸馏，说明它卡住了')
    }
  } else if (s.liveStatus === 'idle') {
    if (s.ageHours > cfg.staleHoursOnline) {
      add('info', 'E7n', '在线但空闲，记忆 ' + humanAge(s.ageMs) + '前更新的（没人跟它说话就不会有新的一轮，正常）')
    }
  } else if (s.ageHours > cfg.staleHoursOffline) {
    add('info', 'E7i', '离线会话，记忆停留在 ' + humanAge(s.ageMs) + '前（归档，不算问题）')
  }
  for (const g of s.guidance.entries) {
    if (g.ms > s.mtimeMs) {
      add('warn', 'E10', '最近一条人工指导（' + g.at + '）之后记忆没再更新过 —— 指导还没落进记忆')
      break
    }
  }
  if (s.wiring && s.wiring.status && s.wiring.status !== 'none') {
    const copyOnly = s.wiring.status === 'copy-only'
    const noisy = copyOnly || s.wiring.status === 'read-with-drift' || s.wiring.status === 'contract-mismatch' || s.wiring.status === 'read-partial'
    add(noisy ? 'warn' : 'info', copyOnly ? 'E11b' : 'E11', '接线：' + s.wiring.text)
  }
  const level = issues.some((i) => i.level === 'bad') ? 'bad' : (issues.some((i) => i.level === 'warn') ? 'warn' : 'ok')
  return { level: level, issues: issues }
}

// ===== 只读消费：两个 JSON API =====
function webServerOf(ctx) {
  try { return ctx.get('webServer') } catch { return undefined }
}
function apiBaseOf(ctx, cfg) {
  if (cfg.apiBase && String(cfg.apiBase).trim()) return String(cfg.apiBase).trim().replace(/\/+$/, '')
  const server = webServerOf(ctx)
  const port = Number(server && server.port) || 3080
  return 'http://127.0.0.1:' + port
}
async function fetchWithTimeout(url, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => { try { ac.abort() } catch { /* 忽略 */ } }, Math.max(200, Number(timeoutMs) || 4000))
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json, text/plain, */*' } })
    const text = await res.text()
    return { status: res.status, contentType: String(res.headers.get('content-type') || ''), text: text }
  } finally { clearTimeout(timer) }
}
function listDiskMemories(cfg) {
  const dir = memoryDir(cfg)
  const out = { dir: dir, files: [], error: '' }
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
    for (const n of names) {
      let stat = null
      try { stat = fs.statSync(path.join(dir, n)) } catch { stat = null }
      out.files.push({
        sessionId: n.replace(/\.md$/, ''),
        bytes: stat ? stat.size : 0,
        mtime: stat ? new Date(stat.mtimeMs).toISOString() : '',
        mtimeMs: stat ? stat.mtimeMs : 0,
      })
    }
    out.files.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
  } catch (error) { out.error = errText(error) }
  return out
}
function liveAgents(ctx) {
  const map = new Map()
  try {
    const service = ctx.get('agents')
    if (!service || typeof service.list !== 'function') return map
    for (const agent of (service.list() || [])) {
      let id = ''
      try { id = String((agent.session && agent.session.id) || agent.id || '') } catch { id = '' }
      if (!id) continue
      let name = ''
      try { name = String((agent.session && agent.session.header && agent.session.header.cwd) || '') } catch { name = '' }
      map.set(normId(id), { id: id, status: String((agent && agent.status) || 'unknown'), cwd: name })
    }
  } catch { /* 没有 agents 服务：在线状态全标未知，不影响主判据 */ }
  return map
}
function readTitles() {
  const map = new Map()
  try {
    const file = path.join(homeDir(), 'storages', 'session_projcache.json')
    const stat = fs.statSync(file)
    if (stat.size > 8 * 1024 * 1024) return map
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const sessions = parsed && parsed.tables && parsed.tables.sessions
    for (const id of Object.keys(sessions || {})) {
      const entry = sessions[id] || {}
      const title = String((entry.rows && entry.rows.title && entry.rows.title.val) || '')
      const cwd = String((entry.identity && entry.identity.cwd) || '')
      if (title || cwd) map.set(normId(id), { title: title, cwd: cwd })
    }
  } catch { /* 缓存不在或太大：降级成短 id */ }
  return map
}

// ===== 人工指导（本插件唯一的写入口）=====
function parseGuidance(text) {
  const entries = []
  const re = /^##[ \t]+(.+?)[ \t]*$/gm
  const marks = []
  let m
  while ((m = re.exec(String(text))) !== null) marks.push({ head: m[1].trim(), start: m.index, end: re.lastIndex })
  for (let i = 0; i < marks.length; i += 1) {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : String(text).length
    const body = String(text).slice(marks[i].end, bodyEnd).trim()
    const parts = marks[i].head.split('·').map((s) => s.trim())
    const at = parts[0] || ''
    const ms = Date.parse(at.replace(/ /, 'T')) || 0
    const sectionPart = parts.find((p) => p.indexOf('分区：') === 0) || ''
    entries.push({
      at: at, ms: ms,
      source: parts[1] || '',
      section: sectionPart ? sectionPart.replace(/^分区：/, '') : '整体',
      text: body,
    })
  }
  return entries
}
function readGuidanceAt(file) {
  try {
    const stat = fs.statSync(file)
    const text = fs.readFileSync(file, 'utf8')
    return { file: file, exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs, mtime: new Date(stat.mtimeMs).toISOString(), entries: parseGuidance(text), readError: '' }
  } catch (error) {
    return { file: file, exists: false, bytes: 0, mtimeMs: 0, mtime: '', entries: [], readError: '' }
  }
}
function readGuidance(cfg, sessionId) { return readGuidanceAt(guidanceFile(cfg, sessionId)) }
function readMirror(cfg, sessionId) { return readGuidanceAt(guidanceMirrorFile(cfg, sessionId)) }
function readAllGuidance(cfg, sessionIds) {
  const map = new Map()
  for (const id of sessionIds) map.set(id, readGuidance(cfg, id))
  return map
}
// 追加一条指导：**双写** —— ① 契约位置 <DSH_HOME>/hot-memory/_guidance/<id>.md（本体读这份）
//   ② 面板自己的副本 data/guidance/<id>.md（面板要能独立工作）。
// 两处都是「读全文 → 拼 → 原子写 → **回读校验**」；追加、绝不改写历史条目；目录不在就自建。
// 任何一处没写成，都返回 ok=false + 明确 error（不许静默）。
function appendGuidance(cfg, sessionId, section, text, source) {
  const cleaned = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim()
  if (!cleaned) return { ok: false, error: '指导内容是空的，没写' }
  const block = '\n## ' + localNow() + ' · ' + (source || '面板') + ' · 分区：' + (section || '整体') + '\n' + cleaned + '\n'
  const writeOne = (file, role) => {
    // 目录不存在就自建（硬要求之一）
    let dirMade = false
    try {
      if (!fs.existsSync(path.dirname(file))) { fs.mkdirSync(path.dirname(file), { recursive: true }); dirMade = true }
    } catch (error) { return { role: role, file: file, ok: false, readbackOk: false, error: '建目录失败：' + errText(error), dirMade: false } }
    let before = ''
    try { before = fs.readFileSync(file, 'utf8') } catch { before = '' }
    const bytesBefore = byteLen(before)
    const header = before.trim()
      ? before.replace(/\s*$/, '\n')
      : '# 人工指导 · ' + sessionId + '\n\n' +
        '<!-- 由 dsh-hot-memory-panel 追加：' + (role === 'mirror' ? '契约位置，由 dsh-hot-memory 读取' : '面板自己的副本') +
        '。只追加，不改写历史条目。 -->\n'
    try { writeAtomic(file, header + block) }
    catch (error) { return { role: role, file: file, ok: false, readbackOk: false, error: '写文件失败：' + errText(error), bytesBefore: bytesBefore, dirMade: dirMade } }
    let readback = ''
    try { readback = fs.readFileSync(file, 'utf8') } catch (error) { return { role: role, file: file, ok: false, readbackOk: false, error: '回读失败：' + errText(error), bytesBefore: bytesBefore, dirMade: dirMade } }
    const stat = (() => { try { return fs.statSync(file) } catch { return null } })()
    const readbackOk = readback.indexOf(cleaned) !== -1
    return {
      role: role, file: file, ok: readbackOk, readbackOk: readbackOk, dirMade: dirMade, bytesBefore: bytesBefore,
      bytes: stat ? stat.size : byteLen(readback), entries: parseGuidance(readback).length,
      error: readbackOk ? '' : '回读没找到刚写的内容 —— 当失败处理',
    }
  }
  const guard = mirrorGuard(cfg, sessionId)
  const mirror = guard
    ? { role: 'mirror', file: guidanceMirrorFile(cfg, sessionId), ok: false, readbackOk: false, error: '拒绝写：' + guard, dirMade: false }
    : writeOne(guidanceMirrorFile(cfg, sessionId), 'mirror')
  const copy = writeOne(guidanceFile(cfg, sessionId), 'copy')
  const ok = mirror.ok === true && copy.ok === true
  const errors = []
  if (mirror.ok !== true) errors.push('契约位置（本体读的那份 ' + mirror.file + '）：' + (mirror.error || '未知'))
  if (copy.ok !== true) errors.push('面板副本（' + copy.file + '）：' + (copy.error || '未知'))
  return {
    ok: ok, readbackOk: mirror.readbackOk === true, mirror: mirror, copy: copy,
    file: copy.file, mirrorFile: mirror.file, bytes: copy.bytes, entries: copy.entries, bytesBefore: copy.bytesBefore,
    block: block.trim(),
    error: ok ? '' : errors.join(' / '),
    note: ok
      ? '两处都已原子落盘并回读校验通过（契约位置 ' + mirror.file + (mirror.dirMade ? '，目录是这次新建的' : '') + '）'
      : '写入不完整：' + errors.join(' / '),
    rollback: mirror.ok
      ? ('回滚这一条：把 ' + mirror.file + ' 截断到 ' + mirror.bytesBefore + ' 字节（PowerShell：$p=\'' + mirror.file +
        '\'; $b=[IO.File]::ReadAllBytes($p)[0..' + Math.max(0, mirror.bytesBefore - 1) + ']; [IO.File]::WriteAllBytes($p,$b)）')
      : '契约位置没写成，无需回滚',
  }
}

// ===== 接线状态：全部**从现场重新解析**，页面上不写死任何状态字符串 =====
// 判据链（每条都会印在页面上）：
//   ① 契约文件在不在：<memoryDir>/_guidance/<id>.md（磁盘事实，本插件自己写的）
//   ② 本体路由在不在：GET /hot-memory/guidance 的状态码（A 侧上线后才是 200；现在 404 = 未就绪）
//   ③ 本体读没读到：该路由返回的 JSON 里有没有这个会话、报了几条
//      —— 形状已经问明（见下面的实测契约），不再用容错猜测：直接要 exists/count/fileBytes。
// ② 路由挂载探测（**实测契约**，不是猜的）：
//    裸 GET /hot-memory/guidance → 400（缺 id，说明路由挂着）；带 ?id=<sessionId> → 200 JSON
//    {ok, sessionId, contract:{dir,file,format}, dirExists, exists, count, fileBytes}；未知路径 → 404。
//    ⇒ 「路由在不在」= 400 或 200；「本体读没读到」= 直接问 ?id=<sessionId>。
async function probeGuidanceRoute(ctx, cfg, state) {
  const url = apiBaseOf(ctx, cfg) + '/hot-memory/guidance'
  const fresh = state.wiringCache && (Date.now() - state.wiringCache.at) < (Number(cfg.wiringProbeCacheMs) || 5000)
  if (fresh) return state.wiringCache
  const probe = { url: url, at: Date.now(), status: 0, mounted: false, error: '', contentType: '' }
  try {
    const r = await fetchWithTimeout(url, cfg.fetchTimeoutMs)
    probe.status = r.status
    probe.contentType = r.contentType
    probe.mounted = r.status === 200 || r.status === 400   // 400 = 缺 id：路由在
    if (!probe.mounted) probe.error = 'HTTP ' + r.status
  } catch (error) { probe.error = errText(error) }
  state.wiringCache = probe
  return probe
}
// ③ 问本体「这个会话你读到几条」——只问**真有指导的会话**（通常 1~3 个），5 秒缓存，不刷它的接口
async function probeGuidanceForSession(ctx, cfg, state, sessionId) {
  const url = apiBaseOf(ctx, cfg) + '/hot-memory/guidance?id=' + encodeURIComponent(sessionId)
  const cache = state.guidanceReadCache || (state.guidanceReadCache = new Map())
  const hit = cache.get(sessionId)
  if (hit && (Date.now() - hit.at) < (Number(cfg.wiringProbeCacheMs) || 5000)) return hit
  const out = { sessionId: sessionId, url: url, at: Date.now(), status: 0, exists: null, count: null, fileBytes: null, dirExists: null, contractFile: '', error: '', raw: null, renderedCount: null, renderedBytes: null, memoHasGuidance: null, memoBytes: null }
  try {
    const r = await fetchWithTimeout(url, cfg.fetchTimeoutMs)
    out.status = r.status
    if (r.status === 200) {
      try {
        const data = JSON.parse(r.text)
        out.raw = data
        out.exists = data.exists === true
        out.count = typeof data.count === 'number' ? data.count : null
        out.fileBytes = typeof data.fileBytes === 'number' ? data.fileBytes : null
        out.dirExists = data.dirExists === true
        out.contractFile = String((data.contract && data.contract.file) || '')
        // 更强的证据：指导有没有真的**渲染进记忆**（hasGuidanceSection）——这是「写了≠生效了」的分界线
        out.renderedCount = typeof (data.rendered && data.rendered.count) === 'number' ? data.rendered.count : null
        out.renderedBytes = typeof (data.rendered && data.rendered.bytes) === 'number' ? data.rendered.bytes : null
        out.memoHasGuidance = data.memoFile ? data.memoFile.hasGuidanceSection === true : null
        out.memoBytes = typeof (data.memoFile && data.memoFile.bytes) === 'number' ? data.memoFile.bytes : null
      } catch (error) { out.error = '返回不是 JSON：' + errText(error) }
    } else out.error = 'HTTP ' + r.status
  } catch (error) { out.error = errText(error) }
  cache.set(sessionId, out)
  if (cache.size > 200) for (const key of Array.from(cache.keys())) if (key !== sessionId) cache.delete(key)
  return out
}
function wiringForSession(s, mirror, probe, info, read) {
  const routeReady = probe.mounted === true
  const mirrorEntries = (mirror.entries || []).length
  const copyEntries = (s.guidance.entries || []).length
  // 副本里有、契约位置没有的条目（双写之前写下的历史条目）—— 本体读不到它们，要说出来
  const mirrorTexts = new Set((mirror.entries || []).map((x) => String(x.text).trim()))
  const missingInContract = (s.guidance.entries || []).filter((x) => !mirrorTexts.has(String(x.text).trim())).length
  const driftNote = missingInContract > 0
    ? '另有 ' + missingInContract + ' 条历史指导只在面板副本里（写在双写之前）→ 本体读不到；重新下发一次即可补写过去'
    : ''
  const ev = []
  ev.push('① 面板写的契约文件 ' + mirror.file + ' → ' + (mirror.exists ? mirrorEntries + ' 条 / ' + mirror.bytes + ' B' : '不存在') +
    (mirrorEntries ? '；副本比契约多 ' + missingInContract + ' 条历史条目' : ''))
  ev.push('② 路由 GET ' + probe.url + ' → ' + (probe.status ? probe.status : ('无响应 ' + probe.error)) +
    (routeReady ? '（挂着：400=缺 id 属正常）' : '（未挂载）') + ' · 本体 v' + (info.version || '?'))
  if (read) {
    ev.push('③ 问本体 ' + read.url + ' → ' + (read.status ? read.status : ('无响应 ' + read.error)) +
      (read.status === 200 ? '：exists=' + read.exists + ' count=' + read.count + ' fileBytes=' + read.fileBytes + ' dirExists=' + read.dirExists : ''))
    if (read.status === 200) ev.push('④ 本体自报：rendered.count=' + read.renderedCount + ' rendered.bytes=' + read.renderedBytes +
      ' · 记忆文件 memoFile.hasGuidanceSection=' + read.memoHasGuidance + '（' + read.memoBytes + ' B）')
  }
  if (!mirrorEntries && !copyEntries) {
    return { status: 'none', level: 'info', text: '没下过人工指导；契约位置已就绪（' + info.contractDir + (info.contractDirExists ? ' 目录在' : ' 目录会在第一次写入时自建') + '）', evidence: ev }
  }
  if (!mirrorEntries && copyEntries) {
    return { status: 'copy-only', level: 'warn', text: '未接线：' + copyEntries + ' 条指导只在面板副本里（' + s.guidance.file + '），契约位置没有 → 本体读不到；重新下发一次即可补写到 ' + mirror.file, evidence: ev }
  }
  if (!routeReady) {
    return {
      status: 'contract-written', level: 'info',
      text: '已按契约写好 ' + mirrorEntries + ' 条 → ' + mirror.file + ' · 本体路由未挂载：GET ' + probe.url + ' → ' +
        (probe.status ? probe.status : ('无响应 ' + probe.error)) + '（本体 v' + (info.version || '?') + '）—— 本体上线后这一节即生效',
      evidence: ev,
    }
  }
  if (!read || read.status !== 200) {
    return {
      status: 'route-only', level: 'info',
      text: '契约文件 ' + mirrorEntries + ' 条已就位；路由挂着但问不到本体读数（GET ' + (read ? read.url : probe.url) + ' → ' +
        (read && read.status ? read.status : '无响应') + (read && read.error ? '：' + read.error : '') + '）',
      evidence: ev,
    }
  }
  if (read.exists !== true) {
    return {
      status: 'contract-mismatch', level: 'warn',
      text: '契约对不上：本体说 exists=false（它按 ' + (read.contractFile || '?') + ' 找），但面板已经写了 ' + mirrorEntries + ' 条到 ' + mirror.file + ' → 两边路径/文件名没对齐',
      evidence: ev,
    }
  }
  if (read.count === 0) {
    return {
      status: 'contract-mismatch', level: 'warn',
      text: '契约对不上：本体读到了文件（fileBytes=' + read.fileBytes + '）但解析出 **0 条**指导 → 格式没对齐（面板格式：## <时间> · <来源> · 分区：X）',
      evidence: ev,
    }
  }
  if (read.count !== null && read.count !== mirrorEntries) {
    return {
      status: 'read-partial', level: 'warn',
      text: '条数不一致：本体 v' + (info.version || '?') + ' 读到 ' + read.count + ' 条，面板写了 ' + mirrorEntries + ' 条（本体可能读到的是旧版本，或有渲染上限）',
      evidence: ev,
    }
  }
  if (driftNote) {
    return {
      status: 'read-with-drift', level: 'warn',
      text: '已接线 · 本体 v' + (info.version || '?') + ' 已读到 ' + read.count + ' 条 · ' + driftNote,
      evidence: ev,
    }
  }
  if (read.memoHasGuidance === false) {
    return {
      status: 'read-pending', level: 'info',
      text: '已接线 · 本体 v' + (info.version || '?') + ' 已读到 ' + read.count + ' 条，但**还没渲染进这个会话的记忆**（本体自报 memoFile.hasGuidanceSection=false）' +
        ' → 本体在下一次蒸馏时会把它拼进「人工指导（不参与蒸馏 · 原样保留）」节；在那之前这个会话看不到它',
      evidence: ev,
    }
  }
  return {
    status: 'read', level: 'ok',
    text: '已接线 · 指导 ' + mirrorEntries + ' 条 · 本体 v' + (info.version || '?') + ' 已读到 ' + (read.count === null ? '同一份文件（条数未报）' : read.count + ' 条') +
      (read.memoHasGuidance === true ? '，并已渲染进记忆（hasGuidanceSection=true，' + read.renderedBytes + ' B）' : '') +
      '（路由级证据：本体读了这份契约文件；仍不等于模型每一轮都用上了）',
    evidence: ev,
  }
}

// ===== 汇总一份数据（页面和 ?json=1 用的是同一份）=====
async function collect(ctx, state, cfg, opts) {
  const base = apiBaseOf(ctx, cfg)
  const out = {
    generatedAt: nowIso(), version: VERSION, title: cfg.title,
    apiBase: base, listSource: 'api', apiOk: false, apiError: '', probe: null,
    memories: [], disk: null, corpus: null, sessions: [], issues: [],
    limits: {}, guidanceDir: guidanceDir(cfg), dataDir: dataDir(cfg), memoryDir: memoryDir(cfg),
  }
  // ① 列表：优先走它的 JSON API
  try {
    const r = await fetchWithTimeout(base + cfg.probePath, cfg.fetchTimeoutMs)
    if (r.status !== 200) throw new Error('GET ' + cfg.probePath + ' → HTTP ' + r.status)
    const data = JSON.parse(r.text)
    out.probe = {
      plugin: data.plugin || '', version: data.version || '', ok: data.ok === true,
      pid: data.pid || 0, dir: data.dir || '', startedAt: data.startedAt || '',
      config: data.config || {}, stats: data.stats || {},
      pending: Array.isArray(data.pending) ? data.pending : [],
      lastCount: data.last ? Object.keys(data.last).length : 0,
    }
    out.apiOk = true
    const list = Array.isArray(data.memories) ? data.memories : []
    out.memories = list.map((x) => ({
      sessionId: String(x.sessionId || ''), bytes: Number(x.bytes) || 0,
      mtime: String(x.mtime || ''), file: String(x.file || ''),
    })).filter((x) => x.sessionId)
  } catch (error) { out.apiError = errText(error) }
  // ② 磁盘对账（只读；API 挂了就用它兜底列表）
  out.disk = listDiskMemories(cfg)
  if (!out.memories.length && out.disk.files.length) {
    out.listSource = 'disk'
    out.memories = out.disk.files.map((f) => ({ sessionId: f.sessionId, bytes: f.bytes, mtime: f.mtime, file: path.join(cfg && out.disk.dir ? out.disk.dir : memoryDir(cfg), f.sessionId + '.md') }))
  }
  const limitBytes = Number(out.probe && out.probe.config && out.probe.config.maxMemoryBytes) || 0
  out.limits = { maxMemoryBytes: limitBytes, staleHoursOnline: cfg.staleHoursOnline, staleHoursOffline: cfg.staleHoursOffline }

  // ③ 正文：按 (bytes, mtime) 缓存，只重取变过的；并发受控（共用一个 node 进程，别把事件循环占满）
  const list = out.memories.slice(0, Math.max(1, Number(cfg.maxSessions) || 300))
  const todo = []
  for (const mem of list) {
    const cached = state.cache.get(mem.sessionId)
    if (cached && cached.bytes === mem.bytes && cached.mtime === mem.mtime) { mem.text = cached.text; mem.from = 'cache'; continue }
    todo.push(mem)
  }
  let cursor = 0
  const workerCount = Math.max(1, Math.min(Number(cfg.concurrency) || 6, todo.length || 1))
  const workers = []
  for (let w = 0; w < workerCount; w += 1) {
    workers.push((async () => {
      while (cursor < todo.length) {
        const mem = todo[cursor]
        cursor += 1
        let text = null
        try {
          const r = await fetchWithTimeout(base + cfg.filePath + '?id=' + encodeURIComponent(mem.sessionId), cfg.fetchTimeoutMs)
          if (r.status === 200) { text = r.text; mem.from = 'api' }
          else mem.error = 'GET ' + cfg.filePath + '?id=' + mem.sessionId + ' → HTTP ' + r.status + ' ' + oneLiner(r.text, 120)
        } catch (error) { mem.error = errText(error) }
        if (text === null) {
          // 兜底：直接读它的产物文件（**只读**）。API 挂了也要能看。
          try { text = fs.readFileSync(memoryPath(cfg, mem.sessionId), 'utf8'); mem.from = 'disk-fallback' }
          catch (error) { mem.error = (mem.error ? mem.error + ' / ' : '') + errText(error); text = '' }
        }
        mem.text = text
        state.cache.set(mem.sessionId, { bytes: mem.bytes, mtime: mem.mtime, text: text })
      }
    })())
  }
  await Promise.all(workers)
  // 缓存别无限长
  if (state.cache.size > 800) {
    const keep = new Set(out.memories.map((m) => m.sessionId))
    for (const key of Array.from(state.cache.keys())) if (!keep.has(key)) state.cache.delete(key)
  }

  // ④ 在线状态 + 会话名字 + 指导
  const live = liveAgents(ctx)
  const titles = readTitles()
  const guidance = readAllGuidance(cfg, out.memories.map((m) => m.sessionId))
  const mirror = new Map()
  for (const m of out.memories) mirror.set(m.sessionId, readMirror(cfg, m.sessionId))
  const now = Date.now()
  for (const mem of out.memories) {
    const parsed = parseMemory(mem.text)
    const counts = new Map()
    for (const t of parsed.sectionTitles) counts.set(t, (counts.get(t) || 0) + 1)
    const dupes = Array.from(counts.entries()).filter((p) => p[1] > 1).map((p) => p[0] + '×' + p[1])
    const mtimeMs = Date.parse(mem.mtime) || 0
    const norm = normId(mem.sessionId)
    const agent = live.get(norm) || null
    const meta = titles.get(norm) || {}
    const reconcile = { head: parsed.headBytes, sections: parsed.sectionsBytes, file: mem.bytes }
    const budget = splitBudget(parsed)
    out.sessions.push({
      sessionId: mem.sessionId, short: shortId(mem.sessionId),
      name: meta.title ? oneLiner(meta.title, 40) : (agent && agent.cwd ? path.basename(String(agent.cwd)) : (meta.cwd ? path.basename(meta.cwd) : '')),
      title: meta.title || '', online: Boolean(agent), liveStatus: agent ? agent.status : '',
      bytes: mem.bytes, mtime: mem.mtime, mtimeMs: mtimeMs, ageMs: mtimeMs ? now - mtimeMs : 0,
      ageHours: mtimeMs ? (now - mtimeMs) / 3600000 : 0,
      sections: parsed.sections, sectionTitles: parsed.sectionTitles, duplicateSections: dupes,
      headBytes: parsed.headBytes, headText: parsed.headText,
      updatedText: parsed.updatedText, round: parsed.round, model: parsed.model,
      text: mem.text, from: mem.from || '', error: mem.error || '',
      reconcile: reconcile, reconcileDiff: (parsed.headBytes + parsed.sectionsBytes) - mem.bytes,
      feedBytes: budget.feedBytes, distilledBytes: budget.distilledBytes, feedSections: budget.feedSections,
      guidance: guidance.get(mem.sessionId) || { entries: [], exists: false, file: guidanceFile(cfg, mem.sessionId) },
      mirror: mirror.get(mem.sessionId) || readMirror(cfg, mem.sessionId),
    })
  }
  // ⑤ 接线状态（现场解析：契约文件 + 本体路由。必须排在规则判定之前，E11 要用它）
  out.contractDir = guidanceMirrorDir(cfg)
  out.contractDirExists = fs.existsSync(out.contractDir)
  out.wiringProbe = await probeGuidanceRoute(ctx, cfg, state)
  const wiringInfo = {
    version: (out.probe && out.probe.version) || '', contractDir: out.contractDir, contractDirExists: out.contractDirExists,
    routeUrl: out.wiringProbe.url, routeStatus: out.wiringProbe.status, routeMounted: out.wiringProbe.mounted === true,
  }
  const readProbes = new Map()
  const askedSessions = out.sessions.filter((s) => ((s.mirror && s.mirror.entries) ? s.mirror.entries.length : 0) > 0).slice(0, 20)
  for (const s of askedSessions) {
    readProbes.set(s.sessionId, await probeGuidanceForSession(ctx, cfg, state, s.sessionId))
  }
  for (const s of out.sessions) {
    s.wiring = wiringForSession(s, s.mirror || { file: guidanceMirrorFile(cfg, s.sessionId), exists: false, bytes: 0, entries: [] },
      out.wiringProbe, wiringInfo, readProbes.get(s.sessionId) || null)
  }
  out.wiringReads = Array.from(readProbes.values()).map((r) => ({ sessionId: r.sessionId, url: r.url, status: r.status, exists: r.exists, count: r.count, fileBytes: r.fileBytes }))
  out.wiring = wiringInfo

  // ⑥ 语料自校准 + 规则判定
  out.corpus = buildCorpus(out.sessions, cfg)
  for (const s of out.sessions) {
    const verdict = judgeSession(s, out.corpus, cfg, limitBytes)
    s.level = verdict.level
    s.issues = verdict.issues
  }
  const rank = { bad: 0, warn: 1, ok: 2 }
  out.sessions.sort((a, b) => (rank[a.level] - rank[b.level]) || (b.ageMs - a.ageMs) || a.short.localeCompare(b.short))
  const bad = out.sessions.filter((s) => s.level === 'bad').length
  const warn = out.sessions.filter((s) => s.level === 'warn').length
  out.counts = {
    sessionsListed: out.sessions.length,
    diskFiles: out.disk.files.length,
    apiMemories: out.memories.length,
    bad: bad, warn: warn, ok: out.sessions.length - bad - warn,
    online: out.sessions.filter((s) => s.online).length,
    withSections: out.corpus.withSections,
    guidanceSessions: out.sessions.filter((s) => s.guidance.entries.length > 0).length,
    wiringRead: out.sessions.filter((s) => s.wiring && s.wiring.status === 'read').length,
    wiringContractWritten: out.sessions.filter((s) => s.wiring && s.wiring.status === 'contract-written').length,
    wiringCopyOnly: out.sessions.filter((s) => s.wiring && s.wiring.status === 'copy-only').length,
    wiringNone: out.sessions.filter((s) => s.wiring && s.wiring.status === 'none').length,
    wiringMismatch: out.sessions.filter((s) => s.wiring && (s.wiring.status === 'contract-mismatch' || s.wiring.status === 'read-partial')).length,
    wiringPending: out.sessions.filter((s) => s.wiring && s.wiring.status === 'read-pending').length,
    wiringDrift: out.sessions.filter((s) => s.wiring && s.wiring.status === 'read-with-drift').length,
    wiringRouteOnly: out.sessions.filter((s) => s.wiring && s.wiring.status === 'route-only').length,
    reconcileMismatch: out.sessions.filter((s) => s.reconcileDiff !== 0).length,
  }
  out.verdict = buildVerdict(out)
  return out
}
function buildVerdict(data) {
  const c = data.counts
  const level = c.bad ? 'bad' : (c.warn ? 'warn' : 'ok')
  if (!data.apiOk && data.listSource === 'disk') {
    return { level: 'bad', text: '读不到本体 API（' + oneLiner(data.apiError, 90) + '）—— 下面是磁盘兜底的列表，内容可能滞后' }
  }
  if (!c.sessionsListed) {
    return { level: 'bad', text: '一份热记忆都没读到：API 说 ' + c.apiMemories + ' 份、磁盘 ' + c.diskFiles + ' 份、目录 ' + data.memoryDir }
  }
  const bits = []
  if (c.bad) bits.push('红 ' + c.bad)
  if (c.warn) bits.push('黄 ' + c.warn)
  if (!bits.length) bits.push('全部健康')
  return {
    level: level,
    text: c.sessionsListed + ' 个会话 · ' + bits.join(' / ') + ' · 在线 ' + c.online +
      ' · 磁盘 ' + c.diskFiles + ' 份 vs 本页 ' + c.sessionsListed + ' 份（差 ' + (c.diskFiles - c.sessionsListed) + '）' +
      (c.guidanceSessions ? ' · 有指导 ' + c.guidanceSessions + ' 个会话' : ''),
  }
}

// ===== 渲染（判据第一，好看第二）=====
const RULE_LEGEND = [
  ['E1', '记忆正文为空'], ['E2', '一个分区都没有'], ['E3', '缺标准分区（按语料覆盖率自校准）'],
  ['E4', '分区标题在、内容是空的'], ['E5', '分区只有占位（- 无 / 待补充 / TODO）→ 只作知情'],
  ['E5b', '一半以上分区是空的或只有占位（空壳记忆）'],
  ['E6', '蒸馏部分超预算（会被截断；投喂区不占预算）'], ['E6b', '单个分区就超预算'], ['E6c', '已达预算 80%'],
  ['E6f', '投喂区大小（不占预算，只作知情）'],
  ['E7', '正在跑的会话记忆太久没更新'], ['E7n', '在线但空闲（不更新是正常的）'],
  ['E7i', '离线会话的老记忆（归档，不算问题）'],
  ['E8', '缺「更新：」元信息行'], ['E9', '同名分区出现多次'], ['E10', '指导之后记忆没再更新'],
  ['E11', '接线状态（现场解析：契约文件 + 本体路由 + 返回内容）'], ['E11b', '指导只在面板副本里，本体读不到'],
  ['E12', '字节对账不平（取内容时文件被改过）'],
]
function renderIssues(issues) {
  if (!issues.length) return '<div class="ok-line">没有发现问题（按上面 ' + RULE_LEGEND.length + ' 条规则）</div>'
  return '<ul class="issues">' + issues.map((i) =>
    '<li class="' + escapeHtml(i.level) + '"><span class="code">' + escapeHtml(i.code) + '</span>' + escapeHtml(i.text) + '</li>').join('') + '</ul>'
}
function renderSections(s) {
  if (!s.sections.length) return '<div class="empty">这份记忆里没有任何 “## 分区”</div>'
  const rows = s.sections.map((sec) => {
    const flag = sec.empty ? '<span class="chip bad">空</span>'
      : (sec.placeholderOnly ? '<span class="chip warn">占位</span>' : '<span class="chip ok">有内容</span>')
    return '<tr><td>' + escapeHtml(sec.title) + '</td><td class="num">' + sec.bullets + '</td><td class="num">' + sec.bytes +
      ' B</td><td>' + flag + '</td><td class="snip">' + escapeHtml(oneLiner(sec.text, 110)) + '</td></tr>'
  }).join('')
  return '<table class="secs"><tr><th>分区</th><th>条目</th><th>字节</th><th>判定</th><th>开头（前 110 字）</th></tr>' + rows + '</table>'
}
// 接线状态块：**全部来自现场**（s.wiring 是 collect 里现解析出来的，没有一个字是写死的）
function renderWiring(s) {
  const w = s.wiring
  if (!w) return ''
  const label = {
    read: '已接线 · 本体已读（并渲染进记忆）', 'read-pending': '已接线 · 本体已读 · 待渲染进记忆',
    'read-with-drift': '已接线，但有历史条目没进契约位置',
    'read-partial': '已接线但条数不一致', 'contract-mismatch': '契约对不上（本体读不到/读成 0 条）',
    'contract-written': '已按契约写好 · 本体路由未挂载', 'route-only': '契约已就位 · 问不到本体读数',
    'copy-only': '未接线（历史条目只在副本里）', none: '没下过指导',
  }[w.status] || w.status
  return '<div class="wired ' + escapeHtml(w.status) + '">接线状态：<b>' + escapeHtml(label) + '</b> · ' + escapeHtml(w.text) +
    '<div class="dim ev">判据（现场解析）：' + (w.evidence || []).map((x) => escapeHtml(x)).join(' · ') + '</div></div>'
}
function renderWiringTail(s, cfg) {
  return '<div class="dim ev">写入位置：契约 ' + escapeHtml(guidanceMirrorFile(cfg, s.sessionId)) +
    (s.mirror && s.mirror.exists ? '（' + (s.mirror.entries || []).length + ' 条 / ' + s.mirror.bytes + ' B）' : '（还没有）') +
    ' · 面板副本 ' + escapeHtml(s.guidance.file || guidanceFile(cfg, s.sessionId)) +
    (s.guidance.exists ? '（' + s.guidance.entries.length + ' 条）' : '（还没有）') + '</div>'
}
function renderGuidance(s, cfg) {
  const list = s.guidance.entries.length
    ? '<ul class="gd-list">' + s.guidance.entries.slice(-6).map((g) =>
      '<li><span class="when">' + escapeHtml(g.at) + '</span><span class="tag">' + escapeHtml(g.section) + '</span>' +
      escapeHtml(oneLiner(g.text, 200)) + '</li>').join('') + '</ul>'
    : '<div class="empty">还没给这个会话下过人工指导</div>'
  const opts = ['整体'].concat(s.sectionTitles).map((t) => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join('')
  return '<div class="gd">' +
    '<div class="gd-head">人工指导 · 落盘到 <span class="mono">' + escapeHtml(s.guidance.file || guidanceFile(cfg, s.sessionId)) + '</span>' +
    (s.guidance.exists ? '（' + s.guidance.entries.length + ' 条 · ' + humanBytes(s.guidance.bytes) + ' · ' + escapeHtml(s.guidance.mtime) + '）' : '（还没建）') + '</div>' +
    list +
    '<form class="gd-form" data-session="' + escapeHtml(s.sessionId) + '">' +
    '<select class="gd-sec">' + opts + '</select>' +
    '<textarea class="gd-text" rows="2" placeholder="给这个会话的人工指导（例：把「未决问题」里那两条删掉，只留正在做的那条）"></textarea>' +
    '<button type="submit" class="btn">下发指导</button><span class="hint"></span>' +
    '</form>' +
    renderWiring(s) + renderWiringTail(s, cfg) +
    '</div>'
}
function renderSession(s, cfg, idx, limitBytes) {
  // limitBytes 就是本体探针里报的 maxMemoryBytes（预算），用在「蒸馏 X/预算」这一栏
  const chip = s.level === 'bad' ? '<span class="chip bad">红</span>'
    : (s.level === 'warn' ? '<span class="chip warn">黄</span>' : '<span class="chip ok">绿</span>')
  const live = s.online
    ? '<span class="pill ' + (s.liveStatus === 'running' ? 'busy' : 'idle') + '">' + escapeHtml(s.liveStatus === 'running' ? '在跑' : '在线·空闲') + '</span>'
    : '<span class="pill off">离线</span>'
  const actCount = s.issues.filter((i) => i.level === 'bad' || i.level === 'warn').length
  const infoCount = s.issues.filter((i) => i.level === 'info').length
  const open = s.level === 'ok' ? '' : ' open'
  return '<details class="sess" data-level="' + escapeHtml(s.level) + '" id="s-' + idx + '"' + open + '>' +
    '<summary>' + chip + ' <b>' + escapeHtml(s.name || s.short) + '</b>' +
    ' <span class="mono dim">' + escapeHtml(s.short) + '</span> ' + live +
    ' <span class="stat">分区 ' + s.sections.length + '</span>' +
    ' <span class="stat' + (limitBytes > 0 && s.distilledBytes > limitBytes ? ' bad' : '') + '">蒸馏 ' + s.distilledBytes + '/' + (limitBytes || '?') + ' B</span>' +
    (s.feedBytes ? ' <span class="stat">投喂 ' + s.feedBytes + ' B</span>' : '') +
    ' <span class="stat">' + escapeHtml(s.ageText || '') + '前蒸馏</span>' +
    ' <span class="stat">第 ' + (s.round || '?') + ' 轮</span>' +
    (actCount ? ' <span class="stat bad">' + actCount + ' 个要处理</span>' : '') +
    (infoCount ? ' <span class="stat">知情 ' + infoCount + '</span>' : '') +
    '</summary>' +
    '<div class="body">' +
    '<div class="meta">记忆：<span class="mono">' + escapeHtml(path.join(memoryDir(cfg), s.sessionId + '.md')) + '</span>' +
    ' · 更新 ' + escapeHtml(s.updatedText || '（缺元信息）') + ' · 蒸馏模型 ' + escapeHtml(s.model || '?') +
    ' · 内容来源 ' + escapeHtml(s.from || '?') +
    (s.error ? ' · <span class="bad">取内容报错：' + escapeHtml(s.error) + '</span>' : '') + '</div>' +
    renderIssues(s.issues) +
    renderSections(s) +
    '<div class="recon">字节口径：整份 ' + s.bytes + ' B = 蒸馏部分 ' + s.distilledBytes + ' B（预算 ' + limitBytes + ' B）+ 投喂区 ' + s.feedBytes + ' B（不占预算）</div>' +
    '<div class="recon">字节对账：头部 ' + s.reconcile.head + ' + Σ分区 ' + s.reconcile.sections + ' − 文件 ' + s.reconcile.file +
    ' = <b class="' + (s.reconcileDiff === 0 ? 'good' : 'bad') + '">' + s.reconcileDiff + '</b> B</div>' +
    renderGuidance(s, cfg) +
    '</div></details>'
}
function renderPage(data, cfg) {
  const c = data.counts
  const legend = RULE_LEGEND.map((r) => '<span class="rule"><b>' + escapeHtml(r[0]) + '</b> ' + escapeHtml(r[1]) + '</span>').join(' · ')
  const corpus = '语料校准：' + data.corpus.withSections + '/' + c.sessionsListed + ' 份有分区结构；' +
    Object.keys(data.corpus.coverage).map((t) => t + ' ' + Math.round(data.corpus.coverage[t] * 100) + '%').join(' · ') +
    '（覆盖率 < ' + Math.round(cfg.standardCoverageFloor * 100) + '% 的分区名不参与 E3，避免本体改格式时全变红）'
  const top = data.corpus.top.map((t) => '<span class="rule">' + escapeHtml(t.title) + ' ×' + t.count + '</span>').join(' ')
  const d = data.disk
  const reconcileLine = '对账：磁盘 .md <b>' + c.diskFiles + '</b> 份 / 本体 API memories <b>' + c.apiMemories + '</b> 份 / 本页列出 <b>' +
    c.sessionsListed + '</b> 份 —— 磁盘−本页 = <b class="' + (c.diskFiles === c.sessionsListed ? 'good' : 'bad') + '">' +
    (c.diskFiles - c.sessionsListed) + '</b>' + (d && d.error ? ' · 读磁盘报错：' + escapeHtml(d.error) : '')
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(data.title) + '</title><style>' + PAGE_CSS + '</style></head><body>' +
    '<header><h1>' + escapeHtml(data.title) + ' <span class="v">v' + escapeHtml(data.version) + '</span></h1>' +
    '<div class="verdict ' + escapeHtml(data.verdict.level) + '">' + escapeHtml(data.verdict.text) + '</div>' +
    '<div class="src">数据源（只读）：<span class="mono">GET ' + escapeHtml(data.apiBase + cfg.probePath) + '</span>（列表/探针）· ' +
    '<span class="mono">GET ' + escapeHtml(data.apiBase + cfg.filePath) + '?id=&lt;sessionId&gt;</span>（单份正文）' +
    ' · 本体 ' + escapeHtml((data.probe && data.probe.plugin) || '?') + ' v' + escapeHtml((data.probe && data.probe.version) || '?') +
    ' pid ' + escapeHtml(String((data.probe && data.probe.pid) || '?')) +
    ' · 记忆目录 <span class="mono">' + escapeHtml(data.memoryDir) + '</span>' +
    ' · 本页每 ' + cfg.refreshSeconds + ' 秒自刷（只重取变过的：<span class="mono">bytes+mtime</span> 命中缓存）' +
    ' · 生成于 ' + escapeHtml(data.generatedAt) + '</div>' +
    '<div class="src">' + reconcileLine + '</div>' +
    '<div class="src">接线契约（R24）：指导双写 → 契约位置 <span class="mono">' + escapeHtml(data.contractDir || '') + '</span>（' +
    (data.contractDirExists ? '目录在' : '目录待建，第一次写入时自建') + '，由 dsh-hot-memory 读取）· 面板副本 <span class="mono">' +
    escapeHtml(data.guidanceDir) + '</span> · 本体路由 <span class="mono">GET ' + escapeHtml((data.wiring && data.wiring.routeUrl) || '') + '</span> → <b class="' +
    ((data.wiring && data.wiring.routeMounted) ? 'good' : 'bad') + '">' + escapeHtml(String((data.wiring && data.wiring.routeStatus) || '无响应')) + '</b>' +
    ((data.wiring && data.wiring.routeMounted) ? '（已挂载；400=缺 id 属正常，带 ?id= 才是读数）' : '（未挂载：本体还没上线这个路由）') +
    ' · 已接线 ' + (data.counts.wiringRead || 0) + ' / 契约已写 ' + (data.counts.wiringContractWritten || 0) +
    ' / 待渲染 ' + (data.counts.wiringPending || 0) + ' / 历史漂移 ' + (data.counts.wiringDrift || 0) + ' / 契约对不上 ' + ((data.counts.wiringMismatch || 0)) +
    ' / 未接线 ' + (data.counts.wiringCopyOnly || 0) + ' 个会话</div>' +
    (data.apiError ? '<div class="src bad">API 报错：' + escapeHtml(data.apiError) + '</div>' : '') +
    '</header>' +
    '<section class="legend"><div class="lt">规则（红色=要处理 / 黄色=要看一眼 / 灰色=知情）</div><div>' + legend + '</div>' +
    '<div class="lt2">' + escapeHtml(corpus) + '</div><div class="top">现场分区排行：' + top + '</div></section>' +
    '<div class="bar"><label><input type="checkbox" id="onlyProb"> 只看红/黄</label>' +
    '<span class="counts">红 ' + c.bad + ' · 黄 ' + c.warn + ' · 绿 ' + c.ok + ' · 有指导 ' + c.guidanceSessions +
    ' · 对账不平 ' + c.reconcileMismatch + '</span>' +
    '<span class="counts">本体配置：上限 ' + (data.limits.maxMemoryBytes || '?') + ' B · 在线判定阈值 ' + data.limits.staleHoursOnline + ' 小时</span></div>' +
    '<main>' + data.sessions.map((s, i) => renderSession(s, cfg, i, data.limits.maxMemoryBytes)).join('') + '</main>' +
    '<footer>dsh-hot-memory-panel v' + escapeHtml(data.version) + ' · 只读消费 dsh-hot-memory 的 JSON API，只写自己的指导文件（' +
    escapeHtml(data.guidanceDir) + '）· 本页 ?json=1 给的就是同一份数据</footer>' +
    '<script>' + pageJs(cfg.refreshSeconds) + '</script></body></html>'
}
const PAGE_CSS = [
  ':root{--bg:#12141a;--fg:#e6e8ee;--dim:#9aa3b2;--card:#1b1f28;--line:#2b3140;--bad:#ff6b6b;--warn:#ffb84d;--ok:#4dd08a;--info:#7aa7ff}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Microsoft YaHei",system-ui,sans-serif}',
  'header{padding:14px 18px 10px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}',
  'h1{margin:0 0 8px;font-size:19px}.v{color:var(--dim);font-size:12px;font-weight:400}',
  '.verdict{padding:8px 12px;border-radius:6px;font-size:16px;font-weight:700;margin-bottom:8px}',
  '.verdict.bad{background:#3a1b1b;color:var(--bad)}.verdict.warn{background:#3a301b;color:var(--warn)}.verdict.ok{background:#1b3a29;color:var(--ok)}',
  '.src{color:var(--dim);font-size:12px;margin:2px 0}.src b{color:var(--fg)}',
  '.mono{font-family:Consolas,monospace}.dim{color:var(--dim)}.good{color:var(--ok)}.bad{color:var(--bad)}',
  '.legend{padding:10px 18px;border-bottom:1px solid var(--line);font-size:12px;color:var(--dim)}',
  '.lt{font-weight:700;color:var(--fg);margin-bottom:4px}.lt2{margin-top:6px}.top{margin-top:6px}',
  '.rule{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 6px;margin:2px 4px 2px 0}',
  '.rule b{color:var(--info)}',
  '.bar{display:flex;gap:16px;align-items:center;padding:8px 18px;border-bottom:1px solid var(--line);font-size:13px}',
  '.counts{color:var(--dim)}',
  'main{padding:12px 18px 40px}',
  'details.sess{background:var(--card);border:1px solid var(--line);border-left-width:4px;border-radius:6px;margin-bottom:8px}',
  'details.sess[data-level=bad]{border-left-color:var(--bad)}details.sess[data-level=warn]{border-left-color:var(--warn)}details.sess[data-level=ok]{border-left-color:var(--ok)}',
  'summary{cursor:pointer;padding:8px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
  '.stat{color:var(--dim);font-size:12px}.stat.bad{color:var(--bad);font-weight:700}',
  '.chip{display:inline-block;border-radius:4px;padding:0 6px;font-size:12px;font-weight:700}',
  '.chip.bad{background:#4a1f1f;color:var(--bad)}.chip.warn{background:#4a3c1f;color:var(--warn)}.chip.ok{background:#1f4a33;color:var(--ok)}',
  '.pill{border-radius:10px;padding:0 8px;font-size:12px}.pill.busy{background:#1f4a33;color:var(--ok)}.pill.idle{background:#243049;color:var(--info)}.pill.off{background:#2b3140;color:var(--dim)}',
  '.body{padding:4px 12px 12px;border-top:1px solid var(--line)}',
  '.meta{color:var(--dim);font-size:12px;margin:6px 0}',
  'ul.issues{list-style:none;margin:6px 0;padding:0}ul.issues li{padding:4px 8px;margin:3px 0;border-radius:4px;background:#20242e}',
  'ul.issues li.bad{border-left:3px solid var(--bad)}ul.issues li.warn{border-left:3px solid var(--warn)}ul.issues li.info{border-left:3px solid var(--info)}',
  '.code{font-family:Consolas,monospace;color:var(--info);font-weight:700;margin-right:6px}',
  '.ok-line{color:var(--ok);font-size:13px;margin:6px 0}',
  'table.secs{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0}',
  'table.secs th,table.secs td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}',
  'table.secs th{color:var(--dim);font-weight:400}table.secs td.num{text-align:right;font-family:Consolas,monospace}',
  '.snip{color:var(--dim);font-size:12px}',
  '.recon{color:var(--dim);font-size:12px;margin:4px 0 10px}',
  '.gd{border-top:1px dashed var(--line);padding-top:8px;margin-top:6px}',
  '.gd-head{font-size:12px;color:var(--dim);margin-bottom:4px}',
  'ul.gd-list{list-style:none;margin:4px 0;padding:0;font-size:13px}ul.gd-list li{padding:3px 0;border-bottom:1px solid var(--line)}',
  '.when{font-family:Consolas,monospace;color:var(--info);margin-right:6px}',
  '.tag{display:inline-block;background:#243049;color:var(--info);border-radius:4px;padding:0 6px;margin-right:6px;font-size:12px}',
  '.gd-form{display:flex;gap:8px;align-items:flex-start;margin-top:6px;flex-wrap:wrap}',
  '.gd-sec{background:#12141a;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:5px;max-width:200px}',
  '.gd-text{flex:1;min-width:260px;background:#12141a;color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:6px;font:13px/1.4 inherit}',
  '.btn{background:#2f6df6;color:#fff;border:0;border-radius:4px;padding:7px 12px;cursor:pointer}',
  '.hint{font-size:12px;color:var(--dim)}.hint.ok{color:var(--ok)}.hint.err{color:var(--bad)}',
  '.wired{font-size:12px;margin-top:6px;color:var(--dim)}',
  '.wired.read{color:var(--ok)}.wired.contract-written{color:var(--info)}.wired.copy-only{color:var(--warn)}',
  '.wired b{color:inherit}.ev{font-size:11px;color:var(--dim);margin-top:2px;word-break:break-all}',
  '.empty{color:var(--dim);font-size:13px;padding:4px 0}',
  'footer{padding:14px 18px;color:var(--dim);font-size:12px;border-top:1px solid var(--line)}',
].join('')
function pageJs(refreshSeconds) { return [
  '(function(){',
  'var box=document.getElementById("onlyProb");',
  'function applyFilter(){var on=box&&box.checked;var els=document.querySelectorAll("details.sess");',
  'for(var i=0;i<els.length;i++){var lv=els[i].getAttribute("data-level");els[i].style.display=(on&&lv==="ok")?"none":"";}}',
  'if(box){box.addEventListener("change",applyFilter);applyFilter();}',
  'var forms=document.querySelectorAll("form.gd-form");',
  'for(var i=0;i<forms.length;i++){(function(f){',
  'f.addEventListener("submit",function(ev){ev.preventDefault();',
  'var hint=f.querySelector(".hint");var ta=f.querySelector(".gd-text");var sel=f.querySelector(".gd-sec");',
  'var text=(ta.value||"").trim();',
  'if(!text){hint.textContent="内容是空的，没写";hint.className="hint err";return;}',
  'hint.textContent="正在写…";hint.className="hint";',
  'fetch("/hot-memory-panel/guidance",{method:"POST",headers:{"content-type":"application/json; charset=utf-8"},',
  'body:JSON.stringify({sessionId:f.getAttribute("data-session"),section:sel?sel.value:"",text:text})})',
  '.then(function(r){return r.json();}).then(function(j){',
  'if(j&&j.ok){hint.textContent="已落盘两处（回读校验通过）：契约 "+(j.mirror?j.mirror.file:"-")+" · 副本 "+j.file+" · "+j.entries+" 条";hint.className="hint ok";ta.value="";',
  'setTimeout(function(){location.reload();},1200);}',
  'else{hint.textContent="没写成："+((j&&j.error)||"未知错误");hint.className="hint err";}',
  '}).catch(function(e){hint.textContent="请求失败："+e.message;hint.className="hint err";});',
  '});})(forms[i]);}',
  'setTimeout(function(){location.reload();},' + (Math.max(5, Number(refreshSeconds) || 15) * 1000) + ');',
  '})();',
].join('\n') }

// ===== 路由 =====
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value, null, 2))
}
function readJsonBody(req) {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => { text += chunk; if (text.length > 65536) { resolve(null); req.destroy() } })
    req.on('end', () => { try { resolve(JSON.parse(text || '{}')) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}
async function handleGuidance(ctx, state, cfg, req, res) {
  try {
    const body = await readJsonBody(req)
    if (!body) { sendJson(res, 200, { ok: false, error: '请求体不是合法 JSON' }); return }
    const sessionId = String(body.sessionId || '').trim()
    const text = String(body.text == null ? '' : body.text).trim()
    if (!sessionId) { sendJson(res, 200, { ok: false, error: '缺 sessionId' }); return }
    if (!text) { sendJson(res, 200, { ok: false, error: '指导内容是空的，没写' }); return }
    if (text.length > 4000) { sendJson(res, 200, { ok: false, error: '指导太长（上限 4000 字），先拆开写' }); return }
    const dupId = sessionId + '|' + hashKey(text)
    const last = state.submitted.get(dupId)
    if (typeof last === 'number' && Date.now() - last < cfg.dedupeSeconds * 1000) {
      sendJson(res, 200, { ok: true, saved: false, deduped: true, note: '一分钟内同一条重复提交，已忽略（没有重复写文件）' })
      return
    }
    const out = appendGuidance(cfg, sessionId, String(body.section || '').trim(), text, String(body.source || '面板'))
    if (out.ok) {
      state.submitted.set(dupId, Date.now())
      // 刚写完，本体读数缓存立刻作废 —— 否则 1.2 秒后页面自刷会拿旧条数误报「契约对不上」（实测踩到过）
      if (state.guidanceReadCache) state.guidanceReadCache.delete(sessionId)
      state.wiringCache = null
    }
    if (state.submitted.size > 500) {
      const now = Date.now()
      for (const pair of Array.from(state.submitted.entries())) if (now - pair[1] > 600000) state.submitted.delete(pair[0])
    }
    sendJson(res, 200, out)
  } catch (error) { sendJson(res, 200, { ok: false, error: errText(error) }) }
}
function registerRoutes(ctx, state, cfg) {
  const server = webServerOf(ctx)
  if (!server || typeof server.register !== 'function') { warn('没有 webServer 服务，/hot-memory-panel 没挂上'); return false }
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/hot-memory-panel', 'http://127.0.0.1')
      const method = String(req.method || 'GET').toUpperCase()
      if (url.pathname === '/hot-memory-panel/guidance' && method === 'POST') { await handleGuidance(ctx, state, cfg, req, res); return }
      const data = await collect(ctx, state, cfg)
      if (url.searchParams.get('json') === '1') {
        sendJson(res, 200, {
          plugin: PLUGIN_ID, version: VERSION, ok: true, pid: process.pid,
          generatedAt: data.generatedAt, apiBase: data.apiBase, apiOk: data.apiOk, apiError: data.apiError,
          listSource: data.listSource, memoryDir: data.memoryDir, guidanceDir: data.guidanceDir,
          probe: data.probe, counts: data.counts, verdict: data.verdict, limits: data.limits,
          wiring: { contractDir: data.contractDir, contractDirExists: data.contractDirExists, routeUrl: data.wiring.routeUrl, routeStatus: data.wiring.routeStatus, routeMounted: data.wiring.routeMounted, routeError: data.wiringProbe.error || '' },
          wiringReads: data.wiringReads || [],
          contractDir: data.contractDir, contractDirExists: data.contractDirExists,
          corpus: data.corpus, disk: { dir: data.disk.dir, files: data.disk.files.length, error: data.disk.error },
          sessions: data.sessions.map((s) => ({
            sessionId: s.sessionId, short: s.short, name: s.name, online: s.online, liveStatus: s.liveStatus,
            bytes: s.bytes, mtime: s.mtime, round: s.round, updatedText: s.updatedText, level: s.level,
            issueCodes: s.issues.map((i) => i.code), issues: s.issues,
            sections: s.sections.map((x) => ({ title: x.title, bytes: x.bytes, bullets: x.bullets, empty: x.empty, placeholderOnly: x.placeholderOnly })),
            feedBytes: s.feedBytes, distilledBytes: s.distilledBytes, headBytes: s.headBytes, reconcileDiff: s.reconcileDiff, from: s.from,
            guidance: { file: s.guidance.file, exists: s.guidance.exists, bytes: s.guidance.bytes, entries: s.guidance.entries.length, last: s.guidance.entries.length ? s.guidance.entries[s.guidance.entries.length - 1].at : '' },
            mirror: { file: (s.mirror || {}).file || '', exists: Boolean(s.mirror && s.mirror.exists), bytes: (s.mirror && s.mirror.bytes) || 0, entries: (s.mirror && s.mirror.entries ? s.mirror.entries.length : 0) },
            wiring: s.wiring ? { status: s.wiring.status, level: s.wiring.level, text: s.wiring.text, evidence: s.wiring.evidence } : null,
          })),
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(renderPage(data, cfg))
    } catch (error) {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(PLUGIN_ID + ' 出错：' + errText(error))
      } catch { /* 忽略 */ }
    }
  }
  let mounted = 0
  try {
    ctx.effect(() => server.register({ kind: 'exact', path: '/hot-memory-panel', handler: handler }), PLUGIN_ID + ': /hot-memory-panel')
    mounted += 1
    ctx.effect(() => server.register({ kind: 'exact', path: '/hot-memory-panel/guidance', handler: handler }), PLUGIN_ID + ': /hot-memory-panel/guidance')
    mounted += 1
  } catch (error) { warn('路由注册失败：', errText(error)) }
  return mounted === 2
}

// ===== 工具（和页面 ?json=1 同一份数据）=====
function registerTool(ctx, state, cfg) {
  let service
  try { service = (ctx && ctx.tools && typeof ctx.tools.register === 'function') ? ctx.tools : ctx.get('tools') } catch { service = undefined }
  if (!service || typeof service.register !== 'function') { warn('没有 tools 服务，hot_memory_panel 没挂上'); return false }
  try {
    service.register({
      name: 'hot_memory_panel',
      description: '读「热记忆面板」同一份数据（不打开网页也能看）：会话数、磁盘/API 对账、每个会话的分区与字节、红黄判定（E1…E12）、人工指导落盘情况。只读，不改任何东西。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => {
        const data = await collect(ctx, state, cfg)
        return {
          version: VERSION, generatedAt: data.generatedAt, apiOk: data.apiOk, apiError: data.apiError,
          counts: data.counts, verdict: data.verdict, limits: data.limits, corpus: data.corpus,
          wiring: { contractDir: data.contractDir, routeUrl: data.wiring.routeUrl, routeStatus: data.wiring.routeStatus, routeMounted: data.wiring.routeMounted }, wiringReads: data.wiringReads || [],
          sessions: data.sessions.map((s) => ({
            sessionId: s.sessionId, short: s.short, online: s.online, liveStatus: s.liveStatus,
            bytes: s.bytes, distilledBytes: s.distilledBytes, feedBytes: s.feedBytes, mtime: s.mtime, round: s.round, level: s.level,
            issueCodes: s.issues.map((i) => i.code),
            sections: s.sections.map((x) => ({ title: x.title, bytes: x.bytes, bullets: x.bullets, empty: x.empty, placeholderOnly: x.placeholderOnly })),
            guidanceEntries: s.guidance.entries.length,
            guidanceMirrorEntries: s.mirror && s.mirror.entries ? s.mirror.entries.length : 0,
            wiringStatus: s.wiring ? s.wiring.status : '',
          })),
        }
      },
    })
    return true
  } catch (error) { warn('hot_memory_panel 注册失败：', errText(error)); return false }
}

// ===== 启动 =====
function start(ctx, cfg) {
  const state = { cache: new Map(), submitted: new Map() }
  ensureDir(dataDir(cfg))
  // 硬要求：契约目录不在就自建（本体上线后直接能读到）
  let contractDirMade = false
  try { if (!fs.existsSync(guidanceMirrorDir(cfg))) { fs.mkdirSync(guidanceMirrorDir(cfg), { recursive: true }); contractDirMade = true } } catch (error) { warn('契约目录建不了（写入时会再试一次并明确报错）：', errText(error)) }
  const routesOk = registerRoutes(ctx, state, cfg)
  const toolOk = registerTool(ctx, state, cfg)
  try {
    writeAtomic(path.join(dataDir(cfg), 'state.json'), JSON.stringify({
      plugin: PLUGIN_ID, version: VERSION, at: nowIso(), pid: process.pid,
      apiBase: apiBaseOf(ctx, cfg), memoryDir: memoryDir(cfg), guidanceDir: guidanceDir(cfg),
      contractDir: guidanceMirrorDir(cfg), contractDirMade: contractDirMade,
      routesOk: routesOk, toolOk: toolOk,
    }, null, 2) + '\n')
  } catch (error) { warn('写 state.json 失败：', errText(error)) }
  log('v' + VERSION + ' 就绪 · 面板 http://127.0.0.1:' + (Number(webServerOf(ctx) && webServerOf(ctx).port) || 3080) +
    '/hot-memory-panel · 只读 ' + apiBaseOf(ctx, cfg) + ' · 指导双写：契约 ' + guidanceMirrorDir(cfg) + ' + 副本 ' + guidanceDir(cfg))
  return { routesOk: routesOk, toolOk: toolOk }
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  try { return start(ctx, cfg) }
  catch (error) { warn('初始化失败（已降级，DSH 不受影响）：', errText(error)); return { routesOk: false, toolOk: false } }
}

// 自检用（verify.mjs 直接调这些纯函数，不走 HTTP）
export const __internals = {
  parseMemory, buildCorpus, judgeSession, appendGuidance, readGuidance, parseGuidance,
  renderPage, collect, DEFAULTS, PLUGIN_ID, VERSION,
  memoryDir, guidanceDir, guidanceFile, dataDir, memoryPath,
  guidanceMirrorDir, guidanceMirrorFile, mirrorGuard, wiringForSession,
}
