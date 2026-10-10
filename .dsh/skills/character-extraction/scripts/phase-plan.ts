/**
 * 「实体卡 + 阶段卡」切分的**确定性**部分。
 *
 * 本模块只做机械计算：把逐章 `ch*.json` 里的 `characters[]` 记录按角色归并，再按
 * `age` / `identity` / `appearance` / `clothing` 的变化与 `phase_hint` 切分阶段，产出
 * 「实体 + 阶段」两份**数据**。**不做**任何语义推断，也**不**读章节原文。
 *
 * 业务判定规则（哪些变化算「不可逆」、阶段标签怎么起）写在
 * `references/character-rules.md` 与 `references/aggregation-rules.md`，由汇总子代理负责；
 * 本模块只保证「同一输入必得同一输出」，便于测试与增量重跑。
 *
 * 用法::
 *
 *     npx tsx .dsh/skills/character-extraction/scripts/phase-plan.ts \
 *         --extracted extracted --output .dsh/tmp/phase-plan.json
 *
 * 退出码：0 = 成功；1 = 运行期失败；2 = 用法/环境错误。
 *
 * @module character-extraction/scripts/phase-plan
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import type { Chapter, Meta } from './types.ts'
import { compareStrings, errorMessage, isPlainObject, stripBom } from './util.ts'

// --------------------------------------------------------------------------- //
// 类型
// --------------------------------------------------------------------------- //

/** 置信度，`高 > 中 > 低`。 */
export type Confidence = '高' | '中' | '低'

/** 逐章 JSON 中的一条角色记录（已归一为字符串字段，缺失即空串）。 */
export interface CharacterRecord {
  /** 章节下标。 */
  chapter: number
  /** 该章的 `name`。 */
  name: string
  /** 该章的 `aliases`。 */
  aliases: string[]
  gender: string
  age: string
  identity: string
  appearance: string
  /** 该章的角色关系。 */
  relations: RelationFact[]
  /** 阶段切分提示；模型无法判断时为空串。 */
  phaseHint: string
  confidence: Confidence
  /** 该章 `sources[].quote` 原样搬运（按出现顺序去重）。 */
  quotes: string[]
}

/** 一条关系事实。 */
export interface RelationFact {
  target: string
  type: string
  /** 支撑该关系的原文引用（来自逐章 `relations[].quote`）。 */
  quote: string
}

/** 一条带章节归属的关系。 */
export interface RelationEntry extends RelationFact {
  /** 出现过的章号，升序去重。 */
  chapters: number[]
}

/** 阶段内的一个字段值。 */
export interface FieldValue {
  value: string
  chapters: number[]
}

/** 阶段内的候选字段值（可能多个，按首次出现章号排序）。 */
export interface PhaseField {
  /** 首次出现的取值（作为阶段卡正文主值）。 */
  primary: string
  /** 全部取值（去重、按首现章号排序）。 */
  values: FieldValue[]
  /** 是否存在多个不同取值（冲突）。 */
  conflict: boolean
}

/** 一个阶段内出现的称呼及其章节归属。 */
export interface NameUsage {
  name: string
  chapters: number[]
  /** 是否为该章记录的主名称（`name` 字段）。 */
  primary: boolean
}

/** 角色在某一章的状态摘要（用于阶段切分比较）。 */
export interface PhaseState {
  age: string
  identity: string
  appearance: string
  /** 该章 `clothing[]` 的描述，升序去重；仅用于比较着装是否改变。 */
  clothing: string[]
}

/** 一个阶段（阶段卡的数据形态）。 */
export interface PhaseSegment {
  /** `phase_01` 形式的稳定 ID。 */
  phaseId: string
  /** 阶段标签，如「卖面时期」；无 `phase_hint` 时回退为该阶段首个非空 `identity`。 */
  label: string
  /** 阶段覆盖的连续章号，升序。 */
  chapters: number[]
  /** 阶段文件名，`phase_01_卖面时期.md`。 */
  fileName: string
  age: PhaseField
  identity: PhaseField
  appearance: PhaseField
  /** 该阶段实际出现过的着装描述，升序去重。 */
  clothing: string[]
  /** 该阶段的时变关系。 */
  relations: RelationEntry[]
  /** 该阶段允许的称呼（主名 + 该阶段实际出现的别名），按首现章号排序。 */
  allowedNames: string[]
  /** 该阶段禁止的称呼：出现在**其他**阶段的称呼，绝不与本阶段实际称呼重叠。 */
  forbiddenNames: string[]
  /** 阶段内最保守（最低）的置信度。 */
  confidence: Confidence
  /** 该阶段的原文依据。 */
  sources: Array<{ chapter: number; quote: string }>
  /** 切分依据摘要，如 `identity: 卖面摊贩 → 顾府书僮`。 */
  signals: string[]
  /** 该阶段是否由「只有 1 章且变化剧烈」合并而来（规则见 aggregation-rules.md）。 */
  merged: boolean
  /** 免责说明，如 `[短暂]`。 */
  note: string
}

/** 一个角色的实体卡 + 阶段卡数据。 */
export interface CharacterPlan {
  id: string
  name: string
  /** 跨阶段通用别名（不含主名）。 */
  aliases: string[]
  gender: string
  stableTraits: {
    baseAppearance: string
    baseIdentity: string
    permanentFeatures: string
  }
  /** 稳定关系（跨阶段长期成立）。 */
  relationsGraph: RelationEntry[]
  firstChapter: number
  /** 该角色出现过的全部章号，升序去重。 */
  chapters: number[]
  confidence: Confidence
  phases: PhaseSegment[]
  sources: Array<{ chapter: number; quote: string }>
  /** 主名裁决依据说明，便于人工复核。 */
  masterNameNote: string
}

/** 归并后的角色（阶段切分之前）。 */
export interface MergedCharacter {
  name: string
  aliases: string[]
  gender: string
  records: CharacterRecord[]
  chapters: number[]
  confidence: Confidence
  masterNameNote: string
}

// --------------------------------------------------------------------------- //
// 基础工具
// --------------------------------------------------------------------------- //

/** 置信度排序权重。 */
const CONFIDENCE_RANK: Record<Confidence, number> = { 高: 3, 中: 2, 低: 1 }

/**
 * 取两个置信度中较保守（较低）的一个。
 * @param left - 左值。
 * @param right - 右值。
 * @returns 较低者。
 */
export function lowerConfidence(left: Confidence, right: Confidence): Confidence {
  return CONFIDENCE_RANK[left] <= CONFIDENCE_RANK[right] ? left : right
}

/**
 * 取两个置信度中较高的一个。
 * @param left - 左值。
 * @param right - 右值。
 * @returns 较高者。
 */
export function higherConfidence(left: Confidence, right: Confidence): Confidence {
  return CONFIDENCE_RANK[left] >= CONFIDENCE_RANK[right] ? left : right
}

/**
 * 去掉首尾空白并把内部连续空白压成单个空格。
 * @param value - 任意文本。
 * @returns 归一后的文本。
 */
export function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * 把任意值归一为非空字符串数组（去重、保持顺序）。
 * @param value - 任意 JSON 值。
 * @returns 字符串数组。
 */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = normalizeText(item)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * 归一置信度：非 `高`/`中`/`低` 一律按 `低` 处理。
 * @param value - 任意值。
 * @returns 置信度。
 */
