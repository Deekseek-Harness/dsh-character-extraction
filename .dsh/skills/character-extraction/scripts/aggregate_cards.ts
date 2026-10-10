#!/usr/bin/env node
/**
 * 汇总落盘：把 `@extracted_dir/ch*.json` 变成「一人一目录」的实体卡 + 阶段卡，以及衣物卡、
 * 物品卡与各类索引。
 *
 * 本脚本承担汇总阶段**全部机械动作**（阶段切分、字段归并、ID 与文件名分配、索引生成、
 * Markdown 渲染），业务判定规则见 `references/aggregation-rules.md`。汇总子代理只负责调用
 * 本脚本并复核产出，不自己拼字符串、不自己算 ID。
 *
 * 用法::
 *
 *     npx tsx .dsh/skills/character-extraction/scripts/aggregate_cards.ts \
 *         --extracted extracted --cards cards --root . --summary .dsh/tmp/agg.json
 *
 * **禁止**读取 `@chapters_dir/*.txt`：本脚本的信息来源只有 `@extracted_dir/*.json`。
 *
 * 退出码：0 = 成功；1 = 运行期失败；2 = 用法/环境错误。
 *
 * @module character-extraction/scripts/aggregate_cards
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  characterIndexEntries,
  loadChapterPayloads,
  loadChapterTitles,
  planCharacters,
  sanitizeFileName,
  uniqueSortedChapters,
  type CharacterPlan,
  type ChapterPayload,
  type ClothingRecord,
  type Confidence,
  type ItemRecord,
  type PhaseSegment,
} from './phase-plan.ts'
import type { JsonObject } from './types.ts'
import { compareStrings, errorMessage } from './util.ts'

// --------------------------------------------------------------------------- //
// 通用工具
// --------------------------------------------------------------------------- //

/** 把字符串包成 YAML 双引号标量（转义 `\` 与 `"`）。 */
function q(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/** YAML 行内字符串数组。 */
function inlineArray(values: string[]): string {
  return `[${values.map((value) => q(value)).join(', ')}]`
}

/** 章号列表格式化为「第10-11章」「第35、38章」。 */
function chapterRanges(chapters: number[]): string {
  if (chapters.length === 0) return '（无）'
  const sorted = uniqueSortedChapters(chapters)
  const ranges: string[] = []
  let start = sorted[0]!
  let previous = start
  for (const chapter of sorted.slice(1)) {
    if (chapter === previous + 1) {
      previous = chapter
      continue
    }
    ranges.push(start === previous ? `第${start}章` : `第${start}-${previous}章`)
    start = chapter
    previous = chapter
  }
  ranges.push(start === previous ? `第${start}章` : `第${start}-${previous}章`)
  return ranges.join('、')
}

/** 章号列表格式化为 `10, 11`。 */
function chapterList(chapters: number[]): string {
  return uniqueSortedChapters(chapters).join(', ')
}

/**
 * 取章节标题；缺失时回退为「第N章」。
 * @param titles - 章号 → 标题。
 * @param chapter - 章号。
 * @returns 标题。
 */
function titleOf(titles: Map<number, string>, chapter: number): string {
  const title = titles.get(chapter)
  return title === undefined || title === '' ? `第${chapter}章` : title
}

/** 渲染原文依据块。 */
function renderSources(sources: Array<{ chapter: number; quote: string }>): string {
  if (sources.length === 0) return '（无）'
  return sources.map((source) => `> 第${source.chapter}章：${source.quote}`).join('\n')
}

/**
 * 把相对工作区根的路径统一为 `/` 分隔。
 * @param value - 任意相对路径。
 * @returns 正斜杠路径。
 */
function toPosix(value: string): string {
  return value.replace(/\\/gu, '/').replace(/\/+$/u, '')
}

// --------------------------------------------------------------------------- //
// 实体卡 / 阶段卡
// --------------------------------------------------------------------------- //

/**
 * 渲染实体卡 `index.md`（只含跨阶段稳定信息）。
 * @param plan - 角色计划。
 * @param titles - 章号 → 章节标题。
 * @returns Markdown 文本。
 */
export function renderEntityCard(plan: CharacterPlan, titles: Map<number, string>): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`id: ${plan.id}`)
  lines.push(`name: ${q(plan.name)}`)
  lines.push(`aliases: ${inlineArray(plan.aliases)}`)
  lines.push(`gender: ${q(plan.gender)}`)
  lines.push('stable_traits:')
  lines.push(`  base_appearance: ${q(plan.stableTraits.baseAppearance)}`)
  lines.push(`  base_identity: ${q(plan.stableTraits.baseIdentity)}`)
  lines.push(`  permanent_features: ${q(plan.stableTraits.permanentFeatures)}`)
  lines.push('relations_graph:')
  if (plan.relationsGraph.length === 0) {
    lines.push('  []')
  } else {
    for (const relation of plan.relationsGraph) {
      lines.push(`  - target: ${q(relation.target)}`)
      lines.push(`    type: ${q(relation.type)}`)
      lines.push(`    chapters: [${chapterList(relation.chapters)}]`)
    }
  }
  lines.push(`first_chapter: ${plan.firstChapter}`)
  lines.push(`chapters: [${chapterList(plan.chapters)}]`)
  lines.push(`confidence: ${plan.confidence}`)
  lines.push('phases:')
  if (plan.phases.length === 0) {
    lines.push('  []')
  } else {
    for (const phase of plan.phases) {
      lines.push(`  - phase_id: ${phase.phaseId}`)
      lines.push(`    label: ${q(phase.label)}`)
      lines.push(`    file: ${q(phase.fileName)}`)
      lines.push(`    chapters: [${chapterList(phase.chapters)}]`)
    }
  }
  lines.push('sources:')
  if (plan.sources.length === 0) {
    lines.push('  []')
  } else {
    for (const source of plan.sources) {
      lines.push(`  - chapter: ${source.chapter}`)
      lines.push(`    quote: ${q(source.quote)}`)
    }
  }
  lines.push('---')
  lines.push(`# ${plan.name}`)
  lines.push('')
  lines.push('## 稳定身份')
  lines.push(`- 姓名：${plan.name}`)
  lines.push(`- 别名：${plan.aliases.length === 0 ? '（无）' : plan.aliases.join('、')}`)
  lines.push(`- 性别：${plan.gender === '' ? '未知' : plan.gender}`)
  lines.push(`- 基线外貌：${plan.stableTraits.baseAppearance === '' ? '（原文未写）' : plan.stableTraits.baseAppearance}`)
  lines.push(`- 基线身份：${plan.stableTraits.baseIdentity === '' ? '（原文未写）' : plan.stableTraits.baseIdentity}`)
  lines.push(
    `- 永久特征：${plan.stableTraits.permanentFeatures === '' ? '（原文未写）' : plan.stableTraits.permanentFeatures}`,
  )
  lines.push(`- 出场章节：${chapterRanges(plan.chapters)}`)
  lines.push(`- 置信度：${plan.confidence}`)
  lines.push('')
  lines.push('## 稳定关系')
  lines.push('| 对象 | 关系 | 依据 |')
  lines.push('|---|---|---|')
  if (plan.relationsGraph.length === 0) {
    lines.push('| （无） |  |  |')
  } else {
    for (const relation of plan.relationsGraph) {
      const evidence =
        relation.quote === ''
          ? chapterRanges(relation.chapters)
          : `${chapterRanges(relation.chapters)}：${relation.quote}`
      lines.push(`| ${relation.target} | ${relation.type} | ${evidence} |`)
    }
  }
  lines.push('')
  lines.push('## 阶段索引')
  if (plan.phases.length === 0) {
    lines.push('- （未切出阶段）')
  } else {
    for (const phase of plan.phases) {
      lines.push(`- ${phase.phaseId} ${phase.label}：${chapterRanges(phase.chapters)} → [${phase.fileName}](${phase.fileName})`)
    }
  }
  lines.push('')
  lines.push('## 出场章节')
  for (const chapter of uniqueSortedChapters(plan.chapters)) {
    lines.push(`- 第${chapter}章《${titleOf(titles, chapter)}》`)
  }
  lines.push('')
  lines.push('## 原文依据')
  lines.push(renderSources(plan.sources))
  lines.push('')
  lines.push('## 下游使用（生图 / 检索）')
  lines.push('组合方式：**实体卡（本文件）+ 目标阶段卡**，不要使用实体卡字段的并集。')
  for (const phase of plan.phases) {
    lines.push(`- 第${phase.chapters[0] ?? 0}-${phase.chapters[phase.chapters.length - 1] ?? 0}章 → \`${phase.fileName}\``)
  }
  lines.push('')
  return `${lines.join('\n')}`
}

