# 汇总与合并规则

适用对象：`.dsh/agents/character-aggregator.md` 汇总子代理。输入只有 `@extracted_dir/*.json`，**禁止读取** `@chapters_dir/*.txt`。

## 0. 汇总输入输出

- 输入：`@extracted_dir/_meta.json`（章节清单）+ `@extracted_dir/ch*.json`（逐章结果）。
- 输出：`@cards_dir/characters/*.md`、`@cards_dir/clothing/*.md`、`@cards_dir/items/*.md`、`@cards_dir/_index.json`、`@cards_dir/_index.md`。
- 汇总阶段**禁止**打开任何章节 txt；所有溯源信息只能取自逐章 JSON 的 `quote` / `sources`。

### 0.1 与版本备份的先后关系（硬性）

汇总会**覆盖** `@cards_dir` 并重写 `@extracted_dir/_index.json`，因此顺序不能颠倒：

1. **先**：主 Agent 在逐章循环开始前调用 `backup_output.ts` 取得决策（只有两次运行在同一输出目录时才会备份为 `history/V{n}/`）。备份失败不阻塞，原因记入 `_progress.json` 的 `backup_failed`。
2. **后**：逐章提取（跳过已完成章）。
3. **最后**：汇总写盘。

汇总子代理必须遵守：

- **不得**自行调用备份脚本、比较路径、扫描 `history/` 或计算版本号——这些只由 `backup_output.ts` 完成。
- `history/` 是备份存放处，**不是**当前输出：既不读入归并，也不写入。
- 若无法确认备份判断已完成，**不要写盘**，返回说明交由主 Agent 先完成备份再重派。

## 1. 合并同名角色

1. **主名称裁决**：同一角色跨章出现时，取出现频次最高、且最正式（"姓+名"优先于"绰号"）的 `name` 作为主名称。
2. **别名合并**：其余章出现过的 `name` 与所有 `aliases` 一并并入 `aliases`，去重，且**不含主名称本身**。
3. **字段合并**：`gender`、`age`、`identity`、`appearance` 取各章非空值合并去重；多个不同值用 `；` 连接，并保留各自来源。
4. `first_chapter` = 最小章号；`chapters` = 出现过的章号升序去重。
5. `confidence` = 各章置信度的**最高值**；若同一字段存在互相冲突的值，该字段标 `[不确定]`，并把条目 `confidence` 降为 `低`。
6. **无法判定是否同一人时**（同名但身份/关系明显冲突）→ **不合并**，各建一张卡，在卡片里注明区分依据。

## 2. 关系冲突

- 保留**多个来源**，不要只留一条。
- 同一 `target` + `type` 多次出现 → 合并为一条，`sources` 列出全部章号与引用。
- 同一 `target` 出现**不同** `type` → 按 `confidence` 从高到低排序（`高 > 中 > 低`），confidence 相同时按章号升序；全部保留。
- 方向冲突（A 记"师徒"、B 记"仇敌"）→ 两条都保留，各自标注来源章节，**不做仲裁**。
- `target` 指向的姓名若在本卡主名称或别名集合中不存在，也要保留，并在卡片"关系"表中注明 `[未成卡]`。

## 3. 衣物卡

- 归并键：`character` + `scene`。
- 同一"角色+场景"在汇总后出现**多套**衣物（来自不同章或同章多条）→ **加序号**区分：`场景名（一）`、`场景名（二）`……序号按章号升序分配。
- 合并后 `description` 与 `color_material` 用 `；` 连接去重。
- 每套衣物卡保留 `source: { chapter, quote }`；多人/多章来源时，`sources` 数组保留全部。
- `confidence` 规则同角色：取最高；冲突则降级。

## 4. 物品卡

- 归并键：`name`（同名合并）。
- 合并 `holder`：多值去重，用 `；` 连接；空值不写入。
- 合并 `chapters`：全部出现章号升序去重。
- 合并 `sources`：**每章一条** `{ chapter, quote }`；同章多条时取信息量最大的一条（含 `function` 或 `holder` 者优先）。
- `type` 冲突时取多数值，少数值记入 `appearance` 末尾并标 `[不确定]`。
- 同名但明显是两件不同物品（如"两把不同的剑"且各有专名）→ 不合并，`name` 后加区分后缀并注明依据。

## 5. 溯源（硬要求）

- **所有合并结果都必须保留 `sources`**。没有 `sources` 的合并结果视为无效。
- `sources` 每项形如 `{ "chapter": <int>, "quote": "<来自该章 JSON 的原文引用>" }`。
- `quote` **原样搬运**，不得改写、不得拼接跨章内容、不得从原文重新摘录（汇总阶段无原文可读）。
- 合并过程中丢弃任何一条来源引用都不允许；确需裁剪时保留最早与最新各一条，并保证 `chapters` 与 `sources` 的章号集合仍一致。

## 6. ID 与文件名

- ID 形如 `char_0001`、`cloth_0001`、`item_0001`，四位补零，从 1 开始。
- **分配顺序必须确定**：先按 `first_chapter` 升序，再按主名称的 Unicode 码位升序。同一输入必须产出同一套 ID，便于增量重跑。
- 卡片文件名用主名称（或物品名）+ `.md`；替换 Windows 非法字符 `\ / : * ? " < > |` 为 `_`，去掉首尾空格与点号。
- 文件名冲突时追加 `_2`、`_3`。
- `_index.json` 中的 `file` 字段写**相对工作区根目录的路径**；缺省 `cards_dir` 时即为 `cards/characters/角色名.md`。`cards_dir` 被 `@` 覆盖时，用覆盖后的相对路径（如 `mycards/characters/角色名.md`）。

## 7. `_index.json`

```json
{
  "characters": [
    { "id": "char_0001", "name": "角色名", "file": "cards/characters/角色名.md", "chapters": [0] }
  ],
  "clothing": [],
  "items": []
}
```

`clothing` / `items` 条目同构：`{ "id", "name"|"character", "file", "chapters" }`（衣物条目另含 `character` 与 `scene`）。

## 8. `_index.md`

人可读索引，三张表：

```markdown
# 卡片索引

共 3 张人物卡、2 张衣物卡、4 张物品卡。

## 人物卡
| ID | 名称 | 身份 | 出场章节 | 文件 |
|---|---|---|---|---|
| char_0001 | 角色名 | 身份 | 0, 2 | [角色名](characters/角色名.md) |

## 衣物卡
| ID | 角色 | 场景 | 章节 | 文件 |

## 物品卡
| ID | 名称 | 类型 | 持有者 | 章节 | 文件 |
```

## 9. 汇总自检清单

- [ ] 没有读取任何 `.txt`。
- [ ] 每张卡都有 `sources`，且 `quote` 与逐章 JSON 完全一致。
- [ ] `chapters` 与 `sources` 的章号集合一致。
- [ ] ID 分配符合第 6 节的确定性顺序。
- [ ] `_index.json` 覆盖全部卡片文件，路径为相对路径。
- [ ] 卡片 frontmatter 字段与 `templates/*.md` 模板一致。
