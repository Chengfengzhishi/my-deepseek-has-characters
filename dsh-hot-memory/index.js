// dsh-hot-memory —— DSH「热记忆」插件（阶段 1：记忆外置 + 一行指针）
//
// 做什么：
//   1) 每个会话每跑完一轮（session/event 里的 'turn/end'）→ 把本轮新增的消息/工具结果
//      压成材料，交给**便宜模型**蒸馏（provider/model 默认自动探测，可配置覆盖）；
//   2) 蒸馏结果覆盖写 <DSH_HOME>/hot-memory/<sessionId>.md（≤2KB，固定 5 个小节：
//      当前目标 / 已确认事实 / 未决问题 / 关键文件路径 / 最近决策）；
//       R23（2026-09-21）：5 小节之外再**加**「主题分区」+「分区索引」，索引落在文件头部，
//       读取器两种格式都吃（老文件原地可读、不用迁移），按主题可按需只取一区。
//   3) 下一轮只往会话里注入**一行指针**（≤80 token），绝不注入全文 ——
//      注入的全文会被后续每一次调用重放，那比重读还贵。
//
//   4b) R24（2026-09-21）：新增与「中枢投喂」同级的「人工指导（不参与蒸馏 · 原样保留）」节 ——
//      指导由人/面板写进 <DSH_HOME>/hot-memory/_guidance/<sessionId>.md，本体只读不改、逐字保留；
//      指针里带指导条数（无指导时指针格式一字不改）；读取走 /hot-memory/guidance。
//
//   4) R22（2026-09-20）：新增固定第 6 节「中枢投喂（不参与蒸馏 · 原样保留）」——
//      门铃信正文以【投喂】开头 ⇒ 由**代码**原样拼进第 6 节（不喂给蒸馏模型、不占 2KB 预算）；
//      条目行尾带机器标记 〔tN〕（N=捕获轮次），默认 30 轮后移入节内「已过期」子块，不删除。
//
// 不做（阶段 2 的事，本插件一律不碰）：
//   不裁剪/压缩旧历史、不改压缩阈值、不改 preset、不改 settings.yaml。
//
// ===== 三条红线（照 dsh-bell / dsh-model-router / dsh-brief 的模板）=====
// 1) 零依赖：只用 node: 内置模块。要复用 DSH 能力一律走服务（ctx.llm / ctx.tools /
//    ctx.get('agents') / ctx.get('webServer')）。一旦 import 第三方包或 @deepseek-ai/*，
//    junction 的 realpath 解析会失败 → Cordis 插件树整体抛错 → DSH 起不来。
// 2) fail-open 是硬指标：所有 hook 全程 try/catch。蒸馏失败/超时/模型不可用/文件写不动
//    → **原样放行**，请求照常通过，绝不因为热记忆影响正常对话。
// 3) 要可观察的副作用：写 <home>/hot-memory/ready.json + events.jsonl，并有 HTTP 探针。
//
// 为什么**不**挂 llm/stream waterfall：
//   llm/stream 能看见每次请求的 options.messages，但阶段 1 不需要它 —— 会话归属从
//   session/event 拿更准（session.id 直接就是身份）。而挂上去之后，本插件自己发起的
//   蒸馏调用也会穿过这个 waterfall，必须再加一层防递归，平白多一个出错面。
//   少一个挂点 = 少一种把 DSH 搞挂的方式。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-hot-memory'
// tools：没有工具注册表，hot_memory 就没地方挂。
// webServer：必须声明成硬依赖 —— 开机时它还没就绪，软取 ctx.get('webServer') 会**静默跳过**
// 挂路由，重启后 /hot-memory 探针就 404（本机 2026-09-18 实测过两次）。
// llm / agents 走软取：缺了只少一个功能，不让插件卡住。
export const inject = ['tools', 'webServer']

const PLUGIN_ID = name
const VERSION = '0.5.2'

const DEFAULTS = {
  enabled: true,
  dir: '',                       // 记忆目录，默认 $DSH_HOME/hot-memory
  // ★ R32（出厂化）：provider/model 默认【留空 = 自动探测】。
  //   原先写死成本机的 opencode-go / mimo-v2.5 —— 换台机器这两个名字根本不存在，
  //   蒸馏会一路失败而人不知道为什么。现在：配置里给了就用配置，没给就现场问 llm 服务。
  provider: '',
  model: '',
  maxTokens: 3000,               // 蒸馏输出上限（mimo-v2.5 会先把 token 花在 reasoning 上，1200 实测会只回空正文）
  timeoutMs: 120000,             // 单次蒸馏超时（实测 1.1 万字符材料要 30-45 秒）
  maxInputChars: 24000,          // 喂给模型的材料上限（超出取最近的一段）
  maxMemoryBytes: 2048,          // 记忆文件字节上限（硬约束：≤2KB）
  pointer: true,                 // 是否注入那一行指针（关掉=只写文件不打扰会话）
  pointerMaxChars: 96,           // 指针行字符上限（≈token 上界，见 verify 脚本的估算）
  testHooks: false,              // /hot-memory/drive 自测驱动（默认关，验收时才开）
  agentProvider: '',             // ★ R32：自测驱动里被驱动 agent 用的模型；留空 = 用自动探测结果
  agentModel: '',
  driveTimeoutMs: 240000,
  feedMaxLines: 40,              // R22 投喂区活跃条目行数上限（超出最老的移「已过期」，不删）
  feedExpireRounds: 30,          // R22 条目捕获轮次起，过这么多轮后移入「已过期」（仍在文件里）
  guidanceMaxEntries: 20,        // R24 人工指导节最多渲染几条（超出只丢最老的**渲染**；磁盘上的指导文件一字不动）
  // ★ R29（2026-09-22）：按会话分档蒸馏。
  //   列表里的会话走完整五小节；其余会话一律走「错题档」—— 只留错误/踩坑/被否证的结论/纠正，
  //   不留进度台账（已生成/已完成/报表产出/等待确认这类）。判据来自实测：全库 576 条条目里
  //   进度台账型约 92 条（16%），而 172 条「像知识」的条目只有 86 条进了共享池。
  //   用前缀匹配：传完整 id 或 id 前缀都认。
  //   ★ R32（出厂化）改了语义：**空数组 = 不分档，所有会话都走完整档**。
  //   理由：本机那两个会话 id 对别人毫无意义；发给别人时"人人都是完整记忆"才是合理默认。
  //   要启用分档，就把要完整记忆的会话显式写进来（写进来的走完整，其余走错题档）。
  fullMemoSessions: [],
  // ★ R30（2026-09-22）：长轮次兜底蒸馏。
  //   实测事故：agent 连续工作时 turn 迟迟不结束（开了自主目标轮、或人类消息被并入当前轮），
  //   而蒸馏只在 turn/end 触发 ⇒ 那一整轮的记忆一直不落盘，进程一崩就全丢。
  //   本机实测 turn 489 从 14:01 起 20 多分钟没有 turn/end，events.jsonl 里一条蒸馏记录都没有。
  //   兜底：本轮累计事件数或时长任一超限，就用当前事件尾做一次蒸馏（事件里标 trigger='long-turn'）。
  //   是【周期】兜底，不是每轮一次 —— 长轮次会每隔 longTurnMinutes 或每 longTurnEvents 个事件兜一次。
  longTurnDistill: true,
  longTurnEvents: 300,           // 本轮累计【有意义事件】数阈值（user/assistant 消息 + 工具调用/结果）
  longTurnMinutes: 10,           // 本轮持续时长阈值（分钟）
  longTurnMinGapMinutes: 5,      // 两次兜底之间的最小间隔（分钟）—— 兜底是省 token 的，不许每分钟烧一次
}

// ★ R29：会话分档。full = 完整五小节；errors = 只蒸馏错误内容。
//   为什么用"白名单 + 前缀匹配"而不是"黑名单"：新出现的会话默认就该是低噪声的错题档，
//   免得每个新会话都把进度台账灌进来；要完整记忆的会话由人显式加进 fullMemoSessions。
function memoModeOf(cfg, id) {
  const sid = String(id || '')
  const list = Array.isArray(cfg && cfg.fullMemoSessions) ? cfg.fullMemoSessions : []
  const clean = list.map((x) => String(x || '').trim()).filter(Boolean)
  // ★ R32（出厂化）：没配置分档 = 不分档。出厂默认所有人都走完整五小节 ——
  //   本机那两个会话 id 对别人毫无意义，而"人人都是完整记忆"才是发给别人时的合理默认。
  if (!clean.length) return 'full'
  for (const s of clean) if (sid.indexOf(s) === 0) return 'full'
  return 'errors'
}

const SECTIONS = [
  { key: 'goal', title: '当前目标', re: /(当前目标|目标|goal)/i },
  { key: 'facts', title: '已确认事实', re: /(已确认|事实|fact)/i },
  { key: 'open', title: '未决问题', re: /(未决|悬而未决|待办|问题|open|question)/i },
  { key: 'files', title: '关键文件路径', re: /(文件|路径|file|path)/i },
  { key: 'decisions', title: '最近决策', re: /(决策|决定|decision)/i },
]

// ===== R23（2026-09-21）：主题分区 + 索引 + 按需调取 =====
// ★ 这是「加」不是「换」：老文件（扁平 5 小节、没有 schema 行）原地就能读，不需要迁移；
//   parseMemoFile() 两种格式都吃，v1 文件没有落盘索引时由读取时现解析补出索引。
// 分区（partition）= 5 个固定小节 + 主题分区里的每个 `### 主题：X` + 中枢投喂区（system=true）。
// 索引（index）= 每区的 名称/条数/字节数，落**文件头部**：capBytes 是从尾部整行砍的，放头部才不会被砍掉。
// 按需调取 = /hot-memory/index（列索引）、/hot-memory/topic（只取一区）、工具的 topic 参数。
const SCHEMA_V1 = 'hotmem/1'
const SCHEMA_V2 = 'hotmem/2'
const INDEX_TITLE = '分区索引'
const TOPIC_SECTION_TITLE = '主题分区'
const PART_INDEX_KEY = 'index'
const FEED_SECTION_KEY = '_feed'
const TOPIC_HEADING_RE = /^主题\s*[：:]\s*(.+?)\s*$/
const INDEX_ENTRY_RE = /^(.+?)\s*·\s*(\d+)\s*条\s*·\s*(\d+)\s*B$/

