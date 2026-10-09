/**
 * `scan_chapters.ts` 自测。
 *
 * 使用 Node 内置 `node:test` + `node:assert/strict`，全部 fixture 建在 `fs.mkdtemp`
 * 临时目录中，不依赖真实 `chapters/`、`extracted/` 数据，测试结束自动清理。
 *
 * 运行::
 *
 *     node --test --test-isolation=none .dsh/skills/character-extraction/scripts/scan_chapters.test.ts
 *     npx tsx --test .dsh/skills/character-extraction/scripts/scan_chapters.test.ts
 *
 * @module character-extraction/scripts/scan_chapters.test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { loadTitleHints, main, parseScanArgs, scanChapterFiles, scanChapters, splitTitle } from './scan_chapters.ts'
import type { Meta } from './types.ts'

/** 建一个临时工作区，写入给定文件（键为 `chapters/` 下的文件名）。 */
async function makeWorkspace(
  t: TestContext,
  files: Record<string, string>,
): Promise<{ root: string; chaptersDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'charext-scan-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const chaptersDir = path.join(root, 'chapters')
  await mkdir(chaptersDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(chaptersDir, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return { root, chaptersDir }
}

/** 文件是否存在。 */
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

test('空目录：chapter_count 为 0，且仍写出合法的 _meta.json', async (t) => {
  const { root, chaptersDir } = await makeWorkspace(t, {})
  const outputFile = path.join(root, 'extracted', '_meta.json')

  const meta = await scanChapters(chaptersDir, outputFile)

  assert.equal(meta.chapter_count, 0)
  assert.deepEqual(meta.chapters, [])
  assert.equal(meta.source_dir, path.resolve(chaptersDir))

  assert.ok(await exists(outputFile), '空目录也必须写出清单文件')
  const written = JSON.parse(await readFile(outputFile, 'utf8')) as Meta
  assert.equal(written.chapter_count, 0)
  assert.deepEqual(written.chapters, [])
  assert.equal(written.source_dir, path.resolve(chaptersDir))
})

test('正常文件名：解析出 index / volume / chapter / title / full_title', async (t) => {
  const { root, chaptersDir } = await makeWorkspace(t, {
    '000_卷首.txt': '卷首\n',
    '001_楔子_一.txt': '楔子\n',
    '102_第十一卷_重建怒苍_第七章_我自横刀向天笑.txt': '正文\n',
  })

  const meta = await scanChapters(chaptersDir, path.join(root, 'extracted', '_meta.json'))

  assert.equal(meta.chapter_count, 3)
  assert.deepEqual(meta.chapters, [
    { index: 0, file: '000_卷首.txt', volume: '', chapter: '卷首', title: '卷首', full_title: '卷首' },
    { index: 1, file: '001_楔子_一.txt', volume: '', chapter: '楔子', title: '一', full_title: '楔子_一' },
    {
      index: 102,
      file: '102_第十一卷_重建怒苍_第七章_我自横刀向天笑.txt',
      volume: '第十一卷',
      chapter: '第七章',
      title: '我自横刀向天笑',
      full_title: '第十一卷_重建怒苍_第七章_我自横刀向天笑',
    },
  ])
})

test('章节按 index 升序排序，同 index 按文件名排序并给出重复告警', async (t) => {
  const { chaptersDir } = await makeWorkspace(t, {
    '010_c.txt': '',
    '002_a.txt': '',
    '007_b.txt': '',
    '007_a.txt': '',
  })

  const { chapters, warnings } = await scanChapterFiles(chaptersDir)

  assert.deepEqual(
    chapters.map((chapter) => chapter.index),
    [2, 7, 7, 10],
  )
  assert.deepEqual(
    chapters.map((chapter) => chapter.file),
    ['002_a.txt', '007_a.txt', '007_b.txt', '010_c.txt'],
  )
  assert.ok(
    warnings.includes('索引 7 重复：007_a.txt, 007_b.txt'),
    `期望重复索引告警，实际：${JSON.stringify(warnings)}`,
  )
})

test('非法与非常规文件名：忽略非 txt、跳过无数字名、兜底解析并用 _meta.json 回填标题', async (t) => {
  const { root, chaptersDir } = await makeWorkspace(t, {
    'notes.md': '不是章节\n',
    'readme.txt': '没有数字前缀\n',
    'ch0001.txt': '第一章正文\n',
    'ch0002.txt': '第二章正文\n',
    '_meta.json': JSON.stringify({
      chapters: [{ index: 1, file: 'chapters/ch0001.txt', title: '第一章 山雨欲来' }],
    }),
  })

  const { chapters, warnings } = await scanChapterFiles(chaptersDir)

  assert.equal(chapters.length, 2, 'notes.md 被忽略，readme.txt 被跳过，_meta.json 不是章节')

  // 有标题映射：拆出「第一章」与「山雨欲来」。
  assert.deepEqual(chapters[0], {
    index: 1,
    file: 'ch0001.txt',
    volume: '',
    chapter: '第一章',
    title: '山雨欲来',
    full_title: '第一章 山雨欲来',
  })

  // 无标题映射：退化为文件名本身。
  assert.deepEqual(chapters[1], {
    index: 2,
    file: 'ch0002.txt',
    volume: '',
    chapter: 'ch0002',
    title: 'ch0002',
    full_title: 'ch0002',
  })

  assert.ok(warnings.some((warning) => warning.includes('跳过无法解析索引的文件：readme.txt')))
  assert.ok(warnings.some((warning) => warning.includes('回填标题）：ch0001.txt')))
  assert.ok(warnings.some((warning) => warning.includes('无标题映射，用兜底规则解析）：ch0002.txt')))

  // useMetaHint: false 时不读 _meta.json，退化为文件名。
  const noHint = await scanChapterFiles(chaptersDir, { useMetaHint: false })
  assert.equal(noHint.chapters[0]?.full_title, 'ch0001')
  assert.equal(noHint.chapters[0]?.chapter, 'ch0001')

  // 输出目录会被自动创建。
  const outputFile = path.join(root, 'deep', 'nested', '_meta.json')
  await scanChapters(chaptersDir, outputFile)
  assert.ok(await exists(outputFile))
})

test('自定义 --pattern：生效且关闭兜底解析', async (t) => {
  const { chaptersDir } = await makeWorkspace(t, {
    '0001_alpha.txt': '',
    'ch0009.txt': '',
  })

  const { chapters, warnings } = await scanChapterFiles(chaptersDir, {
    pattern: '^([0-9]{4})_(.+)\\.txt$',
  })

  assert.equal(chapters.length, 1)
  assert.equal(chapters[0]?.index, 1)
  assert.equal(chapters[0]?.full_title, 'alpha')
  assert.ok(
    warnings.some((warning) => warning.includes('ch0009.txt')),
    '自定义 pattern 时不应再走兜底解析',
  )
})

test('splitTitle：卷 / 章 / 回 的拆解规则', () => {
  assert.deepEqual(splitTitle('卷首'), { volume: '', chapter: '卷首', title: '卷首' })
  assert.deepEqual(splitTitle('楔子_一'), { volume: '', chapter: '楔子', title: '一' })
  assert.deepEqual(splitTitle('第十一卷_重建怒苍_第七章_我自横刀向天笑'), {
    volume: '第十一卷',
    chapter: '第七章',
    title: '我自横刀向天笑',
  })
  assert.deepEqual(splitTitle('第一回_夜话'), { volume: '', chapter: '第一回', title: '夜话' })
  // 边界：空串不抛异常。
  assert.deepEqual(splitTitle(''), { volume: '', chapter: '', title: '' })
})

test('loadTitleHints：缺失或非法 _meta.json 时返回空映射', async (t) => {
  const empty = await makeWorkspace(t, {})
  assert.deepEqual(await loadTitleHints(empty.chaptersDir), {})

  const broken = await makeWorkspace(t, { '_meta.json': '{ 不是 JSON' })
  assert.deepEqual(await loadTitleHints(broken.chaptersDir), {})

  const good = await makeWorkspace(t, {
    '_meta.json': JSON.stringify({
      chapters: [
        { index: 1, file: 'chapters\\ch0001.txt', title: '第一章 甲' },
        { title: '缺文件名' },
        { index: 3, file: 'ch0003.txt' },
      ],
    }),
  })
  assert.deepEqual(await loadTitleHints(good.chaptersDir), {
    'ch0001.txt': { title: '第一章 甲', index: 1 },
  })
})

test('CLI：--help 返回 0，缺少必填项返回 2，输入目录不存在返回 2', async () => {
  const { value: helpCode, stdout } = await captureConsole(() => main(['--help']))
  assert.equal(helpCode, 0)
  assert.ok(stdout.some((line) => line.includes('用法：scan_chapters.ts')))

  const missing = await captureConsole(() => main([]))
  assert.equal(missing.value, 2)
  assert.ok(missing.stderr.some((line) => line.includes('--input 与 --output 均为必填')))

  assert.equal((await captureConsole(() => main(['--input', 'x']))).value, 2)
  assert.equal(
    (
      await captureConsole(() =>
        main(['--input', path.join(tmpdir(), 'definitely-not-here-xyz'), '--output', 'o.json']),
      )
    ).value,
    2,
  )
  assert.equal((await captureConsole(() => main(['--unknown']))).value, 2)

  // 参数解析：支持 `--flag value` 与 `--flag=value`，默认读取 _meta.json 回填。
  assert.deepEqual(parseScanArgs(['--input', 'a', '--output', 'b']), {
    input: 'a',
    output: 'b',
    useMetaHint: true,
    help: false,
  })
  assert.deepEqual(parseScanArgs(['--input=a', '--output=b', '--no-meta-hint']), {
    input: 'a',
    output: 'b',
    useMetaHint: false,
    help: false,
  })
  assert.throws(() => parseScanArgs(['--input']))
})

test('CLI：端到端扫描并落盘', async (t) => {
  const { root, chaptersDir } = await makeWorkspace(t, {
    '000_卷首.txt': '卷首\n',
    '001_楔子_一.txt': '楔子\n',
  })
  const outputFile = path.join(root, 'extracted', '_meta.json')

  const { value: code, stdout } = await captureConsole(() => main(['--input', chaptersDir, '--output', outputFile]))

  assert.equal(code, 0)
  assert.ok(stdout.some((line) => line.includes('已写入') && line.includes('2 章')))
  const meta = JSON.parse(await readFile(outputFile, 'utf8')) as Meta
  assert.equal(meta.chapter_count, 2)
  assert.deepEqual(
    meta.chapters.map((chapter) => chapter.title),
    ['卷首', '一'],
  )
  assert.ok((await readFile(outputFile, 'utf8')).endsWith('\n'), '文件应以换行结尾')
})

test('CLI：空目录返回 0 但输出告警（chapter_count 为 0）', async (t) => {
  const { root, chaptersDir } = await makeWorkspace(t, {})
  const outputFile = path.join(root, 'extracted', '_meta.json')

  const { value: code, stderr } = await captureConsole(() => main(['--input', chaptersDir, '--output', outputFile]))

  assert.equal(code, 0)
  assert.ok(
    stderr.some((line) => line.includes('警告：') && line.includes('没有找到任何 .txt 章节文件')),
    `期望空目录告警，实际：${JSON.stringify(stderr)}`,
  )
  const meta = JSON.parse(await readFile(outputFile, 'utf8')) as Meta
  assert.equal(meta.chapter_count, 0)
})
