#!/usr/bin/env node
/**
 * 版本备份判断与执行。
 *
 * **硬性规则**：只有「两次运行落在同一个输出目录」时，才把上一次输出备份到 `history/V{n}/`。
 * 输出目录不同、或没有上一次记录（首次运行）、或当前输出为空，都**不备份**，只更新
 * `_index.json` 的 `last_output`。
 *
 * 主 Agent 只读取本脚本输出的决策 JSON；路径规范化、目录比较、版本号扫描、目录存在性
 * 检查全部在这里完成，模型不参与。
 *
 * 用法::
 *
 *     npx tsx .dsh/skills/character-extraction/scripts/backup_output.ts \
 *         --extracted extracted --cards cards
 *
 * 退出码：0 = 已给出决策（**包括备份失败**，因为备份失败不得阻塞主流程）；2 = 用法错误。
 *
 * @module character-extraction/scripts/backup_output
 */

import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  createVersionSnapshot,
  isEmptyOutput,
  isSameOrInside,
  normalizeDir,
  readHistoryIndex,
  recordBackupFailure,
  resolveHistoryDir,
  samePath,
  timestamp,
  writeHistoryIndex,
} from './history-store.ts'
import type { BackupDecision, BackupReason, HistoryIndex } from './types.ts'
import { errorMessage } from './util.ts'

/** `backupOutput()` 的入参。 */
export interface BackupOptions {
  /** 当前逐章输出目录（`@extracted_dir`）。 */
  extractedDir: string
  /** 当前卡片输出目录（`@cards_dir`）。 */
  cardsDir: string
  /** 显式 `history/` 目录；省略时按规则推导。 */
  historyDir?: string
  /** `_manifest.json` 的 `source_chapters` 覆盖值；省略时读 `_meta.json`。 */
  chaptersDir?: string
}

/** 判断 history 目录是否直接落在文件系统根下（此时给出提示）。 */
function historyAtRootWarning(historyDir: string): string | undefined {
  const parent = path.dirname(historyDir)
  if (parent === path.parse(parent).root) {
    return `history 目录位于盘符/文件系统根下（${historyDir}），建议用 --history 显式指定工作区内的位置`
  }
  return undefined
}

/**
 * 执行备份判断（必要时备份），并更新 `history/_index.json` 的 `last_output`。
 *
 * @param options - 输出目录与可选覆盖。
 * @returns 决策对象，可直接序列化为 JSON 交给主 Agent。
 */