export function toConfidence(value: unknown): Confidence {
  return value === '高' || value === '中' || value === '低' ? value : '低'
}

/**
 * 把字符串洗成安全的文件名片段（替掉 Windows 非法字符与路径分隔符）。
 * @param value - 任意文本。
 * @returns 可安全用作文件名（不含扩展名）的片段。
 */
export function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, '')
  return cleaned === '' ? 'untitled' : cleaned
}

/**
 * 章号升序去重。
 * @param chapters - 章号数组。
 * @returns 升序去重结果。
 */
export function uniqueSortedChapters(chapters: number[]): number[] {
  return [...new Set(chapters)].sort((left, right) => left - right)
}

// --------------------------------------------------------------------------- //
// 读取逐章 JSON
// --------------------------------------------------------------------------- //

/** `ch000.json` 形式。 */
const CH_FILE = /^ch([0-9]+)\.json$/i

/**
 * 从一份逐章 JSON 中抽出 `characters[]` 记录。
 * @param payload - 逐章 JSON。
 * @param fallbackChapter - `chapter_index` 缺失时使用的章号。
 * @returns 角色记录数组。
 */
export function extractCharacterRecords(payload: unknown, fallbackChapter = 0): CharacterRecord[] {
  if (!isPlainObject(payload)) return []
  const chapterIndex =
    typeof payload.chapter_index === 'number' ? payload.chapter_index : fallbackChapter
  const characters = payload.characters
  if (!Array.isArray(characters)) return []

  const records: CharacterRecord[] = []
  for (const entry of characters) {
    if (!isPlainObject(entry)) continue
    const name = typeof entry.name === 'string' ? normalizeText(entry.name) : ''
    if (name === '') continue

    records.push({
      chapter: chapterIndex,
      name,
      aliases: toStringArray(entry.aliases),
      gender: typeof entry.gender === 'string' ? normalizeText(entry.gender) : '',
      age: typeof entry.age === 'string' ? normalizeText(entry.age) : '',
      identity: typeof entry.identity === 'string' ? normalizeText(entry.identity) : '',
      appearance: typeof entry.appearance === 'string' ? normalizeText(entry.appearance) : '',
      relations: readRelations(entry.relations),
      phaseHint: typeof entry.phase_hint === 'string' ? normalizeText(entry.phase_hint) : '',
      confidence: toConfidence(entry.confidence),
      quotes: readQuotes(entry.sources),
    })
  }
  return records
}

/**
 * 读取 `relations[]`。
 * @param value - 任意 JSON 值。
 * @returns 关系事实数组。
 */
export function readRelations(value: unknown): RelationFact[] {
  if (!Array.isArray(value)) return []
  const out: RelationFact[] = []
  for (const item of value) {
    if (!isPlainObject(item)) continue
    const target = typeof item.target === 'string' ? normalizeText(item.target) : ''
    const type = typeof item.type === 'string' ? normalizeText(item.type) : ''
    if (target === '' || type === '') continue
    out.push({ target, type, quote: typeof item.quote === 'string' ? normalizeText(item.quote) : '' })
  }
  return out
}

/**
 * 读取 `sources[].quote`。
 * @param value - 任意 JSON 值。
 * @returns 引用数组（去重、保持顺序）。
 */
export function readQuotes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const quote = isPlainObject(item) && typeof item.quote === 'string' ? normalizeText(item.quote) : ''
    if (quote !== '' && !out.includes(quote)) out.push(quote)
  }
  return out
}

/**
 * 逐章 JSON 中的一条衣物记录。
 */
export interface ClothingRecord {
  chapter: number
  character: string
  scene: string
  description: string
  colorMaterial: string
  quote: string
}

/**
 * 从一份逐章 JSON 中抽出 `clothing[]` 记录。
 * @param payload - 逐章 JSON。
 * @param fallbackChapter - 章号兜底。
 * @returns 衣物记录数组。
 */
export function extractClothingRecords(payload: unknown, fallbackChapter = 0): ClothingRecord[] {
  if (!isPlainObject(payload)) return []
  const chapterIndex =
    typeof payload.chapter_index === 'number' ? payload.chapter_index : fallbackChapter
  const clothing = payload.clothing
  if (!Array.isArray(clothing)) return []

  const out: ClothingRecord[] = []
  for (const entry of clothing) {
    if (!isPlainObject(entry)) continue
    const character = typeof entry.character === 'string' ? normalizeText(entry.character) : ''
    const description = typeof entry.description === 'string' ? normalizeText(entry.description) : ''
    if (character === '' || description === '') continue
    out.push({
      chapter: chapterIndex,
      character,
      scene: typeof entry.scene === 'string' ? normalizeText(entry.scene) : '',
      description,
      colorMaterial:
        typeof entry.color_material === 'string' ? normalizeText(entry.color_material) : '',
      quote: typeof entry.quote === 'string' ? normalizeText(entry.quote) : '',
    })
  }
  return out
}

/**
 * 逐章 JSON 中的一条物品记录。
 */
export interface ItemRecord {
  chapter: number
  name: string
  type: string
  appearance: string
  function: string
  holder: string
  quote: string
}

/**
 * 从一份逐章 JSON 中抽出 `items[]` 记录。
 * @param payload - 逐章 JSON。
 * @param fallbackChapter - 章号兜底。
 * @returns 物品记录数组。
 */
export function extractItemRecords(payload: unknown, fallbackChapter = 0): ItemRecord[] {
  if (!isPlainObject(payload)) return []
  const chapterIndex =
    typeof payload.chapter_index === 'number' ? payload.chapter_index : fallbackChapter
  const items = payload.items
  if (!Array.isArray(items)) return []

  const out: ItemRecord[] = []
  for (const entry of items) {
    if (!isPlainObject(entry)) continue
    const name = typeof entry.name === 'string' ? normalizeText(entry.name) : ''
    if (name === '') continue
    out.push({
      chapter: chapterIndex,
      name,
      type: typeof entry.type === 'string' ? normalizeText(entry.type) : '',
      appearance: typeof entry.appearance === 'string' ? normalizeText(entry.appearance) : '',
      function: typeof entry.function === 'string' ? normalizeText(entry.function) : '',
      holder: typeof entry.holder === 'string' ? normalizeText(entry.holder) : '',
      quote: typeof entry.quote === 'string' ? normalizeText(entry.quote) : '',
    })
  }
  return out
}

/** 一份逐章 JSON 的完整解析结果。 */
export interface ChapterPayload {
  chapterIndex: number
  characters: CharacterRecord[]
  clothing: ClothingRecord[]
  items: ItemRecord[]
}

/**
 * 读取 `@extracted_dir` 下全部 `ch*.json`（按章号升序）。
 *
 * 只读 JSON，**不读** `@chapters_dir/*.txt`。单个文件解析失败会被跳过并记入 `warnings`，
 * 与「失败不阻塞」的全局约束一致。
 *
 * @param extractedDir - 逐章 JSON 目录。
 * @returns 解析结果与诊断信息。
 * @throws 目录不存在时抛出。
 */
