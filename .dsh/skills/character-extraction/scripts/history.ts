#!/usr/bin/env node
/**
 * 版本历史子命令：`list` / `show` / `restore` / `prune`。
 *
 * 用法::
 *
 *     npx tsx .dsh/skills/character-extraction/scripts/history.ts list
 *     npx tsx .dsh/skills/character-extraction/scripts/history.ts show V1
 *     npx tsx .dsh/skills/character-extraction/scripts/history.ts restore V1 [--clean]
 *     npx tsx .dsh/skills/character-extraction/scripts/history.ts prune --keep 2 [--dry-run]
 *
 * 版本 token 接受 `V1`、`v1`、`@V1`（`@` 来自 `@` 引用写法）。
 *
 * 退出码：0 = 成功；1 = 运行期失败（版本不存在等）；2 = 用法错误。
 *
 * @module character-extraction/scripts/history
 */

import { rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  copyTree,
  createVersionSnapshot,
  hasSnapshotWorthyContent,
  isSameOrInside,
  listFilesRecursive,
  listVersionNumbers,
  normalizeDir,
  parseVersionNumber,
  readHistoryIndex,
  readJsonFile,
  removeFiles,
  resolveHistoryDir,
  timestamp,
  versionName,
  versionRelativePath,
  writeHistoryIndex,
} from './history-store.ts'
import type { BackupManifest, HistoryIndex, PruneResult, RestoreResult } from './types.ts'
import { errorMessage } from './util.ts'

