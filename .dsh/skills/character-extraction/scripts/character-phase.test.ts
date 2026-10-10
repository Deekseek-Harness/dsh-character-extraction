/**
 * 人物**阶段卡**与阶段切分自测。
 *
 * 覆盖：
 * - 同一角色跨章节 `age` / `identity` / `appearance` 变化时正确切分阶段；
 * - `phase_hint` 优先切分；单章剧烈变化并入相邻阶段并标 `[短暂]`；
 * - 章节不连续必须开新阶段，且阶段之间章节**不重叠**；
 * - 阶段字段（age / identity / appearance）保留全部并存取值并标冲突；
 * - `forbidden_names` 只含其他阶段的称呼，**与 `allowed_names` 无交集**；
 * - 阶段卡 frontmatter 与 `schemas/character-phase.schema.json` 一致。
 *
 * 运行::
 *
 *     node --test --test-isolation=none .dsh/skills/character-extraction/scripts/character-phase.test.ts
 *     npx tsx --test .dsh/skills/character-extraction/scripts/character-phase.test.ts
 *
 * @module character-extraction/scripts/character-phase.test
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  buildPhaseField,
  collectNameUsage,
  diffState,
  hintKeyOf,
  isCrossPhaseAlias,
  planCharacters,
  resolveHintKeys,
  splitPhases,
  type CharacterPlan,
} from './phase-plan.ts'
import { loadSchemas, validateInstance } from './schema-validator.ts'
import { luyunPayloads, record, payload } from './test-fixtures.ts'

/** schema 目录（脚本位于 `<skill>/scripts`）。 */
const SCHEMA_DIR = path.resolve(import.meta.dirname, '..', 'schemas')

/**
 * 只对阶段切分做单元测试时用的便捷入口。
 * @param records - 单角色逐章记录。
 * @returns 切分结果（章号与标签）。
 */
function split(records: Parameters<typeof splitPhases>[0]): Array<{ hint: string; chapters: number[]; merged: boolean }> {
  return splitPhases(records, new Map()).map((draft) => ({
    hint: draft.hint,
    chapters: draft.records.map((item) => item.chapter),
    merged: draft.merged,
  }))
}

/** 取卢云的计划。 */
function luyunPlan(): CharacterPlan {
  const plan = planCharacters(luyunPayloads()).characters.find((character) => character.name === '卢云')
  assert.ok(plan !== undefined)
  return plan
}

test('切分：identity 不可逆变化 → 开新阶段', () => {
  const phases = split([
    record({ chapter: 10, identity: '卖面摊贩' }),
    record({ chapter: 11, identity: '卖面摊贩' }),
    record({ chapter: 12, identity: '顾府书僮' }),
    record({ chapter: 13, identity: '顾府书僮' }),
  ])
  assert.deepEqual(phases, [
    { hint: '', chapters: [10, 11], merged: false },
    { hint: '', chapters: [12, 13], merged: false },
  ])
})

test('切分：age 跨越 → 开新阶段', () => {
  const phases = split([
    record({ chapter: 10, age: '二十七八岁' }),
    record({ chapter: 11, age: '二十七八岁' }),
    record({ chapter: 12, age: '三十岁不到' }),
    record({ chapter: 13, age: '三十岁不到' }),
  ])
  assert.deepEqual(
    phases.map((phase) => phase.chapters),
    [
      [10, 11],
      [12, 13],
    ],
  )
})

test('切分：appearance 不可逆变化 → 开新阶段', () => {
  const phases = split([
    record({ chapter: 10, appearance: '眉清目秀' }),
    record({ chapter: 11, appearance: '眉清目秀' }),
    record({ chapter: 12, appearance: '身形高大，体格壮硕' }),
    record({ chapter: 13, appearance: '身形高大，体格壮硕' }),
  ])
  assert.deepEqual(
    phases.map((phase) => phase.chapters),
    [
      [10, 11],
      [12, 13],
    ],
  )
})