function joinLines(lines) { return lines.join('\n') + '\n' }
// ===== 分区字节数口径（只有这一处定义，别处不许再算一遍）=====
// 「本节字节」= 该节**标题行**到**下一个 1~2 级标题之前**（含中间的空行）的 UTF-8 字节数，
// 不含其后那个起分隔作用的换行；一律用 Buffer.byteLength 量**字节**，不是 String.length 量字符
// （中文 1 字符 = 3 字节，按字符对账必然对不上）。
// 举例（\n 表示换行，\0 表示空行）：
//   ## 已确认事实\n- a\n- b\n\0\n## 未决问题   ⇒ 该节 = "## 已确认事实\n- a\n- b\n" 的 byteLength
// 三种候选口径只差尾部换行的处理，实测只有上面这一种与落盘现场逐个对得上（12/12）；
// 想要「连分隔换行」的，把结果 +1 即可，但**索引里存的是上面这一种**。
function rangeBytes(lines, from, to) {
  return Buffer.byteLength(lines.slice(from, to + 1).join('\n'), 'utf8')
}
// 独立量法：直接从**原文**按字符 offset 切出同一段，再用 Buffer.byteLength 量。
// 存在的理由：bytes 的定义就是 byteLength(content)，拿它跟自己比是**循环论证**，永远为真、
// 拦不住任何系统性偏差（R24 的自检就栽在这上面）。这个函数让「索引报的 B == 现场」可以被机器复核。
function measurePartitionOnDisk(raw, headingLine) {
  const text = String(raw == null ? '' : raw)
  const key = '\n' + headingLine + '\n'
  let start = text.indexOf(key)
  if (start !== -1) start += 1
  else if (text.indexOf(headingLine + '\n') === 0) start = 0
  else return -1
  const after = start + headingLine.length + 1
  const rest = text.slice(after)
  const m = rest.search(/^#{1,2}[ \t]/m)          // 下一个 1~2 级标题；### 是子标题，不算边界
  const end = m === -1 ? text.length : after + m
  return Buffer.byteLength(text.slice(start, end).replace(/\n$/, ''), 'utf8')
}
// 分区在文件里的标题行（主题分区是三级标题，其余是二级）
function headingLineOf(part) { return (part.kind === 'topic' ? '### ' : '## ') + part.title }
const BYTES_RULE = '本节字节 = 该节标题行到下一个 1~2 级标题之前（含空行）的 UTF-8 字节数，不含其后那个分隔换行；用 Buffer.byteLength 量字节，不是字符数'
// 读取器：v1（扁平 5 小节）/ v2（分区 + 索引）都吃，读不出 schema 就按 v1 处理（老文件不报错）。
function parseMemoFile(text) {
  const raw = String(text == null ? '' : text)
  const lines = raw.split(/\r?\n/)
  const schema = (raw.match(/^schema:\s*([^\s]+)\s*$/m) || [])[1] || SCHEMA_V1
  const sections = {}
  for (const s of SECTIONS) sections[s.key] = []
  const topics = []
  const blocks = []
  let feed = null
  let guidance = null
  let open = null
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].trim().match(/^(#{1,6})\s*(.+?)\s*$/)
    if (head) {
      const level = head[1].length
      const title = head[2]
      const tmHead = title.match(TOPIC_HEADING_RE)
      // ★三级及以下的标题是**子标题**，不是分块边界。只有 `### 主题：X` 才是分区；其余
      //（典型：人工指导里的 `### <时间> · <来源> · 分区：X` 条目头）属于当前块的内容 ——
      // 拿它当边界会把人工指导节从自己的条目头处切碎，索引报的字节数当场少一截（实测少 71~309B）。
      if (level >= 3 && !tmHead) continue
      if (open) blocks.push(open)
      if (title.indexOf(FEED_SECTION_TITLE) !== -1) open = { kind: 'feed', key: FEED_SECTION_KEY, title: title, from: i, items: [] }
      else if (title.indexOf(INDEX_TITLE) !== -1) open = { kind: 'index', key: PART_INDEX_KEY, title: INDEX_TITLE, from: i, items: [] }
      else if (title.indexOf(TOPIC_SECTION_TITLE) !== -1) open = { kind: 'topics', key: 'topics', title: TOPIC_SECTION_TITLE, from: i, items: [] }
      else if (title.indexOf(GUIDANCE_MATCH_PREFIX) === 0) open = { kind: 'guidance', key: GUIDANCE_KEY, title: title, from: i, items: [] }
      else {
        let hit = null
        for (const s of SECTIONS) { if (s.re.test(title)) { hit = s; break } }
        if (tmHead) open = { kind: 'topic', key: 'topic:' + tmHead[1], title: '主题：' + tmHead[1], from: i, items: [] }
        else if (hit) open = { kind: 'section', key: hit.key, title: hit.title, from: i, items: [] }
        else open = { kind: 'other', key: 'other', title: title, from: i, items: [] }
      }
      continue
    }
    if (!open) continue
    const item = lines[i].trim().replace(/^[-*+]\s*/, '').replace(/^\d+[.)]\s*/, '').trim()
    if (!item) continue
    if (open.kind === 'index') {
      const m = item.match(INDEX_ENTRY_RE)
      if (m) open.items.push({ title: m[1].trim(), items: Number(m[2]), bytes: Number(m[3]) })
      continue
    }
    if (item === '（无）' || item === '(无)') continue   // 占位行不是内容，但它的字节仍算在该区里
    open.items.push(item)
  }
  if (open) blocks.push(open)
  const partitions = []
  let indexInFile = []
  for (let k = 0; k < blocks.length; k += 1) {
    const b = blocks[k]
    if (b.kind === 'topics' || b.kind === 'other') continue
    // 统一口径：每节都「减去末尾那一个换行」。文件以 \n 结尾时 split 出来的最后一个元素是空串，
    // 末节若把它算进来就会比别的节多 1 —— 指挥台在主题分区上抓到的那 1 字节正是这个
    //（同一个原因，v2 的投喂节 / 无投喂时的主题节 / R22 以前的 最近决策 都会多 1）。
    const lastTo = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 2 : lines.length - 1
    const to = k === blocks.length - 1 ? lastTo : blocks[k + 1].from - 1
    const content = lines.slice(b.from, to + 1).join('\n')
    const part = {
      key: b.key, title: b.title, kind: b.kind, system: b.kind === 'feed' || b.kind === 'guidance',
      items: b.items.length, bytes: rangeBytes(lines, b.from, to), lines: [b.from + 1, to + 1],
      content: content,
    }
    if (b.kind === 'section') sections[b.key] = b.items.slice()
    else if (b.kind === 'topic') topics.push({ name: b.title.replace(/^主题：/, ''), items: b.items.slice(), bytes: part.bytes })
    else if (b.kind === 'feed') feed = part
    else if (b.kind === 'guidance') guidance = part
    else if (b.kind === 'index') { indexInFile = b.items.slice(); continue }
    partitions.push(part)
  }
  return {
    schema: schema, sections: sections, topics: topics, feed: feed, guidance: guidance,
    partitions: partitions, indexInFile: indexInFile, bytes: Buffer.byteLength(raw, 'utf8'),
  }
}
// 按主题名/键挑分区：先精确标题 → 精确 key → 忽略大小写 → 子串。挑不到返回 null（调用侧给可用清单）。
function pickPartition(partitions, want) {
  const w = String(want == null ? '' : want).trim()
  if (!w) return null
  const list = Array.isArray(partitions) ? partitions : []
  for (const p of list) if (p.title === w) return p
  for (const p of list) if (p.key === w) return p
  const lw = w.toLowerCase()
  for (const p of list) if (String(p.title).toLowerCase() === lw) return p
  for (const p of list) if (String(p.title).toLowerCase().indexOf(lw) !== -1) return p
  return null
}


// ===== 小工具 =====
function log() { try { console.log('[' + PLUGIN_ID + ']', ...arguments) } catch { /* 忽略 */ } }
function warn() { try { console.warn('[' + PLUGIN_ID + ']', ...arguments) } catch { /* 忽略 */ } }
function errText(error) { return error && error.message ? String(error.message) : String(error) }
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : path.join(os.homedir(), '.dsh')
}
function workDir(cfg) { return cfg.dir && String(cfg.dir).trim() ? path.resolve(String(cfg.dir).trim()) : path.join(dshHome(), 'hot-memory') }
function memoPath(cfg, id) { return path.join(workDir(cfg), safeId(id) + '.md') }
function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown' }
function shortId(id) { const s = String(id || ''); return s.length > 12 ? s.slice(0, 12) : s }
function clip(text, max) { const s = String(text == null ? '' : text); return s.length > max ? s.slice(0, max) + '…' : s }
function pad2(n) { return n < 10 ? '0' + n : String(n) }
function stamp(date) {
  const d = date || new Date()
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}
function hhmm(date) { const d = date || new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) }
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
// 与 @deepseek-ai/dsh-llm 的 createUserMessage 等价的本地实现（红线 1：不能 import）。
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

// ===== 服务软取 =====
// ★ R32（出厂化）：自动挑蒸馏模型。
//   配置里给了 provider+model 就用配置；没给就问 llm 服务现场挑一个"看起来便宜"的。
//   为什么偏向便宜：蒸馏是每轮都要跑的后台活，用旗舰模型等于持续烧钱。
const CHEAP_RE = /(flash|mini|small|lite|turbo|fast|nano|air|haiku)/i
const PRICEY_RE = /(pro|max|opus|ultra|reason|thinking)/i
function modelScore(id) {
  const s = String(id || '')
  let n = 0
  if (CHEAP_RE.test(s)) n += 2
  if (PRICEY_RE.test(s)) n -= 2
  return n
}
async function resolveModel(ctx, cfg) {
  const wantP = String((cfg && cfg.provider) || '').trim()
  const wantM = String((cfg && cfg.model) || '').trim()
  if (wantP && wantM) return { provider: wantP, model: wantM, how: 'config' }
  const llm = llmService(ctx)
  if (!llm || typeof llm.listProviders !== 'function') return { provider: wantP, model: wantM, how: 'no-llm-runtime' }
  let provs = []
  try { provs = llm.listProviders() || [] } catch { provs = [] }
  const ids = provs.map((p) => String((p && p.id) || '')).filter(Boolean)
  if (!ids.length) return { provider: wantP, model: wantM, how: 'no-provider' }
  // ★ 只配了 model、没配 provider：先在【所有】provider 里找谁真有这个模型。
  //   实测过没这步的后果：写了 model 也会被无视，静默换成自动挑的那一个 —— 人配了等于没配。
  if (!wantP && wantM) {
    for (const pid of ids) {
      let models0 = []
      try { models0 = (await llm.listModels(pid)) || [] } catch { continue }
      const list0 = models0.map((m) => String((m && m.id) || '')).filter(Boolean)
      if (list0.indexOf(wantM) !== -1) return { provider: pid, model: wantM, how: 'config-model' }
    }
  }
  const order = wantP ? [wantP].concat(ids.filter((x) => x !== wantP)) : ids
  for (const pid of order) {
    if (!pid) continue
    let models = []
    try { models = (await llm.listModels(pid)) || [] } catch { continue }
    const list = models.map((m) => String((m && m.id) || '')).filter(Boolean)
    if (!list.length) continue
    if (wantM && list.indexOf(wantM) !== -1) return { provider: pid, model: wantM, how: 'config-model' }
    const ranked = list.slice().sort((a, b) => modelScore(b) - modelScore(a))
    return { provider: pid, model: ranked[0], how: 'auto', candidates: list.length, ranked: ranked.slice(0, 5) }
  }
  return { provider: wantP, model: wantM, how: 'no-model' }
}
// 每轮最多探一次；探到就缓存，失败时清掉下轮重探（见 handleTurnEnd 的 distill-fail 分支）。
async function ensureModel(ctx, cfg, state) {
  const wantP = String((cfg && cfg.provider) || '').trim()
  const wantM = String((cfg && cfg.model) || '').trim()
  if (wantP && wantM) {
    const fixed = { provider: wantP, model: wantM, how: 'config' }
    state.resolvedModel = fixed   // ★ 也写缓存：否则 /hot-memory/doctor 看不到实际生效的模型
    return fixed
  }
  const cur = state.resolvedModel
  if (cur && cur.model) return cur
  let r = null
  try { r = await resolveModel(ctx, cfg) } catch (error) { r = { provider: wantP, model: wantM, how: 'error:' + errText(error) } }
  state.resolvedModel = r
  if (r && r.how === 'auto') log('自动选定蒸馏模型 · ' + r.provider + '/' + r.model + '（配置没写死，从 ' + (r.candidates || '?') + ' 个候选里按"便宜优先"挑的）')
  else if (r && r.how !== 'config') warn('自动选蒸馏模型没成功（' + r.how + '）—— 打 /hot-memory/doctor 看现场有哪些 provider/model')
  return r
}

function llmService(ctx) {
  try { if (ctx && ctx.llm && typeof ctx.llm.stream === 'function') return ctx.llm } catch { /* 忽略 */ }
  try { const s = ctx.get('llm'); return s && typeof s.stream === 'function' ? s : undefined } catch { return undefined }
}
function toolsService(ctx) {
  try { if (ctx && ctx.tools && typeof ctx.tools.register === 'function') return ctx.tools } catch { /* 忽略 */ }
  try { return ctx.get('tools') } catch { return undefined }
}
function agentsService(ctx) {
  try { return ctx.get('agents') } catch { return undefined }
}
function sessionIdOf(agent) {
  try { return String((agent && agent.session && agent.session.id) || (agent && agent.id) || '') } catch { return '' }
}

// ===== 落盘（可观察副作用）=====
function ensureDir(cfg) { try { fs.mkdirSync(workDir(cfg), { recursive: true }) } catch { /* 忽略 */ } }
function appendEvent(cfg, record) {
  try {
    ensureDir(cfg)
    fs.appendFileSync(path.join(workDir(cfg), 'events.jsonl'), JSON.stringify(Object.assign({
      at: new Date().toISOString(), plugin: PLUGIN_ID, pid: process.pid,
    }, record)) + '\n', 'utf8')
  } catch { /* 忽略 */ }
}
// 原子写：先写临时文件再 rename。就地截断写有两个老坑：文件监听器不认（热加载静默失效）、
// 写到一半进程死了留下半截文件。
function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

