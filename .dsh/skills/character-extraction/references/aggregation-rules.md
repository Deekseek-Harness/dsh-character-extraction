# 汇总与合并规则（实体卡 + 阶段卡）

适用对象：`.dsh/agents/character-aggregator.md` 汇总子代理。输入只有 `@extracted_dir/*.json`，
**禁止读取** `@chapters_dir/*.txt`。

汇总产出的是**二维**人物卡：**实体卡**（这个人是谁，跨阶段稳定）+ **阶段卡**（他在某段章节里
是什么样）。不要退回"一人一卡、字段并集"。

## 0. 输入输出

- 输入：`@extracted_dir/_meta.json`（章节清单 + 标题）+ `@extracted_dir/ch*.json`（逐章结果）。
- 输出：
  - `@cards_dir/characters/<姓名>/index.md`（实体卡）
  - `@cards_dir/characters/<姓名>/phase_XX_<标签>.md`（阶段卡，一个角色 0..N 张）
  - `@cards_dir/characters/_index.json`（角色与阶段索引）
  - `@cards_dir/clothing/*.md`、`@cards_dir/items/*.md`（含 `phase_id` / `character_id` 关联）
  - `@cards_dir/_index.json`、`@cards_dir/_index.md`
  - `@extracted_dir/_index.json`（汇总索引）
- 汇总阶段**禁止**打开任何章节 txt；所有溯源信息只能取自逐章 JSON 的 `quote` / `sources`。

### 0.1 确定性执行入口（推荐）

阶段切分、字段归并、ID 与文件名分配、索引生成、Markdown 渲染全部由脚本完成，模型不手写：

```bash
node .dsh/skills/character-extraction/scripts/aggregate_cards.ts \
  --extracted <extracted_dir> --cards <cards_dir> --root . \
  --summary <extracted_dir>/_agg.json
```

- 只读 `@extracted_dir/*.json`；脚本**不会**读章节原文。
- 只做机械动作，业务判定（哪些变化算不可逆、阶段标签、同名不同人）见本文件与
  `references/character-rules.md`。
- 想先看切分结果再落盘，可用只读的规划脚本：

```bash
node .dsh/skills/character-extraction/scripts/phase-plan.ts \
  --extracted <extracted_dir> --output .dsh/tmp/phase-plan.json
```

- 脚本不可用时，由汇总子代理按本文件手工完成等价步骤（模板见
  `templates/character-entity-card.md`、`templates/character-phase-card.md`）。

### 0.2 与版本备份的先后关系（硬性）

汇总会**覆盖** `@cards_dir` 并重写 `@extracted_dir/_index.json`，因此顺序不能颠倒：

1. **先**：主 Agent 在逐章循环开始前调用 `backup_output.ts` 取得决策（只有两次运行在同一输出目录时才会备份为 `history/V{n}/`）。备份失败不阻塞，原因记入 `_progress.json` 的 `backup_failed`。
2. **后**：逐章提取（跳过已完成章）。
3. **最后**：汇总写盘。

汇总子代理必须遵守：

- **不得**自行调用备份脚本、比较路径、扫描 `history/` 或计算版本号——这些只由 `backup_output.ts` 完成。
- `history/` 是备份存放处，**不是**当前输出：既不读入归并，也不写入。
- 若无法确认备份判断已完成，**不要写盘**，返回说明交由主 Agent 先完成备份再重派。

## 1. 合并同名角色（实体层）

1. **主名裁决**：同一角色跨章出现时，取出现章数最多、且最正式的 `name` 作为主名
   （"姓+名"优先于绰号/短称）；同频次按 Unicode 码位升序，保证同一输入产出同一主名。
2. **别名合并（只留跨阶段通用的）**：其余章出现过的 `name` 与所有 `aliases` 去重后，只有
   覆盖 ≥ 60% 阶段或 ≥ 3 个阶段的称呼才进实体卡 `aliases`；其余按章节归属进阶段卡
   `allowed_names`。实体卡 `aliases` 不含主名本身。
