/**
 * 小工具：BOM 处理、字符串排序、码位计数与错误消息归一。
 *
 * 与 `types.ts` 分离，使后者保持「只含类型」，从而可以用 `import type` 引入而不产生
 * 运行时导入。
 *
 * @module character-extraction/scripts/util
 */

import type { JsonObject } from './types.ts'

/** 判断是否为普通对象（非 null、非数组）。 */
export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 去掉 UTF-8 BOM。
 *
 * `readFile(..., 'utf8')` 会把 BOM 留成 `U+FEFF`，直接 `JSON.parse` 会失败，因此必须
 * 显式剥离。
 * @param text - 已按 UTF-8 解码的文本。
 * @returns 无前导 BOM 的文本。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 按 UTF-16 码元比较两个字符串，用于确定性排序。
 *
 * 对 BMP 字符（含中日韩文字与数字）与 Unicode 码位顺序一致；星平面字符会有差异，
 * 但章节文件名不涉及。
 * @param left - 左侧字符串。
 * @param right - 右侧字符串。
 * @returns 负数 / 0 / 正数。
 */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * 按 **Unicode 码位** 计数，而不是 UTF-16 码元。
 *
 * `'👍'.length === 2`（码元），`codePointLength('👍') === 1`（码位）。JSON Schema 的
 * `minLength`/`maxLength` 与引用长度上限都按码位定义，故统一走这里。
 * @param value - 待计数文本。
 * @returns 码位数量。
 */
export function codePointLength(value: string): number {
  return [...value].length
}

/** 把任意抛出物归一为可读消息。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 紧凑的单行表示，仅用于诊断消息。
 * @param value - 任意值。
 * @returns 单行字符串。
 */
export function repr(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
