# 输出格式

本文件给出全部产出的**权威样例**。Agent 生成时以此为准；机器校验见 `schemas/*.schema.json`。

## 1. 目录布局

```text
@extracted_dir/
  _meta.json          章节清单
  _progress.json      处理进度
  _index.json         汇总索引
  ch000.json          逐章提取结果（每章一个）
  ch001.json
  ...
@cards_dir/
  _index.json
  _index.md
  characters/
    _index.json                       角色与阶段索引（等价于 _index.json 的 characters 段）
    卢云/
      index.md                        实体卡（跨阶段稳定信息）
      phase_01_卖面时期.md             阶段卡
      phase_02_书僮时期.md
      ...
    伍定远/
      index.md
      phase_01_...
  clothing/角色名-场景.md              含 character_id / phase_id
  items/物品名.md                      含 character_id / phase_id
```

**一人一目录**：实体卡永远叫 `index.md`，阶段卡固定 `phase_XX_<标签>.md`。

## 2. `_meta.json`

```json
{
  "source_dir": "E:\\Workspaces\\角色提取 Agent 开发\\chapters",
  "chapter_count": 3,
  "chapters": [
    { "index": 0, "file": "000_卷首.txt", "volume": "", "chapter": "卷首", "title": "卷首", "full_title": "卷首" },
    { "index": 1, "file": "001_楔子_一.txt", "volume": "", "chapter": "楔子", "title": "一", "full_title": "楔子_一" },
    { "index": 102, "file": "102_第十一卷_重建怒苍_第七章_我自横刀向天笑.txt", "volume": "第十一卷", "chapter": "第七章", "title": "我自横刀向天笑", "full_title": "第十一卷_重建怒苍_第七章_我自横刀向天笑" }
  ]
}
```

## 3. `_progress.json`

```json
{
  "total": 3,
  "done": 2,
  "current": 2,
  "failed": [
    { "index": 1, "file": "001_楔子_一.txt", "error": "模型返回非法 JSON", "at": "2026-01-01T00:00:00Z" }
  ],
  "updated_at": "2026-01-01T00:00:00Z",
  "backup_failed": {
    "at": "2026-01-01T00:00:00Z",
    "error": "EEXIST: file already exists, mkdir '...\\history\\V1'"
  }
}
```

- `current`：正在处理的章号；空闲时 `null`。
- `done`：已完成章数（= 存在的有效 `ch*.json` 数）。
- `failed`：失败章列表，元素含 `index`、`file`、`error`；**失败不阻塞后续章节**。
- `updated_at`：ISO 8601 UTC 时间戳。
- `backup_failed`：**仅当版本备份失败时出现**，由 `backup_output.ts` 写入。

## 4. 逐章 JSON（`ch{index:03d}.json`）

### 4.1 完整样例

```json
{
  "chapter_index": 10,
  "chapter_title": "落第秀才",
  "source_file": "010_第一卷_西凉风暴_第一章_落第秀才.txt",
  "characters": [
    {
      "name": "卢云",
      "aliases": ["小二", "那小二", "穷酸", "酸秀才"],
      "gender": "男",
      "age": "二十七八岁",
      "identity": "落第秀才，客来轩跑堂",
      "appearance": "相貌堂堂，谈吐文雅；眉清目秀",
      "relations": [
        { "target": "牛二", "type": "仇敌", "quote": "牛二嘿嘿狞笑，伸手捏住那小二的脸颊" }
      ],
      "phase_hint": "卖面时期",
      "confidence": "高",
      "sources": [
        { "chapter": 10, "quote": "只见那人是个年青男子，约莫二十七八岁，长身玉立" }
      ]
    }
  ],
  "clothing": [
    {
      "character": "卢云",
      "scene": "初登场",
      "description": "青布长衫，外罩一件旧氅",
      "color_material": "青布；旧氅为灰色粗毛",
      "phase_hint": "卖面时期",
      "quote": "他身上只一件洗得发白的青布长衫，外面罩着件旧氅。"
    }
  ],
  "items": [
    {
      "name": "小李飞刀",
      "type": "武器",
      "appearance": "薄如蝉翼，长三寸七分",
      "function": "例不虚发的暗器",
      "holder": "李寻欢",
      "phase_hint": "",
      "quote": "他袖中那柄长三寸七分的飞刀，薄得几乎透明。"
    }
  ]
}
```

