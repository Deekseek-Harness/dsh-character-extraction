# character-extraction（DSH Skill）

从已分章的中文小说 txt 目录中**逐章**提取**角色 / 衣物 / 物品**，产出逐章 JSON，再汇总为
**「实体卡 + 阶段卡」**的 Markdown 卡片。

- 命令：`/character-extraction @<chapters_dir> @<extracted_dir> @<cards_dir>`
- 缺省：`/character-extraction` ≡ `/character-extraction @chapters @extracted @cards`
- 处理方式：**顺序同步**逐章，每章处理完**立即落盘**，不在上下文中累积原文或提取结果。

## 人物模型：实体卡 + 阶段卡

人物信息是二维的，**实体与状态解耦**（不再是一人一卡、字段并集）：

| 维度 | 文件 | 回答 | 字段 |
|---|---|---|---|
| **实体** | `cards/characters/<姓名>/index.md` | 这个人**是谁** | `stable_traits`（基线外貌/身份/永久特征）、跨阶段通用 `aliases`、`relations_graph`、`phases` 索引 |
| **阶段** | `cards/characters/<姓名>/phase_XX_<标签>.md` | 他**在某段章节里是什么样** | `age` / `identity` / `appearance` / `clothing_refs` / `item_refs` / 时变 `relations` / `allowed_names` / `forbidden_names` |

- 生图或下游使用时，**只组合「实体卡 + 目标阶段卡」**，不用实体卡字段的并集。
- 别名、关系、年龄、外貌一律按阶段归属；实体卡只保留跨阶段通用称呼与长期关系。
- 衣物卡、物品卡带 `character_id` / `phase_id`，关联到具体阶段卡。
- 逐章提取只给 `phase_hint` **提示**；阶段切分与实体卡生成属于**汇总阶段**。

## 目录结构

```text
.dsh/
  skills/character-extraction/
    SKILL.md                     # 入口：命令用法、核心提取提示词、循环控制提示词
    references/
      character-rules.md         # 人物判定、别名分阶段、关系分阶段、phase_hint、切分信号、置信度
      clothing-rules.md          # 「角色+场景」衣物提取、quote 硬要求、阶段关联
      item-rules.md              # 物品类别、字段、汇总期合并与阶段关联
      output-format.md           # 全部产出的权威样例（实体卡 / 阶段卡 / 索引 / history）
      aggregation-rules.md       # 实体归并、阶段切分、溯源规则
      loop-control.md            # 主 Agent 循环细则、上下文预算、恢复与降级
    schemas/                     # 8 个 JSON Schema（可机器校验）
      chapter-extraction.schema.json
      character.schema.json              # 逐章 characters[]（含 phase_hint）
      character-entity.schema.json       # 实体卡 frontmatter
      character-phase.schema.json        # 阶段卡 frontmatter
      clothing.schema.json  item.schema.json
      cards-index.schema.json            # cards/_index.json
      characters-index.schema.json       # cards/characters/_index.json
    templates/                   # 实体卡 / 阶段卡 / 衣物卡 / 物品卡模板
    scripts/                     # TypeScript 辅助脚本（无第三方依赖）
      types.ts                   # Meta / Chapter / ValidationResult / 版本管理类型
      util.ts                    # BOM、码位计数、排序等小工具
      schema-validator.ts        # 内置 JSON Schema 子集校验器
      history-store.ts           # 版本历史存储层（路径规范化、索引、版本号、递归复制）
      phase-plan.ts              # 实体归并 + 阶段切分的确定性逻辑（只读，可单独出计划 JSON）
      aggregate_cards.ts         # 汇总落盘：实体卡/阶段卡/衣物卡/物品卡 + 全部索引
      scan_chapters.ts           # 扫描章节 → _meta.json
      validate_extraction.ts     # 校验 ch*.json + 回查 quote 原文
      backup_output.ts           # 版本备份判断与执行（输出决策 JSON）
      history.ts                 # history list / show / restore / prune
      *_test / *.test.ts         # 自测（node:test）
      test-fixtures.ts           # 测试共享夹具（合成小说弧线）
  agents/
    chapter-extractor.md         # 单章提取子代理工作说明（给 phase_hint，不切阶段）
    character-aggregator.md      # 汇总子代理工作说明（实体归并 + 阶段切分）
package.json                     # type: module + scripts（test / scan / validate / aggregate）
tsconfig.json                    # 可选类型检查配置
chapters/                        # 默认输入目录（可由第一个 @ 覆盖）
extracted/                       # 默认逐章输出目录（第二个 @）
cards/                           # 默认卡片输出目录（第三个 @）
history/                         # 版本备份（只在同输出目录重复运行时产生 V{n}/）
```

