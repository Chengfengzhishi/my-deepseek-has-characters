# dsh-hot-memory —— DSH「热记忆」（阶段 1）

让会话**不用回头翻上下文**：每轮结束把这一轮压成一份短备忘写到磁盘，下一轮只注入**一行指针**。

- 记忆文件：\`<DSH_HOME>/hot-memory/<sessionId>.md\`（≤2KB，固定 5 小节：当前目标 / 已确认事实 / 未决问题 / 关键文件路径 / 最近决策）
- 指针行：\`热记忆已更新：<路径>（N 条，HH:MM）\`（≈42 token；**无人工指导时不带**「· K 条人工指导」那一段，与 R23 逐字节相同）
- 工具：\`hot_memory\`（只读，读本会话的备忘）
- 探针：\`GET /hot-memory\`、\`/hot-memory/file?id=\`、\`/hot-memory/evidence?id=\`、
  \`/hot-memory/test/config\`（testHooks 开时）、\`/hot-memory/drive\`（testHooks 开时）

## 为什么不注入全文
注入的每一个 token 会被后续**每一次**调用重放。本机实测大会话每轮调用重放 44 万 token，
所以「每轮注入全文」= 给每一轮都加一份长期负债；一行指针 ≈37 token，占比 0.008%。

## 分区字节数口径（★别按字符数对账）

**「某节字节」= 从该节标题行首，到「下一个 1~2 级标题行首」（没有下一个就到底）为止的原文，
再去掉末尾那一个换行符，用 `Buffer.byteLength(..., 'utf8')` 量的字节数。**

- **一律量字节，不是 `.length` 字符数**：中文 1 字符 = 3 字节，按字符对账必然对不上（本机踩过）。
- 三级标题（`###`）是**子标题**，不是分节边界 —— 只有 `### 主题：X` 例外（它本身就是一个分区）。
  早期实现把 `### <时间> · <来源> · 分区：X` 当边界，人工指导节被自己的条目头切碎，少算 71~309B。
- 索引算的是**落盘后的完整文本**（正文后面总跟着人工指导/投喂节），正文的末节在文件里不是末节；
  拿只有正文的字符串自查会差 1（末节会多算文件末尾那个换行）。
- 机器复核：`GET /hot-memory/index?id=` 每条分区都带 `bytes` / `diskBytes` / `bytesMatch`；
  `diskBytes` 是按本口径**独立**量出来的，不是拿 `bytes` 跟自己比（自己比自己恒真，拦不住偏差）。
- 专项自检：`node verify-bytes.mjs` —— 判据是**逐字节相等**，并带**反向对照**：故意篡改 1 字节必须被抓住。

R23 起新增：`GET /hot-memory/index?id=`（列分区 + 每区字节）、`GET /hot-memory/topic?id=&topic=`（只取一区）。
R24 起新增：`GET /hot-memory/guidance?id=`（人工指导状态）、记忆文件里的「人工指导」节。

## 阶段 1 不做什么
不裁剪/压缩旧历史、不改压缩阈值、不改 preset、不改 settings.yaml。那是阶段 2 的事。

## 装 / 卸
    node install.mjs                      # 备份 + junction + package.json link 依赖，并打印要写进 cordis.patch.yml 的那一段
    node install.mjs --check              # 用 js-yaml 真解析 patch，断言每条 insert entry 的 name 非空；不过就自动回滚
    node install.mjs --remove             # 一步回滚：恢复 patch/package.json 备份 + 摘 junction
    node verify-hot-memory.mjs            # 可重复验证（A 现场重解析 / B 在线 / C 三轮真对话 / D fail-open）

**cordis.patch.yml 只许用「字面替换」写**（edit 工具或手改），绝不许脚本整文件重写 ——
本机 2026-09-17 因为整文件重写吞掉注释换行，插件树加载失败，DSH 停在安全带页，一天重启 5 次。
install.mjs 因此**不写 patch 内容**，只做 byte-exact 备份 + 打印待插入段 + YAML 断言。

## 配置（写在 patch 那一段的 config: 里）
    enabled: true            # 总开关
    provider: opencode-go    # 蒸馏用的 provider
    model: mimo-v2.5         # 蒸馏用的便宜模型
    maxTokens: 1200          # 蒸馏输出上限（太小会只回空正文）
    timeoutMs: 60000         # 单次蒸馏超时
    maxInputChars: 24000     # 喂给模型的材料上限
    maxMemoryBytes: 2048     # 记忆文件字节上限
    pointer: true            # 是否注入那一行
    testHooks: false         # /hot-memory/drive 自测驱动（验收时开，平时关）

## fail-open
所有 hook 全程 try/catch：蒸馏失败/超时/模型不可用/文件写不动 → 原样放行请求，
只在 \`hot-memory/events.jsonl\` 留一行 \`distill-fail\`，不注入指针、不打断对话。