/**
 * 渲染阶段卡 `phase_XX_<label>.md`。
 * @param plan - 所属角色计划。
 * @param phase - 阶段数据。
 * @param titles - 章号 → 章节标题。
 * @param clothingRefs - 该阶段关联的衣物卡相对路径。
 * @param itemRefs - 该阶段关联的物品卡相对路径。
 * @returns Markdown 文本。
 */
export function renderPhaseCard(
  plan: CharacterPlan,
  phase: PhaseSegment,
  titles: Map<number, string>,
  clothingRefs: string[],
  itemRefs: string[],
): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`phase_id: ${phase.phaseId}`)
  lines.push(`character_id: ${plan.id}`)
  lines.push(`character_name: ${q(plan.name)}`)
  lines.push(`label: ${q(phase.label)}`)
  lines.push(`chapters: [${chapterList(phase.chapters)}]`)
  lines.push(`age: ${q(phase.age.primary)}`)
  lines.push(`identity: ${q(phase.identity.primary)}`)
  lines.push(`appearance: ${q(phase.appearance.primary)}`)
  lines.push('clothing_refs:')
  if (clothingRefs.length === 0) lines.push('  []')
  else for (const ref of clothingRefs) lines.push(`  - ${q(ref)}`)
  lines.push('item_refs:')
  if (itemRefs.length === 0) lines.push('  []')
  else for (const ref of itemRefs) lines.push(`  - ${q(ref)}`)
  lines.push('relations:')
  if (phase.relations.length === 0) {
    lines.push('  []')
  } else {
    for (const relation of phase.relations) {
      lines.push(`  - target: ${q(relation.target)}`)
      lines.push(`    type: ${q(relation.type)}`)
      lines.push(`    chapters: [${chapterList(relation.chapters)}]`)
    }
  }
  lines.push(`allowed_names: ${inlineArray(phase.allowedNames)}`)
  lines.push(`forbidden_names: ${inlineArray(phase.forbiddenNames)}`)
  lines.push(`confidence: ${phase.confidence}`)
  lines.push('sources:')
  if (phase.sources.length === 0) {
    lines.push('  []')
  } else {
    for (const source of phase.sources) {
      lines.push(`  - chapter: ${source.chapter}`)
      lines.push(`    quote: ${q(source.quote)}`)
    }
  }
  lines.push('---')
  lines.push(`# ${plan.name} - ${phase.label}${phase.note === '' ? '' : ` ${phase.note}`}`)
  lines.push('')
  lines.push('## 阶段范围')
  const first = phase.chapters[0] ?? 0
  const last = phase.chapters[phase.chapters.length - 1] ?? 0
  lines.push(`- 第${first}章《${titleOf(titles, first)}》至第${last}章《${titleOf(titles, last)}》`)
  lines.push(`- 覆盖章号：${chapterList(phase.chapters)}`)
  if (phase.signals.length > 0) lines.push(`- 切分依据：${phase.signals.join('；')}`)
  lines.push('')
  lines.push('## 年龄')
  lines.push(phase.age.primary === '' ? '（原文未写）' : phase.age.primary)
  if (phase.age.conflict) {
    lines.push('')
    lines.push(`> 阶段内取值并存（汇总时保留）：${phase.age.values.map((value) => value.value).join('；')}`)
  }
  lines.push('')
  lines.push('## 身份')
  lines.push(phase.identity.primary === '' ? '（原文未写）' : phase.identity.primary)
  if (phase.identity.conflict) {
    lines.push('')
    lines.push(`> 阶段内取值并存（汇总时保留）：${phase.identity.values.map((value) => value.value).join('；')}`)
  }
  lines.push('')
  lines.push('## 外貌')
  lines.push(phase.appearance.primary === '' ? '（原文未写）' : phase.appearance.primary)
  if (phase.appearance.conflict) {
    lines.push('')
    lines.push(`> 阶段内取值并存（汇总时保留）：${phase.appearance.values.map((value) => value.value).join('；')}`)
  }
  lines.push('')
  lines.push('## 着装')
  if (phase.clothing.length === 0) {
    lines.push('- （原文未写）')
  } else {
    for (const entry of phase.clothing) lines.push(`- ${entry}`)
  }
  if (clothingRefs.length > 0) {
    lines.push('')
    for (const ref of clothingRefs) lines.push(`- 衣物卡：\`${ref}\``)
  }
  if (itemRefs.length > 0) {
    lines.push('')
    for (const ref of itemRefs) lines.push(`- 物品卡：\`${ref}\``)
  }
  lines.push('')
  lines.push('## 阶段关系')
  lines.push('| 对象 | 关系 | 依据 |')
  lines.push('|---|---|---|')
  if (phase.relations.length === 0) {
    lines.push('| （无） |  |  |')
  } else {
    for (const relation of phase.relations) {
      const evidence =
        relation.quote === ''
          ? chapterRanges(relation.chapters)
          : `${chapterRanges(relation.chapters)}：${relation.quote}`
      lines.push(`| ${relation.target} | ${relation.type} | ${evidence} |`)
    }
  }
  lines.push('')
  lines.push('## 本阶段允许称呼')
  lines.push(phase.allowedNames.length === 0 ? '（无）' : phase.allowedNames.join('、'))
  lines.push('')
  lines.push('## 本阶段禁止称呼')
  lines.push(phase.forbiddenNames.length === 0 ? '（无）' : phase.forbiddenNames.join('、'))
  lines.push('')
  lines.push(`## 置信度`)
  lines.push(phase.confidence)
  lines.push('')
  lines.push('## 原文依据')
  lines.push(renderSources(phase.sources))
  lines.push('')
  return `${lines.join('\n')}`
}

