---
name: character-extraction
command: /character-extraction
description: 从中文小说单章文本中提取角色、衣物、物品信息，输出结构化 JSON，并汇总为「实体卡 + 阶段卡」二维人物卡。当处理小说章节并需要提取角色资产时使用。
---

# character-extraction

从已分章的中文小说 txt 目录中，逐章提取**角色 / 衣物 / 物品**，生成逐章 JSON，再汇总成
**「实体卡 + 阶段卡」**的 Markdown 卡片。

## 人物模型：实体卡 + 阶段卡（实体与状态解耦）

人物信息是**二维**的：

| 维度 | 文件 | 回答 | 稳定性 |
|---|---|---|---|
| **实体（Character）** | `@cards_dir/characters/<姓名>/index.md` | 这个人**是谁** | 跨阶段稳定：姓名、跨阶段通用别名、性别、基线外貌、基线身份、永久特征、稳定关系、阶段索引 |
| **阶段（Phase / Look）** | `@cards_dir/characters/<姓名>/phase_XX_<标签>.md` | 他**在某段章节里是什么样** | 只在该章节范围成立：年龄、身份、外貌、着装、时变关系、允许/禁止称呼 |

- 生图或下游使用时，**只组合「实体卡 + 目标阶段卡」**，**不使用实体卡字段的并集**。
- 别名、关系、年龄、外貌一律**按阶段归属**；实体卡只保留跨阶段通用称呼与长期关系。
- 衣物卡、物品卡带 `character_id` / `phase_id`，关联到具体阶段卡。
- 逐章提取只负责给 `phase_hint` **提示**；阶段切分、实体卡生成属于**汇总阶段**。

本文件是**索引与主循环**。细则按需加载，不要一次性全读：

| 需要什么 | 加载 |
|---|---|
| 人物判定、别名词典、`phase_hint`、阶段切分信号、置信度 | `references/character-rules.md` |
| 衣物/配饰/甲胄判定 | `references/clothing-rules.md` |
| 武器/信物/药物等物件判定 | `references/item-rules.md` |
| JSON 与卡片的精确样例（实体卡 / 阶段卡 / 衣物卡 / 物品卡） | `references/output-format.md` |
| 实体归并、阶段切分、衣物物品关联、溯源规则 | `references/aggregation-rules.md` |
| **主 Agent 的循环控制细则** | `references/loop-control.md` |
| 机器校验 schema | `schemas/*.schema.json` |

路径相对本 skill 目录解析（加载 skill 时会给出 base directory）。

## 命令用法

```text
命令：/character-extraction @<chapters_dir> @<extracted_dir> @<cards_dir>
示例：/character-extraction @chapters @extracted @cards
缺省：/character-extraction
等价于：/character-extraction @chapters @extracted @cards
```

- 第一个 `@` = 输入章节目录 `chapters_dir`；第二个 `@` = 逐章 JSON 输出目录 `extracted_dir`；第三个 `@` = 汇总卡片输出目录 `cards_dir`。
- 只传一个 `@` → 视为输入目录，其余用默认；传两个 `@` → 输入、逐章输出，卡片用默认；传三个 `@` → 依次对应。
- 缺省值：`chapters`、`extracted`、`cards`（相对工作区根目录）。
- 输入目录**必须存在**；输出目录不存在时**自动创建**。

### 参数解析

DSH 的 `@path` mention 只是**普通提示词文本**，不带文件内容，也不替本 skill 解析参数：

1. 按书写顺序取出 `@` 引用：`(?:^|\s)@(?:"([^"]*)"?|(\S+))`（引号形式可含空格；目录引用可能是不闭合的 `@"dir/`）。
2. 去掉前导 `@` 与引号，相对路径**按工作区根目录解析**；绝对路径原样使用。
3. 按上面的数量规则补足缺省值；输入目录不存在则报错停止，不要静默换目录。

命令注册：`command` 字段不参与注册（DSH 无此字段），`/character-extraction` 由 DSH 的 `/name` 手势映射到 `name`，无需插件代码。

## 硬约束