// ===== 事件 → 材料 =====
function textOfContent(content, toolClip) {
  const parts = []
  const clipTo = Number(toolClip) > 0 ? Number(toolClip) : 200
  for (const block of Array.isArray(content) ? content : []) {
    if (!block) continue
    const type = String(block.type || '')
    if (type === 'text') { const s = String(block.text || '').trim(); if (s) parts.push(s) }
    else if (type === 'tool-call') parts.push('[工具调用 ' + String(block.name || '') + '] ' + clip(String(block.arguments || ''), 200))
    else if (type === 'tool-result') {
      const inner = Array.isArray(block.content) ? block.content : []
      const s = inner.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join(' ').trim()
      parts.push('[工具结果] ' + clip(s, clipTo))
    }
  }
  return parts.join(' ').trim()
}
// tool/call 不单独收：assistant/message 的 content 里已经带了那次调用。
function renderDigest(events) {
  const lines = []
  for (const event of Array.isArray(events) ? events : []) {
    const data = (event && event.data) || {}
    try {
      if (event.type === 'user/message') {
        const source = data.source || {}
        // 自己注入的指针别回喂自己（否则备忘里会攒一堆「热记忆已更新」的噪声）。
        if (source.kind === 'plugin' && source.plugin === PLUGIN_ID) continue
        const text = textOfContent(data.content)
        if (text) lines.push((source.kind === 'user' ? '人类：' : '注入上下文[' + String(source.plugin || '?') + ']：') + clip(text, 600))
      } else if (event.type === 'assistant/message') {
        const text = textOfContent((data.message || {}).content)
        if (text) lines.push('助手：' + clip(text, 600))
      } else if (event.type === 'tool/result') {
        const text = textOfContent((data.message || {}).content)
        if (text) lines.push('工具结果' + (data.error ? '（失败 ' + String((data.error || {}).code || '') + '）' : '') + '：' + clip(text, 250))
      }
    } catch { /* 单个事件解析失败不影响其它 */ }
  }
  return lines.join('\n')
}

function buildPrompt(previous, digest, meta, mode) {
  const parts = []
  const errorsOnly = (mode === 'errors')
  parts.push('你是「热记忆」蒸馏器：把下面的材料压成一份**短**备忘，供这个会话的下一轮直接用，省得回头翻上下文。')
  parts.push('硬性要求：')
  parts.push('1) 只输出 Markdown，恰好这 5 个二级标题，标题原样照抄（顺序也不要变）：## 当前目标 / ## 已确认事实 / ## 未决问题 / ## 关键文件路径 / ## 最近决策')
  parts.push('2) 每个小节最多 3 条，每条一行、以 "- " 开头，一行不超过 40 个字；确实没有内容的小节写 "- （无）"')
  parts.push('3) 只写材料里**真实出现过**的目标、事实、路径、决定；材料里没有的一律不写。不许推测、不许补全、不许编造。**例外**：【上一版备忘】里已经写着的目标、路径、决定，视同材料的一部分，可以并且应该保留 —— 不许因为"本轮材料没提到"就删掉它们。')
  parts.push('4) 优先保留：具体文件/目录路径、具体数字、已经拍板的决定、还没解决的分歧。')
  parts.push('5) 全文不超过 600 字。不要前言、不要结语、不要代码块、不要解释你在做什么。')
  parts.push('6) 不要输出你的思考过程、不要复述材料，直接给备忘 —— 输出越短越好。')
  parts.push('7) ★「当前目标」具有**粘性**：它的内容来自整条会话的长期目标，不是本轮在干什么。只有当材料里明确出现了一个**新的**目标取代旧目标时才更换；本轮只是在做进度汇报、体检、复跑、核对时，【上一版备忘】的目标必须原样保留。判断依据：若上一版的当前目标非空，而本轮材料里没有任何"要去做某事"的新目标，就照抄上一版的当前目标。')
  parts.push('7b) 反过来，「已确认事实 / 未决问题 / 关键文件路径 / 最近决策」这四节可以随本轮材料更新，只有「当前目标」享有上述粘性。')
  parts.push('8) 不存在第 6 个小节：即使材料里出现「门铃来信」或【投喂】字样，也不要为它输出任何小节或条目 —— 中枢投喂区由系统在文件末尾单独拼装并原样保留，与蒸馏无关。')
  if (errorsOnly) {
    parts.push('')
    parts.push('【本会话走「错题档」—— 这是人为指定的档位，不是默认档】')
    parts.push('A) 只保留这几类：踩过的坑、失败与报错、被否证的结论、对旧结论的纠正、别人明确指出的错误、容易再犯的误解。')
    parts.push('B) 一律不保留：任务进度、已生成/已完成/已创建/已修复、报表与产出清单、"等待用户确认"这类状态、下一轮计划。')
    parts.push('C) 五个小节标题照旧原样输出，内容这样分配：')
    parts.push('   ## 已确认事实 = 错题与纠正（最多 3 条；每条要能独立看懂：错在哪 / 为什么错 / 正确做法）')
    parts.push('   ## 未决问题 = 还没查清的疑点（最多 3 条）')
    parts.push('   ## 当前目标 / ## 关键文件路径 / ## 最近决策 一律写 "- （无）"')
    parts.push('D) 【上一版备忘】里的非错题内容直接丢弃，不要搬过来。')
    parts.push('E) 如果本轮材料里一条错误都没有，就五个小节全部写 "- （无）"。不要为了凑内容把进度写进来。')
    parts.push('')
  }
  parts.push('9) 可选（R23 主题分区）：如果本轮材料里出现了**跨上面 5 节**的专门主题（例如某条工作线、某个子系统的进展），可以在 5 节之后追加若干三级标题，格式严格照抄：### 主题：<不超过 12 个字的名字>，每个主题下最多 2 条、每条一行以 "- " 开头。没有这样的主题就一条都不要写 —— 宁可不写，也不要把 5 节里的内容重复一遍。')
  if (previous) {
    parts.push('')
    parts.push('【上一版备忘（在此基础上更新；仍然有效的内容请保留）】')
    parts.push(clip(previous, 2048))   // R33：1600 会把上一版备忘的尾巴切掉（实测 1931B 的备忘被砍）
  }
  parts.push('')
  parts.push('【本轮材料：第 ' + meta.turn + ' 轮 · ' + meta.count + ' 个事件' + (meta.cut ? '（较早内容已截断）' : '') + '】')
  parts.push(digest)
  return parts.join('\n')
}

// ===== 蒸馏结果 → 固定 5 小节的备忘 =====
function parseMemo(text) {
  const out = { goal: [], facts: [], open: [], files: [], decisions: [], _feed: [], _topics: [] }
  let current = null
  let topic = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/)
    if (heading) {
      const title = heading[1]
      // 系统管理区（中枢投喂）：蒸馏模型胆敢输出，也整段丢弃，绝不许混进老五节。
      if (title.indexOf('中枢投喂') !== -1) { current = '_feed'; topic = null; continue }
      // 索引区是系统派生的视图，模型写了也不算内容。
      if (title.indexOf(INDEX_TITLE) !== -1) { current = null; topic = null; continue }
      const tm = title.match(TOPIC_HEADING_RE)
      if (tm) { topic = { name: tm[1], items: [] }; out._topics.push(topic); current = null; continue }
      topic = null
      let hit = null
      for (const section of SECTIONS) { if (section.re.test(title)) { hit = section; break } }
      current = hit ? hit.key : null
      continue
    }
    const item = line.replace(/^[-*+]\s*/, '').replace(/^\d+[.)]\s*/, '').trim()
    if (!item || item === '（无）' || item === '(无)') continue
    if (topic) topic.items.push(item)
    else if (!current) out.facts.push(item)
    else out[current].push(item)
  }
  return out
}
// v2 正文：头部 4 行（# 标题 / schema / 空行 / 更新）+ 5 节 + 主题分区。索引不在这里拼（见 assembleMemo）。
function renderMemoV2(id, memo, meta) {
  const body = []
  body.push('# 热记忆 · ' + shortId(id))
  body.push('schema: ' + SCHEMA_V2)
  body.push('')
  body.push('更新：' + meta.at + ' · 第 ' + meta.turn + ' 轮 · 蒸馏 ' + meta.model + ' · 源 ' + meta.count + ' 事件')
  for (const section of SECTIONS) {
    body.push('')
    body.push('## ' + section.title)
    const items = (memo[section.key] || []).slice(0, 3)
    if (!items.length) body.push('- （无）')
    else for (const item of items) body.push('- ' + clip(item, 120))
  }
  const topics = (Array.isArray(memo._topics) ? memo._topics : [])
    .map((t) => ({ name: clip(String((t && t.name) || '').trim(), 24), items: ((t && t.items) || []).slice(0, 2).map((it) => clip(it, 120)) }))
    .filter((t) => t.name && t.items.length)
  body.push('')
  body.push('## ' + TOPIC_SECTION_TITLE)
  if (!topics.length) body.push('- （无）')
  else for (const t of topics) { body.push('### 主题：' + t.name); for (const item of t.items) body.push('- ' + item) }
  return body
}
function indexBlock(partitions) {
  const out = ['## ' + INDEX_TITLE]
  const list = Array.isArray(partitions) ? partitions : []
  if (!list.length) out.push('- （无）')
  else for (const p of list) out.push('- ' + p.title + ' · ' + p.items + ' 条 · ' + p.bytes + 'B')
  return out
}
// 只把「模型产出的分区」写进索引：指导节与投喂节是代码拼的、跟在正文后面，不算在内。
function contentPartitions(text) {
  return parseMemoFile(text).partitions.filter((p) => p.kind !== 'feed' && p.kind !== 'guidance')
}
function trimmedTail(text, skip) {
  const lines = String(text).split(/\r?\n/).slice(skip)
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}
// 落盘后自曝：索引里的数字与文件现场对不上就置 true（绝不留下撒谎的索引）。
function indexAgrees(text) {
  const parsed = parseMemoFile(text)
  if (!parsed.indexInFile.length) return false
  const live = parsed.partitions.filter((p) => p.kind !== 'feed' && p.kind !== 'guidance')
  if (live.length !== parsed.indexInFile.length) return false
  for (let i = 0; i < live.length; i += 1) {
    const a = parsed.indexInFile[i]
    if (a.title !== live[i].title || a.bytes !== live[i].bytes || a.items !== live[i].items) return false
  }
  return true
}
// 拼装：先用现解析出的分区算索引，再 capBytes；被砍过就用**砍后现场**重算索引，最多三轮收敛。
// ★tail = 落盘时追加在正文**后面**的「原样保留」节（人工指导 + 中枢投喂）。索引必须按**落盘后的
//   完整文本**算分区边界：正文的最后一个分区在文件里永远不是末节（后面总跟着这两节），
//   不带上 tail 就会按「末节」口径算，跟现场差 1。tail 本身不占 maxMemoryBytes 预算。
function assembleMemo(id, memo, meta, maxBytes, tail) {
  const body = renderMemoV2(id, memo, meta)
  const head = body.slice(0, 4)
  const rest = body.slice(4)
  // 调用方不给 tail 时用这个默认尾巴：真实落盘的正文后面**总**有「原样保留」节
  //（renderFeedSection 至少也会输出一个标题），所以正文的末节在文件里永远不是末节。
  // 它只影响「边界算到哪」，不改变任何一节自己的字节数。
  const DEFAULT_TAIL = '\n## ' + FEED_SECTION_TITLE + '\n' + FEED_NOTE + '\n- （无）'
  const TAIL = String(tail == null ? DEFAULT_TAIL : tail)
  const withTail = (survivedLines) => joinLines(head.concat([''], survivedLines)) + TAIL + '\n'
  const ideal = Buffer.byteLength(joinLines(head.concat([''], indexBlock(contentPartitions(withTail(rest))), rest)) + TAIL + '\n', 'utf8')
  let survived = rest
  let text = ''
  let full = ''
  for (let round = 0; round < 3; round += 1) {
    const idx = indexBlock(contentPartitions(withTail(survived)))
    const capped = capBytes(joinLines(head.concat([''], idx, survived)), maxBytes)   // 只砍正文
    text = capped.text
    full = text + TAIL + '\n'
    if (!capped.cut) break
    survived = trimmedTail(text, head.length + 1 + idx.length)
  }
  if (indexAgrees(full)) {                       // 自证用**落盘后的完整文本**，与写盘口径同源
    const parsed = parseMemoFile(full)
    return {
      text: text, fullText: full, bytes: Buffer.byteLength(text, 'utf8'), cut: ideal > maxBytes,
      partitions: parsed.partitions, indexOmitted: false,
    }
  }
  // 兜底：预算小到连「头部 + 索引」都塞不下时会收敛不了 —— 宁可不写索引
  //（读取侧照样按 v1 路径现解析出分区，两种格式都能吃），也绝不留一个跟现场对不上的索引。
  const bare = capBytes(joinLines(head.concat([''], rest)), maxBytes)
  const bareFull = bare.text + TAIL + '\n'
  return {
    text: bare.text, fullText: bareFull, bytes: Buffer.byteLength(bare.text, 'utf8'), cut: ideal > maxBytes,
    partitions: parseMemoFile(bareFull).partitions, indexOmitted: true,
  }
}
// 硬上限：整行整行地砍，保证结果是合法 UTF-8 且不超过 maxBytes。
function capBytes(text, maxBytes) {
  const before = Buffer.byteLength(text, 'utf8')
  if (before <= maxBytes) return { text: text, bytes: before, cut: false }
  const lines = String(text).split('\n')
  while (lines.length > 1 && Buffer.byteLength(lines.join('\n') + '\n', 'utf8') > maxBytes) lines.pop()
  let out = lines.join('\n') + '\n'
  if (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, maxBytes) // 单行超长的兜底
  return { text: out, bytes: Buffer.byteLength(out, 'utf8'), cut: true }
}
function itemCount(memo) {
  let n = 0
  for (const s of SECTIONS) n += (memo[s.key] || []).length
  for (const t of (Array.isArray(memo._topics) ? memo._topics : [])) n += ((t && t.items) || []).length
  return n
}

