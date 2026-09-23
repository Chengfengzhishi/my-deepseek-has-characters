// dsh-hot-memory-plus —— 「热记忆」的增补件（不改 dsh-hot-memory 一行代码）
//
// 为什么不改 hot-memory 本体：**它正在被另一个会话开发**（R22 在给它加「中枢投喂」，index.js 的
// 注释里直接写着 R22 的字段）。两条会话改同一个文件 = 互相覆盖，而且查不出是谁覆盖的。
// 所以这里换一种合作方式：**只读它的产物**（<DSH_HOME>/hot-memory/<sessionId>.md），补它还没有的能力。
//
// 补的两条，都是从 meow-memory 蒸馏出来的（调研见 <工作区>\_research\meow-memory-调研与可借鉴点.md）：
//
//   ① 压缩后召回：会话被压缩（/compact 或 token 压力自动触发）后会"突然失忆"。
//      监听 compaction 事件 → 在压缩后的下一个步骤，把**本会话热记忆全文**注入一次。
//      为什么这里敢注入全文：热记忆是 ≤2KB 的短备忘，**只在压缩后注入一次**（约 500-800 token），
//      而不是每轮都注入 —— 一次性成本换回被甩掉的记性。这也是 meow-memory 那条做法里唯一
//      和我们「一行指针」哲学不冲突的部分。
//
//   ② 跨会话教训层：现在踩过的坑只留在各自的会话/文件里（比如 指挥台 把「测试手段本身要先被验证」
//      写成纪律，但那条纪律只在他自己的文件里）。这里给一个工作区级共享的 lessons.md，
//      任何会话用 lesson_write 写下教训、用 lesson_read 读；**并且只在它更新过时**注入一行指针
//      （≈40 token，不是每轮都有）—— 有新东西才打扰，这是「指针而非全文」的同一套取舍。
//
// 不做的（都在调研文档里写了理由）：内容注入/BM25 检索（和我们的成本赌注相反）、
// 客户端 UI（它靠读 React fiber 内部属性，DSH 一升级就断）、空闲"做梦"整理（我们已经是每轮蒸馏）。
//
// ===== 零依赖红线 =====
// profile 用 junction 链到本目录，node 从这里往上找不到 node_modules；解析失败会让
// cordis 插件树整体抛错、DSH 起不来。所以只用 node: 内置模块，apply 全程 try/catch，钩子全部 fail-open。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-hot-memory-plus'
// ★ 2026-09-22（重启前加固）：必须把 webServer 声明成【硬依赖】。
//   实测教训：只声明 tools 时，开机阶段 ctx.get('webServer') 还是 undefined，
//   下面那句软取会走 warn + return 的静默分支 —— 路由不注册，**但工具照旧可用**，
//   于是"工具好使"骗过了检查；本机 dsh-hot-memory-panel 就这么静默 404 过一次。
export const inject = ['tools', 'webServer']

const PLUGIN_ID = 'dsh-hot-memory-plus'
const VERSION = '0.1.0'

const DEFAULTS = {
  hotMemoryDir: '',            // 默认 <DSH_HOME>/hot-memory（和 hot-memory 插件一致）
  lessonsFile: '',             // 默认 <hotMemoryDir>/_shared/lessons.md
  recallOnCompaction: true,    // 压缩后召回
  recallMemoMaxBytes: 8192,    // 召回时附的热记忆正文上限
  maxLessonChars: 600,         // 单条教训的字符上限
  pointerOnLessonsChange: true,// 教训更新过才注入指针
  auditRecall: true,           // 压缩召回之后，回头量一次「有没有被真的读进去」
  auditAfterTurns: 2,          // 召回后过多少轮再看（配合「产物 mtime 必须比召回时刻新」）
  auditMaxTurns: 40,           // 超过这么多轮还没法量（热记忆一直没更新）就记一条「无法测量」
}

