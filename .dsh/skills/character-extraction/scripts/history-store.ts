/**
 * 版本历史存储层。
 *
 * 全部为**确定性**逻辑：路径规范化、`history/` 目录解析、`_index.json` 读写、版本号分配、
 * 递归复制、产物计数。供 `backup_output.ts` 与 `history.ts` 复用，使主 Agent 不参与任何
 * 路径比较、版本号扫描或目录存在性判断。
 *
 * 约定：
 * - 路径在写入 `_index.json` 时使用**相对 `history/` 父目录**的路径，并统一用 `/` 分隔
 *   （Windows 下 `path.relative` 会给出 `\`，这里归一化以免同一份索引跨平台漂移）。
 * - 复制**不跟随符号链接**：遇到符号链接时原样重建链接。
 * - 时间戳一律为 ISO 8601 UTC，秒级。
 *
 * @module character-extraction/scripts/history-store
 */

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import type {
  BackupManifest,
  HistoryIndex,
  HistoryVersionEntry,
  JsonObject,
  LastOutput,
  OutputCounts,
} from './types.ts'
import { errorMessage, isPlainObject, stripBom } from './util.ts'

/** `_manifest.json` 的固定说明。 */
export const NOTE_FROM_PREVIOUS_RUN = '备份自上一次运行输出'

/** `V{n}` 目录名。 */
const VERSION_DIR = /^V([0-9]+)$/

// --------------------------------------------------------------------------- //
// 路径
// --------------------------------------------------------------------------- //

/**
 * 规范化目录路径：转绝对路径并去掉尾随分隔符（盘符根保留原样）。
 * @param input - 任意路径。
 * @returns 规范化后的绝对路径。
 */
export function normalizeDir(input: string): string {
  const resolved = path.resolve(input)
  if (resolved === path.parse(resolved).root) return resolved
  return resolved.replace(/[\\/]+$/, '')
}

/**
 * 比较两个路径是否指向同一目录。
 *
 * Windows 文件系统大小写不敏感，因此在该平台按小写比较；其他平台按原样比较。
 * @param left - 左路径。
 * @param right - 右路径。
 * @returns 是否同一目录。
 */
export function samePath(left: string, right: string): boolean {
  const a = normalizeDir(left)
  const b = normalizeDir(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 判断 `child` 是否等于 `parent` 或位于其内部。
 * @param parent - 父路径。
 * @param child - 子路径。
 * @returns 是否相同或在内。
 */
export function isSameOrInside(parent: string, child: string): boolean {
  const base = normalizeDir(parent)
  const target = normalizeDir(child)
  const rel = path.relative(base, target)
  if (rel === '') return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 求两个路径的最近公共祖先目录。
 * @param left - 左路径。
 * @param right - 右路径。
 * @returns 公共祖先的绝对路径。
 */
export function commonAncestor(left: string, right: string): string {
  const a = normalizeDir(left).split(path.sep)
  const b = normalizeDir(right).split(path.sep)
  const shared: string[] = []
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) break
    shared.push(a[i] as string)
  }
  if (shared.length === 0) return path.parse(normalizeDir(left)).root
  const joined = shared.join(path.sep)
  return joined === '' ? path.sep : joined
}

/**
 * 解析 `history/` 目录。
 *
 * 规则：显式指定优先；否则取 `extracted_dir` 的父目录（两者同父时的自然结果）；
 * 两者不同父时取二者最近的公共父目录。
 * @param extractedDir - 逐章输出目录。
 * @param cardsDir - 卡片输出目录。
 * @param override - 显式 `--history`。
 * @returns `history/` 的绝对路径。
 */
export function resolveHistoryDir(extractedDir: string, cardsDir: string, override?: string): string {
  if (override !== undefined && override.trim() !== '') return normalizeDir(override)
  const parentOfExtracted = path.dirname(normalizeDir(extractedDir))
  const parentOfCards = path.dirname(normalizeDir(cardsDir))
  const base = samePath(parentOfExtracted, parentOfCards)
    ? parentOfExtracted
    : commonAncestor(parentOfExtracted, parentOfCards)
  return path.join(base, 'history')
}

/** 时间戳：ISO 8601 UTC，秒级。 */
export function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 解析版本 token，接受 `V1`、`v1`、`@V1`、`@v1`。
 * @param token - 版本 token。
 * @returns 版本号；非法时为 `null`。
 */
export function parseVersionNumber(token: string): number | null {
  const matched = /^@?[Vv]([0-9]+)$/.exec(String(token).trim())
  if (matched === null || matched[1] === undefined) return null
  return Number(matched[1])
}

/**
 * 由版本号生成版本名。
 * @param value - 版本号。
 * @returns 形如 `V3`。
 */
export function versionName(value: number): string {
  return `V${value}`
}

// --------------------------------------------------------------------------- //
// 基础 IO
// --------------------------------------------------------------------------- //

/**
 * 判断路径存在且是目录。
 * @param target - 路径。
 * @returns 是否为已存在的目录。
 */
export async function isDirectory(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => undefined)
  return info !== undefined && info.isDirectory()
}

