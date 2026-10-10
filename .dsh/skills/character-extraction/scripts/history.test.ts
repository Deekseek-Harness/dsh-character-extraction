/**
 * `history.ts` 自测：`list` / `show` / `restore` / `prune`。
 *
 * 运行::
 *
 *     node --test --test-isolation=none .dsh/skills/character-extraction/scripts/history.test.ts
 *     npx tsx --test .dsh/skills/character-extraction/scripts/history.test.ts
 *
 * @module character-extraction/scripts/history.test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { backupOutput } from './backup_output.ts'
import { historyList, historyPrune, historyRestore, historyShow, main } from './history.ts'
import { listVersionNumbers, readHistoryIndex } from './history-store.ts'
import type { JsonObject } from './types.ts'

interface Fixture {
  root: string
  extracted: string
  cards: string
  chapters: string
  history: string
}

async function makeFixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'charext-history-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    extracted: path.join(root, 'extracted'),
    cards: path.join(root, 'cards'),
    chapters: path.join(root, 'chapters'),
    history: path.join(root, 'history'),
  }
}

async function seedOutput(fx: Fixture, chapterIndexes: number[] = [3, 4]): Promise<void> {
  await mkdir(fx.extracted, { recursive: true })
  await mkdir(path.join(fx.cards, 'characters'), { recursive: true })
  await mkdir(fx.chapters, { recursive: true })

  await writeFile(
    path.join(fx.extracted, '_meta.json'),
    JSON.stringify({ source_dir: fx.chapters, chapter_count: chapterIndexes.length, chapters: [] }, null, 2),
    'utf8',
  )
  await writeFile(
    path.join(fx.extracted, '_progress.json'),
    JSON.stringify({ total: chapterIndexes.length, done: chapterIndexes.length, current: null, failed: [], updated_at: '2026-01-01T00:00:00Z' }, null, 2),
    'utf8',
  )
  for (const index of chapterIndexes) {
    await writeFile(
      path.join(fx.extracted, `ch${String(index).padStart(3, '0')}.json`),
      JSON.stringify({ chapter_index: index, chapter_title: `第${index}章`, source_file: `${index}.txt`, characters: [], clothing: [], items: [] }, null, 2),
      'utf8',
    )
  }
  await writeFile(
    path.join(fx.cards, '_index.json'),
    JSON.stringify({ characters: [{ id: 'char_0001' }], clothing: [], items: [] }, null, 2),
    'utf8',
  )
  await writeFile(path.join(fx.cards, 'characters', '伍定远.md'), '# 伍定远\n', 'utf8')
}

/** 造出 V1 与 V2。 */
async function prepareTwoVersions(fx: Fixture): Promise<void> {
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards }) // first_run
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards }) // V1
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards }) // V2
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  )
}

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

test('list：列出全部版本、latest 与 last_output', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  const index = await historyList(fx.history)

  assert.deepEqual(
    index.versions.map((entry) => entry.version),
    ['V1', 'V2'],
  )
  assert.equal(index.latest, 'V2')
  assert.equal(index.last_output?.extracted_dir, fx.extracted)
  assert.equal(index.versions[0]?.path, 'history/V1')

  const cli = await captureConsole(() => main(['list', '--history', fx.history]))
  assert.equal(cli.value, 0)
  assert.ok(cli.stdout.some((line) => line.includes('latest: V2')))
  assert.ok(cli.stdout.some((line) => line.includes('V1')))

  const asJson = await captureConsole(() => main(['list', '--history', fx.history, '--json']))
  const parsed = JSON.parse(asJson.stdout.join('\n')) as JsonObject
  assert.equal(parsed.latest, 'V2')
})

test('show：读取 _manifest.json 摘要，接受 @V{n} 写法', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  const manifest = await historyShow(fx.history, 'V1')
  assert.equal(manifest.version, 'V1')
  assert.equal(manifest.extracted_dir, fx.extracted)
  assert.equal(manifest.chapter_count, 2)

  assert.equal((await historyShow(fx.history, '@V1')).version, 'V1')
  assert.equal((await historyShow(fx.history, 'v2')).version, 'V2')

  await assert.rejects(() => historyShow(fx.history, 'V9'), /不存在|_manifest/)
  await assert.rejects(() => historyShow(fx.history, 'nope'), /无效版本号/)
  assert.equal((await captureConsole(() => main(['show', 'V1', '--history', fx.history]))).value, 0)
  assert.equal((await captureConsole(() => main(['show', 'V9', '--history', fx.history]))).value, 1)
  assert.equal((await captureConsole(() => main(['show', '--history', fx.history]))).value, 1)
})

test('restore：先给当前输出打快照，再回滚；多余文件默认保留并报告', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  // 把当前输出改成"新的一轮结果"。
  await writeFile(path.join(fx.extracted, 'ch099.json'), '{"chapter_index":99}', 'utf8')
  await writeFile(path.join(fx.cards, 'characters', '伍定远.md'), '# 伍定远（改）\n', 'utf8')
  await mkdir(path.join(fx.cards, 'items'), { recursive: true })
  await writeFile(path.join(fx.cards, 'items', '新物品.md'), '# 新物品\n', 'utf8')

  const result = await historyRestore({ historyDir: fx.history, version: 'V1' })

  assert.equal(result.version, 'V1')
  assert.equal(result.snapshot, 'V3', '回滚前必须给当前输出打快照')
  assert.deepEqual(result.extra_files, ['extracted/ch099.json', 'cards/items/新物品.md'])
  assert.equal(result.cleaned, false)

  // 版本内容确实复制回来了。
  assert.equal(await readFile(path.join(fx.cards, 'characters', '伍定远.md'), 'utf8'), '# 伍定远\n')
  assert.ok(await exists(path.join(fx.extracted, 'ch003.json')))
  // 未 clean → 多余文件仍在。
  assert.ok(await exists(path.join(fx.extracted, 'ch099.json')))
  assert.ok(await exists(path.join(fx.cards, 'items', '新物品.md')))
  // 快照保存的是回滚前的状态。
  assert.equal(
    await readFile(path.join(fx.history, 'V3', 'cards', 'characters', '伍定远.md'), 'utf8'),
    '# 伍定远（改）\n',
  )

  const index = await readHistoryIndex(fx.history)
  assert.deepEqual(
    index.versions.map((entry) => entry.version),
    ['V1', 'V2', 'V3'],
  )
  assert.equal(index.last_output?.extracted_dir, fx.extracted)
})