3. **同名不同人守卫（硬要求）**：某称呼若是**另一个角色**的主名，则**不得**并入本角色的
   实体卡 `aliases`；按 `references/character-rules.md` 第 9 节各建一卡，并注明区分依据。
4. 实体卡 `first_chapter` = 最小章号；`chapters` = 出现过的章号升序去重。
5. 实体卡 `confidence` = 各章置信度的**最高值**；存在互相冲突的字段值时不取并集，而是把
   冲突值分配到不同阶段（见第 2 节）。
6. **无法判定是否同一人时**（同名但身份/关系明显冲突）→ **不合并**，各建一卡。

## 2. 阶段切分（核心）

按**章号升序**扫描该角色的逐章记录，按以下优先级切分：

0. **提示归一**：先把 `phase_hint` 归一为比较键——去掉首尾空白与 `时期/阶段/年代/年间/初/末/中`
   这类纯后缀。于是 `书僮时期`、`书僮`、`书僮阶段` 是**同一个**阶段，不会被切开；阶段标签取该
   阶段见过的**最简写法**。归一只是文本处理，不做语义概括（不会把「卖面」与「书僮」并起来）。
1. **`phase_hint` 变化** → 开新阶段。逐章提示是最强信号，同一时期的字符串必须完全一致。
2. **`phase_hint` 缺失**时看状态变化：`identity`（优先）→ `age` → `appearance` → `clothing`。
   判定「不可逆」的规则是**回弹检查**：某章相对当前阶段的基线状态变了，但**其后的下一次稳定登场
   又退回基线**（间隔 ≤ 2 个登场点且 ≤ 4 章）→ 视为阶段内临时状态（受伤、换衣、伪装），不切阶段；
   否则视为不可逆变化，开新阶段。
3. **章节不连续**（中间缺席）→ 开新阶段。阶段 `chapters` 只记实际出场的章。
4. **只有 1 章**的阶段 → 并入**前一**阶段并标 `[短暂]`；没有前一阶段时并入后一阶段。
5. **相邻且归一提示相同**的阶段 → 必须合并回一段。

硬约束：

- 阶段章节**互不重叠**（每章只属于一个阶段）。
- 阶段编号 `phase_01`、`phase_02`……按章号升序连续分配。
- 阶段标签：取该阶段 `phase_hint`；没有提示时取该阶段首现 `identity` 的第一个分句（≤ 16 字，
  超出截断并加 `…`）。
- 阶段文件名：`phase_XX_<标签>.md`，替换 Windows 非法字符 `\ / : * ? " < > |` 为 `_`。

### 2.1 阶段字段

每张阶段卡写入：

| 字段 | 取值 |
|---|---|
| `phase_id` | `phase_01`… |
| `character_id` / `character_name` | 与实体卡一致 |
| `label` / `chapters` | 阶段标签与章号 |
| `age` / `identity` / `appearance` | 该阶段内的值。同一字段有多个取值时，正文按「取值：章节」列出**全部**取值（必须能同时成立） |
| `clothing` | 该阶段各章 `clothing[].description`（升序去重） |
| `relations` | 该阶段的**时变关系** |
| `allowed_names` | 该阶段实际出现的称呼 |
| `forbidden_names` | 只属于**其他**阶段的称呼；`∩ allowed_names = ∅`（硬校验） |
| `confidence` | 该阶段内各章置信度的**最低值** |
| `sources` | 该阶段各章 `sources[].quote`，原样搬运 |

### 2.2 关系分流

- **稳定关系 → 实体卡 `relations_graph`**：跨阶段长期成立（出现在 ≥ 2 章，或覆盖该角色出场
  章的 ≥ 70%）。
- **时变关系 → 阶段卡 `relations`**：只在该阶段成立。
- 同一 `target` + `type` 多次出现 → 合并为一条，`chapters` 列出全部章号。
- 同一 `target` 出现**不同** `type` → 全部保留；方向冲突（A 记"师徒"、B 记"仇敌"）两条都保留，
  **不做仲裁**。
- `target` 指向的姓名若不在任何主名/别名集合中，也要保留，并在正文注明 `[未成卡]`。

## 3. 实体卡（`characters/<姓名>/index.md`）