export async function backupOutput(options: BackupOptions): Promise<BackupDecision> {
  const extractedDir = normalizeDir(options.extractedDir)
  const cardsDir = normalizeDir(options.cardsDir)
  const historyDir = resolveHistoryDir(extractedDir, cardsDir, options.historyDir)

  const base: BackupDecision = {
    backup_performed: false,
    version: null,
    reason: 'first_run',
    history_dir: historyDir,
    current_extracted: extractedDir,
    current_cards: cardsDir,
  }

  const warning = historyAtRootWarning(historyDir)
  if (warning !== undefined) base.warning = warning

  // 递归防护：history 不得位于任一输出目录内部，否则会把 history 自己复制进 history。
  if (isSameOrInside(extractedDir, historyDir) || isSameOrInside(cardsDir, historyDir)) {
    return {
      ...base,
      reason: 'history_inside_output',
      warning: `history 目录（${historyDir}）位于输出目录内部，已跳过备份以避免递归`,
    }
  }

  const index: HistoryIndex = await readHistoryIndex(historyDir)
  const lastOutput = index.last_output

  let reason: BackupReason
  if (lastOutput === null) {
    reason = 'first_run'
  } else if (!samePath(lastOutput.extracted_dir, extractedDir) || !samePath(lastOutput.cards_dir, cardsDir)) {
    reason = 'output_dir_changed'
    base.previous_extracted = lastOutput.extracted_dir
    base.previous_cards = lastOutput.cards_dir
  } else if (await isEmptyOutput(extractedDir)) {
    reason = 'empty_output'
    base.previous_extracted = lastOutput.extracted_dir
    base.previous_cards = lastOutput.cards_dir
  } else {
    reason = 'same_output_dir'
  }

  base.reason = reason

  if (reason === 'same_output_dir') {
    try {
      const snapshot = await createVersionSnapshot({
        historyDir,
        index,
        extractedDir,
        cardsDir,
        ...(options.chaptersDir === undefined ? {} : { chaptersDir: normalizeDir(options.chaptersDir) }),
      })
      index.versions.push(snapshot.entry)
      base.backup_performed = true
      base.version = snapshot.version
      base.manifest = snapshot.manifestFile
      base.counts = {
        chapter_count: snapshot.manifest.chapter_count,
        character_count: snapshot.manifest.character_count,
        clothing_count: snapshot.manifest.clothing_count,
        item_count: snapshot.manifest.item_count,
      }
    } catch (error) {
      // 备份失败不阻塞主流程：把原因写进 _progress.json 的 backup_failed 后继续。
      const recorded = await recordBackupFailure(extractedDir, error)
      return {
        ...base,
        reason: 'backup_error',
        version: null,
        error: errorMessage(error),
        backup_failed_recorded: recorded,
      }
    }
  }

  index.last_output = {
    extracted_dir: extractedDir,
    cards_dir: cardsDir,
    updated_at: timestamp(),
  }

  try {
    await writeHistoryIndex(historyDir, index)
  } catch (error) {
    // 索引写不进去也不阻塞主流程，只把原因带回给调用方。
    base.warning = `${base.warning === undefined ? '' : `${base.warning}；`}无法写入 history/_index.json：${errorMessage(error)}`
  }

  return base
}

/** CLI 用法文本。 */
export function usage(): string {
  return [
    '用法：backup_output.ts --extracted <extracted_dir> --cards <cards_dir> [--history <history_dir>]',
    '',
    '选项：',
    '  --extracted <dir>        当前逐章输出目录（@extracted_dir），必填',
    '  --cards <dir>            当前卡片输出目录（@cards_dir），必填',
    '  --history <dir>          显式 history 目录（默认按规则推导）',
    '  --source-chapters <dir>  写入 _manifest.json 的 source_chapters（默认取 _meta.json）',
    '  --help                   显示本帮助',
    '',
    '退出码：0 = 已给出决策（含备份失败）；2 = 用法错误。',
  ].join('\n')
}

/** CLI 解析结果。 */
export interface BackupCliArgs {
  extracted?: string
  cards?: string
  history?: string
  sourceChapters?: string
  help: boolean
}

/**
 * 手写参数解析（不引入依赖）。
 * @param argv - 参数列表（不含 node 与脚本路径）。
 * @returns 解析结果。
 * @throws 未知选项或缺少取值时抛出。
 */
export function parseBackupArgs(argv: string[]): BackupCliArgs {
  const args: BackupCliArgs = { help: false }

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
      case '--extracted':
        args.extracted = takeValue()
        break
      case '--cards':
        args.cards = takeValue()
        break
      case '--history':
        args.history = takeValue()
        break
      case '--source-chapters':
        args.sourceChapters = takeValue()
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
 * CLI 入口：把决策 JSON 打到 stdout。
 * @param argv - 参数列表，默认取 `process.argv.slice(2)`。
 * @returns 进程退出码。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: BackupCliArgs
  try {
    args = parseBackupArgs(argv)
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

  const decision = await backupOutput({
    extractedDir: args.extracted,
    cardsDir: args.cards,
    ...(args.history === undefined ? {} : { historyDir: args.history }),
    ...(args.sourceChapters === undefined ? {} : { chaptersDir: args.sourceChapters }),
  })

  console.log(JSON.stringify(decision, null, 2))

  if (decision.reason === 'backup_error') {
    console.error(`警告：备份失败但主流程继续；原因已记录：${decision.error ?? '未知'}`)
  }
  return 0
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