### 4.2 空章样例

```json
{
  "chapter_index": 3,
  "chapter_title": "空章",
  "source_file": "003_空章.txt",
  "characters": [],
  "clothing": [],
  "items": []
}
```

### 4.3 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `chapter_index` | 是 | 整数，等于文件名数字前缀 |
| `chapter_title` | 是 | 取自 `_meta.json` 的 `title`（必要时用 `full_title`） |
| `source_file` | 是 | 章节 txt 文件名（不含路径） |
| `characters[]` | 是 | 数组，可为空 |
| `clothing[]` | 是 | 数组，可为空 |
| `items[]` | 是 | 数组，可为空 |

**逐章角色的全部字段都是「本章值」**，不做跨章并集；`phase_hint` 只是阶段提示，
逐章阶段**不做阶段切分**。

**扩展字段**（超出最小规范，用于溯源与阶段切分，建议尽量填写）：

| 字段 | 位置 | 说明 |
|---|---|---|
| `characters[].phase_hint` | 角色 | 2–8 字时期短语，如 `卖面时期`；同一时期必须逐字一致 |
| `characters[].sources` | 角色 | `[{chapter, quote}]`，实体卡 / 阶段卡「原文依据」的数据源 |
| `characters[].relations[].quote` | 关系 | 卡片「关系-依据」列的数据源 |
| `clothing[].phase_hint` / `items[].phase_hint` | 衣物 / 物品 | 与同章该角色一致，便于把衣物、物品挂到阶段 |

衣物与物品的 `quote` 是规范必填字段，无需扩展。

## 5. 实体卡（`@cards_dir/characters/卢云/index.md`）

只含跨阶段稳定的身份锚点。**没有** `age` / `identity` / `appearance` 字段，也没有别名的并集
（下面是真实产出的节选）：