/**
 * 读 JSON 文件，缺失或非法时返回 `undefined`。
 * @param file - 文件路径。
 * @returns 解析结果。
 */
export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(stripBom(raw)) as T
  } catch {
    return undefined
  }
}

/**
 * 写 JSON 文件（UTF-8，2 空格缩进，结尾换行）。
 * @param file - 文件路径；父目录自动创建。
 * @param value - 任意可序列化值。
 */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// --------------------------------------------------------------------------- //
// history/_index.json
// --------------------------------------------------------------------------- //

/** 空的版本索引。 */
export function emptyHistoryIndex(): HistoryIndex {
  return { last_output: null, versions: [], latest: null }
}

function toLastOutput(value: unknown): LastOutput | null {
  if (!isPlainObject(value)) return null
  const extracted = value.extracted_dir
  const cards = value.cards_dir
  if (typeof extracted !== 'string' || typeof cards !== 'string') return null
  return {
    extracted_dir: extracted,
    cards_dir: cards,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
  }
}

function toVersionEntry(value: unknown): HistoryVersionEntry | null {
  if (!isPlainObject(value)) return null
  const version = value.version
  if (typeof version !== 'string' || parseVersionNumber(version) === null) return null
  const number = (key: string): number => (typeof value[key] === 'number' ? (value[key] as number) : 0)
  return {
    version,
    created_at: typeof value.created_at === 'string' ? value.created_at : '',
    path: typeof value.path === 'string' ? value.path : '',
    chapter_count: number('chapter_count'),
    character_count: number('character_count'),
    clothing_count: number('clothing_count'),
    item_count: number('item_count'),
  }
}

/**
 * 读取 `history/_index.json`；缺失或损坏时返回空索引（不抛错，首次运行即依赖此行为）。
 * @param historyDir - `history/` 目录。
 * @returns 版本索引。
 */
export async function readHistoryIndex(historyDir: string): Promise<HistoryIndex> {
  const parsed = await readJsonFile<JsonObject>(path.join(historyDir, '_index.json'))
  if (parsed === undefined) return emptyHistoryIndex()

  const versions: HistoryVersionEntry[] = []
  if (Array.isArray(parsed.versions)) {
    for (const item of parsed.versions) {
      const entry = toVersionEntry(item)
      if (entry !== null) versions.push(entry)
    }
  }
  versions.sort((left, right) => (parseVersionNumber(left.version) ?? 0) - (parseVersionNumber(right.version) ?? 0))

  const latestNumber = versions.reduce<number | null>((acc, entry) => {
    const value = parseVersionNumber(entry.version)
    if (value === null) return acc
    return acc === null || value > acc ? value : acc
  }, null)

  return {
    last_output: toLastOutput(parsed.last_output),
    versions,
    latest: latestNumber === null ? null : versionName(latestNumber),
  }
}

/**
 * 写入 `history/_index.json`（版本按号升序，`latest` 按实际最大号重算）。
 * @param historyDir - `history/` 目录。
 * @param index - 版本索引。
 * @returns 写入的文件绝对路径。
 */
