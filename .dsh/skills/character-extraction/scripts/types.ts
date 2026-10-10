/**
 * character-extraction 脚本的共享类型定义。
 *
 * 本文件**只含类型**：Node 的原生 TypeScript 支持只做类型擦除，因此使用方必须用
 * `import type { ... } from './types.ts'` 引入，避免在运行时产生一次空模块导入。
 *
 * @module character-extraction/scripts/types
 */

/** 任意 JSON 值。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 任意 JSON 对象（逐章提取结果的形状未做运行时约束，用 `unknown` 收窄）。 */
export type JsonObject = { [key: string]: unknown }

// --------------------------------------------------------------------------- //
// 章节清单（_meta.json）
// --------------------------------------------------------------------------- //

/** `_meta.json` 的 chapters[] 条目。 */
export interface Chapter {
  /** 章号，取自文件名数字前缀。 */
  index: number
  /** 章节 txt 文件名（不含路径）。 */
  file: string
  /** 「第X卷」片段；无则空串。 */
  volume: string
  /** 「第X章/回/节」片段；无标记时为首个片段。 */
  chapter: string
  /** 最后一段，作为标题。 */
  title: string
  /** 完整标题（文件名去掉 `NNN_` 前缀与 `.txt`）。 */
  full_title: string
}

/** `_meta.json` 的完整形状。 */
export interface Meta {
  /** 输入章节目录的绝对路径。 */
  source_dir: string
  /** 章节数量。 */
  chapter_count: number
  /** 已按 index 升序排序的章节列表。 */
  chapters: Chapter[]
}

/** `scanChapterFiles()` 的返回值：章节列表 + 诊断信息。 */
export interface ScanResult {
  chapters: Chapter[]
  warnings: string[]
}

/** `scanChapters()` 的可选项。 */
export interface ScanOptions {
  /**
   * 自定义文件名正则（须含数字前缀与 `.txt`）。
   * 提供后**关闭兜底解析**，行为与 `--pattern` 一致。
   */
  pattern?: string
  /** 是否读取同目录 `_meta.json` 回填非规范文件名的标题。默认 `true`。 */
  useMetaHint?: boolean
}

/** `_meta.json` 中提供的标题回填信息（novel-split 风格）。 */
export interface TitleHint {
  title: string
  index?: number
}

// --------------------------------------------------------------------------- //
// 提取结果与校验（_errors.json）
// --------------------------------------------------------------------------- //

/** 一条引用及其约束。 */
export interface QuoteRef {
  /** 在逐章 JSON 中的位置，如 `$.items[0].quote`。 */
  path: string
  /** 引用文本。 */
  quote: string
  /** 是否受 50 字硬限制（衣物为 `true`，其余为 `false` → 仅告警）。 */
  limited: boolean
}

/** 校验问题的类别。 */
export type ValidationKind =
  | 'schema'
  | 'quote'
  | 'quote-length'
  | 'index'
  | 'source'
  | 'json'
  | 'missing'
  | 'extra'

/** 一条校验错误或告警。 */
export interface ValidationError {
  /** 出问题的文件名（如 `ch001.json`）。 */
  file: string
  /** 问题类别。 */
  kind: ValidationKind
  /** JSON 路径。 */
  path: string
  /** 人可读描述。 */
  message: string
}

/** `_meta.json` 中列出、但缺少对应 `ch*.json` 的章节。 */
export interface MissingChapter {
  index: number
  file: string
}

/** `_errors.json` 的 summary 段。 */
export interface ValidationSummary {
  total_expected: number
  checked: number
  missing_count: number
  error_count: number
  warning_count: number
}

/** `validateExtraction()` 的返回值，同时也是 `_errors.json` 的形状。 */
export interface ValidationResult {
  /** ISO 8601 UTC 时间戳，毫秒被截断为秒。 */
  generated_at: string
  chapters_dir: string
  extracted_dir: string
  schema_dir: string
  summary: ValidationSummary
  missing: MissingChapter[]
  errors: ValidationError[]
  warnings: ValidationError[]
}

/** `validateExtraction()` 的可选项。 */
export interface ValidateOptions {
  /** schema 目录；默认 `<skill>/schemas`。 */
  schemaDir?: string
  /** 引用长度告警阈值，默认 50（按 Unicode 码位计数）。 */
  quoteMax?: number
}

