# character-extraction（DSH Skill）

从已分章的中文小说 txt 目录中**逐章**提取**角色 / 衣物 / 物品**，产出逐章 JSON，再汇总为 Markdown 卡片。

- 命令：`/character-extraction @<chapters_dir> @<extracted_dir> @<cards_dir>`
- 缺省：`/character-extraction` ≡ `/character-extraction @chapters @extracted @cards`
- 处理方式：**顺序同步**逐章，每章处理完**立即落盘**，不在上下文中累积原文或提取结果。

## 目录结构

```text
.dsh/
  skills/character-extraction/
    SKILL.md                     # 入口：命令用法、核心提取提示词、循环控制提示词
    references/
      character-rules.md         # 人物判定、别名、关系方向、同名不同人、置信度
      clothing-rules.md          # 「角色+场景」衣物提取、quote 硬要求
      item-rules.md              # 物品类别、字段、汇总期合并
      output-format.md           # 全部产出的权威样例
      aggregation-rules.md       # 合并/去重/溯源规则
      loop-control.md            # 主 Agent 循环细则、上下文预算、恢复与降级
    schemas/                     # 4 个 JSON Schema（可机器校验）
    templates/                   # 人物卡 / 衣物卡 / 物品卡模板
    scripts/                     # TypeScript 辅助脚本（无第三方依赖）
      types.ts                   # Meta / Chapter / ValidationResult / ValidationError 等
      util.ts                    # BOM、码位计数、排序等小工具
      schema-validator.ts        # 内置 JSON Schema 子集校验器
      scan_chapters.ts           # 扫描章节 → _meta.json
      validate_extraction.ts     # 校验 ch*.json + 回查 quote 原文
      scan_chapters.test.ts      # 自测（node:test）
      validate_extraction.test.ts
  agents/
    chapter-extractor.md         # 单章提取子代理工作说明
    character-aggregator.md      # 汇总子代理工作说明
package.json                     # type: module + scripts（test / scan / validate）
tsconfig.json                    # 可选类型检查配置
chapters/                        # 默认输入目录（可由第一个 @ 覆盖）
extracted/                       # 默认逐章输出目录（第二个 @）
cards/                           # 默认卡片输出目录（第三个 @）
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

1. **准备**：解析 `@` 参数 → 校验输入目录 → 创建输出目录 → 生成/读取 `_meta.json` → 初始化 `_progress.json`。
2. **逐章循环**（`index` 升序）：每章把「读原文 → 提取 → 校验 → 写 `ch{index:03d}.json` → 更新 `_progress.json`」整体交给一个**单章子代理**（同步等待）。主 Agent 每章只保留一行状态。
3. **汇总**：交给汇总子代理，**只读** `extracted/*.json`，产出卡片与索引。
4. **收尾**：进度对账 + 可选校验 + 一行摘要汇报。

失败不阻塞：该章记入 `_progress.json` 的 `failed`，继续下一章。

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
```

也可通过 npm scripts：`npm run scan:chapters` / `npm run validate:extraction`（需自行追加参数）。

- `scan_chapters.ts`：支持规范命名 `000_卷首.txt`（含 `第X卷`/`第X章/回/节` 拆解），也兼容 `ch0001.txt` 这类命名——非规范命名会从同目录 novel-split 风格的 `_meta.json` 回填标题，诊断写 stderr，输出严格保持规范形状。空目录不报错，写出 `chapter_count: 0` 的清单并给出告警。
- `validate_extraction.ts`：校验 `schemas/*.schema.json`、`chapter_index` 与文件名一致性、`quote` 能否在对应章节原文中逐字找到（忽略空白差异，UTF-8 / UTF-8 BOM / GB18030 均可读）、覆盖率缺失章；退出码 `0` 无错误 / `1` 有错误 / `2` 用法或环境错误，便于 CI。

### 自测

使用 Node 内置 `node:test` + `node:assert/strict`，fixture 全部建在 `fs.mkdtemp` 临时目录中，不依赖真实 `chapters/`、`extracted/` 数据。

```bash
npm test
# 或直接指定：
node --test --test-isolation=none \
  .dsh/skills/character-extraction/scripts/scan_chapters.test.ts \
  .dsh/skills/character-extraction/scripts/validate_extraction.test.ts
# 若已安装 tsx：
npx tsx --test .dsh/skills/character-extraction/scripts/*.test.ts
```

> `--test-isolation=none` 让测试在单进程内运行，避免测试运行器为每个文件 spawn 子进程（在受限沙箱下 `spawn` 可能被拒绝）。

### 类型检查（可选）

```bash
npm i -D typescript @types/node && npx tsc --noEmit
```

`tsconfig.json` 已启用 `erasableSyntaxOnly`，与 Node 的原生类型擦除保持一致。默认不安装 `node_modules`——脚本运行与自测都不需要它。


## 关于 DSH 机制的事实（已核对实现源码）

| 事项 | 事实 |
|---|---|
| skill 发现根 | `<projectRoot>/.dsh/skills`（rank 100）；`projectRoot` = 最近的含 `.git` 祖先，否则 cwd。本工作区无 `.git`，故 cwd 即项目根 |
| `command` frontmatter | **DSH 没有这个字段**。只读取 `name`/`description`/`whenToUse`/`metadata`/`disable-model-invocation`/`user-invocable`；未知键被静默忽略（故 `command:` 行无害但也不参与注册）。camelCase 调用键会被拒绝并丢弃整个 skill |
| 命令如何触发 | `dsh-tool-skill` 的手势正则 `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`：用户输入中任何以空白为界的 `/name` 命中 skill 名，即把该 skill 全文注入该步。故 `name` 即命令名 |
| `@` 引用 | `dsh-file-reference` 只把 mention 作为普通提示词文本插入，**不读文件内容**；路径需由模型解析后自行读取 |
| `.dsh/agents/*.md` | **DSH 没有该自动发现机制**。子代理由 `subagent` 工具用自包含提示词创建；因此这两个文件是「磁盘上的子代理工作说明」，由子代理自己读取 |
| skill 体积 | 出货 skill 的正文作为工具结果受 8192 字符修剪阈值约束，故细则放在 `references/` 按需加载 |

## 两处明确的设计决定

1. **人物 `sources` 扩展字段**：规范给出的单章 `characters` 对象没有 `quote`，但全局规则要求「每条信息必须有 quote 溯源」，且人物卡需要「原文依据」与「关系-依据」。因此在 `characters[]` 增加**可选** `sources: [{chapter, quote}]`，`relations[]` 增加**可选** `quote`。字段可选，保证最小规范形态仍能通过校验；提取时建议填写，否则卡片依据列只能留空。
2. **`.dsh/agents/` 是说明文件而非注册表**：文件顶部保留规范给定的 frontmatter 与正文，其下追加「在 DSH 中的执行说明」，把规范流程展开成可执行步骤（含失败路径、进度更新、返回格式）。

## 产出清单

```text
extracted/
  _meta.json        章节清单（source_dir / chapter_count / chapters[]）
  _progress.json    进度（total / done / current / failed / updated_at）
  _index.json       汇总索引
  ch000.json ...    逐章提取结果
cards/
  _index.json       卡片索引（characters / clothing / items）
  _index.md         人可读索引
  characters/*.md   人物卡
  clothing/*.md     衣物卡
  items/*.md        物品卡
```

格式细节以 `.dsh/skills/character-extraction/references/output-format.md` 为准。