// ===== 小工具 =====
function log() { try { console.log('[' + PLUGIN_ID + ']', ...arguments) } catch { /* 忽略 */ } }
function warn() { try { console.warn('[' + PLUGIN_ID + ']', ...arguments) } catch { /* 忽略 */ } }
function errText(error) { return error && error.message ? String(error.message) : String(error) }
function homeDir() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : path.join(os.homedir(), '.dsh')
}
function workDir() { return path.join(homeDir(), PLUGIN_ID) }
function hotMemoryDir(cfg) {
  return cfg.hotMemoryDir && String(cfg.hotMemoryDir).trim()
    ? String(cfg.hotMemoryDir).trim()
    : path.join(homeDir(), 'hot-memory')
}
function lessonsPath(cfg) {
  return cfg.lessonsFile && String(cfg.lessonsFile).trim()
    ? String(cfg.lessonsFile).trim()
    : path.join(hotMemoryDir(cfg), '_shared', 'lessons.md')
}
function memoPath(cfg, sessionId) { return path.join(hotMemoryDir(cfg), String(sessionId) + '.md') }
function nowIso() { return new Date().toISOString() }
// 事件日志：钩子做的事必须留下可核查的痕迹，否则「召回发出去了」这句没法举证。
// （这个习惯是被一次静默热加载失败逼出来的：只看「没报错」等于没验证。）
function logEvent(record) {
  try {
    fs.mkdirSync(workDir(), { recursive: true })
    fs.appendFileSync(path.join(workDir(), 'events.jsonl'), JSON.stringify(Object.assign({ at: nowIso(), pid: process.pid }, record)) + '\n', 'utf8')
  } catch { /* fail-open：日志写不动也不影响对话 */ }
}
function recentEvents(limit) {
  try {
    const lines = fs.readFileSync(path.join(workDir(), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
    return lines.slice(-(limit || 10)).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
function stampOf(date) {
  const p = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
    ' ' + p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds())
}
function hhmm(date) { const p = (n) => String(n).padStart(2, '0'); return p(date.getHours()) + ':' + p(date.getMinutes()) }
function sessionIdOf(agent) {
  try { return String((agent && agent.session && agent.session.id) || (agent && agent.id) || '') } catch { return '' }
}
function shortId(id) { return String(id || '').replace(/^session-/, '').slice(0, 8) }
function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}
function clip(text, maxBytes) {
  const s = String(text || '')
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = s.slice(0, maxBytes)
  while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) out = out.slice(0, -1)
  return out + '\n…（超长已截断，完整内容看文件）'
}
// 与 @deepseek-ai/dsh-llm 的 createUserMessage 等价的本地实现（零依赖红线）
function deepFreeze(value, seen) {
  const marks = seen || new WeakSet()
  if (value === null || typeof value !== 'object' || marks.has(value)) return value
  marks.add(value)
  for (const key of Object.keys(value)) deepFreeze(value[key], marks)
  return Object.freeze(value)
}
function createUserMessage(input) {
  return deepFreeze(structuredClone(Object.assign({}, input, { role: 'user', id: randomUUID() })))
}
function message(text, form) {
  return createUserMessage({
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: form || 'recall' },
  })
}

