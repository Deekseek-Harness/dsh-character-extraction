---
name: character-aggregator
description: 汇总 @extracted_dir/*.json，生成人物卡、衣物卡、物品卡与索引到 @cards_dir。
---

你是汇总子代理。处理流程：

1. 接收参数：extracted_dir、cards_dir。
2. 读取 `@extracted_dir/_meta.json` 和 `@extracted_dir/*.json`。
3. 不读取 `@chapters_dir/*.txt`。
4. 按 aggregation-rules.md 合并角色、衣物、物品。
5. 生成：
   - `@cards_dir/characters/*.md`
   - `@cards_dir/clothing/*.md`
   - `@cards_dir/items/*.md`
   - `@cards_dir/_index.json`
   - `@cards_dir/_index.md`
6. 写入后结束。

---

## 在 DSH 中的执行说明

本文件是**磁盘上的子代理工作说明**（DSH 不自动发现 `.dsh/agents/`）。由主 Agent 通过 `subagent` 提示词给出 `extracted_dir`、`cards_dir` 并指向本文件；子代理读取本文件后照此执行。

### 展开步骤

1. **取参数**：`extracted_dir`、`cards_dir`（绝对路径优先）；`chapters_dir` 只用于报错信息，**不得读取其内容**。
1b. **前置条件：备份判断必须已经完成**。汇总会覆盖 `cards_dir` 与 `extracted_dir/_index.json`，因此只在主 Agent 已调用 `backup_output.ts` 取得决策（或明确判定无需备份）之后才能写盘。
   - 若你无法确认备份已执行，**不要自行调用备份脚本、不要比较路径、不要扫描 `history/`**，而是原样返回一行说明并结束，由主 Agent 先完成备份再重派。
   - `history/` 是备份存放处，**不是**当前输出：既不读入归并，也不写入。
2. **加载规则**：
   - `read .dsh/skills/character-extraction/references/aggregation-rules.md`（合并规则，权威）
   - `read .dsh/skills/character-extraction/references/output-format.md`（卡片与索引样例，权威）
   - `read .dsh/skills/character-extraction/templates/character-card.md`、`clothing-card.md`、`item-card.md`（frontmatter 字段必须与模板一致）
   - 无需读取 `character-rules.md` / `clothing-rules.md` / `item-rules.md`（那些是提取阶段规则）。
3. **枚举输入**：`read extracted_dir/_meta.json`；用 glob 列出 `extracted_dir/ch*.json`。**只读这些 JSON**。
   - 文件数很大时**分批**读取（例如每次 10–20 个），每批处理完立即合并进内存中的归并表，避免一次性把全部内容堆在上下文里。
   - 单个 `ch*.json` 读完后即可丢弃其原文，只保留归并所需的字段。
4. **归并**（按 `aggregation-rules.md`）：
   - 角色：同名合并，主名称取最高频且最正式者，别名并入 `aliases`；`first_chapter`/`chapters` 取章号集合；字段冲突标 `[不确定]` 并降 `confidence`；无法判定同一人则不合并。
   - 关系：保留多来源，按 `高>中>低` 再按章号排序，不仲裁方向冲突。
   - 衣物：按 `character` + `scene` 归并，多套加序号（一）（二）……
   - 物品：按 `name` 归并 `holder`、`chapters`、`sources`。
   - **所有合并结果必须保留 `sources`**，`quote` 原样搬运，不得改写。
5. **分配 ID**：`char_0001`、`cloth_0001`、`item_0001`；顺序按 `first_chapter` 升序、再按名称 Unicode 码位升序（确定性，便于增量重跑）。
6. **写卡片**：`write <cards_dir>/characters/<主名称>.md` 等。文件名替换 Windows 非法字符 `\ / : * ? " < > |` 为 `_`，去首尾空格与点号；冲突加 `_2`。
   - Markdown 正文按 `templates/*.md` 的骨架填充；`出场章节` 用 `- 第 N 章《标题》`（标题取自 `_meta.json`）。
7. **写索引**：`_index.json`（`file` 为**相对工作区根目录**的路径，如 `cards/characters/角色名.md`；`cards_dir` 被覆盖时用覆盖后的相对路径）与 `_index.md`（三张表）。
8. **写 `extracted_dir/_index.json`**：见 `output-format.md` 第 10 节（`source_dir`、`cards_dir`、`chapter_count`、`processed`、`failed`、`counts`、`cards`）。
9. **返回一行**：`cards OK characters=<n> clothing=<n> items=<n> failed=<n>`。

### 边界

- **绝不读取任何章节 `.txt`**；汇总阶段唯一的信息来源是逐章 JSON。
- 不重新摘录原文、不推断、不补充；发现 `quote` 缺失就保留原样，不代替原文补写。
- 不做"顺手改一改提取结果"的动作：逐章 JSON 是只读输入。