export async function writeHistoryIndex(historyDir: string, index: HistoryIndex): Promise<string> {
  const versions = [...index.versions].sort(
    (left, right) => (parseVersionNumber(left.version) ?? 0) - (parseVersionNumber(right.version) ?? 0),
  )
  const latestNumber = versions.reduce<number | null>((acc, entry) => {
    const value = parseVersionNumber(entry.version)
    if (value === null) return acc
    return acc === null || value > acc ? value : acc
  }, null)

  const file = path.join(normalizeDir(historyDir), '_index.json')
  await writeJsonFile(file, {
    last_output: index.last_output,
    versions,
    latest: latestNumber === null ? null : versionName(latestNumber),
  } satisfies HistoryIndex)
  return file
}

/**
 * 列出磁盘上实际存在的版本号（升序）。
 * @param historyDir - `history/` 目录。
 * @returns 版本号数组。
 */
export async function listVersionNumbers(historyDir: string): Promise<number[]> {
  const entries = await readdir(historyDir, { withFileTypes: true }).catch(() => [])
  const numbers: number[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const matched = VERSION_DIR.exec(entry.name)
    if (matched === null || matched[1] === undefined) continue
    numbers.push(Number(matched[1]))
  }
  return numbers.sort((left, right) => left - right)
}

/**
 * 计算下一个版本号。
 *
 * 同时参考磁盘目录与索引条目，因此**已删除的编号不会被复用**。
 * @param historyDir - `history/` 目录。
 * @param index - 版本索引。
 * @returns 下一个版本号（最小为 1）。
 */
export async function nextVersionNumber(historyDir: string, index: HistoryIndex): Promise<number> {
  const fromDisk = await listVersionNumbers(historyDir)
  const fromIndex = index.versions
    .map((entry) => parseVersionNumber(entry.version))
    .filter((value): value is number => value !== null)
  const all = [...fromDisk, ...fromIndex]
  return all.length === 0 ? 1 : Math.max(...all) + 1
}

/**
 * 版本目录相对 `history/` 父目录的路径（统一 `/` 分隔）。
 * @param historyDir - `history/` 目录。
 * @param versionDir - 版本目录绝对路径。
 * @returns 形如 `history/V1`。
 */
export function versionRelativePath(historyDir: string, versionDir: string): string {
  return path.relative(path.dirname(normalizeDir(historyDir)), versionDir).split(path.sep).join('/')
}

// --------------------------------------------------------------------------- //
// 目录操作
// --------------------------------------------------------------------------- //