/** 强校验：`target` 必须严格位于 `historyDir` 内部。 */
function assertStrictlyInside(historyDir: string, target: string): void {
  const base = normalizeDir(historyDir)
  const resolved = normalizeDir(target)
  const rel = path.relative(base, resolved)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝操作 history 目录之外的路径：${resolved}`)
  }
}

/** 解析版本目录（并强校验范围）。 */
function versionDirOf(historyDir: string, version: string): string {
  const number = parseVersionNumber(version)
  if (number === null) throw new Error(`无效版本号：${version}（应为 V1 形式）`)
  const dir = path.join(normalizeDir(historyDir), versionName(number))
  assertStrictlyInside(historyDir, dir)
  return dir
}

/**
 * 列出全部版本（`history list`）。
 * @param historyDir - `history/` 目录。
 * @returns 版本索引。
 */
export async function historyList(historyDir: string): Promise<HistoryIndex> {
  return await readHistoryIndex(historyDir)
}

/**
 * 读取某个版本的 `_manifest.json`（`history show`），不修改任何文件。
 * @param historyDir - `history/` 目录。
 * @param version - 版本 token。
 * @returns 版本清单。
 * @throws 版本目录或清单缺失时抛出。
 */
export async function historyShow(historyDir: string, version: string): Promise<BackupManifest> {
  const dir = versionDirOf(historyDir, version)
  const manifest = await readJsonFile<BackupManifest>(path.join(dir, '_manifest.json'))
  if (manifest === undefined) {
    throw new Error(`版本 ${versionName(parseVersionNumber(version) as number)} 不存在或缺少 _manifest.json：${dir}`)
  }
  return manifest
}

/** `historyRestore()` 的入参。 */
export interface RestoreOptions {
  historyDir: string
  version: string
  /** 目标逐章目录；省略时取该版本清单里的 `extracted_dir`。 */
  extractedDir?: string
  /** 目标卡片目录；省略时取该版本清单里的 `cards_dir`。 */
  cardsDir?: string
  /** 是否删除当前输出中该版本没有的多余文件。 */
  clean?: boolean
}

/**
 * 回滚到某个版本（`history restore`）。
 *
 * 顺序：先给**当前输出**打一份新快照（避免回滚不可逆），再把版本内容复制回目标目录。
 * 默认不删除多余文件，只把它们报告出来；`clean` 为真时先删除再复制。
 * @param options - 回滚参数。
 * @returns 回滚结果。
 * @throws 版本不存在、目标目录无法确定时抛出。
 */
export async function historyRestore(options: RestoreOptions): Promise<RestoreResult> {
  const historyDir = normalizeDir(options.historyDir)
  const manifest = await historyShow(historyDir, options.version)
  const versionDir = versionDirOf(historyDir, options.version)

  const index = await readHistoryIndex(historyDir)
  const targetExtracted = normalizeDir(
    options.extractedDir ?? manifest.extracted_dir ?? index.last_output?.extracted_dir ?? '',
  )
  const targetCards = normalizeDir(options.cardsDir ?? manifest.cards_dir ?? index.last_output?.cards_dir ?? '')

  if (targetExtracted === '' || targetCards === '') {
    throw new Error('无法确定回滚目标目录：请在清单缺失时用 --extracted 与 --cards 显式指定')
  }
  if (isSameOrInside(historyDir, targetExtracted) || isSameOrInside(historyDir, targetCards)) {
    throw new Error(`回滚目标（${targetExtracted} / ${targetCards}）不能位于 history 目录内部`)
  }

  // 1) 回滚前先快照当前输出。
  let snapshot: string | null = null
  if (await hasSnapshotWorthyContent(targetExtracted, targetCards)) {
    const created = await createVersionSnapshot({
      historyDir,
      index,
      extractedDir: targetExtracted,
      cardsDir: targetCards,
      note: '回滚前自动快照',
    })
    index.versions.push(created.entry)
    snapshot = created.version
  }

  // 2) 计算当前输出中该版本没有的多余文件。
  const sourceExtracted = path.join(versionDir, 'extracted')
  const sourceCards = path.join(versionDir, 'cards')
  const versionExtractedFiles = new Set(await listFilesRecursive(sourceExtracted))
  const versionCardsFiles = new Set(await listFilesRecursive(sourceCards))

  const extrasExtracted = (await listFilesRecursive(targetExtracted)).filter((name) => !versionExtractedFiles.has(name))
  const extrasCards = (await listFilesRecursive(targetCards)).filter((name) => !versionCardsFiles.has(name))
  const extraFiles = [
    ...extrasExtracted.map((name) => `extracted/${name}`),
    ...extrasCards.map((name) => `cards/${name}`),
  ]

  // 3) 可选清理，然后复制。
  if (options.clean === true) {
    await removeFiles(targetExtracted, extrasExtracted)
    await removeFiles(targetCards, extrasCards)
  }
  await copyTree(sourceExtracted, targetExtracted)
  await copyTree(sourceCards, targetCards)

  // 4) 目标目录现在就是"上一次运行输出"。
  index.last_output = {
    extracted_dir: targetExtracted,
    cards_dir: targetCards,
    updated_at: timestamp(),
  }
  await writeHistoryIndex(historyDir, index)

  return {
    version: manifest.version,
    restored_extracted: targetExtracted,
    restored_cards: targetCards,
    snapshot,
    extra_files: extraFiles,
    cleaned: options.clean === true,
  }
}

/**
 * 只保留最近 N 个版本（`history prune`）。不做自动清理，必须显式调用。
 * @param historyDir - `history/` 目录。
 * @param keep - 保留的版本数量（>= 0）。
 * @param options - `dryRun` 为真时只报告不删除。
 * @returns `kept` 为**由新到旧**（与 `list` 一致），`pruned` 为**由旧到新**（删除顺序）。
 * @throws `keep` 非法时抛出。
 */
export async function historyPrune(
  historyDir: string,
  keep: number,
  options: { dryRun?: boolean } = {},
): Promise<PruneResult> {
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`--keep 必须是不小于 0 的整数，实际为 ${keep}`)

  const base = normalizeDir(historyDir)
  const index = await readHistoryIndex(base)
  const fromDisk = await listVersionNumbers(base)
  const fromIndex = index.versions
    .map((entry) => parseVersionNumber(entry.version))
    .filter((value): value is number => value !== null)

  const allNumbers = [...new Set([...fromDisk, ...fromIndex])].sort((left, right) => right - left)
  const keepNumbers = allNumbers.slice(0, keep)
  const pruneNumbers = allNumbers.slice(keep)

  const dryRun = options.dryRun === true
  if (!dryRun) {
    for (const number of pruneNumbers) {
      const dir = path.join(base, versionName(number))
      if (!isSameOrInside(base, dir) || normalizeDir(dir) === base) continue
      assertStrictlyInside(base, dir)
      await rm(dir, { recursive: true, force: true })
    }
    index.versions = index.versions.filter((entry) => {
      const number = parseVersionNumber(entry.version)
      return number !== null && keepNumbers.includes(number)
    })
    await writeHistoryIndex(base, index)
  }

  return {
    kept: keepNumbers.map(versionName),
    pruned: [...pruneNumbers].reverse().map(versionName),
    dry_run: dryRun,
  }
}

/** CLI 用法文本。 */
export function usage(): string {
  return [
    '用法：history.ts <list|show|restore|prune> [参数]',
    '',
    '子命令：',
    '  list                          列出 history/_index.json 中的全部版本',
    '  show <V{n}>                   显示该版本 _manifest.json 摘要（不修改文件）',
    '  restore <V{n}> [--clean]      回滚到该版本（回滚前自动给当前输出打快照）',
    '  prune --keep <N> [--dry-run]  只保留最近 N 个版本，其余删除',
    '',
    '通用选项：',
    '  --history <dir>   显式 history 目录（默认由 --extracted/--cards 推导，再退化为 ./extracted 与 ./cards）',
    '  --extracted <dir> 逐章输出目录（restore 的目标；list/show/prune 仅用于推导 history）',
    '  --cards <dir>     卡片输出目录（restore 的目标；同上）',
    '  --json            以 JSON 输出结果',
    '  --help            显示本帮助',
    '',
    '退出码：0 = 成功；1 = 运行期失败；2 = 用法错误。',
  ].join('\n')
}

/** CLI 解析结果。 */
export interface HistoryCliArgs {
  command?: string
  target?: string
  history?: string
  extracted?: string
  cards?: string
  keep?: number
  clean: boolean
  dryRun: boolean
  json: boolean
  help: boolean
}

/**
 * 手写参数解析（不引入依赖）。
 * @param argv - 参数列表（不含 node 与脚本路径）。
 * @returns 解析结果。
 * @throws 未知选项、缺少取值或 `--keep` 非整数时抛出。
 */
export function parseHistoryArgs(argv: string[]): HistoryCliArgs {
  const args: HistoryCliArgs = { clean: false, dryRun: false, json: false, help: false }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? ''
    const equals = token.indexOf('=')
    const flag = token.startsWith('--') && equals > 0 ? token.slice(0, equals) : token

    const takeValue = (): string => {
      if (equals > 0) return token.slice(equals + 1)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`选项 ${flag} 缺少取值`)
      i += 1
      return next
    }

    switch (flag) {
      case '--history':
        args.history = takeValue()
        break
      case '--extracted':
        args.extracted = takeValue()
        break
      case '--cards':
        args.cards = takeValue()
        break
      case '--keep': {
        const raw = takeValue()
        const parsed = Number(raw)
        if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--keep 必须是不小于 0 的整数，实际为 ${raw}`)
        args.keep = parsed
        break
      }
      case '--clean':
        args.clean = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--json':
        args.json = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        if (flag.startsWith('--')) throw new Error(`未知选项：${token}`)
        positional.push(token)
    }
  }

  if (positional.length > 0) args.command = positional[0]
  if (positional.length > 1) args.target = positional[1]
  return args
}