```markdown
---
id: char_0001
name: "卢云"
aliases: ["卢兄弟", "卢参谋", "卢公子", "小兄弟", "小贼", "阿云", "云儿", "兔儿爷", "卢某"]
gender: "男"
stable_traits:
  base_appearance: "相貌堂堂，谈吐文雅；眉清目秀"
  base_identity: "落第秀才，客来轩跑堂（小二）"
  permanent_features: "相貌堂堂，谈吐文雅；眉清目秀"
relations_graph:
  - target: "顾嗣源"
    type: "主仆"
    chapters: [13, 14, 15, 16, 17]
  - target: "顾倩兮"
    type: "恋慕"
    chapters: [16, 17, 18, 23, 24, 42]
  - target: "秦仲海"
    type: "上下级"
    chapters: [35, 38, 40, 42, 45]
first_chapter: 11
chapters: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 35, 36, 37, 38, 40, 42, 43, 44, 45]
confidence: 高
phases:
  - phase_id: phase_01
    label: "落第秀才"
    file: "phase_01_落第秀才.md"
    chapters: [11, 12, 13, 14, 15]
  - phase_id: phase_02
    label: "书僮时期"
    file: "phase_02_书僮时期.md"
    chapters: [16, 17]
  - phase_id: phase_03
    label: "卖面时期"
    file: "phase_03_卖面时期.md"
    chapters: [18, 19, 20, 21, 22, 23, 24, 25, 35, 36, 37, 38, 40, 42, 43]
  - phase_id: phase_04
    label: "军中参谋"
    file: "phase_04_军中参谋.md"
    chapters: [44, 45]
sources:
  - chapter: 13
    quote: "那丫鬟见卢云衣着虽然破烂，但长身玉立，剑眉星目，举止间更是器宇轩昂"
  - chapter: 14
    quote: "卢云不愿做个白食的客人，仍坚持做顾嗣源的书僮"
---
# 卢云

## 稳定身份
- 姓名：卢云
- 别名：卢兄弟、卢参谋、卢公子、小兄弟、小贼、阿云、云儿、兔儿爷、卢某
- 性别：男
- 基线外貌：相貌堂堂，谈吐文雅；眉清目秀
- 基线身份：落第秀才，客来轩跑堂（小二）
- 永久特征：相貌堂堂，谈吐文雅；眉清目秀
- 出场章节：第11-25章、第35-38章、第40章、第42-45章
- 置信度：高

## 稳定关系
| 对象 | 关系 | 依据 |
|---|---|---|
| 顾嗣源 | 主仆 | 第13-17章：卢云做的是贱役，从未进过主宅 |
| 顾倩兮 | 恋慕 | 第16-18章、第23-24章、第42章：他看着窗外，想着顾倩兮的一举一动 |
| 秦仲海 | 上下级 | 第35章、第38章、第40章、第42章、第45章：所谓军法如山……我身为参谋，又岂会坏了秦将军的规矩 |

## 阶段索引
- phase_01 落第秀才：第11-15章 → [phase_01_落第秀才.md](phase_01_落第秀才.md)
- phase_02 书僮时期：第16-17章 → [phase_02_书僮时期.md](phase_02_书僮时期.md)
- phase_03 卖面时期：第18-25章、第35-38章、第40章、第42-43章 → [phase_03_卖面时期.md](phase_03_卖面时期.md)
- phase_04 军中参谋：第44-45章 → [phase_04_军中参谋.md](phase_04_军中参谋.md)

## 出场章节
- 第11章《落第秀才》
- 第12章《为天地立心》
…

## 原文依据
> 第13章：那丫鬟见卢云衣着虽然破烂，但长身玉立，剑眉星目，举止间更是器宇轩昂
> 第14章：卢云不愿做个白食的客人，仍坚持做顾嗣源的书僮

## 下游使用（生图 / 检索）
组合方式：**实体卡（本文件）+ 目标阶段卡**，不要使用实体卡字段的并集。
- 第11-15章 → `phase_01_落第秀才.md`
- 第16-17章 → `phase_02_书僮时期.md`
- 第18-43章 → `phase_03_卖面时期.md`
- 第44-45章 → `phase_04_军中参谋.md`
```

## 6. 阶段卡（`@cards_dir/characters/卢云/phase_04_军中参谋.md`）

只描述该章节范围内能**同时成立**的状态；`forbidden_names` 与 `allowed_names` 无交集：

```markdown
---
phase_id: phase_04
character_id: char_0001
character_name: "卢云"
label: "军中参谋"
chapters: [44, 45]
age: "年少"
identity: "公主随从，军中参谋"
appearance: "长方脸蛋，挺挺的鼻梁；面目英挺，气质儒雅"
clothing_refs:
  - "cards/clothing/卢云-山坳送别.md"
  - "cards/clothing/卢云-抱公主跳下燃烧的高台.md"
item_refs:
  []
relations:
  []
allowed_names: ["卢云", "卢某", "卢兄弟", "卢参谋", "卢郎", "参谋"]
forbidden_names: ["卖面郎", "店小二", "小二", "穷酸", "酸秀才", "阿云", "云儿", "面贩", "白面书生"]
confidence: 高
sources:
  - chapter: 44
    quote: "果见眼前这人长方脸蛋，挺挺的鼻梁，不是那跳崖身死的卢参谋"
  - chapter: 45
    quote: "臣不辞艰难，屡次舍身相救，绝不是贪图什么封赏，只求公主这一生都能平安喜乐！"
---
# 卢云 - 军中参谋

## 阶段范围
- 第44章《可汗大点兵》至第45章《劝君更尽一杯酒》
- 覆盖章号：44, 45
- 切分依据：phase_hint: 卖面时期 → 军中参谋

## 年龄
年少

## 身份
公主随从，军中参谋

> 阶段内取值并存（汇总时保留）：公主随从，军中参谋；中国军中参谋，公主口中的中国将军

## 外貌
长方脸蛋，挺挺的鼻梁；面目英挺，气质儒雅

## 着装
- 裤、鞋袜（跳下时被火烧著）
- 身上的皮裘，解下欲为公主披上

- 衣物卡：`cards/clothing/卢云-山坳送别.md`
- 衣物卡：`cards/clothing/卢云-抱公主跳下燃烧的高台.md`

## 阶段关系
| 对象 | 关系 | 依据 |
|---|---|---|
| （无） |  |  |

## 本阶段允许称呼
卢云、卢某、卢兄弟、卢参谋、卢郎、参谋

## 本阶段禁止称呼
卖面郎、店小二、小二、穷酸、酸秀才、阿云、云儿、面贩、白面书生

## 置信度
高

## 原文依据
> 第44章：果见眼前这人长方脸蛋，挺挺的鼻梁，不是那跳崖身死的卢参谋
> 第45章：臣不辞艰难，屡次舍身相救，绝不是贪图什么封赏，只求公主这一生都能平安喜乐！
```

