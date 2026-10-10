/**
 * 人物**实体卡**自测（`index.md` + `cards/characters/_index.json`）。
 *
 * 覆盖：
 * - 实体卡只含跨阶段稳定信息，**不得**出现年龄 / 身份 / 外貌 / 别名的并集；
 * - 别名分阶段：只在个别阶段出现的称呼不进实体卡 `aliases`，进阶段卡 `allowed_names`；
 * - 稳定关系进 `relations_graph`，时变关系留给阶段卡；
 * - 同名不同人守卫：某称呼是别人的主名时不并入本卡别名；
 * - `characterIndexEntries()` 的 `phases` 索引形状；
 * - 实体卡 frontmatter 与 `schemas/character-entity.schema.json` 一致。
 *
 * 运行::
 *
 *     node --test --test-isolation=none .dsh/skills/character-extraction/scripts/character-entity.test.ts
 *     npx tsx --test .dsh/skills/character-extraction/scripts/character-entity.test.ts
 *
 * @module character-extraction/scripts/character-entity.test
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { aggregateCards, renderEntityCard } from './aggregate_cards.ts'
import {
  characterIndexEntries,
  mergeCharacters,
  planCharacters,
  type CharacterPlan,
} from './phase-plan.ts'
import { loadSchemas, validateInstance } from './schema-validator.ts'
import { isPlainObject } from './util.ts'
import { luyunGear, luyunPayloads, makeWorkspace, record } from './test-fixtures.ts'

/** schema 目录（脚本位于 `<skill>/scripts`）。 */
const SCHEMA_DIR = path.resolve(import.meta.dirname, '..', 'schemas')

/** 取卢云的计划。 */
function luyunPlan(): CharacterPlan {
  const bundle = planCharacters(luyunPayloads())
  const plan = bundle.characters.find((character) => character.name === '卢云')
  assert.ok(plan !== undefined, '必须切出卢云的计划')
  return plan
}

/**
 * 从 Markdown frontmatter 粗解析成键值对（只用于断言字段是否存在）。
 * @param markdown - 卡片全文。
 * @returns frontmatter 的顶层键列表。
 */
function frontmatterKeys(markdown: string): string[] {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown)
  assert.ok(match !== null, '卡片必须有 frontmatter')
  return match[1]!
    .split('\n')
    .filter((line) => /^[A-Za-z_]+:/u.test(line))
    .map((line) => line.slice(0, line.indexOf(':')))
}

test('实体卡：只含跨阶段稳定信息，没有年龄/身份/外貌/别名并集', () => {
  const plan = luyunPlan()
  const markdown = renderEntityCard(plan, new Map())

  const keys = frontmatterKeys(markdown)
  for (const forbidden of ['age', 'identity', 'appearance', 'clothing_refs', 'item_refs']) {
    assert.ok(!keys.includes(forbidden), `实体卡 frontmatter 不得含 ${forbidden}：${keys.join(',')}`)
  }
  for (const required of [
    'id',
    'name',
    'aliases',
    'gender',
    'stable_traits',
    'relations_graph',
    'first_chapter',
    'chapters',
    'confidence',
    'phases',
    'sources',
  ]) {
    assert.ok(keys.includes(required), `实体卡 frontmatter 必须含 ${required}：${keys.join(',')}`)
  }

  // 正文也不得出现阶段专属字段小节
  for (const forbidden of ['## 年龄', '## 外貌', '## 着装']) {
    assert.ok(!markdown.includes(forbidden), `实体卡正文不得含「${forbidden}」小节`)
  }
  assert.ok(markdown.includes('## 阶段索引'), '实体卡必须有阶段索引')
  assert.ok(markdown.includes('实体卡（本文件）+ 目标阶段卡'), '实体卡必须写明下游组合方式')
})