1. **顺序同步，不并发**：一次只处理一章；子代理必须同步等待（`run_in_background: false`）。
2. **每次只读当前章节原文**；禁止一次性读取全部章节。
3. **每章提取后立即写盘** `@extracted_dir/ch{index:03d}.json`，随后释放该章原文与提取结果。
4. **绝不在上下文中累积**原文或提取结果：把读原文、写 JSON 全部放进子代理，主 Agent 只保留"章号 + 一行状态"。
5. **汇总阶段只读** `@extracted_dir/*.json`，**不读** `@chapters_dir/*.txt`。
6. **不推断、不补充**，只提取本章实际出现的信息；每条信息必须有 `quote` 溯源。
7. 无名龙套不提取；别名/绰号合入本章 `aliases`（按阶段归属，不做全局并集）；不确定信息标"低"并加 `[不确定]`；每个角色给出 `phase_hint` 时期提示（2–8 字，同一时期逐字一致），但**不在逐章阶段做阶段切分**。
8. 失败不阻塞：记入 `_progress.json` 的 `failed`，继续下一章。
9. **不重复提取**：已完成的章（`ch{index:03d}.json` 存在且非空）必须跳过；**每次运行都必须重扫** `_meta.json`（只读文件名），禁止"已存在就直接读取"——否则新增章节会被静默漏掉。
10. **覆盖输出前必须完成版本备份判断**，且判断只由 `backup_output.ts` 完成（主 Agent 不比较路径、不扫描版本目录、不算版本号）；备份失败不阻塞，原因记入 `_progress.json` 的 `backup_failed`。
11. 版本管理不得破坏核心链路：`history/` 只作为备份存放处，**绝不**当作当前输出目录读取。

## 核心提取提示词

单章提取时使用以下提示词，占位符按当前章替换（`{{chapter_index}}` 为数字下标，`{{chapter_title}}` 为该章标题）：

```text
你正在处理第 {{chapter_index}} 章《{{chapter_title}}》。

从本章原文中提取以下信息，以 JSON 格式返回：

{
  "characters": [
    {
      "name": "角色名",
      "aliases": ["别名/绰号（本章出现的）"],
      "gender": "男/女/未知",
      "age": "本章的年龄或年龄描述",
      "identity": "本章的身份/职业",
      "appearance": "本章的外貌描述",
      "relations": [{"target": "角色名", "type": "关系类型"}],
      "phase_hint": "2-8字时期短语，如 卖面时期 / 军中参谋；判断不了写空串",
      "confidence": "高/中/低"
    }
  ],
  "clothing": [
    {
      "character": "角色名",
      "scene": "场景简述",
      "description": "衣物描述",
      "color_material": "颜色/材质",
      "phase_hint": "与同章该角色的 phase_hint 一致",
      "quote": "原文引用（不超过50字）"
    }
  ],
  "items": [
    {
      "name": "物品名",
      "type": "类型",
      "appearance": "外观",
      "function": "功能",
      "holder": "持有者",
      "phase_hint": "与同章该持有者的 phase_hint 一致",
      "quote": "原文引用"
    }
  ]
}

规则：
- 只提取本章实际出现的信息，不推断、不补充。
- aliases / age / identity / appearance 都是**本章**的值：不要写前几章的状态，也不要把全书写成并集。
- 别名/绰号放入 aliases 数组，不要单独建条目。
- phase_hint 是**时期提示**（2–8 字，如 卖面时期 / 书僮时期 / 逃犯时期 / 军中参谋 / 将军时期）：
  只描述本章的身份处境；**同一时期跨章必须逐字相同**；不复述原句、不写年龄数字、不写章号、不编阶段号。
- 本章**不做阶段切分**：阶段卡与实体卡由汇总阶段生成。
- 不确定的信息在 confidence 中标"低"，并在值后加 [不确定]。
- 每条信息必须能对应到原文，quote 字段用于溯源。
- 无名龙套（无姓名、无对话、仅一笔带过）不提取。
```

## 循环控制提示词

