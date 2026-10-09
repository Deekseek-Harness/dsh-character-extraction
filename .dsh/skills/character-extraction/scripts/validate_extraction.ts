#!/usr/bin/env node
/**
 * 校验 character-extraction 的逐章结果。
 *
 * 用法::
 *
 *     npx tsx .dsh/skills/character-extraction/scripts/validate_extraction.ts \
 *         --chapters chapters --extracted extracted --errors extracted/_errors.json
 *
 * 做三件事：
 *
 * 1. 对照 `<skill>/schemas/*.schema.json` 校验每个 `ch*.json`；
 * 2. 检查每条 `quote` / `sources[].quote` 能否在对应章节原文中逐字找到（忽略空白差异）；
 * 3. 报告 `_meta.json` 里缺失的章节，全部问题写入 `--errors`（默认 `<extracted>/_errors.json`）。
 *
 * 不依赖第三方库：JSON Schema 校验由 `schema-validator.ts` 提供。
 *
 * 退出码：0 = 无错误；1 = 有错误；2 = 用法/环境错误。
 *
 * @module character-extraction/scripts/validate_extraction
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadSchemas, validateInstance } from './schema-validator.ts'
import type {
  JsonObject,
  MissingChapter,
  QuoteRef,
  ValidationError,
  ValidationResult,
  ValidateOptions,
} from './types.ts'
import {
  codePointLength,
  compareStrings,
  errorMessage,
  isPlainObject,
  repr,
  stripBom,
} from './util.ts'

/** 默认 schema 目录：`<skill>/schemas`（脚本位于 `<skill>/scripts`）。 */
export const DEFAULT_SCHEMA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
)

/** `ch000.json` 形式的文件名。 */
const CH_FILE = /^ch([0-9]+)\.json$/i
/** 用于跨行引用的空白归一。 */
const WHITESPACE = /\s+/g
/** 根 schema 文件名。 */
const ROOT_SCHEMA = 'chapter-extraction.schema.json'
/** 引用长度默认阈值。 */
const DEFAULT_QUOTE_MAX = 50

/**
 * 依次尝试 UTF-8 与 GB18030 解码。
 *
 * `TextDecoder('utf-8')` 默认剥离 BOM，因此不需要单独的 BOM 分支。
 * @param file - 章节 txt 路径。
 * @returns 文本；文件不存在或两种编码都解不开时返回 `null`。
 */
export async function readChapterText(file: string): Promise<string | null> {
  let buffer: Buffer
  try {
    buffer = await readFile(file)
  } catch {
    return null
  }

  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer)
    } catch {
      // 该编码解不开，换下一个。
    }
  }
  return null
}

/**
 * 去掉所有空白，使跨行引用也能匹配。
 * @param text - 任意文本。
 * @returns 无空白文本。
 */
export function normalize(text: string): string {
  return text.replace(WHITESPACE, '')
}

/**
 * 收集逐章 JSON 中全部需要回溯原文的引用。
 * @param payload - 逐章 JSON。
 * @returns 引用列表，`limited` 标记该引用是否受 50 字硬限制（衣物为 `true`）。
 */
export function collectQuotes(payload: unknown): QuoteRef[] {
  const found: QuoteRef[] = []
  if (!isPlainObject(payload)) return found

  const clothing = payload.clothing
  if (Array.isArray(clothing)) {
    clothing.forEach((entry, index) => {
      if (isPlainObject(entry) && typeof entry.quote === 'string') {
        found.push({ path: `$.clothing[${index}].quote`, quote: entry.quote, limited: true })
      }
    })
  }

  const items = payload.items
  if (Array.isArray(items)) {
    items.forEach((entry, index) => {
      if (isPlainObject(entry) && typeof entry.quote === 'string') {
        found.push({ path: `$.items[${index}].quote`, quote: entry.quote, limited: false })
      }
    })
  }

  const characters = payload.characters
  if (Array.isArray(characters)) {
    characters.forEach((entry, index) => {
      if (!isPlainObject(entry)) return

      const sources = entry.sources
      if (Array.isArray(sources)) {
        sources.forEach((source, sub) => {
          if (isPlainObject(source) && typeof source.quote === 'string') {
            found.push({
              path: `$.characters[${index}].sources[${sub}].quote`,
              quote: source.quote,
              limited: false,
            })
          }
        })
      }

      const relations = entry.relations
      if (Array.isArray(relations)) {
        relations.forEach((relation, sub) => {
          if (isPlainObject(relation) && typeof relation.quote === 'string') {
            found.push({
              path: `$.characters[${index}].relations[${sub}].quote`,
              quote: relation.quote,
              limited: false,
            })
          }
        })
      }
    })
  }

  return found
}