只写跨阶段稳定的身份锚点，**不得**出现年龄、身份、外貌、别名的并集：

| 字段 | 内容 |
|---|---|
| `id` / `name` / `aliases` / `gender` | 身份锚点；`aliases` 只放跨阶段通用称呼 |
| `stable_traits.base_appearance` | 基线外貌（全书反复出现、不随阶段改变者） |
| `stable_traits.base_identity` | 基线身份（出场时的最初身份，如「落第秀才」） |
| `stable_traits.permanent_features` | 永久特征（胎记、疤痕、身形） |
| `relations_graph` | 稳定关系 |
| `first_chapter` / `chapters` | 首次出场章 / 全部出场章 |
| `confidence` | 各章最高值 |
| `phases[]` | 阶段索引：`phase_id` + `label` + `file` + `chapters` |
| `sources` | 原文依据（稳定关系相关章 + 首末章，最多 6 条） |

正文必须包含「阶段索引」与「下游使用（生图 / 检索）」两节，明示"实体卡 + 目标阶段卡"的组合方式。

## 4. 衣物卡

- 归并键：`character`（归到主名）+ `scene`。
- 同一"角色+场景"在汇总后出现**多套**衣物（来自不同章或同章多条）→ **加序号**区分：
  `场景名（一）`、`场景名（二）`……序号按章号升序分配。
- 合并后 `description` 与 `color_material` 用 `；` 连接去重。
- **关联阶段**：`character_id` = 归属角色 ID；`phase_id` = 该卡首个章号落在的阶段 ID
  （该角色没有阶段时留空串）。
- 保留 `chapters`（升序去重）与 `sources`（每章一条 `{chapter, quote}`）；`chapter` 兼容字段
  保留为该卡最早章号。
- `confidence` 规则同实体卡：取最高；冲突则降级。

## 5. 物品卡

- 归并键：`name`（同名合并）。
- 合并 `holder`：多值去重，用 `；` 连接；空值不写入。
- 合并 `chapters`：全部出现章号升序去重。
- 合并 `sources`：**每章一条** `{ chapter, quote }`；同章多条时取信息量最大的一条
  （含 `function` 或 `holder` 者优先）。
- **关联阶段**：`character_id` = 首个持有者归到的角色 ID；`phase_id` = 首个章号落在的阶段 ID；
  无主或角色无阶段时留空串。
- `type` 冲突时取多数值，少数值记入 `appearance` 末尾并标 `[不确定]`。
- 同名但明显是两件不同物品（如"两把不同的剑"且各有专名）→ 不合并，`name` 后加区分后缀并注明依据。

## 6. 溯源（硬要求）

- **所有合并结果都必须保留 `sources`**。没有 `sources` 的合并结果视为无效。
- `sources` 每项形如 `{ "chapter": <int>, "quote": "<来自该章 JSON 的原文引用>" }`。
- `quote` **原样搬运**，不得改写、不得拼接跨章内容、不得从原文重新摘录（汇总阶段无原文可读）。
- 合并过程中丢弃任何一条来源引用都不允许；确需裁剪时保留最早与最新各一条，并保证 `chapters`
  与 `sources` 的章号集合仍一致。

## 7. ID 与文件名

- ID 形如 `char_0001`、`cloth_0001`、`item_0001`，四位补零，从 1 开始。
- **分配顺序必须确定**：先按 `first_chapter` 升序，再按主名称的 Unicode 码位升序。同一输入必须
  产出同一套 ID，便于增量重跑。
- 角色用**一人一目录**：`characters/<主名>/`，目录内 `index.md` + `phase_XX_<标签>.md`。
- 衣物卡文件名 `角色名-场景.md`，物品卡文件名 `物品名.md`；替换 Windows 非法字符
  `\ / : * ? " < > |` 为 `_`，去掉首尾空格与点号。文件名冲突时追加 `_2`、`_3`。
- 索引中的 `dir` / `entity_file` / `file` 写**相对工作区根目录**的路径，统一 `/` 分隔；
  `cards_dir` 被 `@` 覆盖时用覆盖后的相对路径（如 `mycards/characters/卢云/index.md`）。