test('切分：单章变化并入前一阶段并标 [短暂]', () => {
  // 11 与 12 不同（不是回弹），11 单独构成 1 章阶段 → 按规则并入前一阶段并标 [短暂]
  const phases = split([
    record({ chapter: 10, identity: '卖面摊贩' }),
    record({ chapter: 11, identity: '顾府书僮' }),
    record({ chapter: 12, identity: '军中参谋' }),
  ])
  assert.equal(phases.length, 1, '单章阶段必须并入相邻阶段')
  assert.deepEqual(phases[0]!.chapters, [10, 11, 12])
  assert.equal(phases[0]!.merged, true)

  // 提示不同的单章阶段同样并入前一阶段
  const hinted = split([
    record({ chapter: 10, phaseHint: '卖面时期', identity: '卖面摊贩' }),
    record({ chapter: 11, phaseHint: '军中参谋', identity: '卖面摊贩' }),
    record({ chapter: 12, phaseHint: '军中参谋', identity: '卖面摊贩' }),
  ])
  assert.equal(hinted.length, 1)
  assert.deepEqual(hinted[0]!.chapters, [10, 11, 12])
  assert.equal(hinted[0]!.merged, true)
})

test('切分：单章回弹的临时状态不切阶段', () => {
  const phases = split([
    record({ chapter: 10, identity: '卖面摊贩' }),
    record({ chapter: 11, identity: '受伤的卖面摊贩' }), // 只此一章
    record({ chapter: 12, identity: '卖面摊贩' }),
    record({ chapter: 13, identity: '卖面摊贩' }),
  ])
  assert.equal(phases.length, 1, '下一章回弹的变化属阶段内临时状态')
  assert.deepEqual(phases[0]!.chapters, [10, 11, 12, 13])
  assert.equal(phases[0]!.merged, false)
})

test('切分：章节不连续必须开新阶段，且章节不重叠', () => {
  const phases = split([
    record({ chapter: 10, identity: '卖面摊贩' }),
    record({ chapter: 11, identity: '卖面摊贩' }),
    record({ chapter: 20, identity: '卖面摊贩' }), // 中间空缺
    record({ chapter: 21, identity: '卖面摊贩' }),
  ])
  assert.deepEqual(
    phases.map((phase) => phase.chapters),
    [
      [10, 11],
      [20, 21],
    ],
  )

  const seen = new Set<number>()
  for (const phase of phases) {
    for (const chapter of phase.chapters) {
      assert.ok(!seen.has(chapter), `章号 ${chapter} 不得出现在两个阶段`)
      seen.add(chapter)
    }
  }
})

test('切分：phase_hint 优先，相邻同提示必须合并', () => {
  const phases = split([
    record({ chapter: 10, phaseHint: '卖面时期', identity: '卖面摊贩' }),
    record({ chapter: 11, phaseHint: '卖面时期', identity: '卖面摊贩' }),
    record({ chapter: 12, phaseHint: '军中参谋', identity: '军中参谋' }),
    record({ chapter: 13, phaseHint: '军中参谋', identity: '军中参谋' }),
  ])
  assert.deepEqual(
    phases.map((phase) => [phase.hint, phase.chapters]),
    [
      ['卖面时期', [10, 11]],
      ['军中参谋', [12, 13]],
    ],
  )

  // 提示中途出现一次又变回 → 切成三段，但同提示的相邻段不会被合并（中间隔着不同提示）
  const noisy = split([
    record({ chapter: 10, phaseHint: '书僮时期' }),
    record({ chapter: 11, phaseHint: '逃犯时期' }),
    record({ chapter: 12, phaseHint: '书僮时期' }),
  ])
  assert.equal(noisy.length, 1, '两个单章阶段分别并入相邻阶段后应合成一段')
})