## 用法

```text
/character-extraction @chapters @extracted @cards     # 显式指定三个目录
/character-extraction @chapters                       # 只给输入，其余用默认
/character-extraction @chapters @myjson               # 输入 + 逐章输出
/character-extraction                                 # 全部默认
```

输入目录必须存在；输出目录会自动创建。`@` 是 DSH 的 mention 语法，只作为提示词文本传给模型，**不会附带文件内容**——真正读文件的是处理过程的工具调用。

## 处理流程

1. **准备**：解析 `@` 参数 → 校验输入目录 → **版本备份判断**（`backup_output.ts`，覆盖前）→ 创建输出目录 → **重扫** `_meta.json` → 初始化 `_progress.json`。
2. **逐章循环**（`index` 升序）：**跳过已完成的章**；其余每章把「读原文 → 提取 → 校验 → 写 `ch{index:03d}.json` → 更新 `_progress.json`」整体交给一个**单章子代理**（同步等待）。主 Agent 每章只保留一行状态。
3. **汇总**：交给汇总子代理（首选直接调 `aggregate_cards.ts`），**只读** `extracted/*.json`，先归并实体、再切分阶段，产出实体卡/阶段卡/衣物卡/物品卡与全部索引。
4. **收尾**：进度对账 + 可选校验 + 一行摘要汇报。

失败不阻塞：该章记入 `_progress.json` 的 `failed`，继续下一章。

### 阶段切分（汇总阶段）

| 优先级 | 信号 | 说明 |
|---|---|---|
| 1 | `phase_hint` 变化 | 逐章提示是最强信号；`书僮时期`/`书僮`/`书僮阶段` 这类纯后缀差异会被归一为同一阶段 |
| 2 | `identity` → `age` → `appearance` → `clothing` | 无提示时看状态；**回弹检查**：变化在其后下一次稳定登场就退回基线（≤2 个登场点且 ≤4 章）视为阶段内临时状态，不切阶段 |
| 3 | 章节不连续 | 中间缺席的章不纳入同一阶段 |
| 4 | 只有 1 章 | 并入前一阶段并标 `[短暂]` |
| 5 | 相邻同提示 | 必须合并回一段 |

硬约束：阶段章节**互不重叠**；`forbidden_names ∩ allowed_names = ∅`；阶段标签取最简写法，身份与外描写都缺失时回退为中性的「故事阶段」（不会把章号写进文件名）。

### 不重复提取（续跑）

- 已完成的章（`extracted/ch{index:03d}.json` 存在且非空）**默认跳过**，不再读原文、不再提取。
- `_meta.json` **每次运行都重扫**（只读文件名，幂等）——因此后来往 `chapters/` 里新增的章节会被自动发现并处理；沿用一个旧清单会静默漏章。
- 单章子代理自己也有幂等守卫：若目标 `ch*.json` 已存在且合法，直接返回 `SKIP`，不读原文。即使被误派发也不会覆盖已有结果。
- `failed` 中的章号默认重试。

### 版本备份（`history/`）

**只有两次运行落在同一个输出目录**时，才把上一次输出备份为 `history/V{n}/`；判断与执行全部由 `backup_output.ts` 完成，模型不比较路径、不扫描版本目录、不算版本号。

| 本次运行与 `last_output` | 行为 |
|---|---|
| 同一输出目录且当前输出非空 | 备份为 `history/V{max+1}/`，写 `_manifest.json`，更新 `_index.json` |
| 没有 `last_output`（首次） | 不备份，只记录 `last_output` |
| 输出目录不同 | 不备份，只更新 `last_output` |
| 当前输出为空（无 `ch*.json`） | 不备份，只更新 `last_output` |
| 备份失败 | **不阻塞**：原因写入 `_progress.json` 的 `backup_failed`，继续提取 |

版本号只增不减、不复用已删除编号；`history/` 永不备份进自身。

### 上下文纪律（本 skill 的核心约束）

| 方案 | 主 Agent 每章增量 | 108 章累计 |
|---|---|---|
| 主 Agent 直读原文 | 数 KB（永久保留） | 极易溢出 |
| **主 Agent 循环 + 子代理隔离（默认）** | ~250 字提示词 + 一行结果 | ~30–50 KB |
| `workflow` 脚本串行编排（可选） | 0（仅最终返回值） | ~1 KB |

