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
  characters/角色名.md
  clothing/角色名-场景.md
  items/物品名.md
```

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
- `backup_failed`：**仅当版本备份失败时出现**，由 `backup_output.ts` 写入（原因 + 时间），字段出现即表示本轮备份没成功但主流程继续。

## 4. 逐章 JSON（`ch{index:03d}.json`）

### 4.1 完整样例

```json
{
  "chapter_index": 0,
  "chapter_title": "卷首",
  "source_file": "000_卷首.txt",
  "characters": [
    {
      "name": "李寻欢",
      "aliases": ["小李探花", "李探花"],
      "gender": "男",
      "age": "三十上下",
      "identity": "探花郎，后为游侠",
      "appearance": "身形瘦削，面色苍白，常带倦意",
      "relations": [
        { "target": "阿飞", "type": "结义兄弟", "quote": "两人自此结为兄弟。" }
      ],
      "confidence": "高",
      "sources": [
        { "chapter": 0, "quote": "李寻欢缓步走入客栈，众人皆识得这位小李探花。" }
      ]
    }
  ],
  "clothing": [
    {
      "character": "李寻欢",
      "scene": "初登场",
      "description": "青布长衫，外罩一件旧氅",
      "color_material": "青布；旧氅为灰色粗毛",
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

**扩展字段**（超出最小规范，用于溯源，建议尽量填写）：

| 字段 | 位置 | 说明 |
|---|---|---|
| `characters[].sources` | 角色 | `[{chapter, quote}]`，人物卡"原文依据"的数据源 |
| `characters[].relations[].quote` | 关系 | 人物卡"关系-依据"列的数据源 |

衣物与物品的 `quote` 是规范必填字段，无需扩展。

## 5. 人物卡（`@cards_dir/characters/角色名.md`）

```markdown
---
id: char_0001
name: "李寻欢"
aliases: ["小李探花", "李探花"]
gender: "男"
age: "三十上下"
identity: "探花郎，后为游侠"
appearance: "身形瘦削，面色苍白，常带倦意"
relations:
  - target: "阿飞"
    type: "结义兄弟"
first_chapter: 0
chapters: [0, 2]
confidence: 高
sources:
  - chapter: 0
    quote: "李寻欢缓步走入客栈，众人皆识得这位小李探花。"
  - chapter: 2
    quote: "李寻欢道：你来了。"
---
# 李寻欢

## 基本信息
- 别名：小李探花、李探花
- 性别：男
- 年龄：三十上下
- 身份：探花郎，后为游侠
- 外貌：身形瘦削，面色苍白，常带倦意

## 关系
| 对象 | 关系 | 依据 |
|---|---|---|
| 阿飞 | 结义兄弟 | 第 0 章：两人自此结为兄弟。 |

## 出场章节
- 第 0 章《卷首》
- 第 2 章《风满楼》

## 原文依据
> 第 0 章：李寻欢缓步走入客栈，众人皆识得这位小李探花。
> 第 2 章：李寻欢道：你来了。
```

## 6. 衣物卡（`@cards_dir/clothing/角色名-场景.md`）

```markdown
---
id: cloth_0001
character: "李寻欢"
scene: "初登场"
description: "青布长衫，外罩一件旧氅"
color_material: "青布；旧氅为灰色粗毛"
chapter: 0
confidence: 高
source:
  chapter: 0
  quote: "他身上只一件洗得发白的青布长衫，外面罩着件旧氅。"
---
# 李寻欢 - 初登场

## 描述
青布长衫，外罩一件旧氅

## 颜色/材质
青布；旧氅为灰色粗毛

## 原文依据
> 第 0 章：他身上只一件洗得发白的青布长衫，外面罩着件旧氅。
```

同一"角色+场景"有多套时，标题与 `scene` 加序号：`初登场（一）`、`初登场（二）`，并把 `source` 换成保留全部来源的 `sources` 数组。

## 7. 物品卡（`@cards_dir/items/物品名.md`）

```markdown
---
id: item_0001
name: "小李飞刀"
type: "武器"
appearance: "薄如蝉翼，长三寸七分"
function: "例不虚发的暗器"
holder: "李寻欢"
chapters: [0, 2]
confidence: 高
sources:
  - chapter: 0
    quote: "他袖中那柄长三寸七分的飞刀，薄得几乎透明。"
  - chapter: 2
    quote: "飞刀出手，例不虚发。"
---
# 小李飞刀

## 类型
武器

## 外观
薄如蝉翼，长三寸七分

## 功能
例不虚发的暗器

## 持有者
李寻欢

## 出场章节
- 第 0 章《卷首》
- 第 2 章《风满楼》

## 原文依据
> 第 0 章：他袖中那柄长三寸七分的飞刀，薄得几乎透明。
> 第 2 章：飞刀出手，例不虚发。
```

## 8. `@cards_dir/_index.json`

```json
{
  "characters": [
    { "id": "char_0001", "name": "李寻欢", "file": "cards/characters/李寻欢.md", "chapters": [0, 2] }
  ],
  "clothing": [
    { "id": "cloth_0001", "character": "李寻欢", "scene": "初登场", "name": "李寻欢 - 初登场", "file": "cards/clothing/李寻欢-初登场.md", "chapters": [0] }
  ],
  "items": [
    { "id": "item_0001", "name": "小李飞刀", "file": "cards/items/小李飞刀.md", "chapters": [0, 2] }
  ]
}
```

## 9. `@cards_dir/_index.md`

```markdown
# 卡片索引

共 1 张人物卡、1 张衣物卡、1 张物品卡。

## 人物卡
| ID | 名称 | 身份 | 出场章节 | 文件 |
|---|---|---|---|---|
| char_0001 | 李寻欢 | 探花郎，后为游侠 | 0, 2 | [李寻欢](characters/李寻欢.md) |

## 衣物卡
| ID | 角色 | 场景 | 章节 | 文件 |
|---|---|---|---|---|
| cloth_0001 | 李寻欢 | 初登场 | 0 | [李寻欢-初登场](clothing/李寻欢-初登场.md) |

## 物品卡
| ID | 名称 | 类型 | 持有者 | 章节 | 文件 |
|---|---|---|---|---|---|
| item_0001 | 小李飞刀 | 武器 | 李寻欢 | 0, 2 | [小李飞刀](items/小李飞刀.md) |
```

## 10. `@extracted_dir/_index.json`（汇总索引）

逐章结果的机器可读索引，由汇总阶段生成：

```json
{
  "source_dir": "E:\\Workspaces\\角色提取 Agent 开发\\chapters",
  "cards_dir": "E:\\Workspaces\\角色提取 Agent 开发\\cards",
  "chapter_count": 3,
  "processed": [0, 1, 2],
  "failed": [],
  "counts": { "characters": 12, "clothing": 5, "items": 9 },
  "cards": {
    "characters": ["cards/characters/李寻欢.md"],
    "clothing": ["cards/clothing/李寻欢-初登场.md"],
    "items": ["cards/items/小李飞刀.md"]
  }
}
```

## 11. `history/` 版本备份

每次运行都会覆盖输出，因此覆盖前由 `backup_output.ts` 判断是否备份。**只有两次运行落在同一个输出目录**时，才把上一次输出复制成 `history/V{n}/`。

```text
<workspace>/
  chapters/                # 输入
  extracted/               # 当前输出（逐章 JSON）
  cards/                   # 当前输出（汇总卡片）
  history/
    _index.json            # 版本清单 + 上次输出目录记录
    V1/
      extracted/           # 备份的 _meta.json / _progress.json / _index.json / _errors.json / ch*.json
      cards/               # 备份的 characters/ clothing/ items/ _index.json _index.md
      _manifest.json
    V2/
      ...
```

`history/` 位置规则：默认取 `@extracted_dir` 的父目录；`@extracted_dir` 与 `@cards_dir` 不同父时取两者最近的公共父目录；可用 `--history` 显式覆盖。`history/` **永远不会**被备份进自身。

### 11.1 `history/V{n}/_manifest.json`

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

### 11.2 `history/_index.json`

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

### 11.3 `backup_output.ts` 的决策 JSON

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

