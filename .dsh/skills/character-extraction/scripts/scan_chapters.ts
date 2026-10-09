#!/usr/bin/env node
/**
 * 扫描章节目录，生成 character-extraction 的 `_meta.json` 章节清单。
 *
 * 用法::
 *
 *     npx tsx .dsh/skills/character-extraction/scripts/scan_chapters.ts \
 *         --input chapters --output extracted/_meta.json
 *
 * 只读文件名，不读章节内容，因此可在主 Agent 上下文之外零成本运行。
 *
 * 文件名解析规则（与 SKILL.md 一致）：
 * - 主规则：`^([0-9]{3})_(.+)\.txt$`（忽略大小写），`index` 为三位数字前缀。
 * - 其余部分按 `_` 分割；含「第X卷」的片段填入 `volume`，含「第X章/回/节」的填入
 *   `chapter`；最后一个片段为 `title`。
 * - 无「第X章」时，首个片段作为 `chapter`（于是 `000_卷首.txt` 得到
 *   `chapter=卷首, title=卷首`，与规范样例一致）。
 * - 无法拆分时 `full_title` 保留完整标题。
 * - 兜底：`ch0001.txt`、`1_标题.txt` 这类非规范命名也能解析，索引取自其中的数字；
 *   若该目录下存在 novel-split 风格的 `_meta.json`，用它的 `chapters[].title` 回填标题
 *   （诊断信息写到 stderr，`_meta.json` 本身严格保持规范形状）。
 *
 * 退出码：0 = 成功（含空目录，会输出告警）；1 = 运行期失败；2 = 用法/环境错误。
 *
 * @module character-extraction/scripts/scan_chapters
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import type { Chapter, JsonObject, Meta, ScanOptions, ScanResult, TitleHint } from './types.ts'
import { compareStrings, errorMessage, isPlainObject, stripBom } from './util.ts'

/** 主规则：三位数字前缀 + 下划线 + 标题。 */
const PRIMARY_NAME = /^([0-9]{3})_(.+)\.txt$/i
/** 兜底规则：任意前导数字（含 `ch0001` 形式）。索引只认 ASCII 数字，保证 `Number()` 可用。 */
const FALLBACK_NAME = /^(?:ch)?([0-9]+)/i
/** 「第X卷」片段（`\p{Nd}` 覆盖 Unicode 十进制数字，如全角数字）。 */
const VOLUME_PART = /^第[一二三四五六七八九十百千零两\p{Nd}]+卷/u
/** 「第X章 / 第X回 / 第X节」片段。 */
const CHAPTER_PART = /^第[一二三四五六七八九十百千零两\p{Nd}]+[章回节]/u
/** 从 novel-split 的 title（如「第一章 山雨欲来」）中拆出章节指称与标题。 */
const HINT_TITLE_PART = /^(第[一二三四五六七八九十百千零两\p{Nd}]+[章回节])\s*(.*)$/u

/** 标题拆解结果。 */
interface SplitTitle {
  volume: string
  chapter: string
  title: string
}

/**
 * 把「下划线连接的标题」拆成 volume / chapter / title。
 * @param rest - 已去掉数字前缀与 `.txt` 的标题部分。
 * @returns 拆解结果；无法拆分时 `full_title` 由调用方保留原文。
 */
export function splitTitle(rest: string): SplitTitle {
  let parts = rest.split('_').filter((part) => part !== '')
  if (parts.length === 0) parts = [rest]

  let volume = ''
  let chapter = ''
  for (const part of parts) {
    if (volume === '' && VOLUME_PART.test(part)) {
      volume = part
    } else if (chapter === '' && CHAPTER_PART.test(part)) {
      chapter = part
    }
  }

  const title = parts[parts.length - 1] ?? rest
  if (chapter === '') {
    // 没有「第X章」标记时，首个片段充当章节指称（`卷首` / `楔子`）。
    chapter = parts[0] ?? rest
  }
  return { volume, chapter, title }
}

/**
 * 读取同目录下 novel-split 风格的 `_meta.json`，建立「文件名 → 标题」映射。
 *
 * 只用于兜底命名（`ch0001.txt` 等）回填标题；主规则命名的文件不依赖它。
 * @param inputDir - 章节目录。
 * @returns 文件名 → `{ title, index }`；文件缺失或非法时返回空对象。
 */