test('切分：phase_hint 的纯后缀差异不切阶段（归一比较键）', () => {
  // 「书僮时期 / 书僮 / 书僮阶段」语义相同，不得被切成三段
  const phases = split([
    record({ chapter: 13, phaseHint: '书僮时期', identity: '顾府书僮' }),
    record({ chapter: 14, phaseHint: '书僮', identity: '顾府书僮' }),
    record({ chapter: 15, phaseHint: '书僮阶段', identity: '顾府书僮' }),
    record({ chapter: 16, phaseHint: '逃犯时期', identity: '通缉逃犯' }),
    record({ chapter: 17, phaseHint: '逃犯', identity: '通缉逃犯' }),
  ])
  assert.deepEqual(
    phases.map((phase) => [phase.hint, phase.chapters]),
    [
      ['书僮', [13, 14, 15]],
      ['逃犯', [16, 17]],
    ],
    '同义提示合并，标签取更短、更一般化的写法',
  )

  assert.equal(hintKeyOf('书僮时期'), '书僮')
  assert.equal(hintKeyOf('卖面'), '卖面')
  assert.equal(hintKeyOf(' 军中参谋 '), '军中参谋')
  assert.equal(hintKeyOf(''), '')
  assert.deepEqual(resolveHintKeys(['书僮', '书僮时期', '卖面时期', '']), ['书僮', '书僮', '卖面', ''])
})

test('阶段字段：保留全部并存取值并标冲突', () => {
  const field = buildPhaseField(
    [
      record({ chapter: 13, identity: '顾府书僮' }),
      record({ chapter: 14, identity: '顾府书僮' }),
      record({ chapter: 15, identity: '顾府书童' }),
      record({ chapter: 16, identity: '' }),
    ],
    (item) => item.identity,
  )

  assert.equal(field.primary, '顾府书僮')
  assert.equal(field.conflict, true)
  assert.deepEqual(
    field.values.map((value) => [value.value, value.chapters]),
    [
      ['顾府书僮', [13, 14]],
      ['顾府书童', [15]],
    ],
  )

  const single = buildPhaseField([record({ chapter: 10, age: '二十七八岁' })], (item) => item.age)
  assert.equal(single.conflict, false)
  assert.equal(single.primary, '二十七八岁')
})

test('阶段字段：diffState 只把非空差异算作变化', () => {
  const base = { age: '二十七八岁', identity: '卖面摊贩', appearance: '眉清目秀', clothing: [] }
  assert.deepEqual(diffState(base, { ...base }), [])
  assert.deepEqual(diffState(base, { ...base, age: '' }), [], '空值不算变化')
  assert.deepEqual(diffState(base, { ...base, age: '三十岁不到' }), ['age: 二十七八岁 → 三十岁不到'])
  assert.equal(diffState(base, { ...base, identity: '顾府书僮', age: '三十岁不到' }).length, 2)
  assert.deepEqual(diffState(base, { ...base, clothing: ['胄甲'] }), [
    'clothing:  → 胄甲',
  ].filter(() => false), '旧值为空时不算着装变化')
})