test('restore --clean：删除当前输出中该版本没有的多余文件', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)
  await writeFile(path.join(fx.extracted, 'ch099.json'), '{"chapter_index":99}', 'utf8')
  await mkdir(path.join(fx.cards, 'items'), { recursive: true })
  await writeFile(path.join(fx.cards, 'items', '新物品.md'), '# 新物品\n', 'utf8')

  const result = await historyRestore({ historyDir: fx.history, version: 'V1', clean: true })

  assert.equal(result.cleaned, true)
  assert.ok(!(await exists(path.join(fx.extracted, 'ch099.json'))))
  assert.ok(!(await exists(path.join(fx.cards, 'items', '新物品.md'))))
  assert.ok(await exists(path.join(fx.extracted, 'ch003.json')))
})

test('restore：当前输出为空时不做快照', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  await rm(path.join(fx.extracted, 'ch003.json'), { force: true })
  await rm(path.join(fx.extracted, 'ch004.json'), { force: true })
  await rm(path.join(fx.cards, 'characters', '伍定远.md'), { force: true })

  const result = await historyRestore({ historyDir: fx.history, version: 'V1' })

  assert.equal(result.snapshot, null)
  assert.ok(await exists(path.join(fx.extracted, 'ch003.json')), '回滚应把文件带回来')
})

test('restore：拒绝把 history 目录本身当作回滚目标', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  await assert.rejects(
    () =>
      historyRestore({
        historyDir: fx.history,
        version: 'V1',
        extractedDir: path.join(fx.history, 'extracted'),
        cardsDir: path.join(fx.history, 'cards'),
      }),
    /不能位于 history 目录内部/,
  )
})

test('prune --keep N：只保留最近 N 个版本并更新索引', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  const dryRun = await historyPrune(fx.history, 1, { dryRun: true })
  assert.deepEqual(dryRun.kept, ['V2'])
  assert.deepEqual(dryRun.pruned, ['V1'])
  assert.equal(dryRun.dry_run, true)
  assert.ok(await exists(path.join(fx.history, 'V1')), '--dry-run 不得删除任何目录')

  const result = await historyPrune(fx.history, 1)
  assert.deepEqual(result.kept, ['V2'])
  assert.deepEqual(result.pruned, ['V1'])
  assert.ok(!(await exists(path.join(fx.history, 'V1'))))
  assert.ok(await exists(path.join(fx.history, 'V2')))
  assert.deepEqual(await listVersionNumbers(fx.history), [2])

  const index = await readHistoryIndex(fx.history)
  assert.deepEqual(
    index.versions.map((entry) => entry.version),
    ['V2'],
  )
  assert.equal(index.latest, 'V2')
})

test('prune --keep 0：清空全部版本，latest 变为 null', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  const result = await historyPrune(fx.history, 0)

  assert.deepEqual(result.kept, [])
  assert.deepEqual(result.pruned, ['V1', 'V2'])
  assert.deepEqual(await listVersionNumbers(fx.history), [])
  const index = await readHistoryIndex(fx.history)
  assert.deepEqual(index.versions, [])
  assert.equal(index.latest, null)
})

test('prune：keep 大于版本数时不删除；非法 keep 报用法错误', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  const result = await historyPrune(fx.history, 5)
  assert.deepEqual(result.kept, ['V2', 'V1'])
  assert.deepEqual(result.pruned, [])
  assert.deepEqual(await listVersionNumbers(fx.history), [1, 2])

  await assert.rejects(() => historyPrune(fx.history, -1), /--keep/)
  assert.equal((await captureConsole(() => main(['prune', '--keep', 'abc', '--history', fx.history]))).value, 2)
  assert.equal((await captureConsole(() => main(['prune', '--history', fx.history]))).value, 1)
})

test('CLI：restore / prune 端到端可解析输出', async (t) => {
  const fx = await makeFixture(t)
  await prepareTwoVersions(fx)

  const restore = await captureConsole(() =>
    main(['restore', 'V1', '--history', fx.history, '--extracted', fx.extracted, '--cards', fx.cards, '--json']),
  )
  assert.equal(restore.value, 0)
  const restored = JSON.parse(restore.stdout.join('\n')) as JsonObject
  assert.equal(restored.version, 'V1')
  assert.equal(restored.snapshot, 'V3')

  const prune = await captureConsole(() => main(['prune', '--keep', '1', '--history', fx.history, '--json']))
  assert.equal(prune.value, 0)
  const pruned = JSON.parse(prune.stdout.join('\n')) as JsonObject
  assert.deepEqual(pruned.kept, ['V3'])

  assert.equal((await captureConsole(() => main(['--nope', '--history', fx.history]))).value, 2)
  assert.equal((await captureConsole(() => main(['bogus', '--history', fx.history]))).value, 2)
  assert.equal((await captureConsole(() => main(['--help']))).value, 0)
})