// ===== 中枢投喂（R22 · 固定第 6 节，代码拼装，不参与蒸馏）=====
// 判据只有一条：消息正文以【投喂】开头 ⇒ 投喂条目。来源只认两种：
//   ① 人类直发的消息（source.kind='user'）② 门铃来信（source.plugin='dsh-bell'，取信头/信脚之间的正文）。
// 其余插件注入的一律不算（防别的插件消息混进投喂区）。
const FEED_SECTION_TITLE = '中枢投喂（不参与蒸馏 · 原样保留）'
const FEED_PREFIX = '【投喂】'
const FEED_NOTE = '（投喂≠授权 · 目标/判据仍以第 1/3 节为准 · 〔tN〕=投喂轮次）'
const FEED_EXPIRED_TAG = '- 【已过期】'
// 事件时间兼容两种形状：epoch 毫秒数（实测持久化流是这种）或 ISO 字符串。
function dayOf(time) {
  try {
    let d = null
    const n = Number(time)
    if (Number.isFinite(n) && n > 0) d = new Date(n)
    else if (time) d = new Date(time)
    if (!d || isNaN(d.getTime())) return ''
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  } catch { return '' }
}
// 取一条消息的完整正文（不裁剪 —— 投喂条目要逐字存活，textOfContent 的 600 字剪裁不适用）。
function fullTextOfMessage(data) {
  const content = (data && data.content)
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n')
}
// 门铃信正文 = 信头（🔔 门铃来信 · <fromName>（会话 …））与信脚（（dsh-bell …）之间的那段。
function bellLetterBody(text) {
  const lines = String(text || '').split(/\r?\n/)
  if (!lines.length || lines[0].indexOf('门铃来信') === -1) return null
  let end = -1
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    if (lines[i].indexOf('（dsh-bell') === 0) { end = i; break }
  }
  const bodyLines = lines.slice(1, end === -1 ? lines.length : end)
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift()
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop()
  const m = lines[0].match(/门铃来信 · (.+?)（会话/)
  return { body: bodyLines.join('\n'), fromName: m ? m[1] : '' }
}
// 扫**整个**会话事件流（不是本轮切片）——投喂条目从事件流现推导，热重载/重启都不丢。
// 轮次归属：事件 seq 之后第一个 turn/end 的 data.turn（= 这封信被领取进上下文的那一轮）。
// ★ 0.1.5 兼容：Session 不再有 .events 属性，改成方法 snapshotEvents(fromSeq=0, toSeqExclusive=this.seq)。
//   老写法读 session.events 拿到 undefined ⇒ Array.isArray 为假 ⇒ events=[] ⇒ 每轮都判 empty-digest，
//   症状是"热记忆从此再也不更新"，而且一声不吭（跳过事件里只写 events:0）。
//   语义依据：dsh-session/lib/index.js  get seq() { return this.log.length }（seq=下一个事件的序号）
//             snapshotEvents(from, to) 是半开区间 [from,to)，eventAt(i)===log[i]。
//   两条路都留着，老版本继续能用。
function sessionEvents(session) {
  if (!session) return []
  try { if (Array.isArray(session.events)) return session.events } catch { /* 继续往下试 */ }
  try {
    if (typeof session.snapshotEvents === 'function') {
      const a = session.snapshotEvents()          // 默认 [0, this.seq) = 整本日志
      if (Array.isArray(a)) return a
    }
  } catch { /* 继续往下试 */ }
  try {
    if (typeof session.ownEvents === 'function') {
      const a = session.ownEvents()
      if (Array.isArray(a)) return a
    }
  } catch { /* 忽略 */ }
  return []
}

function extractFeedEntries(session) {
  const events = sessionEvents(session)
  const turnEnds = []
  for (const e of events) {
    try {
      if (e && e.type === 'turn/end') {
        const t = Number((e.data || {}).turn)
        turnEnds.push({ seq: Number(e.seq), turn: Number.isFinite(t) ? t : null })
      }
    } catch { /* 忽略 */ }
  }
  turnEnds.sort((a, b) => a.seq - b.seq)
  const turnOfSeq = (seq) => {
    for (const te of turnEnds) { if (te.seq >= seq) return te.turn }
    return null
  }
  const out = []
  for (const event of events) {
    try {
      if (!event || event.type !== 'user/message') continue
      const data = event.data || {}
      const source = data.source || {}
      if (source.kind === 'plugin' && source.plugin === PLUGIN_ID) continue   // 自己的指针永不入投喂
      let body = null
      let fromName = ''
      if (source.kind === 'plugin' && source.plugin === 'dsh-bell') {
        const letter = bellLetterBody(fullTextOfMessage(data))
        if (!letter) continue
        body = letter.body
        fromName = letter.fromName || 'dsh-bell'
      } else if (source.kind === 'user') {
        body = fullTextOfMessage(data)
        fromName = '用户'
      } else continue
      const trimmed = String(body || '').replace(/^\s+/, '')
      if (trimmed.indexOf(FEED_PREFIX) !== 0) continue
      if (!trimmed.slice(FEED_PREFIX.length).trim()) continue
      out.push({ seq: Number(event.seq), at: dayOf(event.time), from: fromName, text: trimmed, round: turnOfSeq(Number(event.seq)) })
    } catch { /* 单条坏事件不拖垮抽取 */ }
  }
  out.sort((a, b) => a.seq - b.seq)
  return out
}
// sidecar 兜底：防会话在内存里被裁剪后老投喂条目失踪。entries 按 seq 去重合并，轮次以现扫优先。
function feedSidecarPath(cfg, id) { return path.join(workDir(cfg), 'feeds', safeId(id) + '.json') }
function loadFeedSidecar(cfg, id) {
  try {
    const raw = JSON.parse(fs.readFileSync(feedSidecarPath(cfg, id), 'utf8'))
    return Array.isArray(raw && raw.entries) ? raw.entries : []
  } catch { return [] }
}
function saveFeedSidecar(cfg, id, entries) {
  try {
    fs.mkdirSync(path.join(workDir(cfg), 'feeds'), { recursive: true })
    writeAtomic(feedSidecarPath(cfg, id), JSON.stringify({ version: 1, entries: entries }, null, 2))
    return true
  } catch { return false }
}
function mergeFeedEntries(scanned, stored) {
  const bySeq = new Map()
  for (const e of Array.isArray(stored) ? stored : []) {
    try {
      if (!e || !Number.isFinite(Number(e.seq))) continue
      const round = roundNum(e.round)
      bySeq.set(Number(e.seq), { seq: Number(e.seq), at: String(e.at || ''), from: String(e.from || ''), text: String(e.text || ''), round: Number.isFinite(round) ? round : null })
    } catch { /* 忽略 */ }
  }
  for (const e of Array.isArray(scanned) ? scanned : []) {
    const prev = bySeq.get(Number(e.seq))
    if (!prev) bySeq.set(Number(e.seq), e)
    else if (!Number.isFinite(roundNum(prev.round)) && Number.isFinite(roundNum(e.round))) bySeq.set(Number(e.seq), Object.assign({}, prev, { round: e.round }))
  }
  return Array.from(bySeq.values()).sort((a, b) => Number(a.seq) - Number(b.seq))
}
// round 归一：null/undefined/'' 一律 NaN（= 未知轮次）—— Number(null)===0 会把未知轮次伪造成「第 0 轮」：
// 条目标记错成 〔t0〕，renderFeedSection 还会把它当第 0 轮 ⇒ 立即判「已过期」（设计上未知轮次应永远活跃）。
function roundNum(v) { return v === null || v === undefined || v === '' ? NaN : Number(v) }
function feedLine(e) {
  const body = String(e.text || '').split(/\r?\n/).map((l, i) => (i === 0 ? l : '  ' + l)).join('\n')
  const r = roundNum(e.round)
  const tag = Number.isFinite(r) ? '〔t' + r + '〕' : '〔t?〕'
  return '- ' + (e.at || '????-??-??') + ' ' + (e.from || '?') + '：' + body + ' ' + tag
}
// 第 6 节渲染：活跃 = 捕获轮次起 30 轮内（数字来自 cfg.feedExpireRounds）；行数超 feedMaxLines 时
// 最老的先进「已过期」；过期条目**不删除**（仍留在文件里，只是挪到子块下）。
function renderFeedSection(entries, currentTurn, cfg) {
  const lines = []
  lines.push('')
  lines.push('## ' + FEED_SECTION_TITLE)
  lines.push(FEED_NOTE)
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && String(e.text || '').trim())
  const maxLines = clampNumber(cfg.feedMaxLines, 1, 200, 40)
  const expireRounds = clampNumber(cfg.feedExpireRounds, 1, 1000000, 30)
  const cur = Number(currentTurn)
  const known = list.filter((e) => Number.isFinite(roundNum(e.round)))
  const pending = list.filter((e) => !Number.isFinite(roundNum(e.round)))
  let fresh = known
  let stale = []
  if (Number.isFinite(cur) && cur > 0) {
    fresh = known.filter((e) => cur - Number(e.round) < expireRounds)
    stale = known.filter((e) => cur - Number(e.round) >= expireRounds)
  }
  const actives = pending.concat(fresh).sort((a, b) => Number(a.seq) - Number(b.seq))
  const overflow = actives.length > maxLines ? actives.slice(0, actives.length - maxLines) : []
  const keep = actives.slice(actives.length - maxLines)
  const expired = overflow.concat(stale).sort((a, b) => Number(a.seq) - Number(b.seq))
  if (!list.length) lines.push('- （无）')
  else {
    for (const e of keep) lines.push(feedLine(e))
    if (expired.length) {
      lines.push(FEED_EXPIRED_TAG)
      for (const e of expired) lines.push(feedLine(e))
    }
  }
  return { text: lines.join('\n'), active: keep.length, expired: expired.length, total: list.length }
}
// 上一版备忘喂回提示词之前，把投喂区（代码原样保存）和分区索引（派生视图）都摘掉 ——
// 模型看不到这两区，就不会手痒去改写它们；v1 老文件没有索引，照样走这条路。
function stripForPrompt(memoText) {
  const lines = String(memoText || '').split(/\r?\n/)
  const out = []
  let skip = false
  for (const line of lines) {
    // 只认**列 0 起**且**层级 ≤2** 的标题：正文里缩进过的 # 不算标题，`### …`（主题子区/指导条目）
    // 也不会把 skip 提前关掉 —— 否则指导节的后半截会漏进蒸馏材料。
    const heading = line.charAt(0) === '#' ? line.match(/^(#{1,6})\s*(.+?)\s*$/) : null
    if (heading && heading[1].length <= 2) {
      const title = heading[2]
      skip = title.indexOf(FEED_SECTION_TITLE) !== -1 || title.indexOf(INDEX_TITLE) !== -1 || title.indexOf(GUIDANCE_MATCH_PREFIX) === 0
    }
    if (!skip) out.push(line)
  }
  return out.join('\n').replace(/\s+$/, '\n')
}

// ===== R24（2026-09-21）：人工指导（与「中枢投喂」同级的固定节 · 不参与蒸馏 · 原样保留）=====
// 与投喂的差别：投喂从**会话事件流**里现扫（谁的会话自己产生），指导从**磁盘上的指导文件**里读
//（人/面板写的），所以没有 sidecar、没有轮次归属 —— 文件就是唯一事实源，读完即渲染。
// 契约（与面板 B 侧定死，先定死不改）：
//   路径 <DSH_HOME>/hot-memory/_guidance/<sessionId>.md
//   格式 `# 人工指导 · <id>` + 追加的 `## <时间> · <来源> · 分区：X` + 正文；UTF-8。
// 三条硬要求：① 目录不存在 / 文件不存在 / 读不动 / 格式乱 ⇒ 一律当成 0 条，绝不抛、绝不写坏记忆
//             ② **无指导时指针格式一字不改**（仍是 R23 的 `（N 条 · M 区，HH:MM）`）
//             ③ 指导正文喂回蒸馏之前必须摘掉（模型看不到，就不会手痒去改写它）
const GUIDANCE_SECTION_TITLE = '人工指导（不参与蒸馏 · 原样保留）'
const GUIDANCE_MATCH_PREFIX = '人工指导'
const GUIDANCE_DIR_NAME = '_guidance'
const GUIDANCE_KEY = 'guidance'
const GUIDANCE_NOTE = '（人工指导＝人为干预 · 由人/面板追加，本体只读不改 · 目标与判据以本节为准）'

function guidanceDir(cfg) { return path.join(workDir(cfg), GUIDANCE_DIR_NAME) }
function guidancePath(cfg, id) { return path.join(guidanceDir(cfg), safeId(id) + '.md') }
// 解析指导文件。标题只认**列 0 起**的 #：缩进过的 # 是正文（渲染时正文统一缩进 2 空格，就是防打架）。
function parseGuidance(raw) {
  const lines = String(raw == null ? '' : raw).split(/\r?\n/)
  const entries = []
  let cur = null
  for (const line of lines) {
    if (line.charAt(0) === '#') {
      const m = line.match(/^(#{1,6})\s+(.+?)\s*$/)
      if (m && m[1].length <= 2) {
        if (m[1].length === 1) { cur = null; continue }            // 一级标题 = 文件抬头，不是条目
        const parts = m[2].split('·').map((s) => s.trim()).filter(Boolean)
        cur = { at: '', from: '', section: '', body: [] }
        if (parts.length >= 3) { cur.at = parts[0]; cur.from = parts[1]; cur.section = parts[2].replace(/^分区\s*[：:]\s*/, '') }
        else if (parts.length === 2) { cur.at = parts[0]; cur.from = parts[1] }
        else { cur.at = m[2] }
        entries.push(cur)
        continue
      }
    }
    const t = line.trim()
    if (t.indexOf('<!--') === 0) continue                          // 面板的注释行不入正文
    if (!cur) continue
    if (!t) { if (cur.body.length) cur.body.push(''); continue }
    cur.body.push(line)
  }
  const out = []
  for (const e of entries) {
    const body = e.body.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
    if (!body.trim()) continue
    out.push({ at: e.at, from: e.from, section: e.section, body: body })
  }
  return out
}
// 读指导。任何异常都退化成「0 条」并把原因留在返回值里（供路由/探针观察），绝不抛给调用方。
function loadGuidance(cfg, id) {
  const file = guidancePath(cfg, id)
  let dirExists = false
  try { dirExists = fs.statSync(path.dirname(file)).isDirectory() } catch { dirExists = false }
  let exists = false
  let raw = ''
  let entries = []
  try {
    raw = fs.readFileSync(file, 'utf8')
    exists = true
    entries = parseGuidance(raw)
  } catch { exists = false; raw = ''; entries = [] }
  return { path: file, dir: path.dirname(file), dirExists: dirExists, exists: exists, raw: raw, entries: entries }
}
// 渲染固定节。正文**逐字保留**，只统一加 2 空格缩进（内容一个字符都不改，改的只是行首缩进）。
function renderGuidanceSection(entries, cfg) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && String(e.body || '').trim())
  const max = clampNumber(cfg.guidanceMaxEntries, 1, 200, 20)
  const keep = list.slice(Math.max(0, list.length - max))   // 超量只丢最老的**渲染**，磁盘上的指导文件一字不动
  const lines = []
  lines.push('')
  lines.push('## ' + GUIDANCE_SECTION_TITLE)
  lines.push(GUIDANCE_NOTE)
  if (!keep.length) lines.push('- （无）')
  else for (const e of keep) {
    const meta = [e.at || '????-??-?? ??:??:??', e.from || '人工'].concat(e.section ? ['分区：' + e.section] : []).join(' · ')
    lines.push('### ' + meta)
    for (const l of String(e.body).split(/\r?\n/)) lines.push('  ' + l)
  }
  return { text: lines.join('\n'), count: keep.length, total: list.length }
}

// ===== 蒸馏 =====
// 实测教训（2026-09-18）：mimo-v2.5 有时会把整份输出预算花在 reasoning 上，
// 正文为空、finish=max-tokens —— 那是**失败**，不是「空回复」，必须当失败处理。
// 所以：先按配置给预算，空正文/超时就**加一倍预算重试一次**（最多两次尝试）；
// 模型名写错、鉴权失败这类「重试也没用」的错误直接失败，不浪费第二次调用。
async function distill(ctx, cfg, state, prompt) {
  // ★ R32（出厂化）：蒸馏前先把模型定下来。配置里给了就用配置；没给就现场探测。
  //   ⚠ 这一行是【接线】—— 我第一版只写了 ensureModel 函数却没在这里调它，
  //     结果自动探测成了死代码，出厂后蒸馏会直接报「没有配置蒸馏模型」。
  await ensureModel(ctx, cfg, state)
  const budgets = [cfg.maxTokens, Math.min(cfg.maxTokens * 2, 8000)]
  let lastError = null
  let attempts = 0
  for (const budget of budgets) {
    attempts += 1
    try {
      const result = await distillOnce(ctx, cfg, state, prompt, budget)
      return Object.assign(result, { attempts: attempts, maxTokens: budget })
    } catch (error) {
      lastError = error
      if (!/空正文|中止（超时或取消）|max-tokens/.test(errText(error))) break   // 重试没意义的错就不重试
      warn('蒸馏第 ' + attempts + ' 次失败（准备加预算重试）：' + errText(error))
    }
  }
  throw lastError
}

async function distillOnce(ctx, cfg, state, prompt, maxTokens) {
  const llm = llmService(ctx)
  if (!llm) throw new Error('llm 服务不可用（这个 profile 没挂 llm）')
  const picked = (state.resolvedModel && state.resolvedModel.model) ? state.resolvedModel : null
  const provider = String((picked && picked.provider) || cfg.provider || '').trim()
  const model = String(state.modelOverride || cfg.model || (picked && picked.model) || '').trim()
  if (!model) throw new Error('没有配置蒸馏模型，也自动探测不到 —— 打 /hot-memory/doctor 看现场有哪些 provider/model')
  const messages = [createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'instructions' },
  })]
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch { /* 忽略 */ } }, cfg.timeoutMs)
  let text = ''
  let finish = null
  try {
    for await (const chunk of llm.stream({
      provider: provider,
      model: model,
      messages: messages,
      maxTokens: maxTokens,
      signal: controller.signal,
    })) {
      const type = String((chunk && chunk.type) || '')
      if (type === 'text-delta' || type === 'text') text += String(chunk.text || '')
      if (type === 'finish') finish = chunk.reason || chunk
    }
  } finally { clearTimeout(timer) }
  // DSH 的流把失败**带内**传过来（finish.reason.kind === 'error'），不抛异常 ——
  // 不看这个分片就会把 provider 的报错当成「成功的空回复」。
  if (finish && finish.kind === 'error' && finish.failure) {
    const error = new Error(String(finish.failure.message || 'provider 报错但没给消息'))
    error.code = String(finish.failure.code || '')
    error.inband = true
    throw error
  }
  if (finish && finish.kind === 'aborted') throw new Error('蒸馏调用被中止（超时或取消）')
  const trimmed = text.trim()
  if (!trimmed) throw new Error('蒸馏返回空正文（finish=' + String((finish && finish.kind) || '?') + '，模型=' + model + '）')
  return { text: trimmed, model: model, finish: String((finish && finish.kind) || '') }
}