// --------------------------------------------------------------------------- //
// 衣物卡 / 物品卡
// --------------------------------------------------------------------------- //

/** 归并后的衣物卡数据。 */
export interface ClothingCardPlan {
  id: string
  character: string
  characterId: string
  phaseId: string
  scene: string
  description: string
  colorMaterial: string
  chapters: number[]
  confidence: Confidence
  sources: Array<{ chapter: number; quote: string }>
  /** 相对工作区根的卡片路径。 */
  relPath: string
}

/** 归并后的物品卡数据。 */
export interface ItemCardPlan {
  id: string
  name: string
  type: string
  appearance: string
  function: string
  holder: string
  characterId: string
  phaseId: string
  chapters: number[]
  confidence: Confidence
  sources: Array<{ chapter: number; quote: string }>
  relPath: string
}

/** 在角色计划中找到包含指定章号的阶段。 */
function phaseForChapter(plan: CharacterPlan | undefined, chapter: number): string {
  if (plan === undefined) return ''
  const hit = plan.phases.find((phase) => phase.chapters.includes(chapter))
  return hit?.phaseId ?? plan.phases[0]?.phaseId ?? ''
}

/**
 * 归并衣物卡：按 `character` + `scene` 聚合，多套加序号（一）（二）……
 * @param payloads - 逐章 payload。
 * @param plans - 角色计划。
 * @param clothingRelDir - 相对工作区根的 `clothing/` 目录。
 * @returns 衣物卡数据（按角色首章、场景、章号排序）。
 */