**取值并存说明**：同一阶段内某字段确有多个取值时，正文追加一行
`> 阶段内取值并存（汇总时保留）：<值1>；<值2>`，frontmatter 取首现值。

**`[短暂]` 标记**：某阶段只有 1 章且变化明显时，会并入相邻阶段并在标题后标 `[短暂]`，
正文的「切分依据」里也会出现 `[短暂]`。

## 7. 衣物卡（`@cards_dir/clothing/角色名-场景.md`）

`character_id` / `phase_id` 把衣物挂到具体阶段：

```markdown
---
id: cloth_0001
character: "卢云"
character_id: "char_0001"
phase_id: phase_01
scene: "客来轩跑堂"
description: "青色短褐，油布围裙"
color_material: "粗布"
chapters: [11]
chapter: 11
confidence: 高
sources:
  - chapter: 11
    quote: "只见一个小二打扮的青年，端着两个烫碗，从后厨里赶将出来"
---
# 卢云 - 客来轩跑堂

## 描述
青色短褐，油布围裙

## 颜色/材质
粗布

## 所属阶段
- 角色：卢云（char_0001）
- 阶段：phase_01
- 章节：第11章

## 出场章节
- 第11章《落第秀才》

## 原文依据
> 第11章：只见一个小二打扮的青年，端着两个烫碗，从后厨里赶将出来
```

同一"角色+场景"有多套衣物时，`scene` 与标题加序号：`初登场（一）`、`初登场（二）`，
序号按章号升序分配。多章来源时 `chapters` 升序去重、`sources` 每章一条。

## 8. 物品卡（`@cards_dir/items/物品名.md`）

```markdown
---
id: item_0094
name: "郾月大刀"
type: "武器"
appearance: "长刀，刀身厚重"
function: "临阵兵器"
holder: "卢云"
character_id: "char_0001"
phase_id: phase_03
chapters: [38, 43]
confidence: 高
sources:
  - chapter: 38
    quote: "卢云披上胄甲，挂起腰刀，脚跨雪泥宝马，手提郾月大刀"
  - chapter: 43
    quote: "郾月大刀挥出，势不可当"
---
# 郾月大刀

## 类型
武器

## 外观
长刀，刀身厚重

## 功能
临阵兵器

## 持有者
卢云

## 所属阶段
- 角色：卢云（char_0001）
- 阶段：phase_03
- 章节：第38章、第43章

## 出场章节
- 第38章《天朝国威》
- 第43章《大难不死》

## 原文依据
> 第38章：卢云披上胄甲，挂起腰刀，脚跨雪泥宝马，手提郾月大刀
> 第43章：郾月大刀挥出，势不可当
```

无主、或持有者没有阶段时，`character_id` / `phase_id` 写空串（`phase_id: ` 后不跟值）。