// ===== 指针注入 =====
// 指针行是**每一轮都要付**的成本：注入的这一行会被后续每一次调用重放。
// 所以它只留三样东西：路径（能直接 read）、条数、时间。多一个字都是长期开销。
// R24：指导条数只在 >0 时插进来 —— guide=0 时这一行的字节与 R23 **完全一致**（有专项检查盯着）。
// ★形参顺序：guide 必须**追加在末尾**。R23 的调用是 (cfg,id,count,parts,date)，把 guide 插在 date 前面
//   会把 Date 当成指导条数（Number(Date) 是 13 位数字 > 0），R24 第一版就这么错过一次 ——
//   当场被 R23 的老考卷抓住（指针里冒出「· 1789996200000 条人工指导」）。老签名必须继续能用。
function pointerText(cfg, id, count, parts, date, guide) {
  const mid = count + ' 条 · ' + parts + ' 区' + (Number(guide) > 0 ? ' · ' + Number(guide) + ' 条人工指导' : '')
  return '热记忆已更新：' + memoPath(cfg, id) + '（' + mid + '，' + hhmm(date) + '）'
}
function injectPointer(ctx, cfg, state, id, count, parts, date, guide) {
  const text = pointerText(cfg, id, count, parts, date, guide)
  const agents = agentsService(ctx)
  const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
  if (!agent || typeof agent.inject !== 'function') {
    // ★ R26：agent 已注销（子会话蒸馏要跑 30~110s，跑完它往往已经结束）——不把文本丢掉，
    //   落盘进 outbox，等这个会话下次开轮（那时 agent 是活的）再补投。实测此举把子会话的
    //   注入成功率从 28/72 提上去；投成功即删，超 2 小时的不再补（过了时效没意义）。
    try { saveOutbox(cfg, id, text) } catch (error) { warn('写指针 outbox 失败（不影响会话）：', errText(error)) }
    return { ok: false, reason: 'agent-not-live', text, queued: true }
  }
  const message = createUserMessage({
    content: [{ type: 'text', text: text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: clip(text, 120) },
  })
  agent.inject(message)
  return { ok: true, text, messageId: message.id }
}

// ===== 一轮结束 → 写记忆 =====
function eventsForTurn(session, state, endEvent) {
  const events = sessionEvents(session)
  const id = String(session.id)
  const endSeq = Number(endEvent && endEvent.seq)
  let from = state.cursor.has(id) ? state.cursor.get(id) : null
  if (from === null) {
    // 插件是热加载进来的，没有历史游标：往前找上一个 turn/end 当作边界；
    // 找不到就只取最近的一段（别把整本日志塞进材料）。
    from = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if (e && e.type === 'turn/end' && Number(e.seq) < endSeq) { from = Number(e.seq); break }
    }
    if (from === -1) from = Math.max(-1, endSeq - 400)
  }
  state.cursor.set(id, endSeq)
  // 常驻诊断（R32）：把"为什么这轮没有材料"记进 skip 事件。
  // ★ 这条不是调试残留：0.1.5 的 Session 曾有"属性变方法"（.events → snapshotEvents()）的破坏性变更，
  //   那次事故的症状正是 events:0 + empty-digest，而界面上完全没有报错。
  //   留下 eventsArrLen / from / endSeq 三个数，下次同类问题一眼可判，不用再改代码重启。
  try { state.__dbg = { sessionId: id, endSeq: endSeq, from: from, eventsArrLen: events.length, matched: events.filter((e) => e && Number(e.seq) > from && Number(e.seq) <= endSeq).length } } catch (e) { state.__dbg = null }
  return events.filter((e) => e && Number(e.seq) > from && Number(e.seq) <= endSeq)
}