原文与提取结果只存在于子代理上下文中，子代理结束即释放。

## 脚本

TypeScript + ESM，**零第三方运行时依赖**。Node ≥ 22.18（或 23.6+）自带 TypeScript 类型擦除，可直接 `node xxx.ts`；也可用 `npx tsx xxx.ts`。

```bash
# 1) 生成章节清单
node .dsh/skills/character-extraction/scripts/scan_chapters.ts --input chapters --output extracted/_meta.json

# 2) 校验逐章结果（schema + quote 回查原文）
node .dsh/skills/character-extraction/scripts/validate_extraction.ts \
  --chapters chapters --extracted extracted --errors extracted/_errors.json

# 3) 汇总（实体卡 + 阶段卡 + 衣物卡 + 物品卡 + 全部索引）
node .dsh/skills/character-extraction/scripts/aggregate_cards.ts \
  --extracted extracted --cards cards --root . --summary extracted/_agg.json

# 4) 只想先看阶段切分结果、不落盘
node .dsh/skills/character-extraction/scripts/phase-plan.ts \
  --extracted extracted --output .dsh/tmp/phase-plan.json
```

也可通过 npm scripts：`npm run scan:chapters` / `npm run validate:extraction` / `npm run aggregate:cards` / `npm run phase:plan`（需自行追加参数）。

- `scan_chapters.ts`：支持规范命名 `000_卷首.txt`（含 `第X卷`/`第X章/回/节` 拆解），也兼容 `ch0001.txt` 这类命名——非规范命名会从同目录 novel-split 风格的 `_meta.json` 回填标题，诊断写 stderr，输出严格保持规范形状。空目录不报错，写出 `chapter_count: 0` 的清单并给出告警。
- `validate_extraction.ts`：校验 `schemas/*.schema.json`、`chapter_index` 与文件名一致性、`quote` 能否在对应章节原文中逐字找到（忽略空白差异，UTF-8 / UTF-8 BOM / GB18030 均可读）、覆盖率缺失章；退出码 `0` 无错误 / `1` 有错误 / `2` 用法或环境错误，便于 CI。
- `aggregate_cards.ts`：汇总阶段的**全部机械动作**——实体归并、阶段切分、`char_XXXX`/`phase_XX`/`cloth_XXXX`/`item_XXXX` 分配、四类卡片渲染、四份索引写盘。**只读 `extracted/*.json`**（不碰章节原文）；ID 分配顺序确定（首次出场章升序 → 主名 Unicode 码位升序），同一输入必得同一套 ID，便于增量重跑。
- `phase-plan.ts`：同一套切分逻辑的只读出口，输出计划 JSON 供人工复核；`aggregate_cards.ts` 直接复用它，两者不会漂移。
- `backup_output.ts`：版本备份判断与执行，输出决策 JSON 到 stdout。**备份失败仍退出 `0`**（不阻塞主流程），原因写入 `_progress.json` 的 `backup_failed`。
- `history.ts`：`list` / `show <V{n}>` / `restore <V{n}> [--clean]` / `prune --keep <N> [--dry-run]`。

### 版本管理命令

```bash
S=.dsh/skills/character-extraction/scripts

# 覆盖前备份判断（由主 Agent 在逐章循环前调用）
node $S/backup_output.ts --extracted extracted --cards cards

# 查看与回滚
node $S/history.ts list
node $S/history.ts show V1
node $S/history.ts restore V1            # 回滚前会自动把当前输出备份为 V{max+1}
node $S/history.ts restore V1 --clean    # 同时删除当前输出中该版本没有的多余文件
node $S/history.ts prune --keep 2        # 只保留最近 2 个版本（不会自动执行）
node $S/history.ts prune --keep 2 --dry-run
```

`history/` 位置：默认 `@extracted_dir` 的父目录；两个输出目录不同父时取最近公共父目录；`--history` 可显式覆盖。

### 自测

使用 Node 内置 `node:test` + `node:assert/strict`，fixture 全部建在 `fs.mkdtemp` 临时目录中，不依赖真实 `chapters/`、`extracted/`、`cards/` 数据。

```bash
npm test
# 或直接指定：
node --test --test-isolation=none ".dsh/**/*.test.ts"
# 若已安装 tsx：
npx tsx --test .dsh/skills/character-extraction/scripts/*.test.ts
```

