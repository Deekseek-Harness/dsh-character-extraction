/**
 * `backup_output.ts` 自测。
 *
 * 覆盖核心硬性规则：**只有两次运行落在同一个输出目录时才备份**，以及版本编号规则、
 * 路径规范化、递归防护、失败不阻塞。
 *
 * 运行::
 *
 *     node --test --test-isolation=none .dsh/skills/character-extraction/scripts/backup_output.test.ts
 *     npx tsx --test .dsh/skills/character-extraction/scripts/backup_output.test.ts
 *
 * @module character-extraction/scripts/backup_output.test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { backupOutput, main } from './backup_output.ts'
import {
  listVersionNumbers,
  nextVersionNumber,
  readHistoryIndex,
  readJsonFile,
} from './history-store.ts'
import type { BackupManifest, JsonObject } from './types.ts'

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

interface Fixture {
  root: string
  extracted: string
  cards: string
  chapters: string
  history: string
}

async function makeFixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'charext-backup-'))
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

/** 写入一份"看起来已经跑过一轮"的输出。 */
async function seedOutput(
  fx: { extracted: string; cards: string; chapters: string },
  options: { chapterIndexes?: number[]; characters?: number; clothing?: number; items?: number } = {},
): Promise<void> {
  const indexes = options.chapterIndexes ?? [3, 4]
  await mkdir(fx.extracted, { recursive: true })
  await mkdir(path.join(fx.cards, 'characters'), { recursive: true })
  await mkdir(fx.chapters, { recursive: true })

  await writeFile(
    path.join(fx.extracted, '_meta.json'),
    JSON.stringify({ source_dir: fx.chapters, chapter_count: indexes.length, chapters: [] }, null, 2),
    'utf8',
  )
  await writeFile(
    path.join(fx.extracted, '_progress.json'),
    JSON.stringify({ total: indexes.length, done: indexes.length, current: null, failed: [], updated_at: '2026-01-01T00:00:00Z' }, null, 2),
    'utf8',
  )
  for (const index of indexes) {
    const name = `ch${String(index).padStart(3, '0')}.json`
    await writeFile(
      path.join(fx.extracted, name),
      JSON.stringify(
        { chapter_index: index, chapter_title: `第${index}章`, source_file: `${index}.txt`, characters: [], clothing: [], items: [] },
        null,
        2,
      ),
      'utf8',
    )
  }

  const list = (count: number, prefix: string): JsonObject[] =>
    Array.from({ length: count }, (_, position) => ({ id: `${prefix}_${position + 1}` }))
  await writeFile(
    path.join(fx.cards, '_index.json'),
    JSON.stringify(
      {
        characters: list(options.characters ?? 2, 'char'),
        clothing: list(options.clothing ?? 1, 'cloth'),
        items: list(options.items ?? 1, 'item'),
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(path.join(fx.cards, 'characters', '伍定远.md'), '# 伍定远\n', 'utf8')
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

test('首次运行：没有 last_output → 不备份，只记录 last_output', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)

  const decision = await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  assert.equal(decision.backup_performed, false)
  assert.equal(decision.reason, 'first_run')
  assert.equal(decision.version, null)
  assert.equal(decision.history_dir, fx.history)
  assert.deepEqual(await listVersionNumbers(fx.history), [], '首次运行不得产生任何版本目录')

  const index = await readHistoryIndex(fx.history)
  assert.deepEqual(index.versions, [])
  assert.equal(index.latest, null)
  assert.equal(index.last_output?.extracted_dir, fx.extracted)
  assert.equal(index.last_output?.cards_dir, fx.cards)
  assert.match(index.last_output?.updated_at ?? '', ISO_UTC)
})

test('第二次运行、同一输出目录且非空 → 备份为 history/V1', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx, { characters: 12, clothing: 11, items: 21 })
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  const decision = await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  assert.equal(decision.backup_performed, true)
  assert.equal(decision.version, 'V1')
  assert.equal(decision.reason, 'same_output_dir')
  assert.equal(decision.manifest, path.join(fx.history, 'V1', '_manifest.json'))
  assert.deepEqual(decision.counts, {
    chapter_count: 2,
    character_count: 12,
    clothing_count: 11,
    item_count: 21,
  })

  for (const rel of [
    'extracted/_meta.json',
    'extracted/_progress.json',
    'extracted/ch003.json',
    'extracted/ch004.json',
    'cards/_index.json',
    'cards/characters/伍定远.md',
  ]) {
    assert.ok(await exists(path.join(fx.history, 'V1', ...rel.split('/'))), `备份应包含 ${rel}`)
  }

  const manifest = await readJsonFile<BackupManifest>(path.join(fx.history, 'V1', '_manifest.json'))
  assert.ok(manifest !== undefined)
  assert.equal(manifest.version, 'V1')
  assert.match(manifest.created_at, ISO_UTC)
  assert.equal(manifest.source_chapters, fx.chapters, 'source_chapters 应取自 _meta.json 的 source_dir')
  assert.equal(manifest.extracted_dir, fx.extracted)
  assert.equal(manifest.cards_dir, fx.cards)
  assert.equal(manifest.note, '备份自上一次运行输出')
})