test('实体卡：基线身份取最早形态，永久特征不与阶段并集混同', () => {
  const plan = luyunPlan()

  assert.equal(plan.stableTraits.baseIdentity, '卖面摊贩', '基线身份取最早出现的身份')
  assert.equal(plan.stableTraits.baseAppearance, '眉清目秀，衣衫褴褛')
  assert.equal(plan.stableTraits.permanentFeatures, '眉清目秀，衣衫褴褛')

  // 阶段专属身份不得作为实体卡基线
  assert.ok(!plan.stableTraits.baseIdentity.includes('军中参谋'))
  assert.ok(!plan.stableTraits.baseIdentity.includes('顾府书僮'))
})

test('实体卡：别名分阶段，只在个别阶段出现的称呼不进 aliases', () => {
  const plan = luyunPlan()
  // 每个阶段各有一个专属称呼 → 都只覆盖 1/4 阶段，都不该进实体卡
  assert.ok(!plan.aliases.includes('卖面郎'), `卖面郎 只属卖面时期，不应进实体卡：${plan.aliases.join('、')}`)
  assert.ok(!plan.aliases.includes('小二'))
  assert.ok(!plan.aliases.includes('书僮'))
  assert.ok(!plan.aliases.includes('卢参谋'))
  // 跨阶段通用称呼应保留（「卢兄弟」「姓卢的」都出现在逃犯时期与军中参谋时期）
  assert.deepEqual([...plan.aliases].sort(), ['卢兄弟', '姓卢的'])

  const phase01 = plan.phases[0]!
  assert.ok(phase01.allowedNames.includes('卖面郎'), '卖面时期必须允许「卖面郎」')
  assert.ok(phase01.allowedNames.includes('卢云'))
  const last = plan.phases[plan.phases.length - 1]!
  assert.ok(last.allowedNames.includes('卢参谋'), '军中参谋阶段必须允许「卢参谋」')
  assert.ok(!last.allowedNames.includes('卖面郎'), '军中参谋阶段不得允许「卖面郎」')
})

test('实体卡：稳定关系进 relations_graph，时变关系不在其中', () => {
  const plan = luyunPlan()
  const graph = plan.relationsGraph.map((relation) => `${relation.target}/${relation.type}`)

  assert.ok(graph.includes('顾嗣源/主仆'), `稳定关系应进实体卡：${graph.join('、')}`)
  assert.ok(graph.includes('顾倩兮/恋慕'))
  assert.ok(graph.includes('伍定远/结义兄弟'))
  assert.ok(graph.includes('秦仲海/结义兄弟'))
  assert.ok(graph.includes('牛二/仇敌'), '跨 2 章的仇敌关系算稳定关系')
  assert.ok(!graph.includes('秦仲海/上下级'), '只出现在军中参谋阶段的上下级关系属时变关系')
  assert.ok(!graph.includes('银川公主/护卫'), '只出现 1 章的护卫关系属时变关系')

  const phaseRelations = plan.phases.flatMap((phase) =>
    phase.relations.map((relation) => `${relation.target}/${relation.type}`),
  )
  assert.ok(phaseRelations.includes('秦仲海/上下级'), `阶段卡必须承接时变关系：${phaseRelations.join('、')}`)
  assert.ok(phaseRelations.includes('银川公主/护卫'))
  assert.ok(!phaseRelations.includes('顾嗣源/主仆'), '稳定关系不应重复出现在阶段卡')
  assert.ok(!phaseRelations.includes('伍定远/结义兄弟'), '稳定关系不应重复出现在阶段卡')

  // 阶段卡里的关系只带本阶段章号
  for (const phase of plan.phases) {
    for (const relation of phase.relations) {
      assert.ok(relation.chapters.length > 0, '时变关系必须带章节依据')
      for (const chapter of relation.chapters) {
        assert.ok(phase.chapters.includes(chapter), `${phase.phaseId} 的关系章号 ${chapter} 必须落在本阶段`)
      }
    }
  }
})