async function runMemory(ctx, cfg, state, session, endEvent, trigger) {
  const id = String(session.id)
  const turn = Number((endEvent.data || {}).turn)
  // ★ R26：补投【不能在这里同步做】——实测报 "session append cannot reenter while another append is being published"，
  //   因为 runMemory 是在 append 流程中触发的。改成把投递排到事件循环的下一拍（append 事务结束后再投），见本函数末尾 scheduleFlush。
  const slice = eventsForTurn(session, state, endEvent)
  const digest = renderDigest(slice)
  if (!digest.trim()) {
    state.stats.skipped += 1
    appendEvent(cfg, { kind: 'skip', sessionId: id, turn: turn, reason: 'empty-digest', events: slice.length, dbg: state.__dbg || null, digestLen: digest.length, sliceLen: slice.length })
    return
  }
  const cut = digest.length > cfg.maxInputChars
  const material = cut ? digest.slice(digest.length - cfg.maxInputChars) : digest
  // 投喂区（R22）：事件流现扫 + sidecar 兜底，全程 try/catch —— 投喂出任何岔子都不许影响蒸馏。
  let feedStored = []
  try { feedStored = loadFeedSidecar(cfg, id) } catch { feedStored = [] }
  let feedEntries = feedStored
  try { feedEntries = mergeFeedEntries(extractFeedEntries(session), feedStored) } catch (error) {
    feedEntries = Array.isArray(feedStored) ? feedStored : []
    warn('投喂抽取失败（退回 sidecar，不影响蒸馏）：', errText(error))
  }
  // 人工指导（R24）：读盘 —— 目录/文件不存在、格式乱、读不动，全部退化成 0 条，绝不影响蒸馏与写盘。
  let guidance = null
  try { guidance = loadGuidance(cfg, id) }
  catch (error) { warn('读人工指导失败（当成 0 条，不影响本轮）：', errText(error)) }
  if (!guidance) guidance = { path: guidancePath(cfg, id), dir: guidanceDir(cfg), dirExists: false, exists: false, raw: '', entries: [] }
  // 两个「原样保留」节必须**在拼装之前**渲染好：索引要按落盘后的完整文本算边界（见 assembleMemo）。
  let guide = { text: '', count: 0, total: 0 }
  try { guide = renderGuidanceSection(guidance.entries, cfg) } catch (error) { warn('人工指导渲染失败（本节缺席，不影响蒸馏）：', errText(error)) }
  let feed = { text: '', active: 0, expired: 0, total: 0 }
  try { feed = renderFeedSection(feedEntries, turn, cfg) } catch (error) { warn('投喂区渲染失败（本轮第 6 节缺席，不影响蒸馏）：', errText(error)) }
  const tail = (guide.count > 0 && guide.text ? guide.text : '') + (feed.text || '')
  const previous = stripForPrompt(readMemo(cfg, id))
  const mode = memoModeOf(cfg, id)
  const prompt = buildPrompt(previous, material, { turn: turn, count: slice.length, cut: cut }, mode)
  const started = Date.now()
  const result = await distill(ctx, cfg, state, prompt)   // 失败就抛，由外面接住（fail-open）
  const memo = parseMemo(result.text)
  const rendered = assembleMemo(id, memo, { at: stamp(), turn: turn, model: result.model, count: slice.length }, cfg.maxMemoryBytes, tail)
  const capped = { text: rendered.text, bytes: rendered.bytes, cut: rendered.cut }
  // 第 6 节由代码拼装、追加在蒸馏部分之后（不占 maxMemoryBytes 预算）；渲染失败就整节缺席（fail-open）。
  ensureDir(cfg)
  writeAtomic(memoPath(cfg, id), rendered.fullText)   // 与索引自证用的是同一个字符串，口径同源
  try { if (feedEntries.length || feedStored.length) saveFeedSidecar(cfg, id, feedEntries) } catch { /* 忽略 */ }
  const count = itemCount(memo)
  const partCount = rendered.partitions.filter((p) => p.kind !== 'feed').length
  let pointer = { ok: false, reason: 'pointer-disabled', text: '' }
  if (cfg.pointer) {
    try { pointer = injectPointer(ctx, cfg, state, id, count, partCount, new Date(), guide.count) }
    catch (error) { pointer = { ok: false, reason: 'inject-failed: ' + errText(error), text: '' }; warn('注入指针失败（不影响会话）：', errText(error)) }
  }
  state.stats.distillOk += 1
  if (pointer.ok) state.stats.injected += 1
  else state.stats.injectSkipped += 1
  // ★ R26：把"补投上一轮没投出去的指针"排到事件循环的下一拍 —— 本函数此刻仍在 append 事务里，
  //   同步投会被拒（实测 2 次 pointer-flush-fail）。延后一拍后 append 已结束，注入才被允许。
  try { scheduleFlush(ctx, cfg, state, id) } catch (error) { warn('排补投失败（不影响本轮回）：', errText(error)) }
  const snap = {
    sessionId: id, turn: turn, at: new Date().toISOString(), ok: true,
    path: memoPath(cfg, id), bytes: capped.bytes, items: count, truncated: capped.cut,
    events: slice.length, model: result.model, elapsedMs: Date.now() - started, memoMode: mode, trigger: trigger || 'turn-end',
    attempts: result.attempts, maxTokens: result.maxTokens,
    schema: SCHEMA_V2, partitions: partCount, partitionBytes: rendered.partitions.map((p) => ({ title: p.title, bytes: p.bytes })),
    indexMode: rendered.indexOmitted ? 'omitted-预算太小' : 'in-file',
    feeds: { active: feed.active, expired: feed.expired, total: feed.total },
    guidance: { count: guide.count, total: guide.total, exists: guidance.exists, dirExists: guidance.dirExists, path: guidance.path },
    pointerOk: pointer.ok, pointer: pointer.text, pointerReason: pointer.reason || '', pointerMessageId: pointer.messageId || '',
  }
  state.last.set(id, snap)
  appendEvent(cfg, Object.assign({ kind: 'distill' }, snap))
  log('热记忆已更新 · ' + shortId(id) + ' · 第 ' + turn + ' 轮 · ' + capped.bytes + 'B · ' + count + ' 条 · ' + partCount + ' 区 · 人工指导 ' + guide.count + ' · 投喂 ' + feed.active + '（已过期 ' + feed.expired + '）· ' + (Date.now() - started) + 'ms' + (pointer.ok ? ' · 已注入指针' : ' · 未注入（' + pointer.reason + '）'))
  return snap
}

// ★ R30：长轮次兜底。判据：本轮累计事件数 >= longTurnEvents 或时长 >= longTurnMinutes，
//   且同一轮只兜底一次、且当前没有正在跑的蒸馏。任何异常都吞掉（fail-open 红线）。
function maybeLongTurnDistill(ctx, cfg, state, session, event) {
  try {
    if (!cfg.longTurnDistill) return
    const id = String((session && session.id) || '')
    if (!id) return
    const s = state.since.get(id)
    if (!s) return
    const turn = Number(s.turn) || 0
    if (state.pending.has(id)) return                     // 有活正在跑，别插队
    // ★ 周期兜底，不是"每轮只一次"：第一版写成"同一轮只兜底一次"，那样一轮跑两小时也只有开头兜一次，
    //   后面照旧不落盘。改成触发后把计数清零重新计时，并留一个最小间隔防抖。
    const lastAt = Number(state.longTurn.get(id) || 0)
    const gapMs = Math.max(1, Number(cfg.longTurnMinGapMinutes) || 5) * 60 * 1000
    if (lastAt && Date.now() - lastAt < gapMs) return  // 最小间隔（默认 5 分钟）
    const byEvents = Number(s.events) >= Number(cfg.longTurnEvents)
    const byTime = (Date.now() - Number(s.atMs)) >= Number(cfg.longTurnMinutes) * 60 * 1000
    if (!byEvents && !byTime) return
    state.longTurn.set(id, Date.now())
    state.since.set(id, { events: 0, atMs: Date.now(), turn: turn, lastSeq: s.lastSeq })  // 重新计时
    const why = byEvents ? 'events=' + s.events : 'minutes=' + Math.round((Date.now() - s.atMs) / 60000)
    appendEvent(cfg, { kind: 'long-turn-trigger', sessionId: id, turn: turn, reason: why })
    log('长轮次兜底蒸馏触发 · ' + shortId(id) + ' · 第 ' + turn + ' 轮 · ' + why)
    // 合成一个"轮末"事件：runMemory 只用到 data.turn 与 seq 两样。
    handleTurnEnd(ctx, cfg, state, session, { type: 'turn/end', seq: s.lastSeq, data: { turn: turn } }, 'long-turn')
  } catch (error) { warn('长轮次兜底判断失败（已放行）：', errText(error)) }
}

function handleTurnEnd(ctx, cfg, state, session, endEvent, trigger) {
  const id = String(session.id)
  if (state.pending.has(id)) { state.stats.skipped += 1; appendEvent(cfg, { kind: 'skip', sessionId: id, reason: 'busy' }); return }
  let job
  job = (async () => {
    try {
      await runMemory(ctx, cfg, state, session, endEvent, trigger)
    } catch (error) {
      // fail-open：这里吞掉一切异常 —— 蒸馏失败绝不许影响会话本身。
      state.stats.distillFail += 1
      // ★ R32：这一轮的模型选择可能已经过时（provider 掉线/额度用尽），清掉缓存让下一轮重探。
      state.resolvedModel = null
      const snap = { sessionId: id, at: new Date().toISOString(), ok: false, error: errText(error), code: String((error && error.code) || '') }
      state.last.set(id, Object.assign({}, state.last.get(id), snap))
      appendEvent(cfg, Object.assign({ kind: 'distill-fail' }, snap))
      warn('蒸馏失败（已放行，不影响对话）：' + shortId(id) + ' · ' + errText(error))
    } finally {
      if (state.pending.get(id) === job) state.pending.delete(id)
    }
  })()
  state.pending.set(id, job)
}

// ===== R26：指针 outbox（agent 不在时把指针存下来，下次开轮补投）=====
function outboxPath(cfg, id) { return path.join(workDir(cfg), '_pending', safeId(id) + '.json') }
function saveOutbox(cfg, id, text) {
  const p = outboxPath(cfg, id)
  ensureDir(cfg)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const rec = { id: id, text: text, at: new Date().toISOString(), atMs: Date.now() }
  writeAtomic(p, JSON.stringify(rec))
  return p
}
function takeOutbox(cfg, id) {
  const p = outboxPath(cfg, id)
  let rec = null
  // ★ 读不动/坏 JSON 也要把它清掉：否则坏文件会永久卡在 outbox 里，每次开轮读一次、永远清不掉。
  try { rec = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { try { fs.rmSync(p, { force: true }) } catch { /* 忽略 */ } ; return null }
  if (!rec || typeof rec.text !== 'string' || !rec.text) { try { fs.rmSync(p, { force: true }) } catch { /* 忽略 */ } ; return null }
  // 超过 2 小时的指针不再补投：那时它说的"热记忆已更新"已经过期，投出去只会误导。
  if (rec.atMs && Date.now() - rec.atMs > 2 * 60 * 60 * 1000) { try { fs.rmSync(p, { force: true }) } catch { /* 忽略 */ } ; return null }
  return { path: p, rec: rec }
}
function clearOutbox(cfg, id) { try { fs.rmSync(outboxPath(cfg, id), { force: true }) } catch { /* 忽略 */ } }
// ★ R30：只有这几类事件才算"真的干了活"。第一版把 assistant/chunk 也算进去，
//   结果 400 的阈值在热加载后 14 秒就满了（一次工具调用会产生几十个 chunk 事件）。
const LONG_TURN_COUNTED = new Set(['user/message', 'assistant/message', 'tool/result', 'tool/call'])
const FLUSH_QUEUED = new Set()
function scheduleFlush(ctx, cfg, state, id) {
  if (FLUSH_QUEUED.has(id)) return
  FLUSH_QUEUED.add(id)
  setTimeout(() => {
    FLUSH_QUEUED.delete(id)
    try {
      const got = takeOutbox(cfg, id)
      if (!got) return                     // 没有待投的，什么都不做
      const r = flushOutbox(ctx, cfg, state, id)
      if (r && r.ok) warn('补投成功：' + shortId(id) + ' · ' + clip(String(r.text || ''), 80))
    } catch (error) { warn('补投异常（不影响会话）：', errText(error)) }
  }, 2500)
}
function flushOutbox(ctx, cfg, state, id) {
  const got = takeOutbox(cfg, id)
  if (!got) return { ok: false, reason: 'no-queued' }
  const agents = agentsService(ctx)
  const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
  if (!agent || typeof agent.inject !== 'function') return { ok: false, reason: 'still-not-live' }
  try {
    const message = createUserMessage({
      content: [{ type: 'text', text: got.rec.text }],
      source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: clip(got.rec.text, 120) },
    })
    agent.inject(message)
    clearOutbox(cfg, id)
    appendEvent(cfg, { kind: 'pointer-flush', sessionId: id, queuedAt: got.rec.at, messageId: message.id })
    return { ok: true, text: got.rec.text, messageId: message.id }
  } catch (error) {
    appendEvent(cfg, { kind: 'pointer-flush-fail', sessionId: id, error: errText(error) })
    return { ok: false, reason: 'flush-failed: ' + errText(error) }
  }
}

function readMemo(cfg, id) {
  try { return fs.readFileSync(memoPath(cfg, id), 'utf8') } catch { return '' }
}

// ===== 工具：hot_memory（只读）=====
const OUTPUT_OBJECT = { type: 'object', additionalProperties: true }
function jsonBlocks(value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] }