export function planClothingCards(
  payloads: ChapterPayload[],
  plans: CharacterPlan[],
  clothingRelDir: string,
): ClothingCardPlan[] {
  const records: ClothingRecord[] = payloads.flatMap((payload) => payload.clothing)
  const byMaster = new Map<string, CharacterPlan>()
  for (const plan of plans) {
    byMaster.set(plan.name, plan)
    for (const alias of plan.aliases) byMaster.set(alias, plan)
  }

  const groups = new Map<string, ClothingRecord[]>()
  for (const record of records) {
    const plan = byMaster.get(record.character)
    const master = plan?.name ?? record.character
    const key = `${master}\u0000${record.scene}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [record])
    else bucket.push(record)
  }

  const plansOut: ClothingCardPlan[] = []
  const usedNames = new Set<string>()

  const orderedKeys = [...groups.keys()].sort((left, right) => {
    const [leftName = '', leftScene = ''] = left.split('\u0000')
    const [rightName = '', rightScene = ''] = right.split('\u0000')
    const leftPlan = byMaster.get(leftName)
    const rightPlan = byMaster.get(rightName)
    const leftFirst = leftPlan?.firstChapter ?? 0
    const rightFirst = rightPlan?.firstChapter ?? 0
    if (leftFirst !== rightFirst) return leftFirst - rightFirst
    if (leftName !== rightName) return compareStrings(leftName, rightName)
    return compareStrings(leftScene, rightScene)
  })

  let counter = 0
  for (const key of orderedKeys) {
    const bucket = groups.get(key)!
    const [master = '', scene = ''] = key.split('\u0000')
    const plan = byMaster.get(master)

    // 同一「角色+场景」出现多套衣物 → 加序号，序号按章号升序分配。
    const distinct = [...new Set(bucket.map((record) => record.description))]
    const ordered = [...bucket].sort((left, right) => left.chapter - right.chapter)
    const slots = distinct.length <= 1 ? [ordered] : distinct.map((description) => ordered.filter((record) => record.description === description))

    let position = 0
    for (const slot of slots) {
      position += 1
      if (slot.length === 0) continue
      counter += 1
      const sceneLabel = distinct.length <= 1 ? scene : `${scene}（${'一二三四五六七八九十'[position - 1] ?? String(position)}）`
      const chapters = uniqueSortedChapters(slot.map((record) => record.chapter))
      const first = slot[0]!
      const characterId = plan?.id ?? ''
      const phaseId = phaseForChapter(plan, chapters[0] ?? first.chapter)

      const base = sanitizeFileName(`${master}-${sceneLabel}`)
      let name = base
      let suffix = 2
      while (usedNames.has(name)) {
        name = `${base}_${suffix}`
        suffix += 1
      }
      usedNames.add(name)

      const sources: Array<{ chapter: number; quote: string }> = []
      for (const record of slot) {
        if (record.quote !== '') sources.push({ chapter: record.chapter, quote: record.quote })
      }

      plansOut.push({
        id: `cloth_${String(counter).padStart(4, '0')}`,
        character: master,
        characterId,
        phaseId,
        scene: sceneLabel,
        description: distinct.filter((description) => slot.some((record) => record.description === description)).join('；'),
        colorMaterial: [...new Set(slot.map((record) => record.colorMaterial).filter((value) => value !== ''))].join('；'),
        chapters,
        confidence: '高',
        sources,
        relPath: `${clothingRelDir}/${name}.md`,
      })
    }
  }

  return plansOut
}

/**
 * 归并物品卡：按 `name` 聚合，保留每章一条来源。
 * @param payloads - 逐章 payload。
 * @param plans - 角色计划。
 * @param itemsRelDir - 相对工作区根的 `items/` 目录。
 * @returns 物品卡数据（按首章、名称排序）。
 */
export function planItemCards(
  payloads: ChapterPayload[],
  plans: CharacterPlan[],
  itemsRelDir: string,
): ItemCardPlan[] {
  const records: ItemRecord[] = payloads.flatMap((payload) => payload.items)
  const byMaster = new Map<string, CharacterPlan>()
  for (const plan of plans) {
    byMaster.set(plan.name, plan)
    for (const alias of plan.aliases) byMaster.set(alias, plan)
  }

  const groups = new Map<string, ItemRecord[]>()
  for (const record of records) {
    const bucket = groups.get(record.name)
    if (bucket === undefined) groups.set(record.name, [record])
    else bucket.push(record)
  }

  const usedNames = new Set<string>()
  const out: ItemCardPlan[] = []
  let counter = 0

  for (const name of [...groups.keys()].sort(compareStrings)) {
    const bucket = [...groups.get(name)!].sort((left, right) => left.chapter - right.chapter)
    counter += 1

    // 每章一条来源：同章取信息量最大的一条。
    const perChapter = new Map<number, ItemRecord>()
    for (const record of bucket) {
      const existing = perChapter.get(record.chapter)
      const richness = (item: ItemRecord): number =>
        (item.function !== '' ? 2 : 0) + (item.holder !== '' ? 2 : 0) + (item.appearance !== '' ? 1 : 0)
      if (existing === undefined || richness(record) > richness(existing)) perChapter.set(record.chapter, record)
    }
    const ordered = [...perChapter.values()].sort((left, right) => left.chapter - right.chapter)
    const sources = ordered
      .filter((record) => record.quote !== '')
      .map((record) => ({ chapter: record.chapter, quote: record.quote }))
    const chapters = uniqueSortedChapters(ordered.map((record) => record.chapter))
    const first = ordered[0]!

    const holder = [...new Set(ordered.map((record) => record.holder).filter((value) => value !== ''))].join('；')
    const plan = byMaster.get(first.holder)
    const characterId = plan?.id ?? ''
    const phaseId = phaseForChapter(plan, chapters[0] ?? first.chapter)
    const type = [...new Set(ordered.map((record) => record.type).filter((value) => value !== ''))][0] ?? ''
    const appearance = [...new Set(ordered.map((record) => record.appearance).filter((value) => value !== ''))].join('；')
    const func = [...new Set(ordered.map((record) => record.function).filter((value) => value !== ''))].join('；')

    const base = sanitizeFileName(name)
    let fileName = base
    let suffix = 2
    while (usedNames.has(fileName)) {
      fileName = `${base}_${suffix}`
      suffix += 1
    }
    usedNames.add(fileName)

    out.push({
      id: `item_${String(counter).padStart(4, '0')}`,
      name,
      type,
      appearance,
      function: func,
      holder,
      characterId,
      phaseId,
      chapters,
      confidence: '高',
      sources,
      relPath: `${itemsRelDir}/${fileName}.md`,
    })
  }

  return out
}

/**
 * 渲染衣物卡。
 * @param card - 衣物卡数据。
 * @param titles - 章号 → 标题。
 * @returns Markdown 文本。
 */
export function renderClothingCard(card: ClothingCardPlan, titles: Map<number, string>): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`id: ${card.id}`)
  lines.push(`character: ${q(card.character)}`)
  lines.push(`character_id: ${card.characterId}`)
  lines.push(`phase_id: ${card.phaseId}`)
  lines.push(`scene: ${q(card.scene)}`)
  lines.push(`description: ${q(card.description)}`)
  lines.push(`color_material: ${q(card.colorMaterial)}`)
  lines.push(`chapters: [${chapterList(card.chapters)}]`)
  lines.push(`chapter: ${card.chapters[0] ?? 0}`)
  lines.push(`confidence: ${card.confidence}`)
  lines.push('sources:')
  if (card.sources.length === 0) lines.push('  []')
  else for (const source of card.sources) {
    lines.push(`  - chapter: ${source.chapter}`)
    lines.push(`    quote: ${q(source.quote)}`)
  }
  lines.push('---')
  lines.push(`# ${card.character} - ${card.scene}`)
  lines.push('')
  lines.push('## 描述')
  lines.push(card.description)
  lines.push('')
  lines.push('## 颜色/材质')
  lines.push(card.colorMaterial === '' ? '（原文未写）' : card.colorMaterial)
  lines.push('')
  lines.push('## 所属阶段')
  lines.push(`- 角色：${card.character}${card.characterId === '' ? '' : `（${card.characterId}）`}`)
  lines.push(`- 阶段：${card.phaseId === '' ? '（未关联）' : card.phaseId}`)
  lines.push(`- 章节：${chapterRanges(card.chapters)}`)
  lines.push('')
  lines.push('## 出场章节')
  for (const chapter of uniqueSortedChapters(card.chapters)) {
    lines.push(`- 第${chapter}章《${titleOf(titles, chapter)}》`)
  }
  lines.push('')
  lines.push('## 原文依据')
  lines.push(renderSources(card.sources))
  lines.push('')
  return `${lines.join('\n')}`
}

/**
 * 渲染物品卡。
 * @param card - 物品卡数据。
 * @param titles - 章号 → 标题。
 * @returns Markdown 文本。
 */
export function renderItemCard(card: ItemCardPlan, titles: Map<number, string>): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`id: ${card.id}`)
  lines.push(`name: ${q(card.name)}`)
  lines.push(`type: ${q(card.type)}`)
  lines.push(`appearance: ${q(card.appearance)}`)
  lines.push(`function: ${q(card.function)}`)
  lines.push(`holder: ${q(card.holder)}`)
  lines.push(`character_id: ${card.characterId}`)
  lines.push(`phase_id: ${card.phaseId}`)
  lines.push(`chapters: [${chapterList(card.chapters)}]`)
  lines.push(`confidence: ${card.confidence}`)
  lines.push('sources:')
  if (card.sources.length === 0) lines.push('  []')
  else for (const source of card.sources) {
    lines.push(`  - chapter: ${source.chapter}`)
    lines.push(`    quote: ${q(source.quote)}`)
  }
  lines.push('---')
  lines.push(`# ${card.name}`)
  lines.push('')
  lines.push('## 类型')
  lines.push(card.type === '' ? '（原文未写）' : card.type)
  lines.push('')
  lines.push('## 外观')
  lines.push(card.appearance === '' ? '（原文未写）' : card.appearance)
  lines.push('')
  lines.push('## 功能')
  lines.push(card.function === '' ? '（原文未写）' : card.function)
  lines.push('')
  lines.push('## 持有者')
  lines.push(card.holder === '' ? '（无主）' : card.holder)
  lines.push('')
  lines.push('## 所属阶段')
  lines.push(`- 角色：${card.holder === '' ? '（无主）' : card.holder}${card.characterId === '' ? '' : `（${card.characterId}）`}`)
  lines.push(`- 阶段：${card.phaseId === '' ? '（未关联）' : card.phaseId}`)
  lines.push(`- 章节：${chapterRanges(card.chapters)}`)
  lines.push('')
  lines.push('## 出场章节')
  for (const chapter of uniqueSortedChapters(card.chapters)) {
    lines.push(`- 第${chapter}章《${titleOf(titles, chapter)}》`)
  }
  lines.push('')
  lines.push('## 原文依据')
  lines.push(renderSources(card.sources))
  lines.push('')
  return `${lines.join('\n')}`
}

