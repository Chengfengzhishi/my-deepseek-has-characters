# 热记忆 · DSH hot-memory 三件套

让会话**不用回头翻上下文**：每轮结束把这一轮蒸馏成一份 ≤2KB 的短备忘写到磁盘，下一轮只注入**一行指针**。

> 本仓库是三个 DSH 插件源码的镜像（除 3 处注释/文档里的本机路径做了脱敏外与源逐字节一致，见提交信息）。机制说明以各目录下 `README.md` 的原文为准。

## 为什么是「一行指针」而不是「注入全文」

注入的每一个 token 都会被后续**每一次**调用重放。本机实测：某大会话每轮调用重放 44 万 token，
所以「每轮注入全文」等于给每一轮都加一份长期负债。
指针行形如 `热记忆已更新：<路径>（N 条，HH:MM）`，约 42 token，占比 0.008%。这是整套设计的出发点。

## 三件套分工

| 目录 | 角色 | 一句话 |
|---|---|---|
| `dsh-hot-memory/` | 本体（阶段 1，VERSION 0.5.2） | 蒸馏出短备忘 + 每轮注入一行指针 |
| `dsh-hot-memory-plus/` | 增补件 | 压缩后补记性（召回一次全文）+ 跨会话教训层 |
| `dsh-hot-memory-panel/` | 面板 | 给人看（分区 / 每区字节 / 红黄判定）+ 人给指导（双写落盘） |

三者**只通过磁盘产物与 HTTP 探针耦合，互不 import** —— 所以能各自独立升级。

## 各自入口

### dsh-hot-memory（本体）

- 记忆文件：`<DSH_HOME>/hot-memory/<sessionId>.md`，固定 5 小节（当前目标 / 已确认事实 / 未决问题 / 关键文件路径 / 最近决策），另有「分区索引」「主题分区」「人工指导」节
- 工具：`hot_memory`（只读）
- 探针：`GET /hot-memory`、`/hot-memory/file?id=`、`/hot-memory/index?id=`、`/hot-memory/topic?id=&topic=`、`/hot-memory/guidance?id=`
- 分区字节口径：从该节标题行首到下一个 1~2 级标题行首、去掉末尾一个换行，用 `Buffer.byteLength` 量**字节**（不是 `.length` 字符数）；三级标题是子标题，只有 `### 主题：X` 例外
- fail-open：所有 hook 全程 try/catch，蒸馏失败 / 超时 / 模型不可用 → 原样放行，只记一行 `distill-fail`
- 配置项：`enabled / provider / model / maxTokens / timeoutMs / maxInputChars / maxMemoryBytes / pointer / testHooks`

### dsh-hot-memory-plus（增补件）

- ① 压缩后召回：监听 `compaction/start|end`，在压缩后的**下一个步骤**（`agent/pre-step`）注入一次「本会话热记忆全文 + 工作区教训最近 12 条」（约 500-800 token）
  - 带可核实的量 `recallAudit`：按字符二元组重合率算「召回带过去的关键项有多少仍在下次蒸馏里」；产物 mtime 不新就记 `recall-audit-unmeasurable`，不编数字
- ② 跨会话教训层：`<DSH_HOME>/hot-memory/_shared/lessons.md`（只追加）+ 工具 `lesson_write` / `lesson_read`；只在教训变更时注入一行指针（约 40 token / 会话），已见状态落 `seen.json`，重载与重启都不重复提示
- 探针：`GET /hot-memory-plus`；状态 `state.json`、事件 `events.jsonl`

### dsh-hot-memory-panel（面板）

- 面板：`GET /hot-memory-panel`（加 `?json=1` 取同一份数据）；写指导：`POST /hot-memory-panel/guidance`
- 工具：`hot_memory_panel`（只读）
- 两条硬红线：只读消费本体的 JSON API（不 import 它的模块、不写它的任何产物）；人工指导**双写**到契约位置 `<DSH_HOME>/hot-memory/_guidance/<sessionId>.md` + 面板副本 `data/guidance/<sessionId>.md`，只追加、原子写、回读校验
- 判定档位 E1…E12：正文为空 / 缺分区 / 分区超预算 / 空壳记忆 / 缺元信息 / 同名分区重复 / 会话在跑但记忆久未更新 / 字节对账不平 等

## 安装

三个插件目录各自执行（以本体为例，plus 与 panel 的用法相同）：

    node install.mjs            # 备份 + junction + patch 行 + profile link 依赖
    node install.mjs --check    # 用 js-yaml 真解析 patch，断言 insert entry 的 name 非空，不过自动回滚
    node install.mjs --remove   # 一步回滚
    node verify-hot-memory.mjs  # 可重复验证（plus 与 panel 用 verify.mjs）

**红线（本体 README 原文）**：`cordis.patch.yml` 只许用「字面替换」写（edit 工具或手改），**绝不许脚本整文件重写** ——
本机曾因整文件重写吞掉注释换行导致插件树加载失败、DSH 停在安全带页。
因此 `install.mjs` **不写 patch 内容**，只做 byte-exact 备份 + 打印待插入段 + YAML 断言。

## 仓库结构

    .gitattributes
    README.md
    dsh-hot-memory/{README.md, package.json, index.js, install.mjs}
    dsh-hot-memory-plus/{README.md, package.json, index.js, install.mjs}
    dsh-hot-memory-panel/{README.md, package.json, index.js, install.mjs}

`.gitattributes` 里是 `* -text`：本机 `core.autocrlf=true`，关掉行尾转换才能保证
仓库里的 blob 与源文件逐字节相同。

## 许可

`dsh-hot-memory-plus` 与 `dsh-hot-memory-panel` 的 `package.json` 声明 `license: MIT`；
`dsh-hot-memory` 的 `package.json` 未声明 license 字段 —— 待补。