/** 用 `/` 拼接子路径。 */
function joinRel(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`
}

async function copyInto(srcDir: string, destDir: string, copied: string[], prefix: string): Promise<void> {
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    const rel = joinRel(prefix, entry.name)

    if (entry.isSymbolicLink()) {
      const target = await readlink(srcPath).catch(() => undefined)
      if (target === undefined) continue
      await symlink(target, destPath).catch(() => undefined)
      copied.push(rel)
      continue
    }
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true })
      await copyInto(srcPath, destPath, copied, rel)
      continue
    }
    if (entry.isFile()) {
      await copyFile(srcPath, destPath)
      copied.push(rel)
    }
  }
}

/**
 * 递归复制目录内容。不跟随符号链接（原样重建链接），不修改源文件。
 * @param src - 源目录；不存在或不是目录时直接返回空数组。
 * @param dest - 目标目录；自动创建。
 * @returns 已复制的相对路径列表（`/` 分隔）。
 */
export async function copyTree(src: string, dest: string): Promise<string[]> {
  const copied: string[] = []
  const info = await stat(src).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) return copied
  await mkdir(dest, { recursive: true })
  await copyInto(src, dest, copied, '')
  return copied
}

/**
 * 递归列出目录下的文件（含符号链接），返回相对路径。
 * @param dir - 目录。
 * @returns 相对路径数组（`/` 分隔）。
 */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const found: string[] = []
  const info = await stat(dir).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) return found

  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = joinRel(prefix, entry.name)
      if (entry.isDirectory()) {
        await walk(full, rel)
        continue
      }
      found.push(rel)
    }
  }
  await walk(dir, '')
  return found.sort()
}

/**
 * 删除目录下的指定相对路径文件（用于 `restore --clean` 清理多余文件）。
 * @param dir - 目录。
 * @param relativePaths - 相对路径列表。
 */
export async function removeFiles(dir: string, relativePaths: string[]): Promise<void> {
  for (const rel of relativePaths) {
    await unlink(path.join(dir, rel.split('/').join(path.sep))).catch(() => undefined)
  }
}

// --------------------------------------------------------------------------- //
// 产物计数
// --------------------------------------------------------------------------- //

/**
 * 统计逐章 JSON 文件数量（只看文件名）。
 * @param extractedDir - 逐章输出目录。
 * @returns `ch*.json` 的数量。
 */
export async function countChapterFiles(extractedDir: string): Promise<number> {
  const entries = await readdir(extractedDir).catch(() => [] as string[])
  return entries.filter((name) => /^ch[0-9]+\.json$/i.test(name)).length
}

/**
 * 当前输出是否为空。
 *
 * 判据：`extracted_dir` 下没有任何 `ch*.json`（只有 `_meta.json`/`_progress.json` 也算空）。
 * @param extractedDir - 逐章输出目录。
 * @returns 是否为空。
 */
export async function isEmptyOutput(extractedDir: string): Promise<boolean> {
  return (await countChapterFiles(extractedDir)) === 0
}

/**
 * 统计一次输出的产物数量。
 *
 * 章节数优先取 `_meta.json` 的 `chapter_count`；卡片数优先取 `cards/_index.json` 的数组长度，
 * 缺失时退化为按目录内 `.md` 计数。
 * @param extractedDir - 逐章输出目录。
 * @param cardsDir - 卡片输出目录。
 * @returns 计数。
 */
export async function countOutputs(extractedDir: string, cardsDir: string): Promise<OutputCounts> {
  let chapterCount = await countChapterFiles(extractedDir)
  const meta = await readJsonFile<JsonObject>(path.join(extractedDir, '_meta.json'))
  if (meta !== undefined && typeof meta.chapter_count === 'number' && Number.isInteger(meta.chapter_count)) {
    chapterCount = meta.chapter_count
  }

  let characters = 0
  let clothing = 0
  let items = 0

  const cardIndex = await readJsonFile<JsonObject>(path.join(cardsDir, '_index.json'))
  if (cardIndex !== undefined) {
    if (Array.isArray(cardIndex.characters)) characters = cardIndex.characters.length
    if (Array.isArray(cardIndex.clothing)) clothing = cardIndex.clothing.length
    if (Array.isArray(cardIndex.items)) items = cardIndex.items.length
  } else {
    const count = async (sub: string): Promise<number> => {
      const entries = await readdir(path.join(cardsDir, sub)).catch(() => [] as string[])
      return entries.filter((name) => name.endsWith('.md')).length
    }
    characters = await count('characters')
    clothing = await count('clothing')
    items = await count('items')
  }

  return {
    chapter_count: chapterCount,
    character_count: characters,
    clothing_count: clothing,
    item_count: items,
  }
}

/**
 * 当前输出是否值得打快照。
 *
 * 判据：`extracted_dir` 有 `ch*.json`，或 `cards_dir` 里有**实质**卡片文件。
 * 只有记账文件（`.gitkeep`、`_index.json`、`_index.md`）不算内容，避免空跑一次快照。
 * @param extractedDir - 逐章输出目录。
 * @param cardsDir - 卡片输出目录。
 * @returns 是否值得快照。
 */
export async function hasSnapshotWorthyContent(extractedDir: string, cardsDir: string): Promise<boolean> {
  if (!(await isEmptyOutput(extractedDir))) return true
  const bookkeeping = new Set(['_index.json', '_index.md', '.gitkeep'])
  const files = await listFilesRecursive(cardsDir)
  return files.some((name) => !bookkeeping.has(name))
}

/**
 * 读取 `_meta.json` 的 `source_dir` 作为 `_manifest.json` 的 `source_chapters`。
 * @param extractedDir - 逐章输出目录。
 * @returns 章节目录绝对路径；未知时为空串。
 */
export async function readSourceChapters(extractedDir: string): Promise<string> {
  const meta = await readJsonFile<JsonObject>(path.join(extractedDir, '_meta.json'))
  if (meta === undefined) return ''
  const source = meta.source_dir
  return typeof source === 'string' ? source : ''
}

// --------------------------------------------------------------------------- //
// 版本快照
// --------------------------------------------------------------------------- //

/** `createVersionSnapshot` 的入参。 */
export interface SnapshotOptions {
  historyDir: string
  index: HistoryIndex
  extractedDir: string
  cardsDir: string
  /** `_manifest.json` 的 `source_chapters`；省略时读 `_meta.json`。 */
  chaptersDir?: string
  /** `_manifest.json` 的 `note`。 */
  note?: string
  /** 指定版本号；省略时自动取下一个可用编号。 */
  version?: number
}

/**
 * 把当前输出复制成一个新版本 `history/V{n}/`。
 *
 * 只读取当前输出，不修改任何源文件；`history/` 自身不会出现在复制源里（复制源只有
 * `extracted/` 与 `cards/` 两个目录）。
 * @param options - 快照参数。
 * @returns 版本名、版本目录、清单路径、索引条目与清单内容。
 */
export async function createVersionSnapshot(options: SnapshotOptions): Promise<{
  version: string
  versionDir: string
  manifestFile: string
  entry: HistoryVersionEntry
  manifest: BackupManifest
}> {
  const historyDir = normalizeDir(options.historyDir)
  const extractedDir = normalizeDir(options.extractedDir)
  const cardsDir = normalizeDir(options.cardsDir)
  const number = options.version ?? (await nextVersionNumber(historyDir, options.index))
  const version = versionName(number)
  const versionDir = path.join(historyDir, version)

  await mkdir(versionDir, { recursive: true })
  await copyTree(extractedDir, path.join(versionDir, 'extracted'))
  await copyTree(cardsDir, path.join(versionDir, 'cards'))

  const counts = await countOutputs(extractedDir, cardsDir)
  const createdAt = timestamp()
  const sourceChapters = options.chaptersDir ?? (await readSourceChapters(extractedDir))

  const manifest: BackupManifest = {
    version,
    created_at: createdAt,
    source_chapters: sourceChapters,
    extracted_dir: extractedDir,
    cards_dir: cardsDir,
    chapter_count: counts.chapter_count,
    character_count: counts.character_count,
    clothing_count: counts.clothing_count,
    item_count: counts.item_count,
    note: options.note ?? NOTE_FROM_PREVIOUS_RUN,
  }

  const manifestFile = path.join(versionDir, '_manifest.json')
  await writeJsonFile(manifestFile, manifest)

  return {
    version,
    versionDir,
    manifestFile,
    entry: {
      version,
      created_at: createdAt,
      path: versionRelativePath(historyDir, versionDir),
      chapter_count: counts.chapter_count,
      character_count: counts.character_count,
      clothing_count: counts.clothing_count,
      item_count: counts.item_count,
    },
    manifest,
  }
}

// --------------------------------------------------------------------------- //
// 失败记录
// --------------------------------------------------------------------------- //

/**
 * 把备份失败原因写入 `_progress.json` 的 `backup_failed` 字段（保留其余字段）。
 *
 * 备份失败不得阻塞主流程，因此该写入本身也失败时只返回 `false`。
 * @param extractedDir - 逐章输出目录。
 * @param error - 失败原因。
 * @returns 是否写入成功。
 */
export async function recordBackupFailure(extractedDir: string, error: unknown): Promise<boolean> {
  const file = path.join(normalizeDir(extractedDir), '_progress.json')
  const existing = (await readJsonFile<JsonObject>(file)) ?? {}
  const merged: JsonObject = {
    total: typeof existing.total === 'number' ? existing.total : 0,
    done: typeof existing.done === 'number' ? existing.done : 0,
    current: existing.current ?? null,
    failed: Array.isArray(existing.failed) ? existing.failed : [],
    updated_at: timestamp(),
    ...existing,
    backup_failed: { at: timestamp(), error: errorMessage(error) },
  }
  try {
    await writeJsonFile(file, merged)
    return true
  } catch {
    return false
  }
}