/** 解析 CLI 使用的 history 目录（显式 > 由输出目录推导 > 工作区默认值）。 */
function historyDirFor(args: HistoryCliArgs): string {
  if (args.history !== undefined && args.history.trim() !== '') return normalizeDir(args.history)
  const extracted = normalizeDir(args.extracted ?? path.resolve('extracted'))
  const cards = normalizeDir(args.cards ?? path.resolve('cards'))
  return resolveHistoryDir(extracted, cards)
}

function formatCounts(entry: { chapter_count: number; character_count: number; clothing_count: number; item_count: number }): string {
  return `章 ${entry.chapter_count} / 人物 ${entry.character_count} / 衣物 ${entry.clothing_count} / 物品 ${entry.item_count}`
}

function printList(index: HistoryIndex, historyDir: string): void {
  console.log(`history: ${historyDir}`)
  console.log(`latest: ${index.latest ?? '(无)'}`)
  if (index.last_output === null) {
    console.log('last_output: (无)')
  } else {
    console.log(`last_output: extracted=${index.last_output.extracted_dir}`)
    console.log(`             cards=${index.last_output.cards_dir}`)
    console.log(`             updated_at=${index.last_output.updated_at}`)
  }
  if (index.versions.length === 0) {
    console.log('versions: (无)')
    return
  }
  console.log(`versions: ${index.versions.length} 个`)
  for (const entry of [...index.versions].reverse()) {
    console.log(`  ${entry.version}  ${entry.created_at}  ${formatCounts(entry)}  ${entry.path}`)
  }
}