test('第三次运行：备份为 V2，编号连续且索引正确', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })
  const first = await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })
  const second = await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  assert.equal(first.version, 'V1')
  assert.equal(second.version, 'V2')

  const index = await readHistoryIndex(fx.history)
  assert.deepEqual(
    index.versions.map((entry) => entry.version),
    ['V1', 'V2'],
  )
  assert.equal(index.latest, 'V2')
  assert.equal(index.versions[0]?.path, 'history/V1')
  assert.equal(index.versions[1]?.path, 'history/V2')
  assert.equal(index.last_output?.extracted_dir, fx.extracted)
  assert.deepEqual(await listVersionNumbers(fx.history), [1, 2])
})

test('版本号只增不减：删除旧版本目录后不复用其编号', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards }) // V1
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards }) // V2

  await rm(path.join(fx.history, 'V1'), { recursive: true, force: true })
  const decision = await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  assert.equal(decision.version, 'V3', '已删除的 V1 不得被复用')
  assert.ok(!(await exists(path.join(fx.history, 'V1'))))
  assert.ok(await exists(path.join(fx.history, 'V3')))
})

test('版本号扫描同时参考磁盘目录与索引（磁盘上有 V1/V5 → 下一个是 V6）', async (t) => {
  const fx = await makeFixture(t)
  await mkdir(path.join(fx.history, 'V1'), { recursive: true })
  await mkdir(path.join(fx.history, 'V5'), { recursive: true })

  const next = await nextVersionNumber(fx.history, { last_output: null, versions: [], latest: null })

  assert.equal(next, 6)
})

test('输出目录变更：不触发备份，只更新 last_output', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  const other = {
    extracted: path.join(fx.root, 'extracted2'),
    cards: path.join(fx.root, 'cards2'),
    chapters: fx.chapters,
  }
  await seedOutput(other)

  const decision = await backupOutput({ extractedDir: other.extracted, cardsDir: other.cards })

  assert.equal(decision.backup_performed, false)
  assert.equal(decision.reason, 'output_dir_changed')
  assert.equal(decision.version, null)
  assert.equal(decision.previous_extracted, fx.extracted)
  assert.equal(decision.current_extracted, other.extracted)
  assert.deepEqual(await listVersionNumbers(fx.history), [], '换目录后不应产生备份')

  const index = await readHistoryIndex(fx.history)
  assert.equal(index.last_output?.extracted_dir, other.extracted)
  assert.equal(index.last_output?.cards_dir, other.cards)
  assert.equal(index.latest, null)
})

test('路径规范化：尾斜杠与 .. 归一化后仍判定为同一输出目录', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  const decision = await backupOutput({
    extractedDir: `${fx.extracted}${path.sep}`,
    cardsDir: path.join(fx.root, 'cards', '..', 'cards'),
  })

  assert.equal(decision.backup_performed, true, '规范化后应认定为同一目录')
  assert.equal(decision.version, 'V1')
  assert.equal(decision.current_extracted, fx.extracted)
  assert.equal(decision.current_cards, fx.cards)
})

test('当前输出为空（无 ch*.json）：不备份，只更新 last_output', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  await rm(path.join(fx.extracted, 'ch003.json'), { force: true })
  await rm(path.join(fx.extracted, 'ch004.json'), { force: true })

  const decision = await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  assert.equal(decision.backup_performed, false)
  assert.equal(decision.reason, 'empty_output')
  assert.deepEqual(await listVersionNumbers(fx.history), [])
  const index = await readHistoryIndex(fx.history)
  assert.equal(index.last_output?.extracted_dir, fx.extracted)
})