```text
处理流程：
1. 解析命令参数：
   - @chapters_dir：输入章节目录
   - @extracted_dir：逐章 JSON 输出目录
   - @cards_dir：汇总卡片输出目录
   缺省时使用 @chapters @extracted @cards。
2. 调用 backup_output.ts 取得版本备份决策（覆盖输出之前必须完成；备份判断与版本号只由脚本负责）。
3. 重新扫描 @chapters_dir/*.txt 并覆盖写 @extracted_dir/_meta.json（每次都扫，禁止"已存在就直接读取"，否则新增章节会被漏掉）。
4. 用 glob 列出 @extracted_dir/ch*.json 得到已完成章号集合 done_set（只看文件名，不读内容）。
5. 按 index 升序循环（index ∈ done_set 且文件非空的章跳过，除非用户明确要求强制重跑）：
   a. 读取当前章节原文。
   b. 调用 character-extraction Skill。
   c. 校验返回 JSON。
   d. 写入 @extracted_dir/ch{index:03d}.json。
   e. 更新 @extracted_dir/_progress.json。
   f. 释放当前章节原文和提取结果，不加入后续上下文。
6. 失败则记录到 @extracted_dir/_progress.json 的 failed，继续下一章。
7. 全部完成后，进入汇总阶段。
关键约束：
- 禁止一次性读取所有章节。
- 禁止在上下文中保留已处理章节原文。
- 禁止重复引用已处理章节内容。
- 每章必须立即写盘。
- 已完成的章（ch{index:03d}.json 存在且非空）必须跳过，不得重复提取；除非用户明确要求强制重跑。
- _meta.json 每次运行都必须重扫覆盖；新增章节必须被发现。
- 覆盖输出前必须先由 backup_output.ts 给出决策；主 Agent 不比较路径、不扫描版本目录、不算版本号。
- 汇总阶段只读 @extracted_dir/*.json，不读 @chapters_dir/*.txt。
```

**在主 Agent 中执行第 5 步时，`a`–`f` 全部委托给单章子代理**（见下节）；主 Agent 自己不读原文、不读提取结果。完整可复制的循环细则见 `references/loop-control.md`。

## 版本管理（`history/`）

每次运行都会覆盖输出，因此覆盖前要先做一次**简单目录备份**。判断与执行全部由脚本完成：

```bash
node .dsh/skills/character-extraction/scripts/backup_output.ts --extracted extracted --cards cards
```

- **只有两次运行落在同一个输出目录**，脚本才把上一次输出备份为 `history/V{n}/`（含 `extracted/`、`cards/`、`_manifest.json`）。
- 换了输出目录 / 首次运行 / 当前输出为空 → **不备份**，只更新 `history/_index.json` 的 `last_output`。
- 版本号只增不减，不复用已删除编号；`history/` 永不备份进自身。
- 备份失败**不阻塞**：原因写入 `_progress.json` 的 `backup_failed` 后继续。
- 调用时机：阶段 0、**任何写盘之前**；单章子代理不触发备份。

查看与回滚子命令：

```bash
node .dsh/skills/character-extraction/scripts/history.ts list
node .dsh/skills/character-extraction/scripts/history.ts show V1
node .dsh/skills/character-extraction/scripts/history.ts restore V1 [--clean]
node .dsh/skills/character-extraction/scripts/history.ts prune --keep 2 [--dry-run]
```

`restore` 先备份当前输出为 `history/V{max+1}/` 再回滚；默认不删多余文件（`--clean` 才删）。`prune` 不自动执行。格式见 `references/output-format.md`。

## 子代理隔离（默认推荐）

DSH **没有** `.dsh/agents/*.md` 自动发现机制；子代理由 `subagent` 工具用一段自包含提示词创建。因此 `.dsh/agents/` 下的文件是**磁盘上的子代理工作说明**，由子代理自己读取：

- `.dsh/agents/chapter-extractor.md` —— 单章提取子代理说明。
- `.dsh/agents/character-aggregator.md` —— 汇总子代理说明。

主 Agent 每章只发一条**极短**提示词（约 250 字），让子代理自己去读说明、读原文、写 JSON：

```text
你是单章提取子代理。先读取 <workdir>/.dsh/agents/chapter-extractor.md 并严格遵照执行。
参数：chapter_index={{index}}; chapter_title={{title}}; chapter_file={{file}}; extracted_dir={{extracted_dir}}
只返回一行：ch{{index:03d}}.json OK characters=<n> clothing=<n> items=<n>
```

这样原文与提取结果只存在于子代理上下文中，子代理结束即释放；主 Agent 上下文只增长"一行状态"。

若 `subagent` 工具不可用，则退回主 Agent 顺序循环：**每章处理完立刻写盘，写盘后不得再引用该章原文**；此模式上下文占用大，仅作降级。

汇总同样交给子代理：读取 `.dsh/agents/character-aggregator.md` 并执行，主 Agent 只接收一行汇总统计。

## 产出