// --------------------------------------------------------------------------- //
// JSON Schema 子集
// --------------------------------------------------------------------------- //

/** 本项目 schema 用到的 JSON Schema 关键字子集。 */
export interface JsonSchema {
  $id?: string
  $schema?: string
  $ref?: string
  title?: string
  description?: string
  type?: string
  enum?: unknown[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  uniqueItems?: boolean
  [key: string]: unknown
}

/** 按文件名索引的 schema 集合。 */
export type SchemaMap = Record<string, JsonSchema>

/** schema 校验器的单条产出。 */
export interface SchemaViolation {
  path: string
  message: string
}

// --------------------------------------------------------------------------- //
// 版本管理（history/）
// --------------------------------------------------------------------------- //

/** 上一次运行的输出目录记录，用于判断「两次运行是否落在同一个输出目录」。 */
export interface LastOutput {
  /** 规范化绝对路径。 */
  extracted_dir: string
  /** 规范化绝对路径。 */
  cards_dir: string
  /** ISO 8601 UTC。 */
  updated_at: string
}

/** `history/_index.json` 的版本条目。 */
export interface HistoryVersionEntry {
  /** 形如 `V1`。 */
  version: string
  created_at: string
  /** 相对 `history/` 父目录的路径，如 `history/V1`。 */
  path: string
  chapter_count: number
  character_count: number
  clothing_count: number
  item_count: number
}

/** `history/_index.json` 的完整形状。 */
export interface HistoryIndex {
  last_output: LastOutput | null
  versions: HistoryVersionEntry[]
  /** 最高版本号；无版本时为 `null`。 */
  latest: string | null
}

/** `history/V{n}/_manifest.json` 的完整形状。 */
export interface BackupManifest {
  version: string
  created_at: string
  /** 章节目录解析后的绝对路径。 */
  source_chapters: string
  extracted_dir: string
  cards_dir: string
  chapter_count: number
  character_count: number
  clothing_count: number
  item_count: number
  note: string
}

/** 输出产物的统计。 */
export interface OutputCounts {
  chapter_count: number
  character_count: number
  clothing_count: number
  item_count: number
}

/** 备份决策原因。 */
export type BackupReason =
  /** 与上一次运行同一输出目录且当前输出非空 → 已备份。 */
  | 'same_output_dir'
  /** 没有 `last_output`：首次运行，不备份。 */
  | 'first_run'
  /** 输出目录与上一次不同：不备份。 */
  | 'output_dir_changed'
  /** 当前输出为空（无 `ch*.json`）：不备份。 */
  | 'empty_output'
  /** `history/` 落在输出目录内部，拒绝备份以避免递归。 */
  | 'history_inside_output'
  /** 备份过程抛错：不阻塞主流程，原因写入 `_progress.json` 的 `backup_failed`。 */
  | 'backup_error'

/** `backup_output.ts` 输出给主 Agent 的决策 JSON。 */
export interface BackupDecision {
  backup_performed: boolean
  version: string | null
  reason: BackupReason
  history_dir: string
  current_extracted: string
  current_cards: string
  /** 仅 `backup_performed` 为真时存在：`history/V{n}/_manifest.json` 的绝对路径。 */
  manifest?: string
  previous_extracted?: string
  previous_cards?: string
  /** 仅 `backup_performed` 为真时存在。 */
  counts?: OutputCounts
  /** 仅 `backup_error` 时存在。 */
  error?: string
  /** 失败原因是否已写入 `_progress.json` 的 `backup_failed`。 */
  backup_failed_recorded?: boolean
  /** 非致命提示，例如 history 落在盘符根目录。 */
  warning?: string
}

/** `history restore` 的结果。 */
export interface RestoreResult {
  version: string
  restored_extracted: string
  restored_cards: string
  /** 回滚前对当前输出的快照版本号；当前输出为空时为 `null`。 */
  snapshot: string | null
  /** 版本中不存在、但当前输出里多出来的文件（`--clean` 时会被删除）。 */
  extra_files: string[]
  cleaned: boolean
}

/** `history prune` 的结果。 */
export interface PruneResult {
  kept: string[]
  pruned: string[]
  dry_run: boolean
}