// ===== 教训层（跨会话共享）=====
function normalizeLesson(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/[。．.,，;；]+$/, '').trim().toLowerCase()
}
function parseLessons(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- ')) continue
    // 形如：- 2026-09-20 10:55:12 [修饰系统] 【测试】正文
    const m = t.match(/^-\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[([^\]]*)\]\s*(?:【([^】]*)】)?\s*(.*)$/)
    if (!m) { out.push({ at: '', author: '', tag: '', text: t.slice(2) }); continue }
    out.push({ at: m[1], author: m[2], tag: m[3] || '', text: m[4] })
  }
  return out
}
// 「这个会话见过哪一版教训」要落盘：只放内存的话，插件每次重载都会把所有会话再提示一遍
// （实测：我自己这一轮就被重载重复提示了两次）—— 那违背了「只在更新时提示」这个承诺。
function seenPath() { return path.join(workDir(), 'seen.json') }
function loadSeen(state) {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenPath(), 'utf8'))
    for (const key of Object.keys(parsed || {})) state.seenLessons.set(key, Number(parsed[key]))
  } catch { /* 第一次跑没有这个文件，正常 */ }
}
function saveSeen(state) {
  try {
    fs.mkdirSync(workDir(), { recursive: true })
    fs.writeFileSync(seenPath(), JSON.stringify(Object.fromEntries(state.seenLessons)), 'utf8')
  } catch { /* fail-open */ }
}
function lessonsStat(cfg) {
  try {
    const stat = fs.statSync(lessonsPath(cfg))
    return { mtimeMs: stat.mtimeMs, size: stat.size, at: new Date(stat.mtimeMs) }
  } catch { return null }
}
function countLessons(cfg) {
  return parseLessons(readTextSafe(lessonsPath(cfg))).length
}
function appendLesson(cfg, options) {
  const file = lessonsPath(cfg)
  const text = String(options.text || '').trim().slice(0, cfg.maxLessonChars)
  if (!text) return { ok: false, error: '内容不能为空' }
  const existing = parseLessons(readTextSafe(file))
  const key = normalizeLesson(text)
  const dup = existing.find((e) => normalizeLesson(e.text) === key)
  if (dup) return { ok: true, added: false, deduped: true, total: existing.length, path: file, matched: dup }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tag = String(options.tag || '').trim()
  const line = '- ' + stampOf(new Date()) + ' [' + String(options.author || '匿名') + '] ' + (tag ? '【' + tag + '】' : '') + text + '\n'
  const head = fs.existsSync(file) ? '' : '# 工作区教训（跨会话共享 · dsh-hot-memory-plus）\n\n只追加。每条：- 时间 [谁] 【标签】正文\n\n'
  fs.appendFileSync(file, head + line, 'utf8')
  return { ok: true, added: true, deduped: false, total: existing.length + 1, path: file }
}

