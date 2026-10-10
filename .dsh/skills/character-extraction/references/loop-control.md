# 循环控制细则（主 Agent）

主 Agent 的唯一职责是**驱动循环**，不是读小说。本文件是 `SKILL.md`「循环控制提示词」的展开与执行细节；下面那份是规范原文，**必须与 `SKILL.md` 中的同名块逐字一致**（改动其一就要同步另一处）。

## 循环控制提示词（规范原文，与 SKILL.md 保持一致）

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

第 5 步的 `a`–`f` **整体委托**给单章子代理；主 Agent 只保留"章号 + 一行状态"。

## 阶段 0：解析与准备

1. **解析参数**（见 `SKILL.md` 参数解析节）：取出 `@` 引用，相对路径按工作区根目录解析，按 1/2/3 个引用补缺省值 → `chapters_dir`、`extracted_dir`、`cards_dir`。
2. 校验 `chapters_dir` 存在；不存在 → 报错停止，**不要**静默换目录。
3. **版本备份判断（必须在任何写盘之前）**：执行
   `node .dsh/skills/character-extraction/scripts/backup_output.ts --extracted <extracted_dir> --cards <cards_dir>`
   并读取它输出的决策 JSON。**只有两次运行落在同一个输出目录**时，脚本才会把上一次输出备份为 `history/V{n}/`；主 Agent **不得**自己比较路径、扫描版本目录或计算版本号。
   - `backup_performed: true` → 记下 `version`，继续。
   - `reason: "backup_error"` → **不阻塞**：脚本已把原因写入 `_progress.json` 的 `backup_failed`，继续流程。
   - 其他 reason（`first_run` / `output_dir_changed` / `empty_output` / `history_inside_output`）→ 未备份，继续流程。
4. 创建 `extracted_dir`、`cards_dir`（不存在则创建）。
5. **每次运行都必须重扫 `_meta.json`（发现新增章节）**：执行
   `node .dsh/skills/character-extraction/scripts/scan_chapters.ts --input <chapters_dir> --output <extracted_dir>/_meta.json`，
   **无条件覆盖**。该脚本只读文件名，幂等且零成本。
   - **禁止**"`_meta.json` 已存在就直接读取"：那样新加入 `chapters_dir` 的章节永远不会被发现，"继续提取"会静默漏章。
   - 脚本不可用时由主 Agent 扫描 `chapters_dir/*.txt` 生成完整清单并覆盖写入，规则同 `SKILL.md`。
6. 初始化 `_progress.json`（若不存在）：`{"total": N, "done": 0, "current": null, "failed": [], "updated_at": "<now>"}`。
7. **续跑检测**：用 glob 列出 `extracted_dir/ch*.json`，得到已完成章号集合 `done_set`；已存在且非空的章号**默认跳过**（除非用户明确要求强制重跑）。这一步只看文件名，不读内容。

## 阶段 1：逐章循环

按 `_meta.json` 中 `chapters` 的 `index` **升序**遍历。

- `index ∈ done_set` 的章**直接跳过**：不派发子代理、不读原文、不重复提取。
- 已被 `chapters_dir` 移除的旧章，其 `ch*.json` 保留不动（历史产物不删除）；如需清理请显式说明。

### 每章只发这一条提示词（约 250 字，同步调用）

```text
你是单章提取子代理。先读取 <workdir>/.dsh/agents/chapter-extractor.md 并严格遵照执行。
参数：chapter_index={{index}}; chapter_title={{title}}; chapter_file={{file}}; extracted_dir={{extracted_dir}}
只返回一行：ch{{index:03d}}.json OK characters=<n> clothing=<n> items=<n>
```

要点：

- `<workdir>` 是工作区绝对路径；`chapter_file` 是 `chapters_dir` 下的文件名；`extracted_dir` 用绝对路径更稳妥。
- **必须同步等待**（`subagent` 工具 `run_in_background: false`）。下一章依赖上一章落盘，且并发会破坏"顺序同步"约束。
- 提示词里**不要**粘贴 `chapter-extractor.md` 的正文，也不要粘贴章节原文：子代理自己读，读完随其上下文一起释放。
- 上一章失败也要继续下一章；失败由子代理自己写入 `_progress.json` 的 `failed`。

### 主 Agent 收到一行结果后

- 只记一个计数（已完成 / 失败），**不要**读回 `ch*.json` 验证，**不要**把原文或提取结果留在上下文里。
- 不要为"确认"而重复处理已完成的章。

### 主 Agent 禁止事项

- 禁止 `read` 任何 `ch*.json` 的内容（那是汇总子代理的输入）。
- 禁止 `read` 任何章节 `.txt`（哪怕"只想看一眼"）。
- 禁止一次性 `read` 多章、禁止拼接多章原文。
- 禁止在上下文里保留、复用、引用已处理章节的任何文本。

