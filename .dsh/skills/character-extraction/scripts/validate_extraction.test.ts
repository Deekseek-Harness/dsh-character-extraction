/**
 * `validate_extraction.ts` 自测。
 *
 * 使用 Node 内置 `node:test` + `node:assert/strict`，全部 fixture 建在 `fs.mkdtemp`
 * 临时目录中，不依赖真实 `chapters/`、`extracted/` 数据，测试结束自动清理。
 *
 * 运行::
 *
 *     node --test --test-isolation=none .dsh/skills/character-extraction/scripts/validate_extraction.test.ts
 *     npx tsx --test .dsh/skills/character-extraction/scripts/validate_extraction.test.ts
 *
 * @module character-extraction/scripts/validate_extraction.test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { JsonObject, ValidationResult } from './types.ts'
import {
  DEFAULT_SCHEMA_DIR,
  collectQuotes,
  main,
  normalize,
  parseValidateArgs,
  readChapterText,
  validateExtraction,
} from './validate_extraction.ts'

/** 第 0 章原文，包含 testChapter0() 中每条 quote 的字面片段。 */
const CHAPTER_0_TEXT =
  '卷首\n\n李寻欢缓步走入客栈，众人皆识得这位小李探花。他身上只一件洗得发白的青布长衫，外面罩着件旧氅。\n' +
  '他袖中那柄长三寸七分的飞刀，薄得几乎透明。\n' +
  '阿飞道：“你来了。”两人自此结为兄弟。\n'

/** 第 1 章原文。 */
const CHAPTER_1_TEXT = '楔子 一\n\n孙小红撑着一把油纸伞，站在雨中。她穿一件杏黄短袄，腰间系着红绳。\n'

/** 一个字段齐全的角色。 */
function testCharacter(overrides: JsonObject = {}): JsonObject {
  return {
    name: '李寻欢',
    aliases: ['小李探花'],
    gender: '男',
    age: '三十上下',
    identity: '探花郎',
    appearance: '面色苍白',
    relations: [{ target: '阿飞', type: '结义兄弟', quote: '两人自此结为兄弟。' }],
    confidence: '高',
    sources: [{ chapter: 0, quote: '李寻欢缓步走入客栈，众人皆识得这位小李探花。' }],
    ...overrides,
  }
}

/** 一份完全合法的第 0 章提取结果。 */
function testChapter0(overrides: JsonObject = {}): JsonObject {
  return {
    chapter_index: 0,
    chapter_title: '卷首',
    source_file: '000_卷首.txt',
    characters: [testCharacter()],
    clothing: [
      {
        character: '李寻欢',
        scene: '初登场',
        description: '青布长衫，外罩旧氅',
        color_material: '青布',
        quote: '他身上只一件洗得发白的青布长衫，外面罩着件旧氅。',
      },
    ],
    items: [
      {
        name: '小李飞刀',
        type: '武器',
        appearance: '薄得几乎透明',
        function: '暗器',
        holder: '李寻欢',
        quote: '他袖中那柄长三寸七分的飞刀，薄得几乎透明。',
      },
    ],
    ...overrides,
  }
}

/** `_meta.json` 中只列出指定章号。 */
function testMeta(indexes: number[], files: string[] = []): unknown {
  return {
    source_dir: 'chapters',
    chapter_count: indexes.length,
    chapters: indexes.map((index, position) => ({
      index,
      file: files[position] ?? `ch${String(index).padStart(3, '0')}.txt`,
      volume: '',
      chapter: '',
      title: `第 ${index} 章`,
      full_title: `第 ${index} 章`,
    })),
  }
}

interface Fixture {
  root: string
  chaptersDir: string
  extractedDir: string
  errorsFile: string
}