/**
 * 校验逐章结果并写出 `_errors.json`。
 *
 * @param chaptersDir - 输入章节目录（@chapters_dir），用于回查原文。
 * @param extractedDir - 逐章 JSON 目录（@extracted_dir）。
 * @param errorsFile - 报告输出路径；省略时为 `<extractedDir>/_errors.json`。
 * @param options - `schemaDir` 覆盖 schema 目录；`quoteMax` 覆盖引用长度阈值。
 * @returns 报告对象（同时也是写入文件的形状）。
 * @throws schema 目录缺失、为空或 `extractedDir` 不存在时抛出。
 */
export async function validateExtraction(
  chaptersDir: string,
  extractedDir: string,
  errorsFile?: string,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const absoluteChapters = path.resolve(chaptersDir)
  const absoluteExtracted = path.resolve(extractedDir)
  const absoluteErrors = path.resolve(errorsFile ?? path.join(absoluteExtracted, '_errors.json'))
  const schemaDir = path.resolve(options.schemaDir ?? DEFAULT_SCHEMA_DIR)
  const quoteMax = options.quoteMax ?? DEFAULT_QUOTE_MAX

  const extractedInfo = await readdir(absoluteExtracted).catch(() => undefined)
  if (extractedInfo === undefined) {
    throw new Error(`逐章输出目录不存在：${absoluteExtracted}`)
  }

  const schemas = await loadSchemas(schemaDir)
  const rootSchema = schemas[ROOT_SCHEMA]
  if (rootSchema === undefined) throw new Error(`缺少 ${ROOT_SCHEMA}`)

  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  // ---- 期望章节清单 -------------------------------------------------------
  const expected: JsonObject[] = []
  const metaPath = path.join(absoluteExtracted, '_meta.json')
  let metaRaw: string | undefined
  try {
    metaRaw = await readFile(metaPath, 'utf8')
  } catch {
    metaRaw = undefined
  }

  if (metaRaw === undefined) {
    warnings.push({
      file: '_meta.json',
      kind: 'missing',
      path: '$',
      message: '缺少 _meta.json，跳过覆盖率检查',
    })
  } else {
    try {
      const meta: unknown = JSON.parse(stripBom(metaRaw))
      const chapters = isPlainObject(meta) ? meta.chapters : undefined
      if (Array.isArray(chapters)) {
        for (const chapter of chapters) {
          if (isPlainObject(chapter) && typeof chapter.index === 'number') expected.push(chapter)
        }
      }
    } catch (error) {
      errors.push({
        file: '_meta.json',
        kind: 'json',
        path: '$',
        message: `无法解析：${errorMessage(error)}`,
      })
    }
  }

  // ---- 逐章校验 -----------------------------------------------------------
  const present = new Map<number, string>()
  let checked = 0

  for (const name of (await readdir(absoluteExtracted)).sort(compareStrings)) {
    const match = CH_FILE.exec(name)
    if (match === null || match[1] === undefined) continue

    const fileIndex = Number(match[1])
    present.set(fileIndex, name)

    let payload: unknown
    try {
      payload = JSON.parse(stripBom(await readFile(path.join(absoluteExtracted, name), 'utf8')))
    } catch (error) {
      errors.push({
        file: name,
        kind: 'json',
        path: '$',
        message: `无法解析 JSON：${errorMessage(error)}`,
      })
      continue
    }

    checked += 1

    for (const violation of validateInstance(payload, rootSchema, schemas, ROOT_SCHEMA)) {
      errors.push({ file: name, kind: 'schema', path: violation.path, message: violation.message })
    }

    const record = isPlainObject(payload) ? payload : {}
    const chapterIndex = record.chapter_index
    if (typeof chapterIndex === 'number' && chapterIndex !== fileIndex) {
      errors.push({
        file: name,
        kind: 'index',
        path: '$.chapter_index',
        message: `chapter_index=${chapterIndex} 与文件名 ch${String(fileIndex).padStart(3, '0')} 不一致`,
      })
    }

    // 引用溯源
    const sourceFile = record.source_file
    let chapterText: string | null = null
    if (typeof sourceFile === 'string' && sourceFile !== '') {
      const candidate = path.join(absoluteChapters, sourceFile)
      chapterText = await readChapterText(candidate)
      if (chapterText === null) {
        errors.push({
          file: name,
          kind: 'source',
          path: '$.source_file',
          message: `找不到章节原文：${candidate}`,
        })
      }
    } else {
      errors.push({
        file: name,
        kind: 'source',
        path: '$.source_file',
        message: 'source_file 缺失或为空',
      })
    }

    const normalizedChapter = chapterText === null ? null : normalize(chapterText)
    for (const reference of collectQuotes(payload)) {
      if (reference.quote === '') {
        errors.push({ file: name, kind: 'quote', path: reference.path, message: '引用为空' })
        continue
      }

      const length = codePointLength(reference.quote)
      if (length > quoteMax) {
        const entry: ValidationError = {
          file: name,
          kind: 'quote-length',
          path: reference.path,
          message: `引用 ${length} 字，超过 ${quoteMax} 字上限`,
        }
        if (reference.limited) errors.push(entry)
        else warnings.push(entry)
      }

      if (normalizedChapter !== null && !normalizedChapter.includes(normalize(reference.quote))) {
        errors.push({
          file: name,
          kind: 'quote',
          path: reference.path,
          message: `引用无法在 ${String(sourceFile)} 中逐字找到：${[...reference.quote].slice(0, 40).join('')}`,
        })
      }
    }
  }

  // ---- 覆盖率 -------------------------------------------------------------
  const missing: MissingChapter[] = []
  const expectedIndexes = new Set<number>()
  for (const chapter of expected) {
    const index = chapter.index as number
    expectedIndexes.add(index)
    if (!present.has(index)) {
      missing.push({ index, file: typeof chapter.file === 'string' ? chapter.file : '' })
    }
  }
  for (const index of [...present.keys()].sort((left, right) => left - right)) {
    if (expected.length > 0 && !expectedIndexes.has(index)) {
      warnings.push({
        file: present.get(index) ?? '',
        kind: 'extra',
        path: '$',
        message: `索引 ${index} 不在 _meta.json 中`,
      })
    }
  }

  const report: ValidationResult = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    chapters_dir: absoluteChapters,
    extracted_dir: absoluteExtracted,
    schema_dir: schemaDir,
    summary: {
      total_expected: expected.length,
      checked,
      missing_count: missing.length,
      error_count: errors.length,
      warning_count: warnings.length,
    },
    missing,
    errors,
    warnings,
  }

  await mkdir(path.dirname(absoluteErrors), { recursive: true })
  await writeFile(absoluteErrors, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  return report
}