## 9. 索引（`cards/characters/_index.json` 与 `cards/_index.json`）

`@cards_dir/characters/_index.json`（机器校验见 `schemas/characters-index.schema.json`）：

```json
{
  "characters": [
    {
      "id": "char_0001",
      "name": "卢云",
      "dir": "cards/characters/卢云",
      "entity_file": "cards/characters/卢云/index.md",
      "chapters": [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 35, 36, 37, 38, 40, 42, 43, 44, 45],
      "phases": [
        {
          "phase_id": "phase_01",
          "label": "落第秀才",
          "file": "cards/characters/卢云/phase_01_落第秀才.md",
          "chapters": [11, 12, 13, 14, 15]
        },
        {
          "phase_id": "phase_02",
          "label": "书僮时期",
          "file": "cards/characters/卢云/phase_02_书僮时期.md",
          "chapters": [16, 17]
        }
      ]
    }
  ]
}
```

`@cards_dir/_index.json`（机器校验见 `schemas/cards-index.schema.json`）复用同一份 `characters` 段，
并追加 `clothing` / `items`：

```json
{
  "characters": [ "…同上…" ],
  "clothing": [
    {
      "id": "cloth_0001",
      "character": "卢云",
      "character_id": "char_0001",
      "phase_id": "phase_01",
      "scene": "客来轩跑堂",
      "name": "卢云 - 客来轩跑堂",
      "file": "cards/clothing/卢云-客来轩跑堂.md",
      "chapters": [11]
    }
  ],
  "items": [
    {
      "id": "item_0094",
      "name": "郾月大刀",
      "type": "武器",
      "holder": "卢云",
      "character_id": "char_0001",
      "phase_id": "phase_03",
      "file": "cards/items/郾月大刀.md",
      "chapters": [38, 43]
    }
  ]
}
```

## 10. `@cards_dir/_index.md`

```markdown
# 卡片索引

共 1 个角色实体、2 张阶段卡、1 张衣物卡、1 张物品卡。

生图 / 下游使用：取「实体卡 + 目标阶段卡」，不要使用实体卡字段的并集。

## 角色实体卡
| ID | 姓名 | 基线身份 | 出场章节 | 阶段数 | 实体卡 |
|---|---|---|---|---|---|
| char_0041 | 卢云 | 落第秀才 | 10, 11, … | 2 | [卢云](characters/卢云/index.md) |

## 阶段卡
| 角色 | 阶段 | 标签 | 章节 | 时变关系 | 文件 |
|---|---|---|---|---|---|
| 卢云 | phase_01 | 卖面时期 | 10, 11 | 牛二(仇敌) | [phase_01_卖面时期.md](characters/卢云/phase_01_卖面时期.md) |

## 衣物卡
| ID | 角色 | 阶段 | 场景 | 章节 | 文件 |

## 物品卡
| ID | 名称 | 类型 | 持有者 | 阶段 | 章节 | 文件 |
```

## 11. `@extracted_dir/_index.json`（汇总索引）

```json
{
  "source_dir": "E:\\Workspaces\\角色提取 Agent 开发\\chapters",
  "cards_dir": "E:\\Workspaces\\角色提取 Agent 开发\\cards",
  "chapter_count": 43,
  "processed": [3, 4, 5],
  "failed": [],
  "counts": { "characters": 141, "phases": 160, "clothing": 134, "items": 234 },
  "cards": {
    "characters": ["cards/characters/伍定远/index.md"],
    "character_phases": ["cards/characters/伍定远/phase_01_西凉城的衙门捕头.md"],
    "clothing": ["cards/clothing/伍定远-初登场.md"],
    "items": ["cards/items/飞天银梭.md"]
  }
}
```

## 12. `history/` 版本备份

每次运行都会覆盖输出，因此覆盖前由 `backup_output.ts` 判断是否备份。**只有两次运行落在同一个输出目录**时，才把上一次输出复制成 `history/V{n}/`。

