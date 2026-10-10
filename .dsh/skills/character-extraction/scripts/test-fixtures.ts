/**
 * 人物实体卡 / 阶段卡测试的共享夹具。
 *
 * 全部夹具建在 `fs.mkdtemp` 临时目录中，不依赖真实 `chapters/`、`extracted/` 数据，
 * 测试结束自动清理。
 *
 * 合成数据围绕「卢云」的典型弧线：
 *
 * | 阶段 | 章号 | 身份 | 年龄 | 称呼 | 关系 |
 * |---|---|---|---|---|---|
 * | 卖面时期 | 10, 11 | 卖面摊贩 | 二十七八岁 | 卖面郎、小二 | 牛二(仇敌) |
 * | 书僮时期 | 13, 14, 15 | 顾府书僮 | 二十七八岁 | 书僮、云儿 | 顾嗣源(主仆)、顾倩兮(恋慕) |
 * | 逃犯时期 | 18, 19 | 通缉要犯 | 三十岁不到 | 姓卢的、卢某 | 伍定远(结义兄弟)、秦仲海(结义兄弟) |
 * | 军中参谋 | 35, 36, 37, 38 | 征北游击随军参谋 | 三十岁不到 | 卢参谋、卢云 | 秦仲海(上下级)、银川公主(护卫) |
 *
 * 说明：章号刻意留出空缺（12、16、17、20-34），用于验证「章节不连续必须开新阶段」。
 *
 * @module character-extraction/scripts/test-fixtures
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import type { CharacterRecord, ChapterPayload, ClothingRecord, ItemRecord } from './phase-plan.ts'

/** 逐章衣物 / 物品的构造参数（`chapter` 由 `makeWorkspace` 按当前章回填）。 */
export type ClothingInit = Omit<ClothingRecord, 'chapter'>
export type ItemInit = Omit<ItemRecord, 'chapter'>
export type Gear = Map<number, { clothing: ClothingInit[]; items: ItemInit[] }>

/** 一条逐章角色记录的构造参数。 */
export interface RecordInit {
  chapter: number
  name?: string
  aliases?: string[]
  gender?: string
  age?: string
  identity?: string
  appearance?: string
  relations?: Array<{ target: string; type: string; quote?: string }>
  phaseHint?: string
  confidence?: '高' | '中' | '低'
  quotes?: string[]
}

/**
 * 构造一条逐章角色记录（未提供的字段按空值补全）。
 * @param init - 字段与覆盖值。
 * @returns 角色记录。
 */
export function record(init: RecordInit): CharacterRecord {
  return {
    chapter: init.chapter,
    name: init.name ?? '卢云',
    aliases: init.aliases ?? [],
    gender: init.gender ?? '男',
    age: init.age ?? '',
    identity: init.identity ?? '',
    appearance: init.appearance ?? '',
    relations: (init.relations ?? []).map((relation) => ({
      target: relation.target,
      type: relation.type,
      quote: relation.quote ?? '',
    })),
    phaseHint: init.phaseHint ?? '',
    confidence: init.confidence ?? '高',
    quotes: init.quotes ?? [],
  }
}

/** 一份逐章 JSON 的完整解析结果。 */
export interface ChapterPayloadWithTitle extends ChapterPayload {
  /** 章节标题（写进 `_meta.json` 与逐章 `chapter_title`）。 */
  chapterTitle?: string
}

/** 构造一份逐章 payload。 */
export function payload(
  chapterIndex: number,
  characters: CharacterRecord[],
  extra: {
    clothing?: ChapterPayload['clothing']
    items?: ChapterPayload['items']
    chapterTitle?: string
  } = {},
): ChapterPayloadWithTitle {
  return {
    chapterIndex,
    characters,
    clothing: extra.clothing ?? [],
    items: extra.items ?? [],
    ...(extra.chapterTitle === undefined ? {} : { chapterTitle: extra.chapterTitle }),
  }
}

/**
 * 卢云弧线的完整逐章记录（10–38 章，含空缺）。
 * @returns 按章号升序的 payload 数组。
 */