// --------------------------------------------------------------------------- //
// 索引
// --------------------------------------------------------------------------- //

/** `cards/_index.json` 的形状。 */
export interface CardsIndex {
  characters: Array<{
    id: string
    name: string
    dir: string
    entity_file: string
    chapters: number[]
    phases: Array<{ phase_id: string; label: string; file: string; chapters: number[] }>
  }>
  clothing: Array<{
    id: string
    character: string
    character_id: string
    phase_id: string
    scene: string
    name: string
    file: string
    chapters: number[]
  }>
  items: Array<{
    id: string
    name: string
    type: string
    holder: string
    character_id: string
    phase_id: string
    file: string
    chapters: number[]
  }>
}

/** `extracted/_index.json` 的形状（保留原有字段，另加 entity/phase 路径）。 */
export interface ExtractedIndex {
  source_dir: string
  cards_dir: string
  chapter_count: number
  processed: number[]
  failed: Array<JsonObject>
  counts: { characters: number; phases: number; clothing: number; items: number }
  cards: {
    characters: string[]
    character_phases: string[]
    clothing: string[]
    items: string[]
  }
}

/**
 * 渲染 `_index.md`。
 * @param index - `cards/_index.json` 的内容。
 * @param plans - 角色计划（取阶段数）。
 * @param clothing - 衣物卡计划。
 * @param items - 物品卡计划。
 * @returns Markdown 文本。
 */