function registerTools(ctx, cfg, state) {
  const service = toolsService(ctx)
  if (!service || typeof service.register !== 'function') { warn('没有工具注册表（tools 服务缺失），hot_memory 没挂上。'); return false }
  try {
    service.register({
      name: 'hot_memory',
      description: '读取本会话的「热记忆」备忘（每轮自动刷新的短摘要：当前目标 / 已确认事实 / 未决问题 / 关键文件路径 / 最近决策；另有「主题分区」）。想回顾之前发生过什么、又不想翻上下文时用它。不传 topic 返回全文 + 分区索引；传 topic（分区名，如「关键文件路径」）只取那一区，省 token。只读，不会改任何东西。',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '要读哪个会话的热记忆（默认 = 当前会话）' },
          topic: { type: 'string', description: '只要某一个分区（按主题取分区）。不填 = 返回全文与分区索引；填了 = 只返回该分区的字节' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_OBJECT, render: (_args, value) => jsonBlocks(value) },
      execute: async (args, exec) => {
        const mine = sessionIdOf(exec && exec.agent)
        const id = String((args && args.session_id) || '').trim() || mine
        if (!id) return { ok: false, error: '拿不到会话 id（这个工具要在某个会话里调用）' }
        const file = memoPath(cfg, id)
        let stat = null
        let content = ''
        try { stat = fs.statSync(file); content = fs.readFileSync(file, 'utf8') } catch { stat = null }
        if (!stat) {
          return { ok: true, exists: false, sessionId: id, path: file, hint: '这个会话还没有热记忆：至少跑完一轮才会生成（生成后每轮覆盖更新）。' }
        }
        const whole = Buffer.byteLength(content, 'utf8')
        const parsed = parseMemoFile(content)
        const want = String((args && args.topic) || '').trim()
        const brief = parsed.partitions.map((p) => ({ key: p.key, title: p.title, kind: p.kind, system: !!p.system, items: p.items, bytes: p.bytes }))
        // 人工指导（R24）：工具返回里给出条数与文件位置；正文本来就在 content 里（整份文件），不用另取。
        let ginfo = { count: 0, exists: false, dirExists: false, path: guidancePath(cfg, id) }
        try { const g = loadGuidance(cfg, id); ginfo = { count: g.entries.length, exists: g.exists, dirExists: g.dirExists, path: g.path } } catch { /* 忽略：读不动就当 0 条 */ }
        if (want) {
          const hit = pickPartition(parsed.partitions, want)
          if (!hit) {
            return { ok: true, exists: true, sessionId: id, path: file, schema: parsed.schema, topic: want, matched: false, available: brief, hint: '没有这个分区：从 available 里挑一个名字再试。' }
          }
          return {
            ok: true, exists: true, sessionId: id, path: file, schema: parsed.schema,
            topic: hit.title, matched: true, bytes: hit.bytes, wholeFileBytes: whole,
            updatedAt: stat.mtime.toISOString(),
            guidance: ginfo,
            content: hit.content,
          }
        }
        return {
          ok: true, exists: true, sessionId: id, path: file, schema: parsed.schema,
          bytes: whole, updatedAt: stat.mtime.toISOString(),
          partitions: brief,
          guidance: ginfo,
          content: content,
        }
      },
      presentResult: () => ({ card: 'generic', title: '热记忆' }),
    })
    return true
  } catch (error) { warn('hot_memory 注册失败：', errText(error)); return false }
}

// ===== HTTP 探针 =====
function sendJson(res, code, value) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value, null, 2))
  } catch (error) { try { res.end('error: ' + errText(error)) } catch { /* 忽略 */ } }
}
function sendText(res, code, text) {
  try {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  } catch { /* 忽略 */ }
}
function query(req) {
  try { return new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams } catch { return new URLSearchParams('') }
}
// 从活会话的事件日志里把「注入的那一行」原样捞出来 —— 这就是会话记录里的证据。
function injectedEvidence(session) {
  const out = []
  for (const event of sessionEvents(session)) {
    if (!event || event.type !== 'agent/inbox/spliced') continue
    const inserted = Array.isArray((event.data || {}).inserted) ? event.data.inserted : []
    for (const message of inserted) {
      const source = (message && message.source) || {}
      if (source.kind !== 'plugin' || source.plugin !== PLUGIN_ID) continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n')
      out.push({
        seq: event.seq, time: event.time, type: event.type, target: (event.data || {}).target,
        messageId: message.id, summary: source.summary || '', text: text,
      })
    }
  }
  return out
}
function memoryList(cfg) {
  const dir = workDir(cfg)
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')) } catch { names = [] }
  return names.map((n) => {
    const file = path.join(dir, n)
    let stat = null
    try { stat = fs.statSync(file) } catch { stat = null }
    return { file: file, sessionId: n.replace(/\.md$/, ''), bytes: stat ? stat.size : 0, mtime: stat ? new Date(stat.mtimeMs).toISOString() : '' }
  }).sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
}

function waitIdle(agent, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (how) => { if (done) return; done = true; resolve(how) }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    Promise.resolve().then(() => agent.whenIdle()).then(() => { clearTimeout(timer); finish('idle') }, () => { clearTimeout(timer); finish('error') })
  })
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

// 自测驱动：真起一个会话、真跑 N 轮对话（testHooks 打开时才挂）。
// 存在的理由：验收要「3 轮真实对话」的现场证据，而本机有 4 个在线会话在跑，
// 既不能重启 DSH，也不能拿别人的会话当试验品。
async function driveTurns(ctx, cfg, state, opts) {
  const agents = agentsService(ctx)
  if (!agents || typeof agents.create !== 'function') throw new Error('没有 agents 服务，驱动不了自测会话')
  const turns = clampNumber(opts.turns, 1, 5, 3)
  const sessionId = 'hotmem-selftest-' + Date.now().toString(36)
  const handle = await agents.create({
    sessionId: sessionId,
    meta: { cwd: opts.cwd || dshHome() },
    agentOptions: { provider: cfg.agentProvider, model: cfg.agentModel, maxTokens: 400 },
  })
  const agent = handle.agent
  const out = { sessionId: sessionId, turns: [], model: { provider: cfg.agentProvider, model: cfg.agentModel }, startedAt: new Date().toISOString() }
  try {
    for (let i = 1; i <= turns; i += 1) {
      const before = sessionEvents(agent.session).length
      const prompt = String((opts.prompts && opts.prompts[i - 1]) || ('第 ' + i + ' 句：用一句话回答，不要调用任何工具。记住：本次测试的第 ' + i + ' 个编号是 ' + i + '。'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      const how = await waitIdle(agent, cfg.driveTimeoutMs)
      const job = state.pending.get(sessionId)
      if (job) { try { await Promise.race([job, sleep(cfg.timeoutMs + 8000)]) } catch { /* 忽略 */ } }
      const events = sessionEvents(agent.session)
      const endEvent = (() => { for (let k = events.length - 1; k >= 0; k -= 1) if (events[k] && events[k].type === 'turn/end') return events[k]; return null })()
      const assistant = (() => { for (let k = events.length - 1; k >= 0; k -= 1) if (events[k] && events[k].type === 'assistant/message') return events[k]; return null })()
      const memo = state.last.get(sessionId) || null
      let memoStat = null
      try { memoStat = fs.statSync(memoPath(cfg, sessionId)) } catch { memoStat = null }
      // 本轮的工具调用与结果：拿它证明 hot_memory 真的被模型调用过、真的读到了文件。
      const turnCalls = []
      const callNames = new Map()
      const toolResults = []
      for (const e of events.slice(before)) {
        try {
          if (e.type === 'tool/call') {
            callNames.set(String(e.data.callId), String(e.data.name))
            turnCalls.push({ name: String(e.data.name), arguments: clip(String(e.data.arguments || ''), 300) })
          } else if (e.type === 'tool/result') {
            const text = textOfContent((e.data.message || {}).content, 4000)   // 给足：200 字符会把记忆正文剪掉，看不出它到底读到了什么
            toolResults.push({ tool: callNames.get(String((e.data.message || {}).source && (e.data.message || {}).source.callId)) || '', chars: text.length, hasMemoSections: text.indexOf('## 当前目标') !== -1, preview: clip(text, 300) })
          }
        } catch { /* 忽略 */ }
      }
      out.turns.push({
        turn: i, prompt: prompt, idle: how,
        toolCalls: turnCalls, toolResults: toolResults,
        eventsBefore: before, eventsAfter: events.length,
        endReason: endEvent ? ((endEvent.data || {}).reason || {}).kind : null,
        assistantChars: assistant ? textOfContent(((assistant.data || {}).message || {}).content).length : 0,
        assistantPreview: assistant ? clip(textOfContent(((assistant.data || {}).message || {}).content), 200) : '',
        memo: memo,
        memoFile: memoStat ? { path: memoPath(cfg, sessionId), bytes: memoStat.size, mtime: new Date(memoStat.mtimeMs).toISOString() } : null,
        injected: injectedEvidence(agent.session),
      })
    }
  } finally {
    try { out.events = sessionEvents(agent.session).filter((e) => ['turn/start', 'turn/end', 'user/message', 'assistant/message', 'agent/inbox/spliced', 'tool/call', 'tool/result'].indexOf(e.type) !== -1).map((e) => ({ seq: e.seq, type: e.type, time: e.time, data: e.data })) } catch { /* 忽略 */ }
    try { await handle.dispose() } catch (error) { out.disposeError = errText(error) }
  }
  out.finishedAt = new Date().toISOString()
  out.memoFileFinal = (() => { try { const s = fs.statSync(memoPath(cfg, sessionId)); return { path: memoPath(cfg, sessionId), bytes: s.size, mtime: new Date(s.mtimeMs).toISOString() } } catch { return null } })()
  try { ensureDir(cfg); writeAtomic(path.join(workDir(cfg), 'selftest-' + sessionId + '.json'), JSON.stringify(out, null, 2)) } catch (error) { out.saveError = errText(error) }
  return out
}

function registerRoutes(ctx, cfg, state) {
  let server
  try { server = ctx.get('webServer') } catch { server = undefined }
  if (!server || typeof server.register !== 'function') { warn('没有 webServer 服务，/hot-memory 探针没挂上'); return false }
  const routes = []
  routes.push(['/hot-memory', async (req, res) => {
    sendJson(res, 200, {
      plugin: PLUGIN_ID, version: VERSION, ok: true, pid: process.pid, startedAt: state.startedAt,
      dir: workDir(cfg),
      schema: SCHEMA_V2,
      schemasReadable: [SCHEMA_V1, SCHEMA_V2],
      partitionRoutes: ['/hot-memory/index', '/hot-memory/topic'],
      guidanceSupported: true,
      guidanceDir: guidanceDir(cfg),
      bytesRule: BYTES_RULE,
      config: {
        enabled: cfg.enabled, provider: cfg.provider,
        model: String(state.modelOverride || cfg.model), configuredModel: cfg.model, modelOverride: state.modelOverride || null,
        maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs, maxMemoryBytes: cfg.maxMemoryBytes,
        feedMaxLines: cfg.feedMaxLines, feedExpireRounds: cfg.feedExpireRounds,
        guidanceMaxEntries: cfg.guidanceMaxEntries,
        pointer: cfg.pointer, testHooks: cfg.testHooks,
      },
      stats: state.stats,
      toolRegistered: (() => {
        try { const service = toolsService(ctx); return !!(service && typeof service.get === 'function' && service.get('hot_memory')) }
        catch { return false }
      })(),
      pending: Array.from(state.pending.keys()),
      last: Object.fromEntries(state.last),
      memories: memoryList(cfg),
      eventsFile: path.join(workDir(cfg), 'events.jsonl'),
    })
  }])
  routes.push(['/hot-memory/file', async (req, res) => {
    const params = query(req)
    const id = String(params.get('id') || '').trim()
    if (!id) { sendJson(res, 400, { ok: false, error: '缺 id' }); return }
    const file = memoPath(cfg, id)
    try { sendText(res, 200, fs.readFileSync(file, 'utf8')) }
    catch (error) { sendJson(res, 404, { ok: false, error: '读不到 ' + file + '：' + errText(error) }) }
  }])
  // R23：分区索引（列全部区 + 每区字节）。老格式文件没有落盘索引时，这里现解析补出来 —— 这就是「两种格式都能吃」。
  routes.push(['/hot-memory/index', async (req, res) => {
    const params = query(req)
    const id = String(params.get('id') || '').trim()
    if (!id) { sendJson(res, 400, { ok: false, error: '缺 id' }); return }
    const file = memoPath(cfg, id)
    let raw = ''
    try { raw = fs.readFileSync(file, 'utf8') }
    catch (error) { sendJson(res, 404, { ok: false, error: '读不到 ' + file + '：' + errText(error) }); return }
    const parsed = parseMemoFile(raw)
    sendJson(res, 200, {
      ok: true, sessionId: id, path: file,
      schema: parsed.schema,
      format: parsed.schema === SCHEMA_V2 ? 'v2-分区+索引' : 'v1-扁平5小节',
      wholeFileBytes: Buffer.byteLength(raw, 'utf8'),
      partitionCount: parsed.partitions.length,
      contentPartitionCount: parsed.partitions.filter((p) => p.kind !== 'feed').length,
      bytesRule: BYTES_RULE,
      partitions: parsed.partitions.map((p) => {
        const disk = measurePartitionOnDisk(raw, headingLineOf(p))
        return { key: p.key, title: p.title, kind: p.kind, system: !!p.system, items: p.items, bytes: p.bytes, diskBytes: disk, bytesMatch: disk === p.bytes, lines: p.lines }
      }),
      bytesAllMatch: parsed.partitions.every((p) => measurePartitionOnDisk(raw, headingLineOf(p)) === p.bytes),
      indexInFile: parsed.indexInFile,
      indexMatchesFile: indexAgrees(raw),
      topicsInFile: parsed.topics.map((t) => t.name),
    })
  }])
  // R23：按需调取 —— 只返回该分区的字节，并把「整份文件字节数」并排给出来。
  routes.push(['/hot-memory/topic', async (req, res) => {
    const params = query(req)
    const id = String(params.get('id') || '').trim()
    const want = String(params.get('topic') || '').trim()
    if (!id) { sendJson(res, 400, { ok: false, error: '缺 id' }); return }
    if (!want) { sendJson(res, 400, { ok: false, error: '缺 topic（先打 /hot-memory/index?id=… 看有哪些分区）' }); return }
    const file = memoPath(cfg, id)
    let raw = ''
    try { raw = fs.readFileSync(file, 'utf8') }
    catch (error) { sendJson(res, 404, { ok: false, error: '读不到 ' + file + '：' + errText(error) }); return }
    const parsed = parseMemoFile(raw)
    const hit = pickPartition(parsed.partitions, want)
    if (!hit) { sendJson(res, 404, { ok: false, error: '没有这个分区：' + want, available: parsed.partitions.map((p) => p.title) }); return }
    const whole = Buffer.byteLength(raw, 'utf8')
    const others = parsed.partitions.filter((p) => p.key !== hit.key && hit.content.indexOf(p.title) !== -1).map((p) => p.title)
    sendJson(res, 200, {
      ok: true, sessionId: id, path: file, schema: parsed.schema,
      topic: want, matchedTitle: hit.title, key: hit.key, kind: hit.kind,
      bytes: hit.bytes, wholeFileBytes: whole, share: whole ? Number((hit.bytes / whole).toFixed(4)) : 0,
      items: hit.items, lines: hit.lines,
      otherPartitionTitlesPresent: others,
      content: hit.content,
    })
  }])
  // ★ R32（出厂化）：诊断路由 —— 出厂后出了问题，第一个该看的地方。
  //   回答四个问题：① 现场有哪些 provider/model ② 自动挑中了哪个 ③ 记忆目录能不能写 ④ 上次蒸馏成没成。
  //   只读 + 一个写探针（写完立刻删）。
  routes.push(['/hot-memory/doctor', async (req, res) => {
    const llm = llmService(ctx)
    let providers = []
    try { providers = (llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []) || [] } catch { providers = [] }
    const models = {}
    for (const p of providers.slice(0, 12)) {
      const pid = String((p && p.id) || '')
      if (!pid) continue
      try { models[pid] = ((await llm.listModels(pid)) || []).map((m) => String((m && m.id) || '')) }
      catch (error) { models[pid] = ['(读不到：' + errText(error) + ')'] }
    }
    let dirWritable = false, dirWriteError = ''
    try {
      fs.mkdirSync(workDir(cfg), { recursive: true })
      const probe = path.join(workDir(cfg), '.doctor-write-probe')
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })
      dirWritable = true
    } catch (error) { dirWriteError = errText(error) }
    const last = []
    try { for (const kv of state.last.entries()) last.push(Object.assign({ sessionId: kv[0] }, kv[1])) } catch { /* 忽略 */ }
    sendJson(res, 200, {
      ok: true, plugin: PLUGIN_ID, version: VERSION, pid: process.pid, schema: SCHEMA_V2,
      dir: workDir(cfg), dirWritable: dirWritable, dirWriteError: dirWriteError,
      providerConfigured: String(cfg.provider || ''), modelConfigured: String(cfg.model || ''),
      providers: providers.map((p) => ({ id: String((p && p.id) || ''), name: String((p && p.name) || '') })),
      modelsAvailable: models,
      resolvedModel: state.resolvedModel || null,
      memoMode: { note: '空 fullMemoSessions = 不分档，所有会话都走完整档', fullMemoSessions: Array.isArray(cfg.fullMemoSessions) ? cfg.fullMemoSessions : [] },
      lastResults: last.slice(-8),
      stats: state.stats,
    })
  }])
  // R24：人工指导状态 —— 读盘 + 渲染 + 自证「有没有真的进到记忆文件里」。只读，本路由不写任何东西。
  routes.push(['/hot-memory/guidance', async (req, res) => {
    const params = query(req)
    const id = String(params.get('id') || '').trim()
    if (!id) { sendJson(res, 400, { ok: false, error: '缺 id' }); return }
    const g = loadGuidance(cfg, id)
    let rendered = { text: '', count: 0, total: 0 }
    try { rendered = renderGuidanceSection(g.entries, cfg) } catch (error) { warn('/hot-memory/guidance 渲染失败：', errText(error)) }
    const memoFile = memoPath(cfg, id)
    let memo = { path: memoFile, bytes: 0, hasGuidanceSection: false, readError: '' }
    try {
      const raw = fs.readFileSync(memoFile, 'utf8')
      memo = { path: memoFile, bytes: Buffer.byteLength(raw, 'utf8'), hasGuidanceSection: raw.indexOf('## ' + GUIDANCE_SECTION_TITLE) !== -1, readError: '' }
    } catch (error) { memo.readError = errText(error) }
    sendJson(res, 200, {
      ok: true, sessionId: id,
      contract: { dir: guidanceDir(cfg), file: g.path, format: '# 人工指导 · <id> + ## <时间> · <来源> · 分区：X + 正文（UTF-8）' },
      dirExists: g.dirExists, exists: g.exists,
      count: g.entries.length, fileBytes: Buffer.byteLength(g.raw || '', 'utf8'),
      maxEntries: clampNumber(cfg.guidanceMaxEntries, 1, 200, 20),
      entries: g.entries.map((e) => ({ at: e.at, from: e.from, section: e.section, body: e.body })),
      rendered: { count: rendered.count, total: rendered.total, bytes: Buffer.byteLength(rendered.text || '', 'utf8'), text: rendered.text },
      memoFile: memo,
    })
  }])
  routes.push(['/hot-memory/evidence', async (req, res) => {
    const params = query(req)
    const id = String(params.get('id') || '').trim()
    const agents = agentsService(ctx)
    const agent = id && agents && typeof agents.get === 'function' ? agents.get(id) : undefined
    if (!agent) { sendJson(res, 404, { ok: false, error: '没有这个活会话：' + id }); return }
    sendJson(res, 200, {
      ok: true, sessionId: id,
      memoFile: (() => { try { const s = fs.statSync(memoPath(cfg, id)); return { path: memoPath(cfg, id), bytes: s.size, mtime: new Date(s.mtimeMs).toISOString() } } catch { return null } })(),
      last: state.last.get(id) || null,
      injected: injectedEvidence(agent.session),
    })
  }])
  routes.push(['/hot-memory/test/config', async (req, res) => {
    const params = query(req)
    if (!cfg.testHooks) { sendJson(res, 403, { ok: false, error: 'testHooks 关着（要在 patch 的 config 里打开）' }); return }
    if (params.has('model')) state.modelOverride = String(params.get('model') || '').trim() || null
    if (params.has('enabled')) cfg.enabled = String(params.get('enabled')) !== '0' && String(params.get('enabled')) !== 'false'
    sendJson(res, 200, { ok: true, modelOverride: state.modelOverride, enabled: cfg.enabled })
  }])
  routes.push(['/hot-memory/drive', async (req, res) => {
    if (!cfg.testHooks) { sendJson(res, 403, { ok: false, error: 'testHooks 关着（要在 patch 的 config 里打开）' }); return }
    const params = query(req)
    const fail = params.get('fail') === '1'
    const saved = state.modelOverride
    try {
      if (fail) state.modelOverride = String(params.get('failModel') || 'no-such-model-hotmem-selftest')
      const result = await driveTurns(ctx, cfg, state, {
        turns: Number(params.get('turns') || 3),
        cwd: params.get('cwd') || undefined,
        prompts: params.getAll('prompt').length ? params.getAll('prompt') : null,
      })
      result.failMode = fail
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errText(error) })
    } finally { state.modelOverride = saved }
  }])
  let mounted = 0
  for (const [route, handler] of routes) {
    try { ctx.effect(() => server.register({ kind: 'exact', path: route, handler: handler }), PLUGIN_ID + ': ' + route); mounted += 1 }
    catch (error) { warn(route + ' 路由注册失败：', errText(error)) }
  }
  return mounted === routes.length
}

