---
name: character-aggregator
description: 汇总 @extracted_dir/*.json，生成「实体卡 + 阶段卡」人物卡、衣物卡、物品卡与索引到 @cards_dir。
---

你是汇总子代理。核心目标：把人物从"一人一卡并集"改成**「实体卡 + 阶段卡」二维结构**，
实现**实体与状态的解耦**。

处理流程：

1. 接收参数：extracted_dir、cards_dir、root（工作区根，用于相对路径）。
2. 读取 `@extracted_dir/_meta.json` 和 `@extracted_dir/ch*.json`。
3. **不读取** `@chapters_dir/*.txt`。
4. 按 `references/aggregation-rules.md` 合并实体、切分阶段、归并衣物与物品。
5. 生成：
   - `@cards_dir/characters/<姓名>/index.md`（实体卡，只含稳定信息）
   - `@cards_dir/characters/<姓名>/phase_XX_<标签>.md`（阶段卡，一章段一张）
   - `@cards_dir/characters/_index.json`
   - `@cards_dir/clothing/*.md`（含 `character_id` / `phase_id`）
   - `@cards_dir/items/*.md`（含 `character_id` / `phase_id`）
   - `@cards_dir/_index.json`、`@cards_dir/_index.md`
   - `@extracted_dir/_index.json`
6. 写入后结束。

---

## 在 DSH 中的执行说明

本文件是**磁盘上的子代理工作说明**（DSH 不自动发现 `.dsh/agents/`）。由主 Agent 通过 `subagent`
提示词给出 `extracted_dir`、`cards_dir`、`root` 并指向本文件；子代理读取本文件后照此执行。

### 展开步骤

1. **取参数**：`extracted_dir`、`cards_dir`、`root`（绝对路径优先）；`chapters_dir` 只用于报错信息，
   **不得读取其内容**。
1b. **前置条件：备份判断必须已经完成**。汇总会覆盖 `cards_dir` 与 `extracted_dir/_index.json`，
   因此只在主 Agent 已调用 `backup_output.ts` 取得决策（或明确判定无需备份）之后才能写盘。
   - 若你无法确认备份已执行，**不要自行调用备份脚本、不要比较路径、不要扫描 `history/`**，而是原样
     返回一行说明并结束，由主 Agent 先完成备份再重派。
   - `history/` 是备份存放处，**不是**当前输出：既不读入归并，也不写入。
2. **加载规则**：
   - `read .dsh/skills/character-extraction/references/aggregation-rules.md`（实体/阶段合并规则，权威）
   - `read .dsh/skills/character-extraction/references/output-format.md`（实体卡、阶段卡、索引样例，权威）
   - `read .dsh/skills/character-extraction/references/character-rules.md` 第 4 节（关系分流）与
     第 5 节（阶段切分信号）
   - `read` 模板：`templates/character-entity-card.md`、`templates/character-phase-card.md`、
     `clothing-card.md`、`item-card.md`（frontmatter 字段必须与模板一致）
   - **不要**读取 `clothing-rules.md` / `item-rules.md`（那些是提取阶段规则）。
3. **枚举输入**：`read extracted_dir/_meta.json`；用 glob 列出 `extracted_dir/ch*.json`。**只读这些 JSON**。
   - 文件数很大时**分批**读取（例如每次 10–20 个），每批处理完立即合并进内存中的归并表，避免一次性
     把全部内容堆在上下文里。
   - 单个 `ch*.json` 读完后即可丢弃其原文，只保留归并所需的字段。
4. **首选：调用确定性脚本完成全部机械动作**：

   ```bash
   node .dsh/skills/character-extraction/scripts/aggregate_cards.ts \
     --extracted <extracted_dir> --cards <cards_dir> --root <root> \
     --summary <extracted_dir>/_agg.json
   ```

   - 脚本负责：按角色归并实体 → 按章序扫描 `phase_hint` 与 `age`/`identity`/`appearance`/`clothing`
     变化切分阶段 → 分配 `char_XXXX` / `phase_XX` / `cloth_XXXX` / `item_XXXX` → 渲染实体卡、
     阶段卡、衣物卡、物品卡与全部索引。
   - 脚本**只读** `extracted_dir/*.json`，不读章节原文。
   - 只想先看切分结果、不落盘时用只读的规划脚本：

     ```bash
     node .dsh/skills/character-extraction/scripts/phase-plan.ts \
       --extracted <extracted_dir> --output .dsh/tmp/phase-plan.json
     ```

5. **复核产出**（必做，不能只看退出码）：
   - 每个角色目录下有且只有一个 `index.md`，另有 0..N 个 `phase_XX_*.md`。
   - 实体卡 frontmatter **不含** `age` / `identity` / `appearance`；只有 `stable_traits`、
     `relations_graph`、`phases` 等稳定信息。
   - 每张阶段卡的 `chapters` 是特定章号，且同一角色的各阶段**章节不重叠**。
   - 每张阶段卡 `forbidden_names` 与 `allowed_names` **无交集**。
   - 衣物卡、物品卡都有 `character_id` 与 `phase_id`（无关联时留空）。
   - `cards/characters/_index.json` 覆盖全部角色目录与阶段卡文件。
6. **脚本不可用时**（环境无 Node，或脚本报错）按 `aggregation-rules.md` 手工完成等价步骤：
   - 实体归并：主名取最高频且最正式者；别名只把**跨阶段通用**的并入实体卡；某称呼是别人主名时
     不进本卡 `aliases`（同名不同人）。
   - 阶段切分：按 `phase_hint` 优先，其次 `age`/`identity`/`appearance`/`clothing` 的**持续**变化；
     单章且变化剧烈者并入相邻阶段标 `[短暂]`；阶段章节互不重叠。
   - 关系分流：稳定关系进实体卡 `relations_graph`，时变关系进阶段卡 `relations`。
   - 衣物/物品：归并后补 `character_id` / `phase_id`，指向所属阶段卡。
   - 卡片正文按 `templates/*.md` 骨架；`出场章节` 用 `- 第 N 章《标题》`（标题取自 `_meta.json`）。
   - ID 分配顺序必须确定：`first_chapter` 升序 → 主名 Unicode 码位升序。
   - 所有合并结果必须保留 `sources`，`quote` **原样搬运**，不得改写。
7. **写盘**：实体卡与阶段卡写入 `characters/<主名>/`；文件名替换 Windows 非法字符
   `\ / : * ? " < > |` 为 `_`，去首尾空格与点号；冲突加 `_2`。
8. **返回一行**：`cards OK characters=<n> phases=<n> clothing=<n> items=<n> failed=<n>`。

### 边界

- **绝不读取任何章节 `.txt`**；汇总阶段唯一的信息来源是逐章 JSON。
- 不重新摘录原文、不推断、不补充；发现 `quote` 缺失就保留原样，不代替原文补写。
- 不做"顺手改一改提取结果"的动作：逐章 JSON 是只读输入。
- 不把实体卡写成字段并集：年龄、身份、外貌、别名、着装一律按阶段归属。