export function renderCardsIndexMd(
  index: CardsIndex,
  plans: CharacterPlan[],
  clothing: ClothingCardPlan[],
  items: ItemCardPlan[],
): string {
  const phases = plans.reduce((sum, plan) => sum + plan.phases.length, 0)
  const lines: string[] = []
  lines.push('# 卡片索引')
  lines.push('')
  lines.push(
    `共 ${plans.length} 个角色实体、${phases} 张阶段卡、${clothing.length} 张衣物卡、${items.length} 张物品卡。`,
  )
  lines.push('')
  lines.push('生图 / 下游使用：取「实体卡 + 目标阶段卡」，不要使用实体卡字段的并集。')
  lines.push('')
  lines.push('## 角色实体卡')
  lines.push('| ID | 姓名 | 基线身份 | 出场章节 | 阶段数 | 实体卡 |')
  lines.push('|---|---|---|---|---|---|')
  for (const plan of plans) {
    const rel = index.characters.find((entry) => entry.id === plan.id)?.entity_file ?? ''
    const label = rel === '' ? plan.name : `[${plan.name}](${rel.replace(/^.*\/characters\//u, 'characters/')})`
    lines.push(
      `| ${plan.id} | ${plan.name} | ${plan.stableTraits.baseIdentity === '' ? '—' : plan.stableTraits.baseIdentity} | ${chapterList(plan.chapters)} | ${plan.phases.length} | ${label} |`,
    )
  }
  lines.push('')
  lines.push('## 阶段卡')
  lines.push('| 角色 | 阶段 | 标签 | 章节 | 时变关系 | 文件 |')
  lines.push('|---|---|---|---|---|---|')
  for (const plan of plans) {
    const entry = index.characters.find((item) => item.id === plan.id)
    for (const phase of plan.phases) {
      const rel = entry?.phases.find((item) => item.phase_id === phase.phaseId)?.file ?? ''
      const link = rel === '' ? phase.fileName : `[${phase.fileName}](${rel.replace(/^.*\/characters\//u, 'characters/')})`
      lines.push(
        `| ${plan.name} | ${phase.phaseId} | ${phase.label} | ${chapterList(phase.chapters)} | ${phase.relations.length === 0 ? '—' : phase.relations.map((relation) => `${relation.target}(${relation.type})`).join('、')} | ${link} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 衣物卡')
  lines.push('| ID | 角色 | 阶段 | 场景 | 章节 | 文件 |')
  lines.push('|---|---|---|---|---|---|')
  for (const card of index.clothing) {
    lines.push(
      `| ${card.id} | ${card.character} | ${card.phase_id === '' ? '—' : card.phase_id} | ${card.scene} | ${chapterList(card.chapters)} | [${card.name}](${card.file.replace(/^.*\/clothing\//u, 'clothing/')}) |`,
    )
  }
  lines.push('')
  lines.push('## 物品卡')
  lines.push('| ID | 名称 | 类型 | 持有者 | 阶段 | 章节 | 文件 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const card of index.items) {
    lines.push(
      `| ${card.id} | ${card.name} | ${card.type} | ${card.holder === '' ? '—' : card.holder} | ${card.phase_id === '' ? '—' : card.phase_id} | ${chapterList(card.chapters)} | [${card.name}](${card.file.replace(/^.*\/items\//u, 'items/')}) |`,
    )
  }
  lines.push('')
  return `${lines.join('\n')}`
}

// --------------------------------------------------------------------------- //
// 主流程
// --------------------------------------------------------------------------- //

/** `aggregateCards()` 的入参。 */
export interface AggregateOptions {
  /** 逐章 JSON 目录（`@extracted_dir`）。 */
  extractedDir: string
  /** 卡片输出目录（`@cards_dir`）。 */
  cardsDir: string
  /** 工作区根目录，用于生成 `_index.json` 里的相对路径；默认 `process.cwd()`。 */
  root?: string
  /** 读 `_progress.json` 的 `failed` 写入 `extracted/_index.json`。 */
  progressFile?: string
}

/** `aggregateCards()` 的返回值。 */
export interface AggregateResult {
  characterCount: number
  phaseCount: number
  clothingCount: number
  itemCount: number
  charactersDir: string
  clothingDir: string
  itemsDir: string
  index: CardsIndex
  extractedIndex: ExtractedIndex
  warnings: string[]
}

/**
 * 执行完整汇总写盘。
 *
 * @param options - 目录参数。
 * @returns 统计结果。
 * @throws `extractedDir` 不存在时抛出。
 */
export async function aggregateCards(options: AggregateOptions): Promise<AggregateResult> {
  const extractedDir = path.resolve(options.extractedDir)
  const cardsDir = path.resolve(options.cardsDir)
  const root = path.resolve(options.root ?? process.cwd())

  const { payloads, warnings: loadWarnings } = await loadChapterPayloads(extractedDir)
  const bundle = planCharacters(payloads)
  const plans = bundle.characters
  const titles = await loadChapterTitles(extractedDir)

  // ---- 目录准备 ---------------------------------------------------------
  const charactersDir = path.join(cardsDir, 'characters')
  const clothingDir = path.join(cardsDir, 'clothing')
  const itemsDir = path.join(cardsDir, 'items')
  for (const dir of [cardsDir, charactersDir, clothingDir, itemsDir]) {
    await mkdir(dir, { recursive: true })
  }

  const rel = (absolute: string): string => toPosix(path.relative(root, absolute)) || '.'
  const charactersRelDir = rel(charactersDir)
  const clothingRelDir = rel(clothingDir)
  const itemsRelDir = rel(itemsDir)

  // ---- 角色：一人一目录 --------------------------------------------------
  const indexEntries = characterIndexEntries(plans, { charactersRelDir })
  const characterFiles: Array<{ file: string; text: string }> = []

  // 衣物 / 物品先算好：阶段卡要写 clothing_refs / item_refs。
  const clothingCards = planClothingCards(payloads, plans, clothingRelDir)
  const itemCards = planItemCards(payloads, plans, itemsRelDir)
  for (const plan of plans) {
    const dirName = sanitizeFileName(plan.name)
    const planDir = path.join(charactersDir, dirName)
    await mkdir(planDir, { recursive: true })

    characterFiles.push({
      file: path.join(planDir, 'index.md'),
      text: renderEntityCard(plan, titles),
    })
    for (const phase of plan.phases) {
      const clothingRefs = clothingCards
        .filter((card) => card.characterId === plan.id && card.phaseId === phase.phaseId)
        .map((card) => card.relPath)
      const itemRefs = itemCards
        .filter((card) => card.characterId === plan.id && card.phaseId === phase.phaseId)
        .map((card) => card.relPath)
      characterFiles.push({
        file: path.join(planDir, phase.fileName),
        text: renderPhaseCard(plan, phase, titles, clothingRefs, itemRefs),
      })
    }
  }

  for (const entry of characterFiles) await writeFile(entry.file, entry.text, 'utf8')

  // ---- 衣物卡 / 物品卡 ---------------------------------------------------
  for (const card of clothingCards) {
    await writeFile(path.join(cardsDir, 'clothing', path.basename(card.relPath)), renderClothingCard(card, titles), 'utf8')
  }
  for (const card of itemCards) {
    await writeFile(path.join(cardsDir, 'items', path.basename(card.relPath)), renderItemCard(card, titles), 'utf8')
  }

  // ---- 索引 --------------------------------------------------------------
  const index: CardsIndex = {
    characters: indexEntries,
    clothing: clothingCards.map((card) => ({
      id: card.id,
      character: card.character,
      character_id: card.characterId,
      phase_id: card.phaseId,
      scene: card.scene,
      name: `${card.character} - ${card.scene}`,
      file: card.relPath,
      chapters: card.chapters,
    })),
    items: itemCards.map((card) => ({
      id: card.id,
      name: card.name,
      type: card.type,
      holder: card.holder,
      character_id: card.characterId,
      phase_id: card.phaseId,
      file: card.relPath,
      chapters: card.chapters,
    })),
  }

  await writeFile(path.join(cardsDir, '_index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await writeFile(path.join(cardsDir, '_index.md'), renderCardsIndexMd(index, plans, clothingCards, itemCards), 'utf8')
  await writeFile(
    path.join(charactersDir, '_index.json'),
    `${JSON.stringify({ characters: indexEntries }, null, 2)}\n`,
    'utf8',
  )

  // ---- extracted/_index.json --------------------------------------------
  const processed = payloads.map((payload) => payload.chapterIndex)
  const failed: JsonObject[] = []
  if (options.progressFile !== undefined) {
    try {
      const raw = await readFile(path.resolve(options.progressFile), 'utf8')
      const parsed = JSON.parse(raw) as { failed?: unknown }
      if (Array.isArray(parsed.failed)) {
        for (const entry of parsed.failed) if (typeof entry === 'object' && entry !== null) failed.push(entry as JsonObject)
      }
    } catch {
      // 进度文件缺失/损坏不影响汇总。
    }
  }

  let sourceDir = ''
  try {
    const metaRaw = await readFile(path.join(extractedDir, '_meta.json'), 'utf8')
    const meta = JSON.parse(metaRaw) as { source_dir?: unknown }
    if (typeof meta.source_dir === 'string') sourceDir = meta.source_dir
  } catch {
    // 无 _meta.json 时留空。
  }

  const extractedIndex: ExtractedIndex = {
    source_dir: sourceDir,
    cards_dir: cardsDir,
    chapter_count: processed.length,
    processed,
    failed,
    counts: {
      characters: plans.length,
      phases: plans.reduce((sum, plan) => sum + plan.phases.length, 0),
      clothing: clothingCards.length,
      items: itemCards.length,
    },
    cards: {
      characters: indexEntries.map((entry) => entry.entity_file),
      character_phases: indexEntries.flatMap((entry) => entry.phases.map((phase) => phase.file)),
      clothing: clothingCards.map((card) => card.relPath),
      items: itemCards.map((card) => card.relPath),
    },
  }
  await writeFile(
    path.join(extractedDir, '_index.json'),
    `${JSON.stringify(extractedIndex, null, 2)}\n`,
    'utf8',
  )

  const phaseWarnings: string[] = []
  for (const plan of plans) {
    for (const phase of plan.phases) {
      const overlap = phase.forbiddenNames.filter((name) => phase.allowedNames.includes(name))
      if (overlap.length > 0) phaseWarnings.push(`${plan.name}/${phase.phaseId} 禁止称呼与实际称呼重叠：${overlap.join('、')}`)
    }
  }

  return {
    characterCount: plans.length,
    phaseCount: extractedIndex.counts.phases,
    clothingCount: clothingCards.length,
    itemCount: itemCards.length,
    charactersDir,
    clothingDir,
    itemsDir,
    index,
    extractedIndex,
    warnings: [...loadWarnings, ...bundle.warnings, ...phaseWarnings],
  }
}

// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //

/** CLI 参数。 */
export interface AggregateCliArgs {
  extracted?: string
  cards?: string
  root?: string
  progress?: string
  summary?: string
  help: boolean
}

/** 用法文本。 */
export function usage(): string {
  return [
    '用法：aggregate_cards.ts --extracted <extracted_dir> --cards <cards_dir> [--root <dir>] [--summary <file>]',
    '',
    '选项：',
    '  --extracted <dir>   逐章 JSON 目录（@extracted_dir），必填',
    '  --cards <dir>       卡片输出目录（@cards_dir），必填',
    '  --root <dir>        _index.json 相对路径的基准目录（默认当前工作目录）',
    '  --progress <file>   读取 _progress.json 的 failed（默认 <extracted>/_progress.json）',
    '  --summary <file>     统计摘要 JSON 输出路径；省略时写 stdout',
    '  --help              显示本帮助',
  ].join('\n')
}

/**
 * 解析 CLI 参数。
 * @param argv - 参数列表。
 * @returns 解析结果。
 * @throws 未知选项或缺少取值时抛出。
 */
export function parseAggregateArgs(argv: string[]): AggregateCliArgs {
  const args: AggregateCliArgs = { help: false }
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
      case '--cards':
        args.cards = take()
        break
      case '--root':
        args.root = take()
        break
      case '--progress':
        args.progress = take()
        break
      case '--summary':
        args.summary = take()
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
 * @param argv - 参数列表。
 * @returns 退出码：0 成功、1 运行期失败、2 用法/环境错误。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: AggregateCliArgs
  try {
    args = parseAggregateArgs(argv)
  } catch (error) {
    console.error(`错误：${errorMessage(error)}`)
    console.error(usage())
    return 2
  }
  if (args.help) {
    console.log(usage())
    return 0
  }
  if (args.extracted === undefined || args.cards === undefined) {
    console.error('错误：--extracted 与 --cards 均为必填')
    console.error(usage())
    return 2
  }

  try {
    const result = await aggregateCards({
      extractedDir: args.extracted,
      cardsDir: args.cards,
      root: args.root,
      progressFile: args.progress ?? path.join(path.resolve(args.extracted), '_progress.json'),
    })
    const summary = {
      characters: result.characterCount,
      phases: result.phaseCount,
      clothing: result.clothingCount,
      items: result.itemCount,
      cards_dir: path.resolve(args.cards),
      warnings: result.warnings,
    }
    const text = `${JSON.stringify(summary, null, 2)}\n`
    if (args.summary === undefined) {
      console.log(text.trimEnd())
    } else {
      await mkdir(path.dirname(path.resolve(args.summary)), { recursive: true })
      await writeFile(path.resolve(args.summary), text, 'utf8')
      console.log(
        `汇总完成：角色实体 ${result.characterCount}，阶段卡 ${result.phaseCount}，衣物 ${result.clothingCount}，物品 ${result.itemCount}，输出 ${path.resolve(args.cards)}`,
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

/** 供测试直接构造计划时复用。 */
export type { CharacterPlan, PhaseSegment }
