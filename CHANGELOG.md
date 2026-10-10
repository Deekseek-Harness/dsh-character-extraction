# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。每个版本对应仓库中的一次提交，对应的提交说明
（commit message）保存在仓库根的 `commit.txt`。

## [Unreleased]

（无）

## [2.2.0] - 2026-10-10

人物卡从「一人一卡、字段并集」升级为**「实体卡 + 阶段卡」二维结构**，实体与状态解耦。

### 新增

- **人物实体卡 + 阶段卡**：人物卡改为一人一目录
  `cards/characters/<姓名>/index.md`（实体卡，只含跨阶段稳定的身份锚点）+
  `cards/characters/<姓名>/phase_XX_<标签>.md`（阶段卡，描述特定章节范围内能同时成立的状态）。
- **阶段切分**：`identity` → `age` → `appearance` → `clothing` 的不可逆变化开启新阶段；逐章
  `phase_hint` 为最强信号。带**回弹检查**（变化在其后下一次稳定登场就退回基线、且间隔 ≤2 个
  登场点且 ≤4 章 → 视为阶段内临时状态）；章节不连续必须开新阶段；只有 1 章的阶段并入相邻阶段
  并标 `[短暂]`；相邻同提示的阶段合并。阶段章节互不重叠。
- **`phase_hint`**：逐章提取新增时期提示字段（2–8 字，如 `卖面时期` / `军中参谋`）；逐章阶段
  **不做**阶段切分。汇总时做纯后缀归一（`书僮时期`/`书僮`/`书僮阶段` 视为同一阶段），标签取最简
  写法；身份与外描写都缺失时回退为中性的「故事阶段」。
- **别名分阶段**：实体卡 `aliases` 只保留跨阶段通用称呼（覆盖 ≥2 个阶段且 ≥50% 阶段，或 ≥3 个
  阶段）；其余按章节归属进阶段卡 `allowed_names`，只在其他阶段出现过的称呼进 `forbidden_names`。
  硬校验：`forbidden_names ∩ allowed_names = ∅`。
- **关系分阶段**：跨阶段长期成立的关系（≥2 章或覆盖 >50% 出场章）进实体卡 `relations_graph`；
  时变关系进阶段卡 `relations`，同一 `(target, type)` 合并并保留全部章号。
- **衣物卡 / 物品卡关联阶段**：新增 `character_id` 与 `phase_id`，指向对应阶段卡；阶段卡的
  `clothing_refs` / `item_refs` 反向引用卡片路径。
- 新增脚本 `scripts/phase-plan.ts`（实体归并 + 阶段切分的确定性逻辑，可单独输出计划 JSON）与
  `scripts/aggregate_cards.ts`（汇总落盘：四类卡片 + 全部索引 + ID/文件名分配）。
- 新增 schema：`character-entity.schema.json`、`character-phase.schema.json`、
  `cards-index.schema.json`、`characters-index.schema.json`。
- 新增模板：`templates/character-entity-card.md`、`templates/character-phase-card.md`。
- 新增测试：`character-entity.test.ts`、`character-phase.test.ts`、
  `aggregation-phase-split.test.ts`，以及共享夹具 `test-fixtures.ts`。
- npm scripts：`aggregate:cards`、`phase:plan`、`test:dot`。

### 变更

- `schemas/character.schema.json` 明确为**逐章**记录（各字段皆本章值），
  `chapter-extraction.schema.json` 说明逐章阶段不切分。
- `schemas/clothing.schema.json` / `item.schema.json` 新增可选 `phase_hint`。
- `SKILL.md`：新增「人物模型：实体卡 + 阶段卡」章节；核心提取提示词加入 `phase_hint`；产出
  结构、可选脚本、自测说明同步更新。
- `references/character-rules.md`：写入实体/阶段分离规则、切分信号、别名分阶段、关系分阶段、
  `phase_hint` 写法专节。
- `references/output-format.md`：人物卡样例改为实体卡 + 阶段卡；衣物卡/物品卡样例加入
  `character_id` / `phase_id`；索引样例含 `phases`。
- `references/aggregation-rules.md`：汇总流程改为「实体归并 → 阶段切分 → 卡片与索引」，
  新增确定性执行入口与提示词归一说明。
- `references/clothing-rules.md` / `item-rules.md` / `loop-control.md`：补阶段关联与阶段切分条目。
- `.dsh/agents/chapter-extractor.md`：说明逐章只给 `phase_hint`、不做阶段切分（附速查表）。
- `.dsh/agents/character-aggregator.md`：新的汇总流程与复核清单。
- `templates/clothing-card.md` / `item-card.md`：frontmatter 增加 `character_id` / `phase_id` 与
  「所属阶段」正文段。