// ===== 启动 =====
function start(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  const state = {
    startedAt: new Date().toISOString(),
    cursor: new Map(),      // 会话 id → 已处理到的 seq
    pending: new Map(),     // 会话 id → 正在跑的那次蒸馏
    last: new Map(),        // 会话 id → 最近一次结果快照
    since: new Map(),       // ★ R30：会话 id → { events, atMs, turn, lastSeq } 本轮累计（供长轮次兜底）
    longTurn: new Map(),    // ★ R30：会话 id → 上一次兜底蒸馏的时间戳（防抖用；不是"每轮一次"）
    modelOverride: null,    // 只给验收用（临时把模型名写错）
    stats: { turnEnd: 0, distillOk: 0, distillFail: 0, injected: 0, injectSkipped: 0, skipped: 0 },
  }
  ensureDir(cfg)
  const toolsOk = registerTools(ctx, cfg, state)
  const routesOk = registerRoutes(ctx, cfg, state)
  // 唯一的 hook：一轮结束。收到的每个事件都先过 type 判断，别让 assistant/chunk 拖着走。
  ctx.on('session/event', (session, event) => {
    try {
      if (!cfg.enabled) return
      if (!event) return
      if (event.type !== 'turn/end') {
        // ★ R30：不是轮末也要累计 —— 长轮次兜底全靠这里。
        //   这一步必须极轻（只加计数），绝不许在这里做任何磁盘/网络动作。
        const sid = String((session && session.id) || '')
        if (sid) {
          const cur = Number((event.data || {}).turn)
          const s = state.since.get(sid) || { events: 0, atMs: Date.now(), turn: 0, lastSeq: 0 }
          if (LONG_TURN_COUNTED.has(String(event.type))) s.events += 1
          if (Number(event.seq)) s.lastSeq = Number(event.seq)
          if (Number.isFinite(cur) && cur > 0) s.turn = cur
          state.since.set(sid, s)
          maybeLongTurnDistill(ctx, cfg, state, session, event)
        }
        return
      }
      state.stats.turnEnd += 1
      state.since.delete(String((session && session.id) || ''))
      state.longTurn.delete(String((session && session.id) || ''))   // R30：新轮开始，兜底计时重置
      handleTurnEnd(ctx, cfg, state, session, event)
    } catch (error) { warn('turn/end 处理失败（已放行）：', errText(error)) }
  })
  try {
    writeAtomic(path.join(workDir(cfg), 'ready.json'), JSON.stringify({
      plugin: PLUGIN_ID, version: VERSION, pid: process.pid, startedAt: state.startedAt,
      dir: workDir(cfg),
      provider: cfg.provider, model: cfg.model, enabled: cfg.enabled, pointer: cfg.pointer, testHooks: cfg.testHooks,
      schema: SCHEMA_V2, schemasReadable: [SCHEMA_V1, SCHEMA_V2],
      guidanceSupported: true, guidanceDir: guidanceDir(cfg), guidanceMaxEntries: cfg.guidanceMaxEntries,
      feedMaxLines: cfg.feedMaxLines, feedExpireRounds: cfg.feedExpireRounds,
      toolsRegistered: toolsOk, routesRegistered: routesOk,
      // ★ R29/R30：把分档与兜底的配置写进 ready.json —— 否则"白名单有没有真的被插件读到"只能靠等一轮蒸馏来间接证明。
      fullMemoSessions: (Array.isArray(cfg.fullMemoSessions) ? cfg.fullMemoSessions : []),
      longTurnDistill: cfg.longTurnDistill, longTurnEvents: cfg.longTurnEvents,
      longTurnMinutes: cfg.longTurnMinutes, longTurnMinGapMinutes: cfg.longTurnMinGapMinutes,
    }, null, 2))
  } catch (error) { warn('写 ready.json 失败：', errText(error)) }
  appendEvent(cfg, { kind: 'boot', version: VERSION, dir: workDir(cfg), provider: cfg.provider, model: cfg.model, tools: toolsOk, routes: routesOk })
  log('v' + VERSION + ' 就绪 · 记忆目录 ' + workDir(cfg) + ' · 蒸馏 ' + cfg.provider + '/' + cfg.model + ' · 指针注入=' + (cfg.pointer ? '开' : '关') + ' · pid=' + process.pid + ' · GET /hot-memory')
}

// ★ R29：把纯函数露出来给自检直接调（面板那边同款做法）。
//   只导出纯函数与常量，导出它们不改变任何行为。
export const __internals = {
  memoModeOf, buildPrompt, parseMemo, itemCount, stripForPrompt,
  maybeLongTurnDistill, handleTurnEnd, resolveModel, ensureModel, modelScore, memoModeOf, llmService,
  DEFAULTS, SECTIONS, VERSION, PLUGIN_ID,
}

export function apply(ctx, config) {
  try { start(ctx, config) } catch (error) {
    // 红线 2：插件出问题绝不能让 DSH 起不来。
    warn('初始化失败（已降级，DSH 不受影响）：', errText(error))
  }
}