test('阶段卡：章节范围、阶段 ID、文件名与标签', () => {
  const plan = luyunPlan()
  assert.equal(plan.phases.length, 4, `卢云必须切出 4 个阶段，实际 ${plan.phases.length}`)
  assert.deepEqual(
    plan.phases.map((phase) => phase.phaseId),
    ['phase_01', 'phase_02', 'phase_03', 'phase_04'],
  )
  assert.deepEqual(
    plan.phases.map((phase) => phase.label),
    ['卖面时期', '书僮时期', '逃犯时期', '军中参谋'],
  )
  assert.deepEqual(
    plan.phases.map((phase) => phase.chapters),
    [
      [10, 11],
      [13, 14, 15],
      [18, 19],
      [35, 36, 37, 38],
    ],
  )
  for (const phase of plan.phases) {
    assert.match(phase.fileName, new RegExp(`^${phase.phaseId}_.+\\.md$`, 'u'))
    assert.ok(!/[\\/:*?"<>|]/u.test(phase.fileName), '文件名不得含 Windows 非法字符')
  }
  assert.equal(new Set(plan.phases.map((phase) => phase.fileName)).size, plan.phases.length)

  // 阶段章节整体等于出场章号集合，且互不重叠
  const flat = plan.phases.flatMap((phase) => phase.chapters).sort((left, right) => left - right)
  assert.deepEqual(flat, plan.chapters)
})

test('阶段字段：年龄跨阶段不并集，阶段内取值可并存', () => {
  const plan = luyunPlan()
  const ages = plan.phases.map((phase) => phase.age.primary)
  assert.deepEqual(ages, ['二十七八岁', '二十七八岁', '三十岁不到', '三十岁不到'])
  assert.ok(plan.phases.every((phase) => !phase.age.conflict), '每个阶段内的年龄必须唯一')

  // identity 同样按阶段拆开，不做并集
  assert.equal(plan.phases[0]!.identity.primary, '卖面摊贩')
  assert.equal(plan.phases[3]!.identity.primary, '征北游击随军参谋')
  assert.equal(plan.phases[3]!.appearance.primary, '身形高大，体格壮硕，龙眉凤目')
})

test('阶段卡：forbidden_names 与 allowed_names 无交集，且只含其他阶段称呼', () => {
  const plan = luyunPlan()

  for (const phase of plan.phases) {
    const allowed = new Set(phase.allowedNames)
    const overlap = phase.forbiddenNames.filter((name) => allowed.has(name))
    assert.deepEqual(overlap, [], `${phase.phaseId} 的 forbidden_names 不得与 allowed_names 重叠`)

    for (const name of phase.forbiddenNames) {
      const appearsHere = plan.phases.some(
        (other) =>
          other.phaseId === phase.phaseId && other.allowedNames.includes(name),
      )
      assert.ok(!appearsHere, `${phase.phaseId} 禁止的「${name}」不得在本阶段实际出现`)
    }
  }

  const phase01 = plan.phases[0]!
  const phase04 = plan.phases[3]!
  assert.ok(phase01.forbiddenNames.includes('卢参谋'), '卖面时期必须禁止后期称呼「卢参谋」')
  assert.ok(phase04.forbiddenNames.includes('卖面郎'), '军中参谋时期必须禁止早期称呼「卖面郎」')
})

test('阶段卡：时变关系只带本阶段章号，稳定关系不重复出现', () => {
  const plan = luyunPlan()
  const relationKeys = plan.relationsGraph.map((relation) => `${relation.target}/${relation.type}`)

  for (const phase of plan.phases) {
    for (const relation of phase.relations) {
      assert.ok(
        !relationKeys.includes(`${relation.target}/${relation.type}`),
        `稳定关系 ${relation.target}/${relation.type} 不得重复写进阶段卡`,
      )
      for (const chapter of relation.chapters) {
        assert.ok(phase.chapters.includes(chapter), `${phase.phaseId} 的关系章号必须落在本阶段`)
      }
    }
  }

  const last = plan.phases[3]!
  assert.ok(
    last.relations.some((relation) => relation.target === '银川公主' && relation.type === '护卫'),
    '军中参谋阶段必须承接护卫关系',
  )
})

test('阶段卡：置信度取阶段内最低值，实体卡取最高值', () => {
  const bundle = planCharacters([
    payload(10, [record({ chapter: 10, identity: '卖面摊贩', confidence: '高' })]),
    payload(11, [record({ chapter: 11, identity: '卖面摊贩', confidence: '低' })]),
    payload(12, [record({ chapter: 12, identity: '顾府书僮', confidence: '高' })]),
    payload(13, [record({ chapter: 13, identity: '顾府书僮', confidence: '中' })]),
  ])
  const plan = bundle.characters[0]!
  assert.equal(plan.confidence, '高', '实体卡取各章最高置信度')
  assert.deepEqual(
    plan.phases.map((phase) => phase.confidence),
    ['低', '中'],
    '阶段卡取阶段内最低置信度',
  )
})

test('阶段卡 frontmatter 通过 character-phase.schema.json 校验', async () => {
  const schemas = await loadSchemas(SCHEMA_DIR)
  const schema = schemas['character-phase.schema.json']
  assert.ok(schema !== undefined, '必须存在 character-phase.schema.json')

  const plan = luyunPlan()
  for (const phase of plan.phases) {
    const frontmatter = {
      phase_id: phase.phaseId,
      character_id: plan.id,
      character_name: plan.name,
      label: phase.label,
      chapters: phase.chapters,
      age: phase.age.primary,
      identity: phase.identity.primary,
      appearance: phase.appearance.primary,
      clothing_refs: [],
      item_refs: [],
      relations: phase.relations.map((relation) => ({
        target: relation.target,
        type: relation.type,
        chapters: relation.chapters,
      })),
      allowed_names: phase.allowedNames,
      forbidden_names: phase.forbiddenNames,
      confidence: phase.confidence,
      sources: phase.sources,
    }
    assert.deepEqual(
      validateInstance(frontmatter, schema, schemas, 'character-phase.schema.json'),
      [],
      `${phase.phaseId} 必须通过阶段卡 schema 校验`,
    )
  }

  // 阶段卡不能匿名（缺 character_id）
  const first = plan.phases[0]!
  const orphan = {
    phase_id: first.phaseId,
    character_name: plan.name,
    label: first.label,
    chapters: first.chapters,
    age: first.age.primary,
    identity: first.identity.primary,
    appearance: first.appearance.primary,
    clothing_refs: [],
    item_refs: [],
    relations: [],
    allowed_names: first.allowedNames,
    forbidden_names: first.forbiddenNames,
    confidence: first.confidence,
    sources: first.sources,
  }
  assert.ok(
    validateInstance(orphan, schema, schemas, 'character-phase.schema.json').length > 0,
    '缺少 character_id 的阶段卡必须报错',
  )
})

test('工具函数：collectNameUsage 与 isCrossPhaseAlias', () => {
  const usage = collectNameUsage([
    record({ chapter: 10, name: '卢云', aliases: ['卖面郎', '小二'] }),
    record({ chapter: 11, name: '卢云', aliases: ['卖面郎'] }),
    record({ chapter: 13, name: '卢云', aliases: ['卖面郎', '书僮'] }),
  ])
  assert.deepEqual(usage.get('卢云')?.chapters, [10, 11, 13])
  assert.equal(usage.get('卢云')?.primary, true)
  assert.deepEqual(usage.get('卖面郎')?.chapters, [10, 11, 13])
  assert.equal(usage.get('卖面郎')?.primary, false)
  assert.deepEqual(usage.get('书僮')?.chapters, [13])

  const phases = [
    [10, 11],
    [13, 14],
    [18, 19],
    [35, 36],
  ]
  assert.equal(isCrossPhaseAlias([10, 11], phases), false, '只覆盖 1 个阶段 → 不算通用别名')
  assert.equal(isCrossPhaseAlias([10, 35], phases), true, '覆盖 2/4 阶段 → 通用别名')
  assert.equal(isCrossPhaseAlias([10, 13, 18], phases), true, '覆盖 ≥ 3 个阶段 → 通用别名')
  assert.equal(isCrossPhaseAlias([10], [[10]]), true, '只有一个阶段时任何称呼都算通用')
})

test('标签兜底：没有 phase_hint 时取首现身份的第一个分句并截断', () => {
  const bundle = planCharacters([
    payload(10, [record({ chapter: 10, identity: '西凉城的衙门捕头；西凉一带威名素着的捕快' })]),
    payload(11, [record({ chapter: 11, identity: '西凉城的衙门捕头；西凉一带威名素着的捕快' })]),
    payload(20, [record({ chapter: 20, identity: '一个非常非常非常非常长的身份描述超过十六个字' })]),
    payload(21, [record({ chapter: 21, identity: '一个非常非常非常非常长的身份描述超过十六个字' })]),
  ])
  const plan = bundle.characters[0]!
  assert.deepEqual(
    plan.phases.map((phase) => phase.label),
    ['西凉城的衙门捕头', '一个非常非常非常非常长的身份描述…'],
  )
  for (const phase of plan.phases) {
    assert.ok([...phase.label].length <= 17, `标签必须截断：${phase.label}`)
  }

  // 身份与外貌都为空（模型判断不了）→ 中性标签，绝不把章号写进文件名
  const blank = planCharacters([
    payload(10, [record({ chapter: 10, identity: '', appearance: '', phaseHint: '' })]),
    payload(11, [record({ chapter: 11, identity: '', appearance: '', phaseHint: '' })]),
  ]).characters[0]!
  assert.equal(blank.phases[0]!.label, '故事阶段')
  assert.ok(!/第\d+章/u.test(blank.phases[0]!.fileName), `文件名不得含章号：${blank.phases[0]!.fileName}`)
})