export function luyunPayloads(): ChapterPayloadWithTitle[] {
  return [
    payload(10, [
      record({
        chapter: 10,
        aliases: ['卖面郎', '小二', '那面贩'],
        age: '二十七八岁',
        identity: '卖面摊贩',
        appearance: '眉清目秀，衣衫褴褛',
        relations: [{ target: '牛二', type: '仇敌', quote: '牛二伸手便掀了他的面摊。' }],
        phaseHint: '卖面时期',
        quotes: ['只见那卖面的年轻人约莫二十七八岁，眉清目秀。'],
      }),
    ], { chapterTitle: '落第秀才' }),
    payload(11, [
      record({
        chapter: 11,
        aliases: ['卖面郎', '小二'],
        age: '二十七八岁',
        identity: '卖面摊贩',
        appearance: '眉清目秀，衣衫褴褛',
        relations: [{ target: '牛二', type: '仇敌', quote: '牛二笑道：穷酸，你也配？' }],
        phaseHint: '卖面时期',
        quotes: ['他一个卖面的，偏生得眉清目秀。'],
      }),
    ], { chapterTitle: '为天地立心' }),
    payload(13, [
      record({
        chapter: 13,
        aliases: ['书僮', '云儿'],
        age: '二十七八岁',
        identity: '顾府书僮',
        appearance: '眉清目秀，一身青布衣衫',
        relations: [
          { target: '顾嗣源', type: '主仆', quote: '这孩子真是我的书僮。' },
          { target: '顾倩兮', type: '恋慕', quote: '他不敢抬眼去看那位小姐。' },
        ],
        phaseHint: '书僮时期',
        quotes: ['卢云做了顾府的书僮，人人都唤他云儿。'],
      }),
    ], { chapterTitle: '白水岂能度' }),
    payload(14, [
      record({
        chapter: 14,
        aliases: ['书僮', '云儿'],
        age: '二十七八岁',
        identity: '顾府书僮',
        appearance: '眉清目秀，一身青布衣衫',
        relations: [{ target: '顾嗣源', type: '主仆', quote: '顾老爷待这书僮极厚。' }],
        phaseHint: '书僮时期',
        quotes: ['云儿捧着书卷，静静立在廊下。'],
      }),
    ], { chapterTitle: '大富人家' }),
    payload(15, [
      record({
        chapter: 15,
        aliases: ['书僮'],
        age: '二十七八岁',
        identity: '顾府书僮',
        appearance: '眉清目秀，一身青布衣衫',
        relations: [{ target: '顾倩兮', type: '恋慕', quote: '他心里只有那位顾家小姐。' }],
        phaseHint: '书僮时期',
        quotes: ['他仍是顾府的书僮，只是心里多了个人。'],
      }),
    ], { chapterTitle: '无双连拳' }),
    payload(18, [
      record({
        chapter: 18,
        aliases: ['姓卢的', '卢某', '卢兄弟'],
        age: '三十岁不到',
        identity: '通缉要犯',
        appearance: '形容憔悴，双目有神',
        relations: [
          { target: '伍定远', type: '结义兄弟', quote: '两人自此结为兄弟。' },
          { target: '秦仲海', type: '结义兄弟', quote: '秦仲海拍着他的肩，唤他一声兄弟。' },
          { target: '牛二', type: '仇敌', quote: '那牛二又带人来寻他的晦气。' },
        ],
        phaseHint: '逃犯时期',
        quotes: ['他成了通缉的要犯，只得连夜出城。'],
      }),
    ], { chapterTitle: '天地一沙鸥' }),
    payload(19, [
      record({
        chapter: 19,
        aliases: ['姓卢的', '卢某', '卢兄弟'],
        age: '三十岁不到',
        identity: '通缉要犯',
        appearance: '形容憔悴，双目有神',
        relations: [
          { target: '秦仲海', type: '结义兄弟', quote: '秦仲海与他八拜为交。' },
          { target: '伍定远', type: '结义兄弟', quote: '卢兄弟，你我既是兄弟，何必见外。' },
        ],
        phaseHint: '逃犯时期',
        quotes: ['姓卢的，你往哪里走？'],
      }),
    ], { chapterTitle: '山东大卤面' }),
    payload(35, [
      record({
        chapter: 35,
        aliases: ['卢参谋', '卢兄弟', '姓卢的'],
        age: '三十岁不到',
        identity: '征北游击随军参谋',
        appearance: '身形高大，体格壮硕，龙眉凤目',
        relations: [{ target: '秦仲海', type: '上下级', quote: '秦将军麾下新添了一位参谋。' }],
        phaseHint: '军中参谋',
        quotes: ['卢云做了秦仲海麾下的随军参谋。'],
      }),
    ], { chapterTitle: '银川公主' }),
    payload(36, [
      record({
        chapter: 36,
        aliases: ['卢参谋'],
        age: '三十岁不到',
        identity: '征北游击随军参谋',
        appearance: '身形高大，体格壮硕，龙眉凤目',
        relations: [],
        phaseHint: '军中参谋',
        quotes: ['参谋卢云献上一策，秦仲海大喜。'],
      }),
    ], { chapterTitle: '西出梁山第一人' }),
    payload(37, [
      record({
        chapter: 37,
        aliases: ['卢参谋'],
        age: '三十岁不到',
        identity: '征北游击随军参谋',
        appearance: '身形高大，体格壮硕，龙眉凤目',
        relations: [],
        phaseHint: '军中参谋',
        quotes: ['卢参谋披甲上马，随军北行。'],
      }),
    ], { chapterTitle: '昭君出塞' }),
    payload(38, [
      record({
        chapter: 38,
        aliases: ['卢参谋'],
        age: '三十岁不到',
        identity: '征北游击随军参谋',
        appearance: '身形高大，体格壮硕，龙眉凤目',
        relations: [{ target: '银川公主', type: '护卫', quote: '卢云奉命护卫公主。' }],
        phaseHint: '军中参谋',
        quotes: ['卢云披上胄甲，挂起腰刀，脚跨雪泥宝马。'],      }),
    ], { chapterTitle: '天朝国威' }),
  ]
}