```text
<workspace>/
  chapters/                # 输入
  extracted/               # 当前输出（逐章 JSON）
  cards/                   # 当前输出（实体卡 / 阶段卡 / 衣物卡 / 物品卡）
  history/
    _index.json            # 版本清单 + 上次输出目录记录
    V1/
      extracted/           # 备份的 _meta.json / _progress.json / _index.json / _errors.json / ch*.json
      cards/               # 备份的 characters/（一人一目录） clothing/ items/ _index.json _index.md
      _manifest.json
    V2/
      ...
```

`history/` 位置规则：默认取 `@extracted_dir` 的父目录；`@extracted_dir` 与 `@cards_dir` 不同父时取两者最近的公共父目录；可用 `--history` 显式覆盖。`history/` **永远不会**被备份进自身。

### 12.1 `history/V{n}/_manifest.json`

```json
{
  "version": "V1",
  "created_at": "2026-01-01T00:00:00Z",
  "source_chapters": "E:\\Workspaces\\角色提取 Agent 开发\\chapters",
  "extracted_dir": "E:\\Workspaces\\角色提取 Agent 开发\\extracted",
  "cards_dir": "E:\\Workspaces\\角色提取 Agent 开发\\cards",
  "chapter_count": 2,
  "character_count": 12,
  "clothing_count": 11,
  "item_count": 21,
  "note": "备份自上一次运行输出"
}
```

`note` 在回滚前自动快照时写为 `回滚前自动快照`。计数优先取自备份内的 `_meta.json`（章节数）与 `cards/_index.json`（卡片数）。

### 12.2 `history/_index.json`

```json
{
  "last_output": {
    "extracted_dir": "E:\\Workspaces\\角色提取 Agent 开发\\extracted",
    "cards_dir": "E:\\Workspaces\\角色提取 Agent 开发\\cards",
    "updated_at": "2026-01-02T00:00:00Z"
  },
  "versions": [
    {
      "version": "V1",
      "created_at": "2026-01-01T00:00:00Z",
      "path": "history/V1",
      "chapter_count": 2,
      "character_count": 12,
      "clothing_count": 11,
      "item_count": 21
    }
  ],
  "latest": "V1"
}
```

- `last_output` 用**规范化绝对路径**，用于判断"两次运行是否同一个输出目录"。Windows 下比较时忽略大小写。
- `versions[].path` 用**相对 `history/` 父目录**的路径并统一 `/` 分隔。
- 版本号只增不减：已删除的编号不会被复用；`latest` 按实际最大号重算。

### 12.3 `backup_output.ts` 的决策 JSON

```json
{
  "backup_performed": true,
  "version": "V2",
  "reason": "same_output_dir",
  "history_dir": "E:\\Workspaces\\角色提取 Agent 开发\\history",
  "current_extracted": "E:\\Workspaces\\角色提取 Agent 开发\\extracted",
  "current_cards": "E:\\Workspaces\\角色提取 Agent 开发\\cards",
  "manifest": "E:\\Workspaces\\角色提取 Agent 开发\\history\\V2\\_manifest.json",
  "counts": { "chapter_count": 2, "character_count": 12, "clothing_count": 11, "item_count": 21 }
}
```

未备份时：

```json
{
  "backup_performed": false,
  "version": null,
  "reason": "output_dir_changed",
  "history_dir": "E:\\Workspaces\\角色提取 Agent 开发\\history",
  "current_extracted": "E:\\Workspaces\\角色提取 Agent 开发\\extracted2",
  "current_cards": "E:\\Workspaces\\角色提取 Agent 开发\\cards2",
  "previous_extracted": "E:\\Workspaces\\角色提取 Agent 开发\\extracted",
  "previous_cards": "E:\\Workspaces\\角色提取 Agent 开发\\cards"
}
```

`reason` 取值：`same_output_dir`（已备份）、`first_run`、`output_dir_changed`、`empty_output`、`history_inside_output`、`backup_error`（失败但不阻塞，原因同时写入 `_progress.json` 的 `backup_failed`）。