export async function loadChapterPayloads(
  extractedDir: string,
): Promise<{ payloads: ChapterPayload[]; warnings: string[] }> {
  const absolute = path.resolve(extractedDir)
  const names = (await readdir(absolute)).filter((name) => CH_FILE.test(name)).sort(compareStrings)
  const warnings: string[] = []
  const payloads: ChapterPayload[] = []

  for (const name of names) {
    const match = CH_FILE.exec(name)
    const fileIndex = match?.[1] === undefined ? 0 : Number(match[1])
    let parsed: unknown
    try {
      parsed = JSON.parse(stripBom(await readFile(path.join(absolute, name), 'utf8')))
    } catch (error) {
      warnings.push(`${name} 无法解析，已跳过：${errorMessage(error)}`)
      continue
    }
    payloads.push({
      chapterIndex: isPlainObject(parsed) && typeof parsed.chapter_index === 'number' ? parsed.chapter_index : fileIndex,
      characters: extractCharacterRecords(parsed, fileIndex),
      clothing: extractClothingRecords(parsed, fileIndex),
      items: extractItemRecords(parsed, fileIndex),
    })
  }

  payloads.sort((left, right) => left.chapterIndex - right.chapterIndex)
  return { payloads, warnings }
}

/**
 * 读取 `_meta.json`（只用于章节标题，缺失时返回空表）。
 * @param extractedDir - 逐章 JSON 目录。
 * @returns 章号 → 标题。
 */
export async function loadChapterTitles(extractedDir: string): Promise<Map<number, string>> {
  const titles = new Map<number, string>()
  let raw: string
  try {
    raw = await readFile(path.join(path.resolve(extractedDir), '_meta.json'), 'utf8')
  } catch {
    return titles
  }
  try {
    const meta = JSON.parse(stripBom(raw)) as Meta
    for (const chapter of Array.isArray(meta.chapters) ? meta.chapters : []) {
      const entry = chapter as Chapter
      if (typeof entry.index === 'number') {
        titles.set(entry.index, entry.title !== '' ? entry.title : entry.full_title)
      }
    }
  } catch {
    // _meta.json 损坏时不影响阶段切分，忽略。
  }
  return titles
}

// --------------------------------------------------------------------------- //
// 归并同名角色
// --------------------------------------------------------------------------- //

/**
 * 归并同名角色（实体层）。
 *
 * 三层判定，逐层放宽：
 *
 * 1. **主名同章**：同一章里被当成主名写下的两个人，一定不是同一人（证据最强）。
 * 2. **主名同字**：不同章里主名完全相同 → 同一人（「卢云」在第 11 章与第 35 章）。
 * 3. **别名桥接**：某条记录的 `name` 只是一个绰号/称呼（`black` 主名以外的称呼），
 *    且它只出现在**某一个**主名分组的别名池里 → 归入该分组；同时出现在多个池里则视为
 *    歧义，保持独立分组（宁可漏合并，不可错合并）。
 *
 * 别名**不会**跨分组传播：「甲章的别名恰好是乙章另一人的主名」不会把两人并成一人。
 *
 * @param records - 全部角色记录。
 * @returns 归并后的角色列表（按首次出现章号升序）。
 */
export function mergeCharacters(records: CharacterRecord[]): MergedCharacter[] {
  // 同一章同一主名的重复记录只保留信息量最大的一条，避免阶段扫描把同章读两次。
  const byChapterAndName = new Map<string, CharacterRecord>()
  for (const record of records) {
    const key = `${record.chapter}\u0000${record.name}`
    const existing = byChapterAndName.get(key)
    if (existing === undefined) {
      byChapterAndName.set(key, record)
      continue
    }
    const richness = (item: CharacterRecord): number =>
      item.quotes.length * 4 +
      item.relations.length * 2 +
      [item.age, item.identity, item.appearance, item.phaseHint].filter((value) => value !== '').length
    if (richness(record) > richness(existing)) byChapterAndName.set(key, record)
  }

  const sorted = [...byChapterAndName.values()].sort((left, right) => left.chapter - right.chapter)

  const parent = new Map<string, string>()
  const ensure = (key: string): void => {
    if (!parent.has(key)) parent.set(key, key)
  }
  const find = (key: string): string => {
    let node = key
    let guard = 0
    while (parent.get(node) !== undefined && parent.get(node) !== node && guard < 100000) {
      node = parent.get(node)!
      guard += 1
    }
    return node
  }
  const union = (left: string, right: string): void => {
    ensure(left)
    ensure(right)
    const a = find(left)
    const b = find(right)
    if (a === b) return
    // 按 Unicode 排序决定代表元，保证确定性。
    const [keep, drop] = compareStrings(a, b) <= 0 ? [a, b] : [b, a]
    parent.set(drop, keep)
  }

  // ---- 第 1 层：主名分组建键（同字主名自动同组） ---------------------------
  for (const record of sorted) ensure(record.name)

  // ---- 第 2 层：跨章「主名的别名 → 该主名」池；同章内的别名不做跨分组传播 -----
  /** 主名 → 该主名在**各章**出现过的别名（含该章主名本身）。 */
  const aliasPools = new Map<string, Set<string>>()
  for (const record of sorted) {
    const pool = aliasPools.get(record.name) ?? new Set<string>()
    for (const alias of [record.name, ...record.aliases]) if (alias !== '') pool.add(alias)
    aliasPools.set(record.name, pool)
  }

  // ---- 第 3 层：别名桥接 ---------------------------------------------------
  const primaryNames = new Set(sorted.map((record) => record.name))
  for (const record of sorted) {
    const others = record.aliases.filter((alias) => alias !== '' && !primaryNames.has(alias))
    if (others.length === 0) continue
    const candidates = [...primaryNames].filter((master) => {
      const pool = aliasPools.get(master)
      return pool !== undefined && others.some((alias) => pool.has(alias))
    })
    if (candidates.length !== 1) continue
    union(record.name, candidates[0]!)
  }

  // ---- 第 4 层：同章内的显式同名桥接 ---------------------------------------
  // 两个条目在同一章互为对方的别名/主名时，视为同一人（如 `name: 小李探花` +
  // `aliases: [李寻欢]` 与 `name: 李寻欢` 同章出现）。跨章不传播。
  const byChapter = new Map<number, CharacterRecord[]>()
  for (const record of sorted) {
    const bucket = byChapter.get(record.chapter) ?? []
    bucket.push(record)
    byChapter.set(record.chapter, bucket)
  }
  for (const bucket of byChapter.values()) {
    for (const record of bucket) {
      for (const alias of record.aliases) {
        if (alias === record.name) continue
        if (bucket.some((other) => other.name === alias)) union(record.name, alias)
      }
    }
  }

  // ---- 分组 ---------------------------------------------------------------
  const groups = new Map<string, CharacterRecord[]>()
  for (const record of sorted) {
    const root = find(record.name)
    const bucket = groups.get(root)
    if (bucket === undefined) groups.set(root, [record])
    else bucket.push(record)
  }

  // 每个分组的主名候选 = 组内出现过的主名（按出现章数降序，同频次按 Unicode）。
  const groupMasters = new Map<string, string[]>()
  const masterOwners = new Map<string, Set<string>>()
  for (const [root, bucket] of groups) {
    const counts = new Map<string, number>()
    for (const record of bucket) counts.set(record.name, (counts.get(record.name) ?? 0) + 1)
    const masters = [...counts.keys()].sort((left, right) => {
      const diff = (counts.get(right) ?? 0) - (counts.get(left) ?? 0)
      return diff !== 0 ? diff : compareStrings(left, right)
    })
    groupMasters.set(root, masters)
    for (const master of masters) {
      const owners = masterOwners.get(master) ?? new Set<string>()
      owners.add(root)
      masterOwners.set(master, owners)
    }
  }

  const merged: MergedCharacter[] = []
  for (const [root, bucket] of groups) {
    const chapters = uniqueSortedChapters(bucket.map((record) => record.chapter))
    const masters = groupMasters.get(root) ?? []
    // 主名裁决：组内出现章数最多者；同频次按 Unicode 码位升序（确定性）。
    const master = masters[0] ?? bucket[0]!.name

    const primaryInGroup = new Set(masters)
    const aliases: string[] = []
    const borrowed: string[] = []
    for (const record of bucket) {
      for (const alias of [record.name, ...record.aliases]) {
        if (alias === '' || alias === master || aliases.includes(alias)) continue
        // 别名恰好是**其他分组**的主名 → 同名不同人，不并入。
        const owners = masterOwners.get(alias)
        if (owners !== undefined && [...owners].some((owner) => owner !== root)) {
          borrowed.push(alias)
          continue
        }
        if (primaryInGroup.has(alias) && alias !== master) continue
        aliases.push(alias)
      }
    }
    aliases.sort((left, right) => {
      const count = (name: string): number =>
        bucket.filter((record) => record.name === name || record.aliases.includes(name)).length
      const diff = count(right) - count(left)
      return diff !== 0 ? diff : compareStrings(left, right)
    })

    let confidence: Confidence = '低'
    for (const record of bucket) confidence = higherConfidence(confidence, record.confidence)

    const primaryChapterCount = new Set(
      bucket.filter((record) => record.name === master).map((record) => record.chapter),
    ).size
    const note = [
      `主名「${master}」以主名形式出现在 ${primaryChapterCount} 章，共出场 ${chapters.length} 章`,
      `候选主名：${masters.join('、')}`,
    ]
    if (borrowed.length > 0) {
      note.push(`未并入的跨角色称呼（属于其他角色主名）：${[...new Set(borrowed)].join('、')}`)
    }

    merged.push({
      name: master,
      aliases,
      gender: bucket.find((record) => record.gender !== '')?.gender ?? '',
      records: bucket,
      chapters,
      confidence,
      masterNameNote: `${note.join('；')}。`,
    })
  }

  merged.sort((left, right) => {
    const first = left.chapters[0] ?? 0
    const other = right.chapters[0] ?? 0
    if (first !== other) return first - other
    return compareStrings(left.name, right.name)
  })

  return merged
}

