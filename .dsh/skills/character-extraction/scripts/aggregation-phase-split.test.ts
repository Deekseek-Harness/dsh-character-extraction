/**
 * 汇总阶段切分的端到端自测（`aggregate_cards.ts`）。
 *
 * 覆盖：
 * - 同一角色跨章节 `age` / `identity` / `appearance` 变化 → 切成多个阶段，阶段章节不重叠；
 * - 别名按章节归属到正确阶段（`allowed_names` / `forbidden_names`）；
 * - `forbidden_names` 不包含该阶段实际出现的称呼；
 * - 稳定关系进实体卡 `relations_graph`，时变关系进阶段卡 `relations`；
 * - 衣物卡、物品卡正确关联 `phase_id` / `character_id`；
 * - `cards/characters/_index.json` 的 `phases` 索引正确（覆盖全部阶段卡文件）；
 * - `cards/_index.json` 通过 `cards-index.schema.json` 校验；
 * - quote 溯源：卡片里的每条引用都能在逐章 JSON 里逐字找到（禁止读章节原文）。
 *
 * 运行::
 *
 *     node --test --test-isolation=none .dsh/skills/character-extraction/scripts/aggregation-phase-split.test.ts
 *     npx tsx --test .dsh/skills/character-extraction/scripts/aggregation-phase-split.test.ts
 *
 * @module character-extraction/scripts/aggregation-phase-split.test
 */

import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { aggregateCards, type AggregateResult } from './aggregate_cards.ts'
import { loadSchemas, validateInstance } from './schema-validator.ts'
import { isPlainObject } from './util.ts'
import {
  luyunGear,
  luyunPayloads,
  makeWorkspace,
  payload,
  record,
  type Workspace,
} from './test-fixtures.ts'

/** schema 目录（脚本位于 `<skill>/scripts`）。 */
const SCHEMA_DIR = path.resolve(import.meta.dirname, '..', 'schemas')

/** `cards/characters/_index.json` 的形状。 */
interface CharactersIndex {
  characters: Array<{
    id: string
    name: string
    dir: string
    entity_file: string
    chapters: number[]
    phases: Array<{ phase_id: string; label: string; file: string; chapters: number[] }>
  }>
}