/** 建临时 fixture：`chapters/` 放原文，`extracted/` 放逐章 JSON 与 `_meta.json`。 */
async function makeFixture(
  t: TestContext,
  options: {
    chapters?: Record<string, string>
    extracted?: Record<string, unknown>
    meta?: unknown
    errorsName?: string
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'charext-validate-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const chaptersDir = path.join(root, 'chapters')
  const extractedDir = path.join(root, 'extracted')
  await mkdir(chaptersDir, { recursive: true })
  await mkdir(extractedDir, { recursive: true })

  for (const [name, content] of Object.entries(options.chapters ?? {})) {
    await writeFile(path.join(chaptersDir, name), content, 'utf8')
  }
  for (const [name, payload] of Object.entries(options.extracted ?? {})) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    await writeFile(path.join(extractedDir, name), text, 'utf8')
  }
  if (options.meta !== undefined) {
    await writeFile(path.join(extractedDir, '_meta.json'), JSON.stringify(options.meta, null, 2), 'utf8')
  }

  return {
    root,
    chaptersDir,
    extractedDir,
    errorsFile: path.join(extractedDir, options.errorsName ?? '_errors.json'),
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

/** 临时接管 console，捕获 CLI 输出并保持测试输出干净。 */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => {
    stdout.push(args.map((arg) => String(arg)).join(' '))
  }
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    const value = await fn()
    return { value, stdout, stderr }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

test('合法 JSON：通过校验且无错误无告警', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': testChapter0() },
    meta: testMeta([0], ['000_卷首.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.summary.error_count, 0)
  assert.equal(result.summary.warning_count, 0)
  assert.equal(result.summary.checked, 1)
  assert.equal(result.summary.total_expected, 1)
  assert.equal(result.summary.missing_count, 0)
})

test('缺失必填字段：报 schema 错误', async (t) => {
  const broken = testCharacter()
  delete broken.confidence

  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': testChapter0({ characters: [broken] }) },
    meta: testMeta([0], ['000_卷首.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  const schemaErrors = result.errors.filter((entry) => entry.kind === 'schema')
  assert.ok(
    schemaErrors.some(
      (entry) => entry.path === '$.characters[0]' && entry.message.includes('缺少必填字段 confidence'),
    ),
    `期望 characters[0] 缺少 confidence，实际：${JSON.stringify(schemaErrors)}`,
  )
  assert.ok(result.summary.error_count > 0)
})

test('schema 类型不符：gender 不在枚举内时报错', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': testChapter0({ characters: [testCharacter({ gender: '男性' })] }) },
    meta: testMeta([0], ['000_卷首.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  assert.ok(
    result.errors.some((entry) => entry.path === '$.characters[0].gender' && entry.kind === 'schema'),
    `期望 gender 枚举报错，实际：${JSON.stringify(result.errors)}`,
  )
})

test('quote 不存在于原文：报 quote 错误', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: {
      'ch000.json': testChapter0({
        clothing: [
          {
            character: '李寻欢',
            scene: '初登场',
            description: '油纸伞',
            color_material: '',
            quote: '孙小红撑着一把红伞，站在雨中。',
          },
        ],
      }),
    },
    meta: testMeta([0], ['000_卷首.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  const quoteErrors = result.errors.filter((entry) => entry.kind === 'quote')
  assert.equal(quoteErrors.length, 1)
  assert.equal(quoteErrors[0]?.path, '$.clothing[0].quote')
  assert.ok(quoteErrors[0]?.message.includes('000_卷首.txt'))
})

test('quote 跨行出现：忽略空白差异后仍能命中', async (t) => {
  const fx = await makeFixture(t, {
    chapters: {
      '000_卷首.txt': CHAPTER_0_TEXT.replace(
        '李寻欢缓步走入客栈，众人皆识得这位小李探花。',
        '李寻欢缓步走入\n  客栈，众人皆识得这位小李探花。',
      ),
    },
    extracted: { 'ch000.json': testChapter0() },
    meta: testMeta([0], ['000_卷首.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  const quoteErrors = result.errors.filter((entry) => entry.kind === 'quote')
  assert.deepEqual(quoteErrors, [], '换行与空格差异不应导致引用失配')
})

test('chapter_index 与文件名不一致：报 index 错误', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '001_楔子_一.txt': CHAPTER_1_TEXT },
    extracted: {
      'ch001.json': {
        chapter_index: 7,
        chapter_title: '楔子',
        source_file: '001_楔子_一.txt',
        characters: [],
        clothing: [],
        items: [],
      },
    },
    meta: testMeta([1], ['001_楔子_一.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.kind, 'index')
  assert.equal(result.errors[0]?.path, '$.chapter_index')
  assert.ok(result.errors[0]?.message.includes('不一致'))
})

test('引用超长：衣物记错误、物品记告警', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': testChapter0() },
    meta: testMeta([0], ['000_卷首.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile, { quoteMax: 5 })

  assert.ok(
    result.errors.some((entry) => entry.kind === 'quote-length' && entry.path === '$.clothing[0].quote'),
    '衣物的 quote 超过上限应记为错误',
  )
  assert.ok(
    result.warnings.some((entry) => entry.kind === 'quote-length' && entry.path === '$.items[0].quote'),
    '物品的 quote 超过上限应记为告警',
  )
  assert.deepEqual(
    result.errors.filter((entry) => entry.kind === 'quote'),
    [],
    '引用本身存在，不应报失配',
  )
})

test('覆盖率：缺失章节被列出，多余索引记为告警', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': testChapter0() },
    meta: testMeta([0, 5], ['000_卷首.txt', '005_未完成.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  assert.deepEqual(result.missing, [{ index: 5, file: '005_未完成.txt' }])
  assert.equal(result.summary.missing_count, 1)

  // 另一个方向：_meta.json 只列 5，实际有 ch000 → extra 告警
  const extra = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': testChapter0() },
    meta: testMeta([5], ['005_x.txt']),
  })
  const extraResult = await validateExtraction(extra.chaptersDir, extra.extractedDir, extra.errorsFile)
  assert.ok(
    extraResult.warnings.some((entry) => entry.kind === 'extra' && entry.message.includes('索引 0')),
    `期望 extra 告警，实际：${JSON.stringify(extraResult.warnings)}`,
  )
})

test('缺少 _meta.json：给出 missing 告警并跳过覆盖率检查', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': testChapter0() },
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  assert.equal(result.summary.total_expected, 0)
  assert.equal(result.summary.missing_count, 0)
  assert.ok(result.warnings.some((entry) => entry.kind === 'missing' && entry.file === '_meta.json'))
  assert.deepEqual(result.errors, [])
})

test('找不到章节原文：报 source 错误', async (t) => {
  const fx = await makeFixture(t, {
    chapters: {},
    extracted: { 'ch000.json': testChapter0() },
    meta: testMeta([0], ['000_卷首.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  assert.ok(
    result.errors.some((entry) => entry.kind === 'source' && entry.path === '$.source_file'),
    `期望 source 错误，实际：${JSON.stringify(result.errors)}`,
  )
})

test('非法 JSON：报 json 错误且不计入已检数量', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': '{ 这不是合法 JSON' },
    meta: testMeta([0], ['000_卷首.txt']),
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  assert.ok(result.errors.some((entry) => entry.kind === 'json' && entry.file === 'ch000.json'))
  assert.equal(result.summary.checked, 0)
  // 文件存在即计入覆盖率，文件损坏则单列为 json 错误。
  assert.equal(result.summary.missing_count, 0)
})

test('_errors.json：形状与字段类型正确，且自定义路径生效', async (t) => {
  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: {
      'ch000.json': testChapter0({
        clothing: [
          { character: '李寻欢', scene: '初登场', description: '伞', color_material: '', quote: '原文里没有这句。' },
        ],
      }),
    },
    meta: testMeta([0], ['000_卷首.txt']),
    errorsName: 'custom_errors.json',
  })

  const result = await validateExtraction(fx.chaptersDir, fx.extractedDir, fx.errorsFile)

  assert.ok(await exists(fx.errorsFile), '报告文件必须写出')
  const raw = await readFile(fx.errorsFile, 'utf8')
  assert.ok(raw.endsWith('\n'), '报告应以换行结尾')

  const report = JSON.parse(raw) as ValidationResult
  assert.deepEqual(Object.keys(report).sort(), [
    'chapters_dir',
    'errors',
    'extracted_dir',
    'generated_at',
    'missing',
    'schema_dir',
    'summary',
    'warnings',
  ])
  assert.deepEqual(Object.keys(report.summary).sort(), [
    'checked',
    'error_count',
    'missing_count',
    'total_expected',
    'warning_count',
  ])
  assert.match(report.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  assert.equal(report.chapters_dir, path.resolve(fx.chaptersDir))
  assert.equal(report.extracted_dir, path.resolve(fx.extractedDir))
  assert.equal(report.schema_dir, DEFAULT_SCHEMA_DIR)
  assert.deepEqual(report, result, '返回对象应与落盘内容一致')

  assert.ok(report.errors.length > 0)
  for (const entry of report.errors) {
    assert.equal(typeof entry.file, 'string')
    assert.equal(typeof entry.kind, 'string')
    assert.equal(typeof entry.path, 'string')
    assert.equal(typeof entry.message, 'string')
  }
})

test('readChapterText：UTF-8 BOM 与 GB18030 都能读', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'charext-encoding-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const bomFile = path.join(root, 'bom.txt')
  await writeFile(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('卷首', 'utf8')]))
  assert.equal(await readChapterText(bomFile), '卷首', 'BOM 必须被剥离')

  const gbFile = path.join(root, 'gb18030.txt')
  await writeFile(gbFile, Buffer.from('beedcad7', 'hex'))
  assert.equal(await readChapterText(gbFile), '卷首', 'GB18030 应作为回退编码生效')

  assert.equal(await readChapterText(path.join(root, 'missing.txt')), null)
})

test('工具函数：collectQuotes / normalize / parseValidateArgs', () => {
  const quotes = collectQuotes(testChapter0())
  assert.deepEqual(quotes, [
    { path: '$.clothing[0].quote', quote: '他身上只一件洗得发白的青布长衫，外面罩着件旧氅。', limited: true },
    { path: '$.items[0].quote', quote: '他袖中那柄长三寸七分的飞刀，薄得几乎透明。', limited: false },
    { path: '$.characters[0].sources[0].quote', quote: '李寻欢缓步走入客栈，众人皆识得这位小李探花。', limited: false },
    { path: '$.characters[0].relations[0].quote', quote: '两人自此结为兄弟。', limited: false },
  ])
  assert.deepEqual(collectQuotes(null), [])
  assert.deepEqual(collectQuotes({ clothing: 'not-an-array' }), [])

  assert.equal(normalize('a\n b\u3000c'), 'abc')

  assert.deepEqual(parseValidateArgs(['--chapters', 'c', '--extracted', 'e']), {
    chapters: 'c',
    extracted: 'e',
    help: false,
  })
  assert.deepEqual(parseValidateArgs(['--chapters=c', '--extracted=e', '--errors=x', '--quote-max=10']), {
    chapters: 'c',
    extracted: 'e',
    errors: 'x',
    quoteMax: 10,
    help: false,
  })
  assert.throws(() => parseValidateArgs(['--quote-max=abc']))
  assert.throws(() => parseValidateArgs(['--chapters']))
  assert.throws(() => parseValidateArgs(['--nope']))
})

test('CLI：--help 为 0，缺参数为 2，有错误为 1，无错误为 0', async (t) => {
  assert.equal((await captureConsole(() => main(['--help']))).value, 0)
  assert.equal((await captureConsole(() => main([]))).value, 2)
  assert.equal((await captureConsole(() => main(['--chapters', 'c']))).value, 2)
  assert.equal((await captureConsole(() => main(['--unknown']))).value, 2)

  const fx = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: { 'ch000.json': testChapter0() },
    meta: testMeta([0], ['000_卷首.txt']),
  })
  const clean = await captureConsole(() => main(['--chapters', fx.chaptersDir, '--extracted', fx.extractedDir]))
  assert.equal(clean.value, 0)
  assert.ok(clean.stdout.some((line) => line.includes('错误 0')))

  const bad = await makeFixture(t, {
    chapters: { '000_卷首.txt': CHAPTER_0_TEXT },
    extracted: {
      'ch000.json': testChapter0({
        clothing: [{ character: '李寻欢', scene: '初登场', description: '伞', color_material: '', quote: '不存在。' }],
      }),
    },
    meta: testMeta([0], ['000_卷首.txt']),
  })
  const dirty = await captureConsole(() => main(['--chapters', bad.chaptersDir, '--extracted', bad.extractedDir]))
  assert.equal(dirty.value, 1)
  assert.ok(dirty.stdout.some((line) => line.includes('引用无法在')))

  // 目录不存在 → 2
  const missingDir = await captureConsole(() =>
    main(['--chapters', bad.chaptersDir, '--extracted', path.join(bad.root, 'nope')]),
  )
  assert.equal(missingDir.value, 2)
  assert.ok(missingDir.stderr.some((line) => line.includes('逐章输出目录不存在')))
})