export async function loadTitleHints(inputDir: string): Promise<Record<string, TitleHint>> {
  const metaPath = path.join(inputDir, '_meta.json')

  let raw: string
  try {
    raw = await readFile(metaPath, 'utf8')
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch {
    return {}
  }
  if (!isPlainObject(parsed)) return {}

  const hints: Record<string, TitleHint> = {}
  const chapters = (parsed as JsonObject).chapters
  if (!Array.isArray(chapters)) return hints

  for (const chapter of chapters) {
    if (!isPlainObject(chapter)) continue
    const title = chapter.title
    const file = chapter.file
    if (typeof title !== 'string' || title === '') continue
    if (typeof file !== 'string' || file === '') continue

    // novel-split 写的是 `chapters/ch0001.txt`，取 basename 才能与目录内文件名对上。
    const base = path.basename(file.replaceAll('\\', '/'))
    const index = chapter.index
    hints[base] = typeof index === 'number' ? { title, index } : { title }
  }
  return hints
}

/**
 * 把 novel-split 的 title 拆成 volume / chapter / title。
 * @param hint - 标题回填信息。
 * @returns 拆解结果。
 */
export function titleFromHint(hint: TitleHint): SplitTitle {
  const raw = hint.title
  const match = HINT_TITLE_PART.exec(raw)
  if (match !== null) {
    const rest = match[2] ?? ''
    return { volume: '', chapter: match[1] ?? raw, title: rest === '' ? raw : rest }
  }
  return { volume: '', chapter: raw, title: raw }
}

/**
 * 扫描目录，产出章节列表与诊断信息（不写盘）。
 * @param inputDir - 章节目录。
 * @param options - `pattern` 自定义正则（提供后关闭兜底解析）；`useMetaHint` 默认 `true`。
 * @returns `{ chapters, warnings }`，`chapters` 已按 `(index, file)` 升序排序。
 */
export async function scanChapterFiles(inputDir: string, options: ScanOptions = {}): Promise<ScanResult> {
  const customPattern = options.pattern
  const primary = customPattern === undefined ? PRIMARY_NAME : new RegExp(customPattern)
  // 自定义正则时不使用兜底规则，保证行为可预期。
  const fallback = customPattern === undefined ? FALLBACK_NAME : undefined

  const hints = options.useMetaHint === false ? {} : await loadTitleHints(inputDir)

  const chapters: Chapter[] = []
  const warnings: string[] = []

  for (const name of (await readdir(inputDir)).sort(compareStrings)) {
    if (!name.toLowerCase().endsWith('.txt')) continue
    const info = await stat(path.join(inputDir, name)).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue

    const stem = name.slice(0, -'.txt'.length)
    const match = primary.exec(name)

    let index: number
    let parsed: SplitTitle
    let fullTitle: string

    if (match !== null && match[1] !== undefined) {
      index = Number(match[1])
      const rest = match[2] ?? stem
      parsed = splitTitle(rest)
      fullTitle = rest
    } else {
      const fallbackMatch = fallback?.exec(stem)
      if (fallbackMatch === undefined || fallbackMatch === null || fallbackMatch[1] === undefined) {
        warnings.push(`跳过无法解析索引的文件：${name}`)
        continue
      }
      index = Number(fallbackMatch[1])
      const hint = hints[name]
      if (hint !== undefined) {
        parsed = titleFromHint(hint)
        fullTitle = hint.title
        warnings.push(`非规范文件名（用同目录 _meta.json 回填标题）：${name}`)
      } else {
        parsed = splitTitle(stem)
        fullTitle = stem
        warnings.push(`非规范文件名（无标题映射，用兜底规则解析）：${name}`)
      }
    }

    chapters.push({
      index,
      file: name,
      volume: parsed.volume,
      chapter: parsed.chapter,
      title: parsed.title,
      full_title: fullTitle,
    })
  }

  chapters.sort((left, right) => left.index - right.index || compareStrings(left.file, right.file))

  const byIndex = new Map<number, string[]>()
  for (const chapter of chapters) {
    const files = byIndex.get(chapter.index)
    if (files === undefined) byIndex.set(chapter.index, [chapter.file])
    else files.push(chapter.file)
  }
  for (const index of [...byIndex.keys()].sort((left, right) => left - right)) {
    const files = byIndex.get(index) ?? []
    if (files.length > 1) warnings.push(`索引 ${index} 重复：${files.join(', ')}`)
  }

  return { chapters, warnings }
}

/**
 * 扫描并写盘，同时把诊断信息带回给调用方（CLI 用）。
 * @param inputDir - 章节目录。
 * @param outputFile - `_meta.json` 输出路径。
 * @param options - 扫描选项。
 * @returns `{ meta, warnings, outputFile }`，路径均为绝对路径。
 */
export async function scanChaptersWithWarnings(
  inputDir: string,
  outputFile: string,
  options: ScanOptions = {},
): Promise<{ meta: Meta; warnings: string[]; outputFile: string }> {
  const absoluteInput = path.resolve(inputDir)
  const absoluteOutput = path.resolve(outputFile)

  const { chapters, warnings } = await scanChapterFiles(absoluteInput, options)
  if (chapters.length === 0) {
    warnings.push(`${absoluteInput} 下没有找到任何 .txt 章节文件`)
  }

  const meta: Meta = {
    source_dir: absoluteInput,
    chapter_count: chapters.length,
    chapters,
  }

  await mkdir(path.dirname(absoluteOutput), { recursive: true })
  await writeFile(absoluteOutput, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  return { meta, warnings, outputFile: absoluteOutput }
}

/**
 * 扫描章节目录并写入 `_meta.json`。
 * @param inputDir - 章节目录。
 * @param outputFile - `_meta.json` 输出路径；父目录会自动创建。
 * @param options - 扫描选项。
 * @returns 写入的 `Meta`（空目录时 `chapter_count` 为 0）。
 */
export async function scanChapters(inputDir: string, outputFile: string, options: ScanOptions = {}): Promise<Meta> {
  const { meta } = await scanChaptersWithWarnings(inputDir, outputFile, options)
  return meta
}

/** CLI 解析结果。 */
export interface ScanCliArgs {
  input?: string
  output?: string
  pattern?: string
  useMetaHint: boolean
  help: boolean
}

/** CLI 用法文本。 */
export function usage(): string {
  return [
    '用法：scan_chapters.ts --input <chapters_dir> --output <extracted_dir/_meta.json>',
    '',
    '选项：',
    '  --input <dir>       输入章节目录（@chapters_dir），必填',
    '  --output <file>     输出的 _meta.json 路径，必填',
    '  --pattern <regex>   自定义章节标题正则（须含数字前缀捕获组与 .txt，',
    '                      如 ^([0-9]{3})_(.+)\\.txt$；提供后关闭兜底解析）',
    '  --no-meta-hint      不读取同目录 _meta.json 来回填非规范文件名的标题',
    '  --help              显示本帮助',
  ].join('\n')
}

/**
 * 手写参数解析（不引入依赖）。
 * @param argv - 参数列表（不含 node 与脚本路径）。
 * @returns 解析结果。
 * @throws 未知选项或缺少取值时抛出。
 */
export function parseScanArgs(argv: string[]): ScanCliArgs {
  const args: ScanCliArgs = { useMetaHint: true, help: false }

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
      case '--input':
        args.input = takeValue()
        break
      case '--output':
        args.output = takeValue()
        break
      case '--pattern':
        args.pattern = takeValue()
        break
      case '--no-meta-hint':
        args.useMetaHint = false
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
 * CLI 入口。
 * @param argv - 参数列表，默认取 `process.argv.slice(2)`。
 * @returns 进程退出码：0 成功、1 运行失败、2 用法/环境错误。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ScanCliArgs
  try {
    args = parseScanArgs(argv)
  } catch (error) {
    console.error(`错误：${errorMessage(error)}`)
    console.error(usage())
    return 2
  }

  if (args.help) {
    console.log(usage())
    return 0
  }

  if (args.input === undefined || args.output === undefined) {
    console.error('错误：--input 与 --output 均为必填')
    console.error(usage())
    return 2
  }

  const inputDir = path.resolve(args.input)
  const info = await stat(inputDir).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    console.error(`错误：输入目录不存在：${inputDir}`)
    return 2
  }

  if (args.pattern !== undefined) {
    try {
      new RegExp(args.pattern)
    } catch (error) {
      console.error(`错误：--pattern 不是合法正则：${errorMessage(error)}`)
      return 2
    }
  }

  try {
    const { meta, warnings, outputFile } = await scanChaptersWithWarnings(inputDir, path.resolve(args.output), {
      pattern: args.pattern,
      useMetaHint: args.useMetaHint,
    })

    for (const warning of warnings) console.error(`警告：${warning}`)

    const first = meta.chapters[0]
    const last = meta.chapters[meta.chapters.length - 1]
    if (first !== undefined && last !== undefined) {
      console.log(`已写入 ${outputFile}（${meta.chapter_count} 章；索引 ${first.index}–${last.index}）`)
    } else {
      console.log(`已写入 ${outputFile}（0 章）`)
    }
    return 0
  } catch (error) {
    console.error(`错误：${errorMessage(error)}`)
    return 1
  }
}

// 仅在作为入口直接执行时运行 CLI；被测试 import 时不触发。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  // 用 exitCode 而不是 process.exit()，避免管道输出在刷新前被截断；退出状态等价。
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(`错误：${errorMessage(error)}`)
      process.exitCode = 1
    })
}