覆盖：逐章 schema 校验与 quote 溯源、章节清单解析、版本备份与回滚、**实体卡、阶段卡、阶段切分
（别名/关系/衣物/物品的阶段归属与索引 phases 校验）**。

> `--test-isolation=none` 让测试在单进程内运行，避免测试运行器为每个文件 spawn 子进程（在受限沙箱下 `spawn` 可能被拒绝）。

### 类型检查（可选）

```bash
npm i -D typescript @types/node && npx tsc --noEmit
```

`tsconfig.json` 已启用 `erasableSyntaxOnly`，与 Node 的原生类型擦除保持一致。默认不安装 `node_modules`——脚本运行与自测都不需要它。


## 关于 DSH 机制的事实（已核对实现源码）

| 事项 | 事实 |
|---|---|
| skill 发现根 | `<projectRoot>/.dsh/skills`（rank 100）；`projectRoot` = 最近的含 `.git` 祖先，否则 cwd。本工作区有 `.git`，故项目根即仓库根 |
| `command` frontmatter | **DSH 没有这个字段**。只读取 `name`/`description`/`whenToUse`/`metadata`/`disable-model-invocation`/`user-invocable`；未知键被静默忽略（故 `command:` 行无害但也不参与注册）。camelCase 调用键会被拒绝并丢弃整个 skill |
| 命令如何触发 | `dsh-tool-skill` 的手势正则 `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`：用户输入中任何以空白为界的 `/name` 命中 skill 名，即把该 skill 全文注入该步。故 `name` 即命令名 |
| `@` 引用 | `dsh-file-reference` 只把 mention 作为普通提示词文本插入，**不读文件内容**；路径需由模型解析后自行读取 |
| `.dsh/agents/*.md` | **DSH 没有该自动发现机制**。子代理由 `subagent` 工具用自包含提示词创建；因此这两个文件是「磁盘上的子代理工作说明」，由子代理自己读取 |
| skill 体积 | 出货 skill 的正文作为工具结果受 8192 字符修剪阈值约束，故细则放在 `references/` 按需加载 |

## 三处明确的设计决定

1. **人物 `sources` 扩展字段**：规范给出的单章 `characters` 对象没有 `quote`，但全局规则要求「每条信息必须有 quote 溯源」，且人物卡需要「原文依据」与「关系-依据」。因此在 `characters[]` 增加**可选** `sources: [{chapter, quote}]`，`relations[]` 增加**可选** `quote`。字段可选，保证最小规范形态仍能通过校验；提取时建议填写，否则卡片依据列只能留空。
2. **`.dsh/agents/` 是说明文件而非注册表**：文件顶部保留规范给定的 frontmatter 与正文，其下追加「在 DSH 中的执行说明」，把规范流程展开成可执行步骤（含失败路径、进度更新、返回格式）。
3. **阶段切分走确定性脚本，提示词只给提示**：`phase_hint` 由模型判断，而切分、归并、ID 分配、文件名与索引生成全部由 `phase-plan.ts` / `aggregate_cards.ts` 完成。同一输入必得同一套 ID 与同一批文件（便于增量重跑与 diff），模型不会在两个阶段之间左右横跳；脚本不可用时才退回按 `references/aggregation-rules.md` 手工执行。

## 产出清单

```text
extracted/
  _meta.json        章节清单（source_dir / chapter_count / chapters[]）
  _progress.json    进度（total / done / current / failed / backup_failed / updated_at）
  _errors.json      校验报告（validate_extraction.ts）
  _index.json       汇总索引（counts + cards 路径，含 character_phases）
  ch000.json ...    逐章提取结果（characters 含 phase_hint / clothing / items）
cards/
  _index.json               全量索引（characters / clothing / items）
  _index.md                 人可读索引（实体卡表 + 阶段卡表 + 衣物表 + 物品表）
  characters/_index.json    角色与阶段索引
  characters/<姓名>/index.md               实体卡（只含稳定信息）
  characters/<姓名>/phase_XX_<标签>.md      阶段卡（该章节范围内的状态）
  clothing/*.md             衣物卡（带 character_id / phase_id）
  items/*.md                物品卡（带 character_id / phase_id）
```

**一人一目录**：实体卡固定叫 `index.md`，阶段卡固定 `phase_XX_<标签>.md`。格式细节以
`.dsh/skills/character-extraction/references/output-format.md` 为准；机器校验见 `schemas/*.schema.json`。