// --------------------------------------------------------------------------- //
// 阶段切分
// --------------------------------------------------------------------------- //

/** 阶段状态（章 → 可比字段）。 */
function stateOf(record: CharacterRecord, clothingByChapter: Map<number, string[]>): PhaseState {
  return {
    age: record.age,
    identity: record.identity,
    appearance: record.appearance,
    clothing: clothingByChapter.get(record.chapter) ?? [],
  }
}

/**
 * 判断两章之间是否出现「不可逆变化」信号。
 *
 * 信号优先级：`identity` > `age` > `appearance` > `clothing`（`location` 由 `phase_hint`
 * 承载）。空值不算变化——原文没写不等于状态变了。
 *
 * @param previous - 前一章状态。
 * @param current - 当前章状态。
 * @returns 变更信号列表；空数组表示状态延续。
 */
export function diffState(previous: PhaseState, current: PhaseState): string[] {
  const signals: string[] = []
  const changed = (a: string, b: string): boolean => a !== '' && b !== '' && a !== b

  if (changed(previous.identity, current.identity)) {
    signals.push(`identity: ${previous.identity} → ${current.identity}`)
  }
  if (changed(previous.age, current.age)) {
    signals.push(`age: ${previous.age} → ${current.age}`)
  }
  if (changed(previous.appearance, current.appearance)) {
    signals.push(`appearance: ${previous.appearance} → ${current.appearance}`)
  }
  const left = previous.clothing.join('；')
  const right = current.clothing.join('；')
  if (left !== '' && right !== '' && left !== right) {
    signals.push(`clothing: ${left} → ${right}`)
  }
  return signals
}

/** 一段候选阶段（切分中间态）。 */
interface DraftPhase {
  hint: string
  records: CharacterRecord[]
  merged: boolean
}

/**
 * 判断某章的状态变化是否是**持续**的（判定为不可逆变化）。
 *
 * @param previous - 变化前的状态。
 * @param current - 当前章状态。
 * @param next - 下一章状态；不存在时视为不持续（变化后没有后续证据）。
 * @returns 下一章仍在 `current` 状态时返回 `true`。
 */
export function isSustainedChange(previous: PhaseState, current: PhaseState, next: PhaseState | undefined): boolean {
  if (next === undefined) return false
  if (diffState(previous, current).length === 0) return false
  return diffState(current, next).length === 0
}

/**
 * 判断 `current` 是否是**单章临时状态**（下一章就回到 `previous` 的状态）。
 *
 * 受伤、生病、换一套衣服、短时间伪装属此类：不切阶段，留在当前阶段内。
 *
 * @param previous - 变化前的状态。
 * @param current - 当前章状态。
 * @param next - 下一章状态。
 * @returns 是否为临时状态。
 */
export function isTransientState(previous: PhaseState, current: PhaseState, next: PhaseState | undefined): boolean {
  if (next === undefined) return false
  if (diffState(previous, current).length === 0) return false
  return diffState(previous, next).length === 0
}

/**
 * 按章序扫描角色的逐章记录，切分出阶段。
 *
 * 规则（详见 `references/aggregation-rules.md`）：
 * 1. `phase_hint` 变化即开新阶段（提示优先，最强信号）；
 * 2. `phase_hint` 缺失时看 `age` / `identity` / `appearance` / `clothing`：只有**持续**到
 *    下一章的变化才算不可逆变化并开新阶段；单章回弹的波动视为阶段内临时状态；
 * 3. 章节不连续（中间缺席）时开新阶段——`chapters` 只记该阶段实际出场的章；
 * 4. 只有 1 章的阶段并入相邻阶段并标 `[短暂]`（见 `collapseShortPhases`）；
 * 5. 相邻同 `phase_hint` 的阶段合并（见 `dedupePhases`）。
 *
 * 阶段与阶段**不重叠**：每章只属于一个阶段。
 *
 * @param records - 单一角色的逐章记录（按章号升序）。
 * @param clothingByChapter - 章号 → 该章该角色着装描述。
 * @returns 阶段列表（含章号）。
 */