/** CLI 解析结果。 */
export interface ValidateCliArgs {
  chapters?: string
  extracted?: string
  errors?: string
  schemas?: string
  quoteMax?: number
  help: boolean
}

/** CLI 用法文本。 */
export function usage(): string {
  return [
    '用法：validate_extraction.ts --chapters <chapters_dir> --extracted <extracted_dir> [--errors <file>]',
    '',
    '选项：',
    '  --chapters <dir>    输入章节目录（@chapters_dir），必填',
    '  --extracted <dir>   逐章 JSON 目录（@extracted_dir），必填',
    '  --errors <file>     报告输出路径（默认 <extracted>/_errors.json）',
    '  --schemas <dir>     schema 目录（默认 <skill>/schemas）',
    '  --quote-max <n>     引用长度告警阈值（默认 50）',
    '  --help              显示本帮助',
  ].join('\n')
}

/**
 * 手写参数解析（不引入依赖）。
 * @param argv - 参数列表（不含 node 与脚本路径）。
 * @returns 解析结果。
 * @throws 未知选项、缺少取值或 `--quote-max` 非数字时抛出。
 */
export function parseValidateArgs(argv: string[]): ValidateCliArgs {
  const args: ValidateCliArgs = { help: false }

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
      case '--chapters':
        args.chapters = takeValue()
        break
      case '--extracted':
        args.extracted = takeValue()
        break
      case '--errors':
        args.errors = takeValue()
        break
      case '--schemas':
        args.schemas = takeValue()
        break
      case '--quote-max': {
        const raw = takeValue()
        const parsed = Number(raw)
        if (!Number.isInteger(parsed)) throw new Error(`--quote-max 必须是整数，实际为 ${repr(raw)}`)
        args.quoteMax = parsed
        break
      }
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
 * @returns 进程退出码：0 无错误、1 有错误、2 用法/环境错误。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ValidateCliArgs
  try {
    args = parseValidateArgs(argv)
  } catch (error) {
    console.error(`错误：${errorMessage(error)}`)
    console.error(usage())
    return 2
  }

  if (args.help) {
    console.log(usage())
    return 0
  }

  if (args.chapters === undefined || args.extracted === undefined) {
    console.error('错误：--chapters 与 --extracted 均为必填')
    console.error(usage())
    return 2
  }

  let report: ValidationResult
  try {
    report = await validateExtraction(args.chapters, args.extracted, args.errors, {
      schemaDir: args.schemas,
      quoteMax: args.quoteMax,
    })
  } catch (error) {
    console.error(`错误：${errorMessage(error)}`)
    return 2
  }

  const errorsPath = path.resolve(args.errors ?? path.join(path.resolve(args.extracted), '_errors.json'))
  const { total_expected, checked, missing_count, error_count, warning_count } = report.summary

  console.log(
    `校验完成：期望 ${total_expected} 章，已检 ${checked} 章，缺失 ${missing_count}，错误 ${error_count}，告警 ${warning_count}`,
  )
  console.log(`报告：${errorsPath}`)
  for (const entry of report.errors.slice(0, 20)) {
    console.log(`  错误 [${entry.kind}] ${entry.file} ${entry.path}：${entry.message}`)
  }
  if (report.errors.length > 20) {
    console.log(`  …… 其余 ${report.errors.length - 20} 条见报告`)
  }

  return report.errors.length > 0 ? 1 : 0
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