test('实体卡：每张卡的 sources 都来自逐章 JSON 且带章号', () => {
  const plan = luyunPlan()
  assert.ok(plan.sources.length > 0)
  for (const source of plan.sources) {
    assert.ok(Number.isInteger(source.chapter))
    assert.ok(source.quote.length > 0)
  }

  const markdown = renderEntityCard(plan, new Map([[10, '落第秀才']]))
  assert.ok(markdown.includes('> 第10章：'), '原文依据必须带章号前缀')
})

test('同名不同人：别名恰好是他人主名时不并入本卡 aliases', () => {
  // 卢云在 3 章里以主名出现；某章把「卢云」错写成另一个角色的别名。
  const records = [
    record({ chapter: 10, name: '卢云', identity: '卖面摊贩', phaseHint: '卖面时期' }),
    record({ chapter: 11, name: '卢云', identity: '卖面摊贩', phaseHint: '卖面时期' }),
    record({ chapter: 13, name: '卢云', identity: '顾府书僮', phaseHint: '书僮时期' }),
    record({ chapter: 14, name: '伍定远', aliases: ['卢云', '伍捕头'], identity: '捕头', phaseHint: '捕头时期' }),
  ]

  const merged = mergeCharacters(records)
  const lu = merged.find((character) => character.name === '卢云')
  const wu = merged.find((character) => character.name === '伍定远')
  assert.ok(lu !== undefined && wu !== undefined, '两人必须各成一组')

  assert.ok(!wu.aliases.includes('卢云'), `伍定远 的别名不得含他人主名「卢云」：${wu.aliases.join('、')}`)
  assert.ok(wu.aliases.includes('伍捕头'), '非主名的普通别名应保留')
  assert.deepEqual(lu.chapters, [10, 11, 13])
  assert.deepEqual(wu.chapters, [14])
})