/** `cards/_index.json` 的形状。 */
interface CardsIndex {
  characters: CharactersIndex['characters']
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

/**
 * 读 JSON 文件。
 * @param file - 绝对路径。
 * @returns 解析结果。
 */
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

/** 跑一次完整汇总。 */
async function runAggregate(t: Parameters<typeof makeWorkspace>[0]): Promise<{
  workspace: Workspace
  result: AggregateResult
  index: CardsIndex
  characters: CharactersIndex
  characterDir: string
}> {
  const workspace = await makeWorkspace(t, luyunPayloads(), luyunGear())
  const result = await aggregateCards({
    extractedDir: workspace.extractedDir,
    cardsDir: workspace.cardsDir,
    root: workspace.root,
  })
  const index = await readJson<CardsIndex>(path.join(workspace.cardsDir, '_index.json'))
  const characters = await readJson<CharactersIndex>(
    path.join(workspace.cardsDir, 'characters', '_index.json'),
  )
  return {
    workspace,
    result,
    index,
    characters,
    characterDir: path.join(workspace.cardsDir, 'characters', '卢云'),
  }
}

test('端到端：按 age/identity/appearance 变化切分阶段，阶段章节不重叠', async (t) => {
  const { result, characters, workspace } = await runAggregate(t)

  assert.equal(result.characterCount, 1)
  assert.equal(result.phaseCount, 4)
  assert.deepEqual(result.warnings, [])

  const entry = characters.characters[0]!
  assert.equal(entry.name, '卢云')
  assert.deepEqual(
    entry.phases.map((phase) => [phase.phase_id, phase.label, phase.chapters]),
    [
      ['phase_01', '卖面时期', [10, 11]],
      ['phase_02', '书僮时期', [13, 14, 15]],
      ['phase_03', '逃犯时期', [18, 19]],
      ['phase_04', '军中参谋', [35, 36, 37, 38]],
    ],
  )

  // 阶段章节必须互不重叠，且合起来等于出场章号集合
  const flat = entry.phases.flatMap((phase) => phase.chapters)
  assert.equal(new Set(flat).size, flat.length, '阶段章节不得重叠')
  assert.deepEqual([...flat].sort((left, right) => left - right), entry.chapters)
  // 年龄 / 身份在阶段之间被拆开，而不是并集
  const phaseFiles = await Promise.all(
    entry.phases.map((phase) => readFile(path.join(workspace.root, ...phase.file.split('/')), 'utf8')),
  )
  assert.ok(phaseFiles[0]!.includes('identity: "卖面摊贩"'), '卖面时期必须写卖面摊贩身份')
  assert.ok(phaseFiles[3]!.includes('identity: "征北游击随军参谋"'))
  assert.ok(phaseFiles[0]!.includes('age: "二十七八岁"'))
  assert.ok(phaseFiles[2]!.includes('age: "三十岁不到"'))
  assert.ok(!phaseFiles[3]!.includes('卖面摊贩'), '军中参谋阶段卡不得出现卖面时期的身份')
})

test('端到端：别名按章节归属到正确阶段，forbidden 与实际出现的称呼无交集', async (t) => {
  const { characterDir, characters } = await runAggregate(t)

  const phase01 = await readFile(path.join(characterDir, 'phase_01_卖面时期.md'), 'utf8')
  const phase04 = await readFile(path.join(characterDir, 'phase_04_军中参谋.md'), 'utf8')

  /** 从 frontmatter 里取一个数组字段。 */
  const field = (text: string, key: string): string[] => {
    const match = new RegExp(`${key}: \\[(.*?)\\]\\n`, 'su').exec(text)
    assert.ok(match !== null, `frontmatter 必须有 ${key}`)
    return [...match[1]!.matchAll(/"([^"]+)"/gu)].map((item) => item[1]!)
  }

  // 允许称呼：本阶段实际出现的
  assert.ok(field(phase01, 'allowed_names').includes('卖面郎'), '卖面时期必须允许「卖面郎」')
  assert.ok(field(phase01, 'forbidden_names').includes('卢参谋'), '卖面时期必须禁止后期称呼「卢参谋」')
  assert.ok(field(phase04, 'allowed_names').includes('卢参谋'), '军中参谋必须允许「卢参谋」')
  assert.ok(field(phase04, 'forbidden_names').includes('卖面郎'), '军中参谋时期必须禁止早期称呼「卖面郎」')

  for (const phase of characters.characters[0]!.phases) {
    const text = await readFile(path.join(characterDir, path.basename(phase.file)), 'utf8')
    const allowed = field(text, 'allowed_names')
    const forbidden = field(text, 'forbidden_names')
    const overlap = forbidden.filter((name) => allowed.includes(name))
    assert.deepEqual(overlap, [], `${phase.phase_id} 的 forbidden 与 allowed 不得重叠`)

    // 阶段内实际出现的称呼必须都在 allowed 里（在正文也出现，不在 forbidden 里）
    for (const name of forbidden) {
      assert.ok(!allowed.includes(name))
    }
  }
})

test('端到端：稳定关系在实体卡，时变关系在阶段卡', async (t) => {
  const { characterDir } = await runAggregate(t)

  const entity = await readFile(path.join(characterDir, 'index.md'), 'utf8')
  assert.ok(entity.includes('target: "顾嗣源"'), '实体卡必须有稳定关系 顾嗣源')
  assert.ok(entity.includes('target: "顾倩兮"'))
  assert.ok(entity.includes('target: "伍定远"'))
  assert.ok(!entity.includes('上下级'), '时变关系（上下级）不得进实体卡 relations_graph')
  assert.ok(!entity.includes('护卫'), '时变关系（护卫）不得进实体卡 relations_graph')

  const phase04 = await readFile(path.join(characterDir, 'phase_04_军中参谋.md'), 'utf8')
  assert.ok(phase04.includes('type: "上下级"'), '军中参谋阶段卡必须承接上下级关系')
  assert.ok(phase04.includes('type: "护卫"'))
  assert.ok(!phase04.includes('target: "顾嗣源"'), '稳定关系不得重复写进阶段卡')
})

test('端到端：衣物卡 / 物品卡正确关联 phase_id 与 character_id', async (t) => {
  const { index, result, workspace, characters } = await runAggregate(t)

  assert.equal(result.clothingCount, 3)
  assert.equal(result.itemCount, 1)

  const entry = characters.characters[0]!
  const phaseChapters = new Map(entry.phases.map((phase) => [phase.phase_id, phase.chapters]))

  for (const card of index.clothing) {
    assert.equal(card.character, '卢云')
    assert.equal(card.character_id, entry.id, '衣物卡必须关联角色 ID')
    assert.ok(card.phase_id !== '', '衣物卡必须关联阶段 ID')
    assert.ok(phaseChapters.has(card.phase_id), `衣物卡阶段 ${card.phase_id} 必须存在于阶段索引`)
    assert.ok(
      card.chapters.every((chapter) => phaseChapters.get(card.phase_id)!.includes(chapter)),
      `衣物卡章节 ${card.chapters.join(',')} 必须落在阶段 ${card.phase_id} 内`,
    )

    const text = await readFile(path.join(workspace.root, ...card.file.split('/')), 'utf8')
    assert.ok(text.includes(`phase_id: ${card.phase_id}`), '卡片正文必须写 phase_id')
    assert.ok(text.includes(`character_id: ${entry.id}`))
    assert.ok(text.includes('## 所属阶段'))
  }

  for (const card of index.items) {
    assert.equal(card.name, '郾月大刀')
    assert.equal(card.character_id, entry.id)
    assert.equal(card.phase_id, 'phase_04', '郾月大刀属于军中参谋阶段')
    assert.deepEqual(card.chapters, [38])
    const text = await readFile(path.join(workspace.root, ...card.file.split('/')), 'utf8')
    assert.ok(text.includes('phase_id: phase_04'))
  }

  // 阶段卡的 clothing_refs / item_refs 必须与卡片一致
  const phase04 = await readFile(path.join(workspace.cardsDir, 'characters', '卢云', 'phase_04_军中参谋.md'), 'utf8')
  assert.ok(phase04.includes('cards/clothing/卢云-军中.md'), '阶段卡必须引用军中衣物卡')
  assert.ok(phase04.includes('cards/items/郾月大刀.md'), '阶段卡必须引用郾月大刀物品卡')

  const phase01 = await readFile(path.join(workspace.cardsDir, 'characters', '卢云', 'phase_01_卖面时期.md'), 'utf8')
  assert.ok(!phase01.includes('胄甲'), '卖面时期不得引用军中衣物')
})

test('端到端：cards/characters/_index.json 的 phases 索引覆盖全部阶段卡文件', async (t) => {
  const { characterDir, characters, workspace } = await runAggregate(t)

  const entry = characters.characters[0]!
  assert.equal(entry.dir, 'cards/characters/卢云')
  assert.equal(entry.entity_file, 'cards/characters/卢云/index.md')
  assert.match(entry.id, /^char_[0-9]{4}$/u)

  const files = (await readdir(characterDir)).sort()
  const expected = ['index.md', ...entry.phases.map((phase) => path.basename(phase.file))].sort()
  assert.deepEqual(files, expected, '角色目录只应有 index.md 与阶段卡，且被索引完全覆盖')

  for (const phase of entry.phases) {
    assert.equal(phase.file, `${entry.dir}/${path.basename(phase.file)}`)
    assert.equal((await stat(path.join(workspace.root, ...phase.file.split('/')))).isFile(), true)
  }

  // 顶层 _index.json 复用同一份 characters 段
  assert.deepEqual(characters.characters, await readJson<CharactersIndex>(path.join(workspace.cardsDir, '_index.json')).then((value) => (value as unknown as CharactersIndex).characters))
})

test('端到端：quote 溯源全部命中逐章 JSON（汇总阶段不读章节原文）', async (t) => {
  const { workspace, characterDir, index } = await runAggregate(t)

  // 逐章 JSON 中出现的全部 quote
  const available = new Set<string>()
  for (const name of await readdir(workspace.extractedDir)) {
    if (!/^ch[0-9]+\.json$/u.test(name)) continue
    const document = await readJson<Record<string, unknown>>(path.join(workspace.extractedDir, name))
    const characters = Array.isArray(document.characters) ? document.characters : []
    for (const character of characters) {
      if (!isPlainObject(character) || !Array.isArray(character.sources)) continue
      for (const source of character.sources) {
        if (isPlainObject(source) && typeof source.quote === 'string') available.add(source.quote)
      }
    }
    for (const key of ['clothing', 'items']) {
      const list = Array.isArray(document[key]) ? (document[key] as unknown[]) : []
      for (const entry of list) {
        if (isPlainObject(entry) && typeof entry.quote === 'string') available.add(entry.quote)
      }
    }
  }
  assert.ok(available.size > 0, '逐章 JSON 必须提供 quote')

  const cardQuotes = async (file: string): Promise<string[]> => {
    const text = await readFile(file, 'utf8')
    return [...text.matchAll(/^> 第\d+章：(.*)$/gmu)].map((match) => match[1]!.trim())
  }

  const files = [
    path.join(characterDir, 'index.md'),
    ...(await readdir(characterDir)).filter((name) => name.startsWith('phase_')).map((name) => path.join(characterDir, name)),
    ...index.clothing.map((card) => path.join(workspace.root, ...card.file.split('/'))),
    ...index.items.map((card) => path.join(workspace.root, ...card.file.split('/'))),
  ]

  let checked = 0
  for (const file of files) {
    for (const quote of await cardQuotes(file)) {
      assert.ok(available.has(quote), `${path.basename(file)} 的引用未在逐章 JSON 中找到：${quote}`)
      checked += 1
    }
  }
  assert.ok(checked >= 20, `至少应校验 20 条引用，实际 ${checked}`)

  // 章节原文目录根本不存在：若汇总读了 txt 就会失败
  await assert.rejects(stat(path.join(workspace.root, 'chapters')))
})

test('端到端：cards/_index.json 通过 cards-index.schema.json 校验', async (t) => {
  const { index } = await runAggregate(t)
  const schemas = await loadSchemas(SCHEMA_DIR)
  const schema = schemas['cards-index.schema.json']
  assert.ok(schema !== undefined, '必须存在 cards-index.schema.json')

  assert.deepEqual(validateInstance(index, schema, schemas, 'cards-index.schema.json'), [])

  // 反向：缺少 phase_id 的衣物条目必须报错
  const broken = {
    ...index,
    clothing: index.clothing.map((card) => {
      const copy: Record<string, unknown> = { ...card }
      delete copy.phase_id
      return copy
    }),
  }
  assert.ok(
    validateInstance(broken, schema, schemas, 'cards-index.schema.json').length > 0,
    '衣物条目缺 phase_id 必须报错',
  )
})

test('端到端：cards/characters/_index.json 通过 characters-index.schema.json 校验', async (t) => {
  const { workspace, characters } = await runAggregate(t)
  const schemas = await loadSchemas(SCHEMA_DIR)
  const schema = schemas['characters-index.schema.json']
  assert.ok(schema !== undefined, '必须存在 characters-index.schema.json')

  const raw = await readJson<unknown>(path.join(workspace.cardsDir, 'characters', '_index.json'))
  assert.deepEqual(validateInstance(raw, schema, schemas, 'characters-index.schema.json'), [])
  assert.deepEqual(raw, characters)

  // 反向：缺少 phases 的角色条目必须报错
  const broken = { characters: characters.characters.map((entry) => ({ ...entry, phases: undefined })) }
  assert.ok(
    validateInstance(broken, schema, schemas, 'characters-index.schema.json').length > 0,
    '角色条目缺 phases 必须报错',
  )
})

test('端到端：extracted/_index.json 记录角色/阶段/衣物/物品计数', async (t) => {
  const { workspace, result } = await runAggregate(t)
  const extractedIndex = await readJson<{
    chapter_count: number
    processed: number[]
    counts: { characters: number; phases: number; clothing: number; items: number }
    cards: { characters: string[]; character_phases: string[]; clothing: string[]; items: string[] }
  }>(path.join(workspace.extractedDir, '_index.json'))

  assert.equal(extractedIndex.chapter_count, 11)
  assert.equal(extractedIndex.processed.length, 11)
  assert.deepEqual(extractedIndex.counts, {
    characters: result.characterCount,
    phases: result.phaseCount,
    clothing: result.clothingCount,
    items: result.itemCount,
  })
  assert.deepEqual(extractedIndex.cards.characters, ['cards/characters/卢云/index.md'])
  assert.equal(extractedIndex.cards.character_phases.length, result.phaseCount)
  assert.equal(extractedIndex.cards.clothing.length, result.clothingCount)
  assert.equal(extractedIndex.cards.items.length, result.itemCount)
})

test('端到端：同名不同人不被别名误合并（每人也切自己的阶段）', async (t) => {
  const payloads = [
    ...luyunPayloads(),
    // 另一个角色，别名里出现「卢云」——不得把卢云吞掉，也不得自己变成卢云
    payload(20, [
      record({
        chapter: 20,
        name: '伍云',
        aliases: ['卢云', '小伍'],
        identity: '客栈伙计',
        phaseHint: '伙计时期',
      }),
    ]),
    payload(21, [
      record({
        chapter: 21,
        name: '伍云',
        aliases: ['小伍'],
        identity: '客栈伙计',
        phaseHint: '伙计时期',
      }),
    ]),
  ]
  const workspace = await makeWorkspace(t, payloads, luyunGear())
  const result = await aggregateCards({
    extractedDir: workspace.extractedDir,
    cardsDir: workspace.cardsDir,
    root: workspace.root,
  })

  assert.equal(result.characterCount, 2)
  const characters = await readJson<CharactersIndex>(
    path.join(workspace.cardsDir, 'characters', '_index.json'),
  )
  const names = characters.characters.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['伍云', '卢云'])

  const wu = characters.characters.find((entry) => entry.name === '伍云')!
  assert.deepEqual(wu.chapters, [20, 21])
  const lu = characters.characters.find((entry) => entry.name === '卢云')!
  assert.equal(lu.chapters.includes(20), false, '卢云 第 20 章没有出场记录，不得被并入')
})