// ===== 召回审计：判断「材料送到了」还是「真的读进去了」=====
// 指挥台提的那条量：召唤注入之后，下一次热记忆里**是否仍带着被注入的关键项**。
// 能测出来 ⇒ 「模型把它读进去、蒸馏时保留了下来」的弱证据；测不出来 ⇒ 至少如实说它没留下痕迹。
// 前提是它自己刚写进教训层的那条：**产物 mtime 必须比判定时刻新**（否则拿旧备忘比对，
// 当然"全都还在"，那就是假绿）。
function normalizeForMatch(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[。．.,，;；:：、！？!?（）()【】\[\]"'“”‘’]/g, '').toLowerCase()
}
function bigrams(text) {
  const s = normalizeForMatch(text)
  const out = new Set()
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}
// 一条关键项「还在不在」：按字符二元组重合率判断，容忍重写/改写（蒸馏本来就会改写句子）
function stillPresent(bullet, memoText) {
  const b = bigrams(bullet)
  if (!b.size) return false
  const m = bigrams(memoText)
  let hit = 0
  for (const gram of b) if (m.has(gram)) hit += 1
  return hit / b.size >= 0.5
}
function bulletsOf(memoText) {
  const out = []
  for (const line of String(memoText || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- ')) continue
    const body = t.slice(2).trim()
    if (body.length >= 6 && !body.startsWith('【')) out.push(body)
    if (out.length >= 20) break
  }
  return out
}
function memoStat(cfg, sessionId) {
  try { const st = fs.statSync(memoPath(cfg, sessionId)); return { mtimeMs: st.mtimeMs, at: new Date(st.mtimeMs) } } catch { return null }
}
function auditPath() { return path.join(workDir(), 'audit.json') }
function loadAudit(state) {
  try {
    const parsed = JSON.parse(fs.readFileSync(auditPath(), 'utf8'))
    for (const id of Object.keys(parsed || {})) state.audit.set(id, parsed[id])
  } catch { /* 第一次跑没有，正常 */ }
}
function saveAudit(state) {
  try {
    fs.mkdirSync(workDir(), { recursive: true })
    fs.writeFileSync(auditPath(), JSON.stringify(Object.fromEntries(state.audit)), 'utf8')
  } catch { /* fail-open */ }
}

// ===== 注入内容 =====
function buildRecallText(cfg, sessionId, authorName) {
  const memoFile = memoPath(cfg, sessionId)
  const memo = readTextSafe(memoFile).trim()
  const lessons = parseLessons(readTextSafe(lessonsPath(cfg)))
  const parts = [
    '【压缩后召回 · ' + PLUGIN_ID + '】',
    '刚才这次会话被**压缩**了，压缩可能把之前的"记性"甩掉了。下面把这些材料补回来，然后继续干活：',
    '',
    '—— 本会话热记忆（原文' + (memo ? '' : '：还没有这份文件') + '）——',
    memo ? clip(memo, cfg.recallMemoMaxBytes) : '（' + memoFile + ' 不存在或还是空的）',
  ]
  if (lessons.length) {
    const lines = lessons.slice(-12).map((e) => '- ' + (e.at ? e.at + ' ' : '') + (e.tag ? '【' + e.tag + '】' : '') + e.text)
    parts.push('', '—— 工作区教训（跨会话共享，最近 ' + Math.min(12, lessons.length) + ' / 共 ' + lessons.length + ' 条）——')
    parts.push(lines.join('\n'))
    parts.push('（完整清单：' + lessonsPath(cfg) + '，读它用 lesson_read）')
  } else {
    parts.push('', '（工作区教训还是空的：' + lessonsPath(cfg) + '）')
  }
  parts.push('', '（' + PLUGIN_ID + '：压缩后只召回这一次，不会每轮都注入。）')
  return parts.join('\n')
}
function buildLessonsPointerText(cfg, stat) {
  const total = countLessons(cfg)
  // 措辞只说实话：真的刚更新才说「刚写下」；隔了很久的更新就说「最近更新于」——
  // 否则插件重载后那句「刚写下」就是假的（实测踩到过）。
  const fresh = Date.now() - stat.at.getTime() < 30 * 60 * 1000
  const when = fresh ? '刚刚更新' : '最近更新于 ' + stampOf(stat.at).slice(5, 16)
  return '【工作区教训' + (fresh ? '有更新' : '') + '】' + lessonsPath(cfg) + '（' + total + ' 条，' + when + '）' +
    ' —— 那是别的会话踩过的坑，和当前任务相关的话用 lesson_read 读一下，别重复踩。' +
    '（' + PLUGIN_ID + '：每会话只在教训变过时提示一次，重载也不会重复提示。）'
}

// ===== 钩子 =====
// 压缩事件 → 打标记；下一个 pre-step 时把召回消息插进这一批（而不是用 inject 抢时序）
function onSessionEvent(state, session, event) {
  try {
    const type = String((event && event.type) || '')
    if (type !== 'compaction/start' && type !== 'compaction/end') return
    let id = ''
    try { id = String((session && session.id) || '') } catch { id = '' }
    if (!id) return
    state.pendingRecall.set(id, nowIso())
    state.compactions += 1
    logEvent({ kind: 'compaction', sessionId: shortId(id), type })
  } catch { /* fail-open */ }
}
// 量一次「召回有没有留下痕迹」：条件是这个会话的热记忆在召回之后**真的更新过**
// （mtime 比召回时刻新）—— 否则拿旧备忘比对，当然"全都在"，那是假绿。
function auditPendingRecall(state, cfg, sessionId) {
  const entry = state.audit.get(sessionId)
  if (!entry) return
  entry.turns = (Number(entry.turns) || 0) + 1
  const stat = memoStat(cfg, sessionId)
  const fresh = stat && Number(stat.mtimeMs) > Number(entry.at)
  if (!fresh) {
    if (entry.turns >= cfg.auditMaxTurns) {
      logEvent({ kind: 'recall-audit-unmeasurable', sessionId: shortId(sessionId), turns: entry.turns, why: '热记忆在这些轮里没有更新过，无法判断' })
      state.audit.delete(sessionId); saveAudit(state)
    } else { saveAudit(state) }
    return
  }
  if (entry.turns < cfg.auditAfterTurns) { saveAudit(state); return }
  const memo = readTextSafe(memoPath(cfg, sessionId))
  const bullets = Array.isArray(entry.bullets) ? entry.bullets : []
  const kept = bullets.filter((b) => stillPresent(b, memo))
  const ratio = bullets.length ? Number((kept.length / bullets.length).toFixed(2)) : null
  const record = { at: nowIso(), sessionId: shortId(sessionId), turns: entry.turns, bullets: bullets.length, kept: kept.length, ratio, memoBytes: Buffer.byteLength(memo, 'utf8') }
  logEvent(Object.assign({ kind: 'recall-audit' }, record))
  state.auditResults.push(record)
  if (state.auditResults.length > 20) state.auditResults.shift()
  state.audit.delete(sessionId); saveAudit(state)
}
async function onPreStep(state, cfg, payload, next) {
  const decision = await next()
  try {
    if (!decision || decision.kind !== 'enter') return decision
    const sessionId = sessionIdOf(payload && payload.agent)
    if (!sessionId) return decision
    // 召回审计：与这一轮注不注入无关，每次 pre-step 都推进一格
    if (cfg.auditRecall) auditPendingRecall(state, cfg, sessionId)
    const extra = []
    if (cfg.recallOnCompaction && state.pendingRecall.has(sessionId)) {
      state.pendingRecall.delete(sessionId)
      extra.push(message(buildRecallText(cfg, sessionId), 'recall'))
      state.recalls += 1
      logEvent({ kind: 'recall', sessionId: shortId(sessionId), memoBytes: Buffer.byteLength(readTextSafe(memoPath(cfg, sessionId)), 'utf8'), lessons: countLessons(cfg) })
      if (cfg.auditRecall) {
        // 记下此刻要核对的关键项 + 时刻：之后拿「比这个时刻新的」那份备忘来比对
        state.audit.set(sessionId, { at: Date.now(), bullets: bulletsOf(readTextSafe(memoPath(cfg, sessionId))), turns: 0 })
        saveAudit(state)
      }
    } else if (cfg.pointerOnLessonsChange) {
      const stat = lessonsStat(cfg)
      if (stat && state.seenLessons.get(sessionId) !== stat.mtimeMs) {
        state.seenLessons.set(sessionId, stat.mtimeMs)
        saveSeen(state)
        extra.push(message(buildLessonsPointerText(cfg, stat), 'recall'))
        state.pointers += 1
        logEvent({ kind: 'pointer', sessionId: shortId(sessionId), lessons: countLessons(cfg) })
      }
    }
    if (!extra.length) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages.slice() : []
    return { kind: 'enter', messages: messages.concat(extra) }
  } catch (error) {
    warn('pre-step 注入失败（放行原批次）：', errText(error))
    return decision
  }
}

// ===== 注册 =====
function toolsService(ctx) {
  try { if (ctx && ctx.tools && typeof ctx.tools.register === 'function') return ctx.tools } catch { /* 忽略 */ }
  try { return ctx.get('tools') } catch { return undefined }
}
function registerTools(ctx, cfg) {
  const service = toolsService(ctx)
  if (!service || typeof service.register !== 'function') { warn('没有 tools 服务，lesson_* 没挂上'); return }
  const register = (definition) => {
    try { service.register(definition) } catch (error) { warn('工具注册失败 ' + definition.name + '：', errText(error)) }
  }
  register({
    name: 'lesson_write',
    description: '把一条「踩过的坑/该记住的规矩」写进工作区级共享教训（跨会话可见，所有会话都能读到）。内容会去重：同一条重复写不会重复入库。用于沉淀「这次学到的、下次别再犯的」东西。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '教训正文，一句话说清「什么情况下该怎么做/别怎么做」' },
        tag: { type: 'string', description: '可选标签，比如 测试 / 打包 / 门铃' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    execute: async (args, exec) => {
      const agent = exec && exec.agent
      let author = shortId(sessionIdOf(agent))
      try {
        const names = JSON.parse(readTextSafe(path.join(homeDir(), 'bell', 'index.json')))
        const alias = names && names.names && names.names[sessionIdOf(agent)]
        if (alias) author = String(alias)
      } catch { /* 没装门铃就用短 id */ }
      return appendLesson(cfg, { text: args && args.text, tag: args && args.tag, author })
    },
  })
  register({
    name: 'lesson_read',
    description: '读工作区级共享教训（别的会话踩过的坑）。用于开工前对一遍、或遇到难题时看看有没有人踩过。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几条（默认 20，上限 100），返回的是最近的' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    execute: async (args) => {
      const all = parseLessons(readTextSafe(lessonsPath(cfg)))
      const limit = Math.max(1, Math.min(100, Math.round(Number((args && args.limit) || 20) || 20)))
      return { path: lessonsPath(cfg), total: all.length, returned: Math.min(limit, all.length), entries: all.slice(-limit) }
    },
  })
}
function registerRoute(ctx, state, cfg) {
  let server
  try { server = ctx.get('webServer') } catch { server = undefined }
  if (!server || typeof server.register !== 'function') return
  const handler = (req, res) => {
    try {
      const stat = lessonsStat(cfg)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        plugin: PLUGIN_ID, version: VERSION, at: nowIso(),
        hotMemoryDir: hotMemoryDir(cfg),
        lessons: { path: lessonsPath(cfg), count: countLessons(cfg), mtime: stat ? stat.at.toISOString() : null },
        pendingRecall: Array.from(state.pendingRecall.keys()),
        counters: { compactions: state.compactions, recalls: state.recalls, pointers: state.pointers },
        config: { recallOnCompaction: cfg.recallOnCompaction, pointerOnLessonsChange: cfg.pointerOnLessonsChange },
        recent: recentEvents(8),
        recallAudit: {
          pending: Array.from(state.audit.keys()).map((id) => ({ session: shortId(id), turns: (state.audit.get(id) || {}).turns })),
          results: state.auditResults,
          note: 'ratio = 召回带过去的关键项里，有多少在这次召回之后新蒸馏出的热记忆里**还在**。它是「读进去了」的弱证据，不是强证据。',
        },
      }, null, 2))
    } catch (error) {
      try { res.writeHead(500); res.end('error: ' + errText(error)) } catch { /* 忽略 */ }
    }
  }
  try { ctx.effect(() => server.register({ kind: 'exact', path: '/hot-memory-plus', handler }), PLUGIN_ID + ': /hot-memory-plus') } catch { /* 忽略 */ }
}