## 阶段 2：汇总

1. 发一条子代理提示词，让汇总子代理自己去读说明：

```text
你是汇总子代理。先读取 <workdir>/.dsh/agents/character-aggregator.md 并严格遵照执行，再读取 <workdir>/.dsh/skills/character-extraction/references/aggregation-rules.md 与 references/output-format.md。
参数：extracted_dir={{extracted_dir}}; cards_dir={{cards_dir}}
只返回一行：cards OK characters=<n> clothing=<n> items=<n> failed=<n>
```

2. 汇总子代理**只读** `extracted_dir/_meta.json` 与 `extracted_dir/ch*.json`，**不读** `chapters_dir/*.txt`。
3. 产出：`cards_dir/characters/*.md`、`cards_dir/clothing/*.md`、`cards_dir/items/*.md`、`cards_dir/_index.json`、`cards_dir/_index.md`，以及 `extracted_dir/_index.json`。
4. 合并规则见 `references/aggregation-rules.md`；所有合并结果必须保留 `sources`。

## 阶段 3：收尾与对账

1. **进度对账**：若 `_progress.json` 与实际文件不一致（例如子代理崩溃未更新），发一条**极短**子代理任务：按 `extracted_dir/ch*.json` 的文件清单重建 `_progress.json` 的 `total` / `done` / `failed`；只看文件名，不读 JSON 内容。
2. 可选校验：`node .dsh/skills/character-extraction/scripts/validate_extraction.ts --chapters <chapters_dir> --extracted <extracted_dir> --errors <extracted_dir>/_errors.json`。
3. 向用户汇报**一行摘要**：总章数、成功数、失败章号、卡片数、产出目录。不要把提取内容复述进上下文。

## 恢复（中断后续跑）

- 重跑同一命令即可：阶段 0 第 7 步的续跑检测会跳过已完成的 `ch*.json`。
- 阶段 0 第 5 步**每次都会重扫** `_meta.json`，因此期间新加入 `chapters_dir` 的章节会被一起处理，不会漏章。
- `failed` 中的章号默认重试。
- `_progress.json` 缺失或不一致时，由阶段 3 的对账任务重建，**不需要**重读原文。
- 续跑同样会先做版本备份判断：与上一次同一输出目录时会先备份为 `history/V{n}/`，再覆盖。若本轮将跳过全部章节，备份仍然会发生（规则如此）；不需要时可先改用新的输出目录，或用 `history prune` 清理。

## 降级模式（`subagent` 工具不可用时）

主 Agent 自己顺序循环：每章 `read` → 抽取 → 立即 `write` → 更新 `_progress.json` → 进入下一章。此时必须：

- 每章写盘后立刻停止引用该章文本；不得回头复述。
- 一旦上下文接近上限，先写盘、再汇报进度，由用户重跑续做（已完成的章会被跳过）。
- 明确告知用户：该模式上下文占用大，长篇小说建议改用支持子代理的环境。

## 可选：`workflow` 脚本编排（上下文最省）

若环境提供 `workflow` 工具，可用一段脚本按 `for` 循环**串行** `await agent(...)` 逐章处理：循环变量与章节内容活在脚本里，**完全不进入任何模型上下文**，只有最终返回值回到主 Agent。约束同上：串行 `await`、每章 `agent()` 内部立即落盘、汇总单独一次调用。此方案比主 Agent 循环更省上下文，但依赖 `workflow` 工具存在；缺失时退回上文默认方案。

## 上下文预算参考

| 方案 | 主 Agent 每章增量 | 108 章累计 |
|---|---|---|
| 主 Agent 直读原文 | 数 KB（原文 + 提取结果，永久保留） | 极易溢出 |
| 主 Agent 循环 + 子代理隔离（默认） | ~250 字一行 + 一行结果 | ~30–50 KB |
| `workflow` 脚本编排 | 0（仅最终返回值） | ~1 KB |

## 自检清单

- [ ] 输入目录存在；输出目录已创建。
- [ ] 覆盖输出前已调用 `backup_output.ts` 并读到决策 JSON；主 Agent 没有自行比较路径或算版本号。
- [ ] `_meta.json` 是**本次重扫**的结果（不是沿用的旧文件），新章节已被纳入。
- [ ] 已完成的章（`done_set`）被跳过，没有重复提取；没有对同一章二次派发子代理。
- [ ] `_meta.json` 按 `index` 升序；`_progress.json` 与实际文件一致。
- [ ] 每章都在**同一轮**内完成读取、提取、校验、写盘。
- [ ] 主 Agent 上下文里没有任何章节原文、没有任何 `ch*.json` 内容。
- [ ] 失败章记入 `failed`，且未阻塞后续章节。
- [ ] 汇总阶段没有读取任何 `.txt`。
- [ ] 汇报只有摘要，没有原文粘贴。
