---
name: character-extraction
command: /character-extraction
description: 从中文小说单章文本中提取角色、衣物、物品信息，输出结构化 JSON。当处理小说章节并需要提取角色资产时使用。
---

# character-extraction

从已分章的中文小说 txt 目录中，逐章提取**角色 / 衣物 / 物品**，生成逐章 JSON，再汇总成 Markdown 卡片。

本文件是**索引与主循环**。细则按需加载，不要一次性全读：

| 需要什么 | 加载 |
|---|---|
| 人物判定、别名词典、置信度 | `references/character-rules.md` |
| 衣物/配饰/甲胄判定 | `references/clothing-rules.md` |
| 武器/信物/药物等物件判定 | `references/item-rules.md` |
| JSON 与卡片的精确样例 | `references/output-format.md` |
| 合并、去重、溯源规则 | `references/aggregation-rules.md` |
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

### 参数解析（已核实的 DSH 行为）

DSH 的 `@path` mention 只是**普通提示词文本**，`@` 引用**不会**把文件内容带进上下文，也**不会**替本 skill 解析参数。因此：

1. 从用户输入中按书写顺序取出 `@` 引用：`(?:^|\s)@(?:"([^"]*)"?|(\S+))`（引号形式可含空格，目录引用可能是不闭合的 `@"dir/`）。
2. 去掉前导 `@` 与包裹引号，相对路径**按工作区根目录解析**为绝对路径；绝对路径原样使用。
3. 按上面的数量规则补足缺省值。输入目录不存在则报错并停止，不要静默改用其他目录。

### 命令注册（已核实的 DSH 行为）

DSH **没有** `command` frontmatter 字段，只有 `name`（必须 kebab-case）、`description`、`whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable` 会被读取；未知键被静默忽略。上面的 `command:` 行仅作兼容与自文档，**不参与注册**。

`/character-extraction` 由 DSH 的 skill 手势映射：直接用户输入中任何以空白为界的 `/name` token，若命中本 skill 的 `name`，就会把本文件全文注入该步，其余文本（`@chapters @extracted @cards`）保持不变。因此命令无需任何插件代码即可触发。

## 硬约束

1. **顺序同步，不并发**：一次只处理一章；子代理必须同步等待（`run_in_background: false`）。
2. **每次只读当前章节原文**；禁止一次性读取全部章节。
3. **每章提取后立即写盘** `@extracted_dir/ch{index:03d}.json`，随后释放该章原文与提取结果。
4. **绝不在上下文中累积**原文或提取结果：把读原文、写 JSON 全部放进子代理，主 Agent 只保留"章号 + 一行状态"。
5. **汇总阶段只读** `@extracted_dir/*.json`，**不读** `@chapters_dir/*.txt`。
6. **不推断、不补充**，只提取本章实际出现的信息；每条信息必须有 `quote` 溯源。
7. 无名龙套不提取；别名/绰号合入 `aliases`；不确定信息标"低"并加 `[不确定]`。
8. 失败不阻塞：记入 `_progress.json` 的 `failed`，继续下一章。

## 核心提取提示词

单章提取时使用以下提示词，占位符按当前章替换（`{{chapter_index}}` 为数字下标，`{{chapter_title}}` 为该章标题）：