## 8. `cards/characters/_index.json`

```json
{
  "characters": [
    {
      "id": "char_0041",
      "name": "卢云",
      "dir": "cards/characters/卢云",
      "entity_file": "cards/characters/卢云/index.md",
      "chapters": [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 35, 36, 37, 38, 40, 42, 43, 44, 45],
      "phases": [
        {
          "phase_id": "phase_01",
          "label": "卖面时期",
          "file": "cards/characters/卢云/phase_01_卖面时期.md",
          "chapters": [10, 11]
        }
      ]
    }
  ]
}
```

`cards/_index.json` 用同一份 `characters` 段，另加 `clothing` / `items`（条目含 `character_id`、
`phase_id`）。

机器校验：`cards/_index.json` 见 `schemas/cards-index.schema.json`；`cards/characters/_index.json`
（只有 `characters` 段）见 `schemas/characters-index.schema.json`。

## 9. `cards/_index.md`

人可读索引：角色实体卡表 + 阶段卡表 + 衣物卡表 + 物品卡表。

```markdown
# 卡片索引

共 1 个角色实体、2 张阶段卡、1 张衣物卡、1 张物品卡。

生图 / 下游使用：取「实体卡 + 目标阶段卡」，不要使用实体卡字段的并集。

## 角色实体卡
| ID | 姓名 | 基线身份 | 出场章节 | 阶段数 | 实体卡 |

## 阶段卡
| 角色 | 阶段 | 标签 | 章节 | 时变关系 | 文件 |

## 衣物卡
| ID | 角色 | 阶段 | 场景 | 章节 | 文件 |

## 物品卡
| ID | 名称 | 类型 | 持有者 | 阶段 | 章节 | 文件 |
```

## 10. `@extracted_dir/_index.json`

```json
{
  "source_dir": "…/chapters",
  "cards_dir": "…/cards",
  "chapter_count": 43,
  "processed": [3, 4, 5],
  "failed": [],
  "counts": { "characters": 141, "phases": 160, "clothing": 134, "items": 234 },
  "cards": {
    "characters": ["cards/characters/伍定远/index.md"],
    "character_phases": ["cards/characters/伍定远/phase_01_西凉城的衙门捕头.md"],
    "clothing": ["cards/clothing/伍定远-…"],
    "items": ["cards/items/…"]
  }
}
```

## 11. 汇总子代理提示词

```text
你是汇总子代理。先读取 <workdir>/.dsh/agents/character-aggregator.md 并严格遵照执行，再读取 <workdir>/.dsh/skills/character-extraction/references/aggregation-rules.md 与 references/output-format.md。
参数：extracted_dir={{extracted_dir}}; cards_dir={{cards_dir}}; root={{workdir}}
只返回一行：cards OK characters=<n> phases=<n> clothing=<n> items=<n> failed=<n>
```

## 12. 汇总自检清单

- [ ] 没有读取任何 `.txt`。
- [ ] 人物卡是「一人一目录」：`characters/<主名>/index.md` + `phase_XX_<标签>.md`。
- [ ] 实体卡里**没有**年龄 / 身份 / 外貌 / 别名的并集，只有稳定锚点。
- [ ] 每张阶段卡描述特定章节范围内**能同时成立**的状态。
- [ ] 阶段之间章节不重叠；单章阶段已并标 `[短暂]`。
- [ ] `forbidden_names ∩ allowed_names = ∅`。
- [ ] 稳定关系在实体卡，时变关系在阶段卡。
- [ ] 衣物卡 / 物品卡都有 `phase_id`（或明确留空）与 `character_id`。
- [ ] `cards/characters/_index.json` 的 `phases` 索引覆盖全部阶段卡文件。
- [ ] 每张卡都有 `sources`，且 `quote` 与逐章 JSON 完全一致。
- [ ] `chapters` 与 `sources` 的章号集合一致。
- [ ] ID 分配符合第 7 节的确定性顺序。
- [ ] `_index.json` 覆盖全部卡片文件，路径为相对路径。
- [ ] 卡片 frontmatter 字段与 `templates/*.md` 模板一致。