test('history 永远不会被备份进自身', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  assert.ok(!(await exists(path.join(fx.history, 'V1', 'extracted', 'history'))))
  assert.ok(!(await exists(path.join(fx.history, 'V1', 'cards', 'history'))))

  // 显式把 history 放进输出目录内部 → 拒绝备份且不写任何东西。
  const inner = path.join(fx.extracted, 'history')
  const decision = await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards, historyDir: inner })

  assert.equal(decision.backup_performed, false)
  assert.equal(decision.reason, 'history_inside_output')
  assert.ok(!(await exists(path.join(inner, '_index.json'))), '应拒绝在输出目录内部写索引')
})

test('备份失败：不阻塞主流程，原因写入 _progress.json 的 backup_failed', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  // 注入失败：把 history/V1 变成文件，使 mkdir 失败。
  const blocker = path.join(fx.history, 'V1')
  await writeFile(blocker, 'blocker', 'utf8')

  const decision = await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  assert.equal(decision.backup_performed, false)
  assert.equal(decision.reason, 'backup_error')
  assert.equal(decision.version, null)
  assert.equal(decision.backup_failed_recorded, true)
  assert.ok((decision.error ?? '').length > 0)

  const progress = await readJsonFile<JsonObject>(path.join(fx.extracted, '_progress.json'))
  assert.ok(progress !== undefined)
  assert.ok(progress.backup_failed !== undefined, '_progress.json 必须有 backup_failed')
  const failure = progress.backup_failed as JsonObject
  assert.equal(typeof failure.error, 'string')
  assert.match(String(failure.at), ISO_UTC)
  // 原有字段保留
  assert.equal(progress.done, 2)
  assert.ok(!(await exists(path.join(fx.history, 'V1', '_manifest.json'))))

  // CLI 层：备份失败仍然退出 0（不阻塞主流程）。
  const cli = await captureConsole(() =>
    main(['--extracted', fx.extracted, '--cards', fx.cards, '--history', fx.history]),
  )
  assert.equal(cli.value, 0)
  const parsed = JSON.parse(cli.stdout.join('\n')) as JsonObject
  assert.equal(parsed.reason, 'backup_error')
})

test('history 目录位置：不同父目录时落在最近公共父目录', async (t) => {
  const fx = await makeFixture(t)
  const extracted = path.join(fx.root, 'a', 'extracted')
  const cards = path.join(fx.root, 'cards')
  await seedOutput({ extracted, cards, chapters: fx.chapters })

  const decision = await backupOutput({ extractedDir: extracted, cardsDir: cards })

  assert.equal(decision.history_dir, path.join(fx.root, 'history'))
})

test('--source-chapters 覆盖 _manifest.json 的 source_chapters', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  const explicit = path.join(fx.root, 'explicit-chapters')
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards, chaptersDir: explicit })

  const manifest = await readJsonFile<BackupManifest>(path.join(fx.history, 'V1', '_manifest.json'))
  assert.equal(manifest?.source_chapters, explicit)
})

test('CLI：端到端两次运行，stdout 决策 JSON 可解析；缺参返回 2', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  const argv = ['--extracted', fx.extracted, '--cards', fx.cards]

  const first = await captureConsole(() => main(argv))
  assert.equal(first.value, 0)
  const firstDecision = JSON.parse(first.stdout.join('\n')) as JsonObject
  assert.equal(firstDecision.backup_performed, false)
  assert.equal(firstDecision.reason, 'first_run')

  const second = await captureConsole(() => main(argv))
  assert.equal(second.value, 0)
  const secondDecision = JSON.parse(second.stdout.join('\n')) as JsonObject
  assert.equal(secondDecision.backup_performed, true)
  assert.equal(secondDecision.version, 'V1')

  assert.equal((await captureConsole(() => main([]))).value, 2)
  assert.equal((await captureConsole(() => main(['--extracted', fx.extracted]))).value, 2)
  assert.equal((await captureConsole(() => main(['--nope']))).value, 2)
  assert.equal((await captureConsole(() => main(['--help']))).value, 0)
})

test('备份是只读复制：源输出文件内容不变', async (t) => {
  const fx = await makeFixture(t)
  await seedOutput(fx)
  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })
  const before = await readFile(path.join(fx.extracted, 'ch003.json'), 'utf8')

  await backupOutput({ extractedDir: fx.extracted, cardsDir: fx.cards })

  const after = await readFile(path.join(fx.extracted, 'ch003.json'), 'utf8')
  const copied = await readFile(path.join(fx.history, 'V1', 'extracted', 'ch003.json'), 'utf8')
  assert.equal(after, before)
  assert.equal(copied, before)
})