```text
你正在处理第 {{chapter_index}} 章《{{chapter_title}}》。

从本章原文中提取以下信息，以 JSON 格式返回：

{
  "characters": [
    {
      "name": "角色名",
      "aliases": ["别名/绰号"],
      "gender": "男/女/未知",
      "age": "年龄或年龄描述",
      "identity": "身份/职业",
      "appearance": "外貌描述",
      "relations": [{"target": "角色名", "type": "关系类型"}],
      "confidence": "高/中/低"
    }
  ],
  "clothing": [
    {
      "character": "角色名",
      "scene": "场景简述",
      "description": "衣物描述",
      "color_material": "颜色/材质",
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
      "quote": "原文引用"
    }
  ]
}

规则：
- 只提取本章实际出现的信息，不推断、不补充。
- 别名/绰号放入 aliases 数组，不要单独建条目。
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
2. 读取 @extracted_dir/_meta.json；若不存在，扫描 @chapters_dir/*.txt 生成。
3. 按 index 升序循环：
   a. 读取当前章节原文。
   b. 调用 character-extraction Skill。
   c. 校验返回 JSON。
   d. 写入 @extracted_dir/ch{index:03d}.json。
   e. 更新 @extracted_dir/_progress.json。
   f. 释放当前章节原文和提取结果，不加入后续上下文。
4. 失败则记录到 @extracted_dir/_progress.json 的 failed，继续下一章。
5. 全部完成后，进入汇总阶段。
关键约束：
- 禁止一次性读取所有章节。
- 禁止在上下文中保留已处理章节原文。
- 禁止重复引用已处理章节内容。
- 每章必须立即写盘。
- 汇总阶段只读 @extracted_dir/*.json，不读 @chapters_dir/*.txt。
```

**在主 Agent 中执行第 3 步时，`a`–`f` 全部委托给单章子代理**（见下节）；主 Agent 自己不读原文、不读提取结果。完整可复制的循环细则见 `references/loop-control.md`。

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

- `@extracted_dir/_meta.json` 章节清单（格式见下）
- `@extracted_dir/_progress.json` 处理进度
- `@extracted_dir/ch000.json`、`ch001.json` … 逐章提取结果
- `@extracted_dir/_index.json` 汇总索引
- `@cards_dir/characters/*.md`、`@cards_dir/clothing/*.md`、`@cards_dir/items/*.md`
- `@cards_dir/_index.json`、`@cards_dir/_index.md`

`_meta.json`：

```json
{
  "source_dir": "@chapters_dir 解析后的路径",
  "chapter_count": 108,
  "chapters": [
    { "index": 0, "file": "000_卷首.txt", "volume": "", "chapter": "卷首", "title": "卷首", "full_title": "卷首" }
  ]
}
```

解析规则：文件名匹配 `^(\d{3})_(.+)\.txt$`；`index` 为前缀数字；剩余部分按 `_` 分割；含"第X卷"填入 `volume`，含"第X章"填入 `chapter`，最后部分为 `title`；无法拆分时 `full_title` 保留完整标题。

`_progress.json`：

```json
{ "total": 108, "done": 0, "current": null, "failed": [], "updated_at": "" }
```

每章 JSON：

```json
{
  "chapter_index": 0,
  "chapter_title": "卷首",
  "source_file": "000_卷首.txt",
  "characters": [],
  "clothing": [],
  "items": []
}
```

## 可选脚本

TypeScript / Node 脚本（无第三方依赖，Node ≥ 22.18 可直接运行 `.ts`）：

```bash
node .dsh/skills/character-extraction/scripts/scan_chapters.ts \
  --input chapters --output extracted/_meta.json
node .dsh/skills/character-extraction/scripts/validate_extraction.ts \
  --chapters chapters --extracted extracted --errors extracted/_errors.json
```

等价的 `npx tsx` 写法（需先安装 tsx）：

```bash
npx tsx .dsh/skills/character-extraction/scripts/scan_chapters.ts --input chapters --output extracted/_meta.json
npx tsx .dsh/skills/character-extraction/scripts/validate_extraction.ts --chapters chapters --extracted extracted --errors extracted/_errors.json
```

`scan_chapters.ts` 生成 `_meta.json`；`validate_extraction.ts` 校验 `ch*.json` 是否符合 `schemas/*.schema.json`、`quote` 能否在对应章节原文中找到，并输出 `_errors.json`。退出码 `0` 无错误、`1` 有错误、`2` 用法/环境错误。脚本不可用时主流程照常，由 Agent 手工完成等价步骤。

自测：

```bash
node --test --test-isolation=none .dsh/skills/character-extraction/scripts/scan_chapters.test.ts \
  .dsh/skills/character-extraction/scripts/validate_extraction.test.ts
# 或：npx tsx --test .dsh/skills/character-extraction/scripts/*.test.ts
```