/**
 * 卢云弧线的衣物与物品记录（用于 `aggregateCards` 端到端测试）。
 * @returns 章号 → 衣物 / 物品。
 */
export function luyunGear(): Gear {
  return new Map<number, { clothing: ClothingInit[]; items: ItemInit[] }>([
    [
      11,
      {
        clothing: [
          {
            character: '卢云',
            scene: '卖面',
            description: '破烂短褐，油渍围裙',
            colorMaterial: '粗布；油渍',
            quote: '他系着一条油渍斑斑的围裙。',
          },
        ],
        items: [],
      },
    ],
    [
      15,
      {
        clothing: [
          {
            character: '卢云',
            scene: '顾府',
            description: '青布长衫，浆洗得发白',
            colorMaterial: '青布',
            quote: '他身上只一件洗得发白的青布长衫。',
          },
        ],
        items: [],
      },
    ],
    [
      38,
      {
        clothing: [
          {
            character: '卢云',
            scene: '军中',
            description: '胄甲，腰刀',
            colorMaterial: '铁甲',
            quote: '卢云披上胄甲，挂起腰刀。',
          },
        ],
        items: [
          {
            name: '郾月大刀',
            type: '武器',
            appearance: '长刀，刀身厚重',
            function: '临阵兵器',
            holder: '卢云',
            quote: '卢云披上胄甲，挂起腰刀，脚跨雪泥宝马。',
          },
        ],
      },
    ],
  ])
}

/** 一份临时工作区。 */
export interface Workspace {
  root: string
  extractedDir: string
  cardsDir: string
}

/**
 * 建临时工作区，并把逐章 JSON 与 `_meta.json` 写进 `extracted/`。
 * @param t - `node:test` 上下文（用于注册清理）。
 * @param payloads - 逐章 payload。
 * @param gear - 章号 → 衣物 / 物品。
 * @returns 目录路径。
 */
export async function makeWorkspace(
  t: TestContext,
  payloads: ChapterPayloadWithTitle[],
  gear: Gear = new Map(),
): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), 'charext-cards-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const extractedDir = path.join(root, 'extracted')
  const cardsDir = path.join(root, 'cards')
  await mkdir(extractedDir, { recursive: true })

  for (const item of payloads) {
    const extra = gear.get(item.chapterIndex)
    const clothing = extra?.clothing ?? []
    const items = extra?.items ?? []
    const document = {
      chapter_index: item.chapterIndex,
      chapter_title: item.chapterTitle ?? `第${item.chapterIndex}章`,
      source_file: `${String(item.chapterIndex).padStart(3, '0')}_chapter.txt`,
      characters: item.characters.map((character) => ({
        name: character.name,
        aliases: character.aliases,
        gender: character.gender,
        age: character.age,
        identity: character.identity,
        appearance: character.appearance,
        relations: character.relations.map((relation) => ({
          target: relation.target,
          type: relation.type,
          ...(relation.quote === '' ? {} : { quote: relation.quote }),
        })),
        ...(character.phaseHint === '' ? {} : { phase_hint: character.phaseHint }),
        confidence: character.confidence,
        ...(character.quotes.length === 0
          ? {}
          : { sources: character.quotes.map((quote) => ({ chapter: character.chapter, quote })) }),
      })),
      clothing: clothing.map((entry) => ({
        character: entry.character,
        scene: entry.scene,
        description: entry.description,
        color_material: entry.colorMaterial,
        quote: entry.quote,
      })),      items: items.map((entry) => ({
        name: entry.name,
        type: entry.type,
        appearance: entry.appearance,
        function: entry.function,
        holder: entry.holder,
        quote: entry.quote,
      })),
    }
    await writeFile(
      path.join(extractedDir, `ch${String(item.chapterIndex).padStart(3, '0')}.json`),
      `${JSON.stringify(document, null, 2)}\n`,
      'utf8',
    )
  }

  const chapters = payloads.map((item) => item.chapterIndex).sort((left, right) => left - right)
  const titles = new Map(
    payloads
      .filter((item) => item.chapterTitle !== undefined)
      .map((item) => [item.chapterIndex, item.chapterTitle!] as const),
  )
  await writeFile(
    path.join(extractedDir, '_meta.json'),
    `${JSON.stringify(
      {
        source_dir: path.join(root, 'chapters'),
        chapter_count: chapters.length,
        chapters: chapters.map((index) => ({
          index,
          file: `${String(index).padStart(3, '0')}_chapter.txt`,
          volume: '',
          chapter: '',
          title: titles.get(index) ?? `第${index}章`,
          full_title: titles.get(index) ?? `第${index}章`,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return { root, extractedDir, cardsDir }
}
