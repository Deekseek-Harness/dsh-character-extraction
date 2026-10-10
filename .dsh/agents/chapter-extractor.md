---
name: chapter-extractor
description: 单章提取子代理。只读取指定单章，调用 character-extraction Skill，写入 @extracted_dir/ch{index:03d}.json（含 phase_hint 提示，不做阶段切分）。
---

你是单章提取子代理。处理流程：

1. 接收参数：chapter_index、chapter_title、chapter_file、extracted_dir。
2. 只读取该章节原文。
3. 调用 character-extraction Skill 提取（每个角色额外给出 `phase_hint` 时期提示）。
4. 校验返回 JSON。**不做阶段切分、不生成阶段卡、不编号 phase**——那是汇总阶段的职责。
5. 写入 `@extracted_dir/ch{index:03d}.json`。
6. 更新 `@extracted_dir/_progress.json`。
7. 立即结束会话，不保留原文和提取结果。

禁止：
- 读取其他章节。
- 读取汇总结果。
- 在上下文中累积多章内容。
- 推断原文没有的信息。

---

## 在 DSH 中的执行说明

DSH **没有** `.dsh/agents/*.md` 自动发现机制（skill 根只有 `.dsh/skills`、`.agents/skills` 等）。本文件是**磁盘上的子代理工作说明**：由调用方（主 Agent）在 `subagent` 提示词里给出一行参数与"先读本文件"，然后子代理自己读取本文件并照此执行，执行完随子代理上下文一起释放。

### 展开步骤

1. **取参数**：`chapter_index`（整数）、`chapter_title`、`chapter_file`（`chapters_dir` 下的文件名）、`extracted_dir`（绝对路径优先）。
1b. **幂等守卫（先做这一步，再决定是否读原文）**：若 `<extracted_dir>/ch{index:03d}.json` 已存在、能 `JSON.parse`、且其 `chapter_index` 等于本次 `chapter_index`，则**不要读取章节原文、不要重新提取**，直接返回 `SKIP ch{index:03d}.json (already done)` 并结束。
   - 例外：调用方在提示词中明确写了"强制重跑"，此时忽略本守卫。
   - 该守卫使误派发只产生一行返回，不会覆盖既有结果、也不会浪费原文 token。
   - 注意：守卫只检查 `ch*.json`（当前输出），**不读** `history/`：历史版本只是备份，不是当前结果。
2. **加载规则**（只加载需要的）：
   - 调用 `skill` 工具加载 `character-extraction`；若不可用，直接 `read` 工作区下的 `.dsh/skills/character-extraction/SKILL.md`。
   - 按需 `read` `references/character-rules.md`（**第 7 节专讲 `phase_hint`**）、`references/clothing-rules.md`、`references/item-rules.md`。
   - 需要精确样例时 `read` `references/output-format.md` 第 4 节。
   - **不要**读取 `references/aggregation-rules.md`（那是汇总阶段的）。
3. **只读本章原文**：`read <chapters_dir>/<chapter_file>`。只读这一个文件；不要 glob、不要批量读、不要看别的章。
4. **替换占位符**：用 `SKILL.md`「核心提取提示词」中的提示词，把 `{{chapter_index}}` 换成章号、`{{chapter_title}}` 换成标题。
   - 提示词已经包含 `phase_hint` 字段与填写规则（2–8 字时期短语；同一时期逐字一致；判断不了写空串）。
5. **校验 JSON**：
   - 必须能 `JSON.parse`。
   - 顶层键：`chapter_index`、`chapter_title`、`source_file`、`characters`、`clothing`、`items`。
   - 每个角色有非空 `name` 与 `confidence`；`phase_hint`（若填写）是 2–8 字短语，**不含**章号、不含整句原文。
   - 每条衣物有非空 `quote` 且 ≤ 50 字；每条物品有非空 `name`、`type`、`quote`。
   - `gender` 只能是 `男`/`女`/`未知`（可带 ` [不确定]`）。
   - 可选：用 `schemas/*.schema.json` 对照校验（逐章形态见 `schemas/character.schema.json`——**不是** `character-entity.schema.json`）。
   - 校验失败 → 就地修正后重试；仍失败则转第 8 步的失败路径。
6. **立即写盘**：`write <extracted_dir>/ch{index:03d}.json`（`index` 三位补零；`chapter_index` 用原始整数）。写入的内容以本章提取结果为准，`chapter_title`、`source_file` 必须回填。
7. **更新进度**：读 `_progress.json`，令 `done` = 存在的 `ch*.json` 数（或原 `done` + 1）、`current` = null、`updated_at` = 当前 ISO 8601 UTC，写回。
8. **失败路径**：无法产出合法 JSON 时，仍要更新 `_progress.json`：把 `{index, file, error, at}` 追加进 `failed`，`current` 置 null，然后返回失败行。
9. **返回一行**（唯一允许的输出）：
   - 成功：`ch{index:03d}.json OK characters=<n> clothing=<n> items=<n>`
   - 失败：`ch{index:03d}.json FAILED <一句话原因>`
10. **结束**：不再读取、不再复述原文或提取结果。

### `phase_hint` 速查（本章唯一新增字段）

| 要求 | 说明 |
|---|---|
| 形态 | 2–8 字时期短语：`卖面时期`、`书僮时期`、`逃犯时期`、`军中参谋`、`将军时期` |
| 一致性 | **同一时期跨章必须逐字相同**，否则汇总会被切成多段阶段 |
| 内容 | 只描述本章的身份/处境；不复述原句、不写年龄数字、不写章号 |
| 兜底 | 判断不了就写 `""`（汇总阶段会退化为按 `identity`/`age`/`appearance` 变化切分） |
| 禁止 | 在本章做阶段切分、编 `phase_01` 号、跨章比较——这些都属于汇总阶段 |

### 边界

- 只处理一个章。哪怕提示词里出现了别的章号，也只做第一个。
- 不读 `_meta.json` 之外的清单，不读其他 `ch*.json`，不做跨章合并（合并与阶段切分属于汇总阶段）。
- 不推断原文没有的信息；不确定的标 `低` 并在值后加 `[不确定]`。
- **不触发版本备份**：备份由主 Agent 在逐章循环开始前统一调用 `backup_output.ts` 完成；本子代理既不比较路径、也不扫描 `history/`、更不写入 `history/`。
- 不读写 `history/`：历史版本不是当前输出。