export function splitPhases(
  records: CharacterRecord[],
  clothingByChapter: Map<number, string[]>,
): DraftPhase[] {
  const sorted = [...records].sort((left, right) => left.chapter - right.chapter)
  if (sorted.length === 0) return []

  const groups: DraftPhase[] = []
  let current: DraftPhase = { hint: sorted[0]!.phaseHint, records: [], merged: false }
  groups.push(current)
  /** 归一后的提示比较键（按登场所序）。 */
  const hintKeys = resolveHintKeys(sorted.map((item) => item.phaseHint))
  /** 当前分组里最后一次见到的非空提示比较键。 */
  let seenHintKey = hintKeys[0] ?? ''
  /** 当前分组**已确立**的状态：临时波动不更新它，因此回弹等于没变。 */
  let baseline = stateOf(sorted[0]!, clothingByChapter)
  /** 已被判定为「临时」的章号——它们不更新基线，但会用回弹证明前一次变化只是一时。 */
  const transientChapters = new Set<number>()

  for (let i = 0; i < sorted.length; i += 1) {
    const record = sorted[i]!
    if (i > 0) {
      const state = stateOf(record, clothingByChapter)
      const gap = record.chapter !== sorted[i - 1]!.chapter + 1
      const hintKey = hintKeys[i] ?? ''
      const hintChanged = seenHintKey !== '' && hintKey !== '' && hintKey !== seenHintKey
      const changed = diffState(baseline, state).length > 0
      // 跳过连续出现的临时章，找到真正「下一个稳定登场」。
      let skipTo = i
      while (skipTo + 1 < sorted.length && transientChapters.has(sorted[skipTo]!.chapter)) skipTo += 1
      const candidate = sorted[skipTo + 1]
      /**
       * 「一时状态」判定：该变化在其后的**下一次稳定登场**就退回基线，且回弹足够近
       * （间隔 ≤ `REVERT_WINDOW` 个登场点或 ≤ `REVERT_CHAPTER_SPAN` 章）。
       * 受伤、换一套衣服、短时间伪装属此类，不切阶段。
       *
       * 回弹太远（角色隔了十几章才回到旧称呼）不算回弹——那更可能是数据本身稀疏，
       * 不能用远方的巧合把中间的真实转变抹掉。
       */
      const transient =
        candidate !== undefined &&
        candidate.chapter - record.chapter <= REVERT_CHAPTER_SPAN &&
        skipTo + 1 - i <= REVERT_WINDOW &&
        isTransientState(baseline, state, stateOf(candidate, clothingByChapter))
      // 双方都有提示时，提示是权威信号，`age`/`identity`/... 的波动不再参与判定。
      const hintGoverns = seenHintKey !== '' && hintKey !== ''
      const split = gap || hintChanged || (!hintGoverns && changed && !transient)

      if (split) {
        current = { hint: record.phaseHint, records: [], merged: false }
        groups.push(current)
        baseline = state
      } else if (transient) {
        transientChapters.add(record.chapter)
      } else {
        baseline = state
      }
    }

    current.records.push(record)
    const hintKey = hintKeys[i] ?? ''
    if (hintKey !== '') {
      // 标签取该阶段见过的**最简写法**（后缀最短），避免同一阶段名来回变。
      if (current.hint === '' || [...record.phaseHint].length < [...current.hint].length) {
        current.hint = record.phaseHint
      }
      seenHintKey = hintKey
    }
  }

  return dedupePhases(collapseShortPhases(groups))
}

/**
 * 把「只有 1 章」的阶段合并到相邻阶段并标记 `[短暂]`（见 `aggregation-rules.md` 4.2）。
 *
 * 合并方向：优先并入**前**一阶段（该变化被视为前一阶段内的临时状态）；前一阶段不存在时
 * 把后一阶段的记录并入本节。合并后必须重算边界：被合并的章不再属于原阶段，避免阶段重叠。
 *
 * @param drafts - 候选阶段。
 * @returns 处理后的阶段列表（章节互不重叠）。
 */
export function collapseShortPhases(drafts: DraftPhase[]): DraftPhase[] {
  const out: DraftPhase[] = []
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i]!
    if (draft.records.length === 1) {
      const previous = out[out.length - 1]
      if (previous !== undefined) {
        // 并入前一阶段：该章从此属于前一阶段。
        previous.records.push(...draft.records)
        previous.merged = true
        continue
      }
      const next = drafts[i + 1]
      if (next !== undefined) {
        // 没有前一阶段：本阶段吞并下一段。
        out.push({
          hint: draft.hint !== '' ? draft.hint : next.hint,
          records: [...draft.records, ...next.records],
          merged: true,
        })
        i += 1
        continue
      }
    }
    out.push({ hint: draft.hint, records: [...draft.records], merged: draft.merged })
  }
  return out
}

/**
 * 合并相邻且**归一提示相同**的阶段（切分过程中被单章波动切开的同阶段重新接回）。
 *
 * 提示为空串时不参与合并——空提示不代表同一阶段。
 *
 * @param drafts - 候选阶段。
 * @returns 合并后的阶段列表。
 */
export function dedupePhases(drafts: DraftPhase[]): DraftPhase[] {
  const keys = resolveHintKeys(drafts.map((draft) => draft.hint))
  const out: DraftPhase[] = []
  const outKeys: string[] = []
  for (const [index, draft] of drafts.entries()) {
    const previous = out[out.length - 1]
    const key = keys[index] ?? ''
    if (previous !== undefined) {
      const previousKey = outKeys[outKeys.length - 1] ?? ''
      // 规范提示取「更短、更一般」的写法。
      if (key !== '' && key === previousKey) {
        previous.records.push(...draft.records)
        previous.merged = previous.merged || draft.merged
        if (draft.hint !== '' && [...draft.hint].length < [...previous.hint].length) {
          previous.hint = draft.hint
        }
        continue
      }
    }
    out.push({ ...draft, records: [...draft.records] })
    outKeys.push(key)
  }
  return out
}

/**
 * 构造阶段内的候选字段值。
 * @param records - 阶段内记录。
 * @param pick - 取值函数。
 * @returns 阶段字段。
 */
export function buildPhaseField(
  records: CharacterRecord[],
  pick: (record: CharacterRecord) => string,
): PhaseField {
  const values: FieldValue[] = []
  for (const record of records) {
    const value = pick(record)
    if (value === '') continue
    const existing = values.find((entry) => entry.value === value)
    if (existing === undefined) values.push({ value, chapters: [record.chapter] })
    else if (!existing.chapters.includes(record.chapter)) existing.chapters.push(record.chapter)
  }
  return {
    primary: values[0]?.value ?? '',
    values,
    conflict: values.length > 1,
  }
}

/** 阶段标签最大长度（字符数）：过长会让文件名难以阅读与维护。 */
const LABEL_MAX = 16

/** 「一时状态」回弹允许的最大登场点间隔。 */
const REVERT_WINDOW = 2
/** 「一时状态」回弹允许的最大章号间隔。 */
const REVERT_CHAPTER_SPAN = 4

/** `phase_hint` 里常见的时期后缀——去掉后不改变语义。 */
const HINT_SUFFIX = /(时期|阶段|年代|年间|之初|末期|中期|初期|初|末|中)$/u

/**
 * 把 `phase_hint` 归一为**比较键**：去掉首尾空白与时期后缀。
 *
 * 纯文本归一，不做语义概括。用途有两条：
 * 1. 跨章比较提示时不再被「书僮时期 / 书僮 / 书僮期」这类纯后缀差异切开；
 * 2. 同一角色的提示变体只保留一个规范写法。
 *
 * @param hint - 原始提示。
 * @returns 比较键；`hint` 为空时返回空串。
 */
export function hintKeyOf(hint: string): string {
  let key = normalizeText(hint)
  for (let round = 0; round < 2; round += 1) {
    const stripped = key.replace(HINT_SUFFIX, '')
    if (stripped.length >= 2 && stripped !== key) key = stripped
    else break
  }
  return key
}