- `package.json`：版本 2.1.0 → 2.2.0，测试命令改为 glob `.dsh/**/*.test.ts`（覆盖全部 8 个测试文件）。
- `README.md`：新增人物模型说明与阶段切分规则表，目录结构/脚本/产出清单同步更新。
- 汇总阶段仍**只读** `extracted/*.json`，**不读**章节原文；版本管理 `history/` 逻辑不变。

### 移除

- `templates/character-card.md`（旧「一人一卡」模板，由实体卡 + 阶段卡模板取代）。

### 修复

- 阶段标签兜底不再把章号写进文件名：原实现身份缺失时回退为 `第33章起`，现改为
  `phase_hint → identity → appearance → 故事阶段`。
- 角色归并不再因「某章的别名恰好是另一角色主名」而把两个角色错并成一人：主名同章/同字优先，
  别名只在唯一候选分组时桥接，跨角色主名不并入 `aliases`。

### 验证

- 87 个 `node:test` 用例全部通过（原 49 + 新增 38）。
- 真实数据全量跑通：`chapters/` 43 章 → 43 个 `ch*.json`（`validate_extraction.ts` 0 错 0 警）
  → 159 个角色实体、184 张阶段卡、121 张衣物卡、208 张物品卡，四类 schema 全量校验通过。
- 旧描述「一人一卡、字段并集」在插件文档中仅以「不得退回」的否定形式出现。

## [2.1.0] - 2026-10-10

让 `/character-extraction` 可安全重复运行，并在覆盖输出前加入版本备份。

### 新增

- **增量续跑**：已完成的章（`ch{index:03d}.json` 存在且非空）默认跳过，不读原文、不重新提取；
  单章子代理新增幂等守卫（目标文件已存在且 `chapter_index` 匹配时直接返回 `SKIP`）。
- **版本备份 `history/`**：只有两次运行落在**同一个输出目录**时，才把上一次输出备份为
  `history/V{n}/`（含 `extracted/`、`cards/`、`_manifest.json`）；首次运行 / 换输出目录 / 当前
  输出为空均不备份，只更新 `history/_index.json` 的 `last_output`。
- 脚本 `backup_output.ts`（备份判断与执行，输出决策 JSON）、`history.ts`
  （`list` / `show` / `restore` / `prune`）、`history-store.ts`（共享确定性层）。
- 测试 `backup_output.test.ts`、`history.test.ts`。

### 变更

- `_meta.json` **每次运行都重扫覆盖**（只读文件名、幂等），删除旧规则「`_meta.json` 已存在就
  直接读取」——后者会让新加入 `chapters/` 的章节永远不被发现。
- `SKILL.md` 与 `references/loop-control.md` 两份循环控制提示词同步更新并加一致性约束。
- `references/aggregation-rules.md` 新增 0.1 节，明确「备份 → 提取 → 汇总」的先后关系。
- `.gitignore` 排除 `history/` 与 `.dsh/tmp/`；`package.json` 版本 2.0.0 → 2.1.0。

### 验证

- 49 个 `node:test` 用例通过；真实环境连续两次运行：第 1 次 `first_run` 不备份，第 2 次
  `same_output_dir` 备份 `V1`。

## [2.0.0] - 2026-10-09

首个完整版本：逐章提取并合并人物（含关系）、衣物、物品。

### 新增

- 逐章提取：顺序同步、一章一子代理、每章立即落盘 `extracted/ch{index:03d}.json`，原文与提取
  结果不进主 Agent 上下文。
- 汇总阶段只读 `extracted/*.json`，产出人物卡、衣物卡、物品卡与索引。
- 脚本 `scan_chapters.ts`（章节清单）、`validate_extraction.ts`（schema 校验 + quote 回查原文）、
  `schema-validator.ts`（零依赖 JSON Schema 子集校验器）。
- 规则文档 `character-rules.md` / `clothing-rules.md` / `item-rules.md` /
  `aggregation-rules.md` / `output-format.md` / `loop-control.md`。
- 失败不阻塞（`_progress.json` 的 `failed`）、`quote` 全量溯源、置信度与 `[不确定]` 约定。

[Unreleased]: https://github.com/Deekseek-Harness/dsh-character-extraction/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/Deekseek-Harness/dsh-character-extraction/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Deekseek-Harness/dsh-character-extraction/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/Deekseek-Harness/dsh-character-extraction/releases/tag/v2.0.0