- `@extracted_dir/`：`_meta.json`、`_progress.json`（含 `failed` / `backup_failed`）、`ch{index:03d}.json`、`_index.json`
- `@cards_dir/`：**一人一目录**的 `characters/<姓名>/index.md`（实体卡）+ `characters/<姓名>/phase_XX_<标签>.md`（阶段卡）、`characters/_index.json`、`clothing/*.md`、`items/*.md`、`_index.json`、`_index.md`
- `history/`：`_index.json` + `V{n}/{extracted,cards,_manifest.json}`（仅在两次运行同一输出目录时产生）

```text
@cards_dir/
  _index.json
  _index.md
  characters/
    _index.json
    卢云/
      index.md                       # 实体卡：只含跨阶段稳定信息
      phase_01_卖面时期.md            # 阶段卡：该章节范围内的状态
      phase_02_书僮时期.md
  clothing/卢云-胄甲.md               # 带 character_id / phase_id
  items/郾月大刀.md                   # 带 character_id / phase_id
```

`_meta.json`（主 Agent 唯一可读的清单）：

```json
{
  "source_dir": "@chapters_dir 解析后的路径",
  "chapter_count": 108,
  "chapters": [
    { "index": 0, "file": "000_卷首.txt", "volume": "", "chapter": "卷首", "title": "卷首", "full_title": "卷首" }
  ]
}
```

解析规则：文件名匹配 `^(\d{3})_(.+)\.txt$`；`index` 为前缀数字；剩余部分按 `_` 分割；含"第X卷"填入 `volume`，含"第X章/回/节"填入 `chapter`，最后部分为 `title`；无法拆分时 `full_title` 保留完整标题。

逐章 JSON、实体卡、阶段卡、各类索引与 `history/` 的**权威样例**见 `references/output-format.md`。

## 可选脚本

TypeScript / Node 脚本（无第三方依赖，Node ≥ 22.18 可直接运行 `.ts`）：

```bash
node .dsh/skills/character-extraction/scripts/scan_chapters.ts \
  --input chapters --output extracted/_meta.json
node .dsh/skills/character-extraction/scripts/validate_extraction.ts \
  --chapters chapters --extracted extracted --errors extracted/_errors.json
node .dsh/skills/character-extraction/scripts/aggregate_cards.ts \
  --extracted extracted --cards cards --root . --summary extracted/_agg.json
node .dsh/skills/character-extraction/scripts/phase-plan.ts \
  --extracted extracted --output .dsh/tmp/phase-plan.json
```

等价的 `npx tsx` 写法（需先安装 tsx）：

```bash
npx tsx .dsh/skills/character-extraction/scripts/scan_chapters.ts --input chapters --output extracted/_meta.json
npx tsx .dsh/skills/character-extraction/scripts/validate_extraction.ts --chapters chapters --extracted extracted --errors extracted/_errors.json
npx tsx .dsh/skills/character-extraction/scripts/aggregate_cards.ts --extracted extracted --cards cards --root . --summary extracted/_agg.json
```

- `scan_chapters.ts` 生成 `_meta.json`。
- `validate_extraction.ts` 校验 `ch*.json` 是否符合 `schemas/*.schema.json`、`quote` 能否在对应章节原文中找到，并输出 `_errors.json`。
- `aggregate_cards.ts`（汇总阶段首选）做全部机械动作：实体归并、阶段切分、ID 与文件名分配、实体卡/阶段卡/衣物卡/物品卡渲染、全部索引写盘。**只读** `@extracted_dir/*.json`。
- `phase-plan.ts` 只读地输出阶段切分计划（JSON），用于先看结果、不落盘。

退出码 `0` 成功、`1` 运行期失败、`2` 用法/环境错误。脚本不可用时主流程照常，由 Agent 手工完成等价步骤（规则见 `references/aggregation-rules.md`）。

版本管理脚本：`backup_output.ts`（决定是否备份并执行，输出决策 JSON；备份失败返回 `reason: "backup_error"` 且**仍退出 0**）、`history.ts`（`list` / `show` / `restore` / `prune`）。两者共享 `history-store.ts` 的确定性逻辑。

自测（`node:test`，无第三方框架）：

```bash
node --test --test-isolation=none .dsh/skills/character-extraction/scripts/*.test.ts
# 或：npx tsx --test .dsh/skills/character-extraction/scripts/*.test.ts
```

覆盖：逐章 schema 校验与 quote 溯源、章节清单解析、版本备份与回滚、**人物实体卡、人物阶段卡、
阶段切分（含别名/关系/衣物/物品的阶段归属与 `_index.json` 的 phases 索引）**。