function start(ctx, cfg) {
  fs.mkdirSync(workDir(), { recursive: true })
  const state = { pendingRecall: new Map(), seenLessons: new Map(), audit: new Map(), auditResults: [], compactions: 0, recalls: 0, pointers: 0 }
  loadSeen(state)
  loadAudit(state)
  registerTools(ctx, cfg)
  registerRoute(ctx, state, cfg)
  ctx.on('session/event', (session, event) => onSessionEvent(state, session, event))
  ctx.on('agent/pre-step', (payload, next) => onPreStep(state, cfg, payload, next))
  try {
    fs.writeFileSync(path.join(workDir(), 'state.json'), JSON.stringify({
      plugin: PLUGIN_ID, version: VERSION, at: nowIso(), pid: process.pid,
      hotMemoryDir: hotMemoryDir(cfg), lessonsPath: lessonsPath(cfg), lessons: countLessons(cfg),
    }, null, 2), 'utf8')
  } catch (error) { warn('写 state.json 失败：', errText(error)) }
  log('v' + VERSION + ' 就绪 · 压缩后召回=' + cfg.recallOnCompaction + ' · 教训层 ' + lessonsPath(cfg))
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  try { start(ctx, cfg) }
  catch (error) { warn('初始化失败（已降级，DSH 不受影响）：', errText(error)) }
}