/**
 * 按章序把每个提示映射到规范比较键。
 *
 * 已绑定的键不会被普通提示改写；只有「严格前缀」提示才允许改写，并且只改新记录。
 * 这样能避免「书僮 → 书僮阶段 → 书僮时期」左右横跳，也不会把两个不同时期错并。
 *
 * @param hints - 按章序排列的提示（可与角色记录不同步，仅取非空值）。
 * @returns 与输入等长的比较键数组。
 */
export function resolveHintKeys(hints: string[]): string[] {
  const bindings = new Map<string, string>()
  return hints.map((hint) => {
    const key = hintKeyOf(hint)
    if (key === '') return ''
    const bound = bindings.get(key)
    if (bound === undefined) {
      bindings.set(key, hint)
      return key
    }
    if (bound !== hint && (bound.startsWith(hint) || hint.startsWith(bound))) {
      // 取更短、更一般化的写法作为规范提示。
      const canonical = hint.length < bound.length ? hint : bound
      bindings.set(hintKeyOf(canonical), canonical)
    }
    return key
  })
}

/**
 * 把长身份描述压成简短阶段标签。
 *
 * 规则：优先取第一个分句（`；` / `，` 之前）；仍超长时截断并加 `…`。纯字符串处理，
 * 不做语义概括。
 * @param value - 身份描述。
 * @returns 简短标签。
 */
export function shortenLabel(value: string): string {
  const head = value.split(/[；;，,。]/u)[0]?.trim() ?? ''
  const text = head === '' ? value.trim() : head
  const chars = [...text]
  return chars.length <= LABEL_MAX ? text : `${chars.slice(0, LABEL_MAX).join('')}…`
}

/** 阶段标签兜底：没有 `phase_hint` 时用首现身份（其次外貌），仍无则用「故事阶段」。 */
function labelFor(hint: string, identity: PhaseField, appearance: PhaseField): string {
  if (hint !== '') return shortenLabel(hint)
  const fromIdentity = identity.values[0]
  if (fromIdentity !== undefined && fromIdentity.value !== '') return shortenLabel(fromIdentity.value)
  const fromAppearance = appearance.values[0]
  if (fromAppearance !== undefined && fromAppearance.value !== '') {
    return shortenLabel(fromAppearance.value)
  }
  // 该阶段各章都没有身份与外描写（模型判断不了）→ 用中性标签，避免把章号写进文件名。
  return '故事阶段'
}

/** 阶段 ID：`phase_01`。 */
function phaseIdFor(position: number): string {
  return `phase_${String(position).padStart(2, '0')}`
}

/**
 * 判断一条关系是否属于「稳定关系」（进实体卡 `relations_graph`）。
 *
 * 判据（确定性、可测试）：
 * - 出现在至少 `minChapters`（默认 2）个不同章节；或
 * - 覆盖角色出场章号的 50% 以上且至少 2 章。
 * 其余为时变关系，进阶段卡 `relations`。
 *
 * @param entry - 关系条目（含章节归属）。
 * @param characterChapters - 该角色全部出场章号。
 * @param minChapters - 稳定关系的最小章数，默认 2。
 * @returns 是否稳定。
 */
export function isStableRelation(
  entry: RelationEntry,
  characterChapters: number[],
  minChapters = 2,
): boolean {
  if (entry.chapters.length >= minChapters) return true
  if (characterChapters.length <= 1) return true
  return entry.chapters.length / characterChapters.length > 0.5
}

/**
 * 把一条角色记录里的全部称呼（含主名）按章归属汇总。
 * @param records - 角色记录。
 * @returns 称呼 → 章号集合。
 */
export function collectNameUsage(records: CharacterRecord[]): Map<string, NameUsage> {
  const usage = new Map<string, NameUsage>()
  for (const record of records) {
    const add = (name: string, primary: boolean): void => {
      if (name === '') return
      const existing = usage.get(name)
      if (existing === undefined) {
        usage.set(name, { name, chapters: [record.chapter], primary })
        return
      }
      if (!existing.chapters.includes(record.chapter)) existing.chapters.push(record.chapter)
      existing.primary = existing.primary || primary
    }
    add(record.name, true)
    for (const alias of record.aliases) add(alias, false)
  }
  for (const entry of usage.values()) entry.chapters.sort((left, right) => left - right)
  return usage
}

/**
 * 判断一个称呼是否算「跨阶段通用别名」（进实体卡 `aliases`）。
 *
 * 判据（确定性）：出现在 ≥ 2 个阶段，且覆盖全部阶段的 50% 以上、或覆盖 ≥ 3 个阶段。
 * 只出现在个别阶段的称呼只进该阶段卡的 `allowed_names`。
 *
 * @param chapters - 该称呼出现的章号。
 * @param phases - 各阶段的章号集合。
 * @returns 是否跨阶段通用。
 */
export function isCrossPhaseAlias(chapters: number[], phases: number[][]): boolean {
  if (phases.length <= 1) return true
  const hits = phases.filter((phase) => phase.some((chapter) => chapters.includes(chapter))).length
  if (hits < 2) return false
  return hits >= 3 || hits / phases.length >= 0.5
}

/**
 * 计算阶段标签与文件名的稳定去重分配。
 * @param segments - 阶段数据（不含文件名）。
 * @returns 阶段数据 + `fileName`。
 */