test('同名跨章合并：同字主名合并为一组并保留主名', () => {
  const merged = mergeCharacters([
    record({ chapter: 10, name: '卢云', aliases: ['卖面郎'], phaseHint: '卖面时期' }),
    record({ chapter: 35, name: '卢云', aliases: ['卢参谋'], phaseHint: '军中参谋' }),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.name, '卢云')
  assert.deepEqual(merged[0]!.chapters, [10, 35])
  // 别名按出现范围排序，两个别名都在
  assert.deepEqual([...merged[0]!.aliases].sort(), ['卖面郎', '卢参谋'])
})

test('阶段索引：characterIndexEntries() 的 dir / entity_file / phases 形状正确', () => {
  const plan = luyunPlan()
  const entries = characterIndexEntries([plan], { charactersRelDir: 'cards/characters' })

  assert.equal(entries.length, 1)
  const entry = entries[0]!
  assert.equal(entry.name, '卢云')
  assert.match(entry.id, /^char_[0-9]{4}$/u)
  assert.equal(entry.dir, 'cards/characters/卢云')
  assert.equal(entry.entity_file, 'cards/characters/卢云/index.md')
  assert.deepEqual(entry.chapters, plan.chapters)
  assert.equal(entry.phases.length, plan.phases.length)

  const phaseIds = entry.phases.map((phase) => phase.phase_id)
  assert.deepEqual(phaseIds, ['phase_01', 'phase_02', 'phase_03', 'phase_04'])
  for (const [index, phase] of entry.phases.entries()) {
    assert.equal(phase.file, `cards/characters/卢云/${plan.phases[index]!.fileName}`)
    assert.ok(phase.chapters.length > 0)
    assert.ok(phase.label.length > 0)
  }

  // 自定义 cards_dir 时必须改用覆盖后的相对路径
  const custom = characterIndexEntries([plan], { charactersRelDir: 'mycards/characters' })
  assert.equal(custom[0]!.entity_file, 'mycards/characters/卢云/index.md')
  assert.equal(custom[0]!.phases[0]!.file, `mycards/characters/卢云/${plan.phases[0]!.fileName}`)
})

test('实体卡 frontmatter 通过 character-entity.schema.json 校验', async () => {
  const schemas = await loadSchemas(SCHEMA_DIR)
  const schema = schemas['character-entity.schema.json']
  assert.ok(schema !== undefined, '必须存在 character-entity.schema.json')

  const plan = luyunPlan()
  const entry = characterIndexEntries([plan], { charactersRelDir: 'cards/characters' })[0]!

  // 用渲染出的卡片回构 frontmatter 对象（字段与模板一一对应）
  const frontmatter = {
    id: plan.id,
    name: plan.name,
    aliases: plan.aliases,
    gender: plan.gender,
    stable_traits: {
      base_appearance: plan.stableTraits.baseAppearance,
      base_identity: plan.stableTraits.baseIdentity,
      permanent_features: plan.stableTraits.permanentFeatures,
    },
    relations_graph: plan.relationsGraph.map((relation) => ({
      target: relation.target,
      type: relation.type,
      chapters: relation.chapters,
    })),
    first_chapter: plan.firstChapter,
    chapters: plan.chapters,
    confidence: plan.confidence,
    phases: entry.phases.map((phase) => ({
      phase_id: phase.phase_id,
      label: phase.label,
      file: phase.file.split('/').pop(),
      chapters: phase.chapters,
    })),
    sources: plan.sources,
  }

  assert.deepEqual(validateInstance(frontmatter, schema, schemas, 'character-entity.schema.json'), [])

  // 反向：把阶段字段塞进实体卡必须报错（accepted 不了 additionalProperties: false）
  const polluted = { ...frontmatter, age: '三十岁不到' }
  assert.ok(
    validateInstance(polluted, schema, schemas, 'character-entity.schema.json').length > 0,
    '实体卡不得接受 age 字段',
  )
})

test('端到端：aggregateCards() 产出 index.md 与 characters/_index.json', async (t) => {
  const workspace = await makeWorkspace(t, luyunPayloads(), luyunGear())
  const result = await aggregateCards({
    extractedDir: workspace.extractedDir,
    cardsDir: workspace.cardsDir,
    root: workspace.root,
  })

  assert.equal(result.characterCount, 1)
  assert.ok(result.phaseCount >= 3, `至少切出 3 个阶段，实际 ${result.phaseCount}`)
  assert.deepEqual(result.warnings, [])

  const indexRaw = await readFile(path.join(workspace.cardsDir, 'characters', '_index.json'), 'utf8')
  const index = JSON.parse(indexRaw) as { characters: Array<Record<string, unknown>> }
  assert.equal(index.characters.length, 1)
  const entry = index.characters[0]!
  assert.equal(entry.name, '卢云')
  assert.equal(entry.entity_file, 'cards/characters/卢云/index.md')
  assert.ok(Array.isArray(entry.phases) && (entry.phases as unknown[]).length >= 3)

  const entity = await readFile(path.join(workspace.cardsDir, 'characters', '卢云', 'index.md'), 'utf8')
  assert.ok(entity.startsWith('---\n'), '实体卡必须有 frontmatter')
  assert.ok(!entity.includes('\nage:'), '实体卡不得含 age')
  assert.ok(!entity.includes('\nidentity:'), '实体卡不得含 identity')

  // 每张阶段卡文件都必须真实存在，并且被 _index.json 覆盖
  for (const phase of entry.phases as Array<{ file: string }>) {
    const raw = await readFile(path.join(workspace.root, ...phase.file.split('/')), 'utf8')
    assert.ok(raw.includes('phase_id:'), `${phase.file} 必须是阶段卡`)
  }

  // _index.json 全量索引用同一份 characters 段
  const cardsIndexRaw = await readFile(path.join(workspace.cardsDir, '_index.json'), 'utf8')
  const cardsIndex = JSON.parse(cardsIndexRaw) as Record<string, unknown>
  assert.ok(isPlainObject(cardsIndex))
  assert.deepEqual(
    (cardsIndex.characters as Array<Record<string, unknown>>)[0]!.entity_file,
    'cards/characters/卢云/index.md',
  )
})