/**
 * CLI 入口。
 * @param argv - 参数列表，默认取 `process.argv.slice(2)`。
 * @returns 进程退出码。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: HistoryCliArgs
  try {
    args = parseHistoryArgs(argv)
  } catch (error) {
    console.error(`错误：${errorMessage(error)}`)
    console.error(usage())
    return 2
  }

  if (args.help || args.command === undefined) {
    console.log(usage())
    return args.command === undefined && !args.help ? 2 : 0
  }

  const historyDir = historyDirFor(args)

  try {
    switch (args.command) {
      case 'list': {
        const index = await historyList(historyDir)
        if (args.json) console.log(JSON.stringify(index, null, 2))
        else printList(index, historyDir)
        return 0
      }

      case 'show': {
        if (args.target === undefined) throw new Error('show 需要版本号，例如：history show V1')
        const manifest = await historyShow(historyDir, args.target)
        if (args.json) {
          console.log(JSON.stringify(manifest, null, 2))
        } else {
          console.log(`${manifest.version}  ${versionRelativePath(historyDir, path.join(historyDir, manifest.version))}`)
          console.log(`created_at: ${manifest.created_at}`)
          console.log(`source_chapters: ${manifest.source_chapters}`)
          console.log(`extracted_dir: ${manifest.extracted_dir}`)
          console.log(`cards_dir: ${manifest.cards_dir}`)
          console.log(`counts: ${formatCounts(manifest)}`)
          console.log(`note: ${manifest.note}`)
        }
        return 0
      }

      case 'restore': {
        if (args.target === undefined) throw new Error('restore 需要版本号，例如：history restore V1')
        const result = await historyRestore({
          historyDir,
          version: args.target,
          ...(args.extracted === undefined ? {} : { extractedDir: args.extracted }),
          ...(args.cards === undefined ? {} : { cardsDir: args.cards }),
          clean: args.clean,
        })
        if (args.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(`已回滚到 ${result.version}${result.cleaned ? '（已清理多余文件）' : ''}`)
          console.log(`extracted: ${result.restored_extracted}`)
          console.log(`cards: ${result.restored_cards}`)
          console.log(`回滚前快照: ${result.snapshot ?? '(当前输出为空，未打快照)'}`)
          console.log(`多余文件: ${result.extra_files.length}${result.cleaned ? '（已删除）' : '（未删除，用 --clean 删除）'}`)
          for (const name of result.extra_files.slice(0, 20)) console.log(`  - ${name}`)
          if (result.extra_files.length > 20) console.log(`  …… 其余 ${result.extra_files.length - 20} 个`)
        }
        return 0
      }

      case 'prune': {
        if (args.keep === undefined) throw new Error('prune 需要 --keep <N>，例如：history prune --keep 2')
        const result = await historyPrune(historyDir, args.keep, { dryRun: args.dryRun })
        if (args.json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(`保留: ${result.kept.length === 0 ? '(无)' : result.kept.join(', ')}`)
          console.log(`删除: ${result.pruned.length === 0 ? '(无)' : result.pruned.join(', ')}`)
          if (result.dry_run) console.log('（--dry-run：未实际删除）')
        }
        return 0
      }

      default:
        console.error(`错误：未知子命令 ${args.command}`)
        console.error(usage())
        return 2
    }
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