function assignFileNames(segments: Array<Omit<PhaseSegment, 'fileName'>>): PhaseSegment[] {
  const used = new Set<string>()
  return segments.map((segment) => {
    const base = sanitizeFileName(segment.label)
    let candidate = `${segment.phaseId}_${base}`
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${segment.phaseId}_${base}_${suffix}`
      suffix += 1
    }
    used.add(candidate)
    return { ...segment, fileName: `${candidate}.md` }
  })
}

/**
 * 把一个归并后的角色切成「实体 + 阶段」。
 * @param character - 归并后的角色。
 * @param clothingByChapter - 章号 → 该角色该章着装描述。
 * @param foreignNames - 本角色之外、被其他角色当作主名的称呼（跨角色同名守卫）。
 * @returns 实体 + 阶段数据。
 */
export function buildCharacterPlan(
  character: MergedCharacter,
  clothingByChapter: Map<number, string[]>,
  foreignNames: string[] = [],
): CharacterPlan {
  const records = [...character.records].sort((left, right) => left.chapter - right.chapter)
  const chapters = uniqueSortedChapters(records.map((record) => record.chapter))
  const drafts = splitPhases(records, clothingByChapter)

  // 关系：按 (target, type) 归并，保留全部章节与引用。
  const relationMap = new Map<string, RelationEntry>()
  for (const record of records) {
    for (const relation of record.relations) {
      const key = `${relation.target}\u0000${relation.type}`
      const existing = relationMap.get(key)
      if (existing === undefined) {
        relationMap.set(key, { ...relation, chapters: [record.chapter] })
        continue
      }
      if (!existing.chapters.includes(record.chapter)) existing.chapters.push(record.chapter)
      if (existing.quote === '' && relation.quote !== '') existing.quote = relation.quote
    }
  }
  const allRelations = [...relationMap.values()]
  for (const entry of allRelations) entry.chapters.sort((left, right) => left - right)

  const nameUsage = collectNameUsage(records)

  // 先切出阶段草稿，才能按阶段判断别名归属。
  const phaseChapters = drafts.map((draft) => uniqueSortedChapters(draft.records.map((record) => record.chapter)))

  // 跨角色同名守卫：某个称呼是本角色之外另一角色的主名时，不并入实体卡 `aliases`
  // （规则见 references/character-rules.md 第 6 节「同名不同人」）。阶段卡的
  // `allowed_names` 仍保留原文实际出现的称呼，不做删改。
  const foreignPrimaries = new Set(foreignNames.filter((name) => name !== character.name))

  const generalAliases: string[] = []
  for (const alias of character.aliases) {
    if (foreignPrimaries.has(alias)) continue
    const usage = nameUsage.get(alias)
    if (usage !== undefined && isCrossPhaseAlias(usage.chapters, phaseChapters)) generalAliases.push(alias)
  }

  const stableChapters = allRelations
    .filter((entry) => isStableRelation(entry, chapters))
    .map((entry) => entry.chapters)
    .flat()

  // 阶段卡
  const partials: Array<Omit<PhaseSegment, 'fileName'>> = drafts.map((draft, position) => {
    const phaseRecords = draft.records
    const phaseChaptersHere = phaseChapters[position]!
    const age = buildPhaseField(phaseRecords, (record) => record.age)
    const identity = buildPhaseField(phaseRecords, (record) => record.identity)
    const appearance = buildPhaseField(phaseRecords, (record) => record.appearance)
    const label = labelFor(draft.hint, identity, appearance)

    // 该阶段实际出现的称呼（主名 + 别名）。
    const allowed: string[] = []
    for (const [name, usage] of nameUsage) {
      if (usage.chapters.some((chapter) => phaseChaptersHere.includes(chapter)) && !allowed.includes(name)) {
        allowed.push(name)
      }
    }
    allowed.sort((left, right) => {
      const leftAt = nameUsage.get(left)?.chapters[0] ?? 0
      const rightAt = nameUsage.get(right)?.chapters[0] ?? 0
      if (leftAt !== rightAt) return leftAt - rightAt
      if (left === character.name) return -1
      if (right === character.name) return 1
      return compareStrings(left, right)
    })

    // 禁止称呼：出现在**其他**阶段的称呼；绝不与本阶段实际称呼重叠。
    const allowedSet = new Set(allowed)
    const forbidden: string[] = []
    for (const [name, usage] of nameUsage) {
      if (allowedSet.has(name)) continue
      const inOtherPhase = usage.chapters.some((chapter) =>
        phaseChapters.some((phase, index) => index !== position && phase.includes(chapter)),
      )
      if (inOtherPhase && !forbidden.includes(name)) forbidden.push(name)
    }
    forbidden.sort(compareStrings)

    const relations: RelationEntry[] = allRelations
      .filter(
        (entry) =>
          !isStableRelation(entry, chapters) &&
          entry.chapters.some((chapter) => phaseChaptersHere.includes(chapter)),
      )
      .map((entry) => ({ ...entry, chapters: entry.chapters.filter((chapter) => phaseChaptersHere.includes(chapter)) }))

    const sources: Array<{ chapter: number; quote: string }> = []
    for (const record of phaseRecords) {
      for (const quote of record.quotes) {
        if (!sources.some((entry) => entry.chapter === record.chapter && entry.quote === quote)) {
          sources.push({ chapter: record.chapter, quote })
        }
      }
    }

    let confidence: Confidence = '高'
    for (const record of phaseRecords) confidence = lowerConfidence(confidence, record.confidence)

    const clothing = [
      ...new Set(
        phaseRecords.flatMap((record) => clothingByChapter.get(record.chapter) ?? []),
      ),
    ].sort(compareStrings)

    const signals: string[] = []
    const nextDraft = drafts[position + 1]
    if (nextDraft !== undefined) {
      const nextHint = nextDraft.hint
      const currentHint = draft.hint
      if (currentHint !== '' && nextHint !== '' && currentHint !== nextHint) {
        signals.push(`phase_hint: ${currentHint} → ${nextHint}`)
      } else {
        const lastRecord = phaseRecords[phaseRecords.length - 1]!
        const nextRecord = nextDraft.records[0]!
        signals.push(
          ...diffState(stateOf(lastRecord, clothingByChapter), stateOf(nextRecord, clothingByChapter)),
        )
        if (signals.length === 0 && nextRecord.chapter !== lastRecord.chapter + 1) {
          signals.push(`章号不连续：第${lastRecord.chapter}章 → 第${nextRecord.chapter}章`)
        }
      }
    }
    if (draft.merged) signals.push('[短暂]')
    const note = draft.merged ? '[短暂]' : ''

    return {
      phaseId: phaseIdFor(position + 1),
      label,
      chapters: phaseChaptersHere,
      age,
      identity,
      appearance,
      clothing,
      relations,
      allowedNames: allowed,
      forbiddenNames: forbidden,
      confidence,
      sources,
      signals,
      merged: draft.merged,
      note,
    }
  })

  const phases = assignFileNames(partials)

  // 实体卡溯源：跨阶段稳定关系涉及章 + 首末章，最多 6 条。
  const entitySources: Array<{ chapter: number; quote: string }> = []
  const pushSource = (record: CharacterRecord): void => {
    for (const quote of record.quotes) {
      if (entitySources.some((entry) => entry.chapter === record.chapter && entry.quote === quote)) continue
      if (entitySources.length >= 6) return
      entitySources.push({ chapter: record.chapter, quote })
    }
  }
  for (const record of records) {
    if (stableChapters.includes(record.chapter)) pushSource(record)
  }
  for (const record of records) pushSource(record)

  const baseIdentity = records.find((record) => record.identity !== '')?.identity ?? ''
  const baseAppearance =
    records.find((record) => record.appearance !== '')?.appearance ??
    records[0]?.appearance ??
    ''

  return {
    id: '', // 由 planCharacters 统一分配，保证确定性
    name: character.name,
    aliases: generalAliases,
    gender: character.gender,
    stableTraits: {
      baseAppearance,
      baseIdentity,
      permanentFeatures: records[0]?.appearance ?? '',
    },
    relationsGraph: allRelations.filter((entry) => isStableRelation(entry, chapters)),
    firstChapter: chapters[0] ?? 0,
    chapters,
    confidence: character.confidence,
    phases,
    sources: entitySources,
    masterNameNote: character.masterNameNote,
  }
}

/** `planCharacters()` 的完整结果。 */
export interface CharacterPlanBundle {
  characters: CharacterPlan[]
  /** 全部角色（含未切分成功的），便于诊断。 */
  merged: MergedCharacter[]
  warnings: string[]
}

/**
 * 从逐章 payload 生成「实体 + 阶段」计划。
 *
 * @param payloads - 逐章 payload（按章号升序）。
 * @param options - `minStableChapters` 覆盖稳定关系最小章数，默认 2。
 * @returns 计划 + 诊断。
 */
export function planCharacters(
  payloads: ChapterPayload[],
  options: { minStableChapters?: number } = {},
): CharacterPlanBundle {
  const warnings: string[] = []
  const allRecords: CharacterRecord[] = []
  /** 章号 + 角色主名 → 着装描述。 */
  const clothingByCharacter = new Map<string, Map<number, string[]>>()

  for (const payload of payloads) {
    allRecords.push(...payload.characters)
    for (const record of payload.clothing) {
      const key = `${record.chapter}\u0000${record.character}`
      const bucket = clothingByCharacter.get(key) ?? new Map<number, string[]>()
      const list = bucket.get(record.chapter) ?? []
      if (!list.includes(record.description)) list.push(record.description)
      bucket.set(record.chapter, list)
      clothingByCharacter.set(key, bucket)
    }
  }

  const merged = mergeCharacters(allRecords)
  // 别名指向的主名：用并查集结果把衣物记录的 character 归到主名。
  const aliasToMaster = new Map<string, string>()
  for (const character of merged) {
    aliasToMaster.set(character.name, character.name)
    for (const alias of character.aliases) aliasToMaster.set(alias, character.name)
  }
  const allMasters = merged.map((character) => character.name)

  const plans: CharacterPlan[] = []
  for (const character of merged) {
    const clothingByChapter = new Map<number, string[]>()
    for (const [key, bucket] of clothingByCharacter) {
      const [chapterText, rawName] = key.split('\u0000')
      const chapter = Number(chapterText)
      const master = aliasToMaster.get(rawName ?? '') ?? rawName ?? ''
      if (master !== character.name) continue
      const list = clothingByChapter.get(chapter) ?? []
      for (const description of bucket.get(chapter) ?? []) {
        if (!list.includes(description)) list.push(description)
      }
      clothingByChapter.set(chapter, list)
    }
    plans.push(buildCharacterPlan(character, clothingByChapter, allMasters))
  }

  // ID 分配：先按首次出场章升序，再按主名 Unicode 码位升序（确定性）。
  plans.sort((left, right) => {
    if (left.firstChapter !== right.firstChapter) return left.firstChapter - right.firstChapter
    return compareStrings(left.name, right.name)
  })
  plans.forEach((plan, position) => {
    plan.id = `char_${String(position + 1).padStart(4, '0')}`
  })

  for (const plan of plans) {
    if (plan.phases.length === 0) warnings.push(`${plan.name}：未切出任何阶段`)
    for (const phase of plan.phases) {
      const overlap = phase.forbiddenNames.filter((name) => phase.allowedNames.includes(name))
      if (overlap.length > 0) {
        warnings.push(`${plan.name}/${phase.phaseId}：禁止称呼与实际称呼重叠：${overlap.join('、')}`)
      }
    }
  }

  return { characters: plans, merged, warnings }
}

/** `characterPhaseIndex()` 的输出形状（`cards/characters/_index.json`）。 */
export interface CharacterIndexEntry {
  id: string
  name: string
  dir: string
  entity_file: string
  chapters: number[]
  phases: Array<{ phase_id: string; label: string; file: string; chapters: number[] }>
}

/**
 * 生成 `cards/characters/_index.json` 的 `characters` 数组。
 *
 * @param plans - 角色计划。
 * @param options - `charactersRelDir`：相对工作区根的 `characters/` 目录（默认 `cards/characters`）。
 * @returns 索引条目。
 */
export function characterIndexEntries(
  plans: CharacterPlan[],
  options: { charactersRelDir?: string } = {},
): CharacterIndexEntry[] {
  const relDir = (options.charactersRelDir ?? 'cards/characters').replace(/\\/gu, '/').replace(/\/+$/u, '')
  return plans.map((plan) => {
    const dirName = sanitizeFileName(plan.name)
    return {
      id: plan.id,
      name: plan.name,
      dir: `${relDir}/${dirName}`,
      entity_file: `${relDir}/${dirName}/index.md`,
      chapters: plan.chapters,
      phases: plan.phases.map((phase) => ({
        phase_id: phase.phaseId,
        label: phase.label,
        file: `${relDir}/${dirName}/${phase.fileName}`,
        chapters: phase.chapters,
      })),
    }
  })
}

// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //

/** CLI 参数。 */
export interface PhasePlanCliArgs {
  extracted?: string
  output?: string
  pretty: boolean
  help: boolean
}

/** 用法文本。 */
export function usage(): string {
  return [
    '用法：phase-plan.ts --extracted <extracted_dir> [--output <file>] [--compact]',
    '',
    '选项：',
    '  --extracted <dir>   逐章 JSON 目录（@extracted_dir），必填',
    '  --output <file>     计划 JSON 输出路径；省略时写 stdout',
    '  --compact           输出单行 JSON',
    '  --help              显示本帮助',
  ].join('\n')
}

/**
 * 解析 CLI 参数。
 * @param argv - 参数列表（不含 node 与脚本路径）。
 * @returns 解析结果。
 * @throws 未知选项或缺少取值时抛出。
 */
export function parsePhasePlanArgs(argv: string[]): PhasePlanCliArgs {
  const args: PhasePlanCliArgs = { pretty: true, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? ''
    const equals = token.indexOf('=')
    const flag = token.startsWith('--') && equals > 0 ? token.slice(0, equals) : token
    const take = (): string => {
      if (equals > 0) return token.slice(equals + 1)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`选项 ${flag} 缺少取值`)
      i += 1
      return next
    }
    switch (flag) {
      case '--extracted':
        args.extracted = take()
        break
      case '--output':
        args.output = take()
        break
      case '--compact':
        args.pretty = false
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`未知选项：${token}`)
    }
  }
  return args
}

/**
 * CLI 入口。
 * @param argv - 参数列表，默认 `process.argv.slice(2)`。
 * @returns 退出码：0 成功、1 运行期失败、2 用法/环境错误。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: PhasePlanCliArgs
  try {
    args = parsePhasePlanArgs(argv)
  } catch (error) {
    console.error(`错误：${errorMessage(error)}`)
    console.error(usage())
    return 2
  }
  if (args.help) {
    console.log(usage())
    return 0
  }
  if (args.extracted === undefined) {
    console.error('错误：--extracted 为必填')
    console.error(usage())
    return 2
  }

  try {
    const { payloads, warnings } = await loadChapterPayloads(args.extracted)
    const bundle = planCharacters(payloads)
    const charactersRelDir = path
      .relative(process.cwd(), path.resolve(args.extracted, '..', 'cards', 'characters'))
      .replace(/\\/gu, '/')
    const result = {
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
      extracted_dir: path.resolve(args.extracted),
      character_count: bundle.characters.length,
      warnings: [...warnings, ...bundle.warnings],
      characters: bundle.characters,
      index: { characters: characterIndexEntries(bundle.characters, { charactersRelDir }) },
    }
    const text = args.pretty ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`
    if (args.output === undefined) {
      console.log(text.trimEnd())
    } else {
      await mkdir(path.dirname(path.resolve(args.output)), { recursive: true })
      await writeFile(path.resolve(args.output), text, 'utf8')
      console.log(
        `阶段计划完成：角色 ${bundle.characters.length}，阶段 ${bundle.characters.reduce((sum, plan) => sum + plan.phases.length, 0)}，输出 ${path.resolve(args.output)}`,
      )
    }
    return 0
  } catch (error) {
    console.error(`错误：${errorMessage(error)}`)
    return 1
  }
}

// 仅在作为入口直接执行时运行 CLI；被测试 import 时不触发。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(`错误：${errorMessage(error)}`)
      process.exitCode = 1
    })
}
