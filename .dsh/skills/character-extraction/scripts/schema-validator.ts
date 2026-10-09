/**
 * 无第三方依赖的 JSON Schema 子集校验器。
 *
 * 覆盖本项目 `schemas/*.schema.json` 实际用到的关键字：`$ref`（文件内 `#/...` 指针与
 * 同级文件引用）/ `type` / `enum` / `pattern` / `minLength` / `maxLength` / `minimum` /
 * `required` / `properties` / `additionalProperties` / `items` / `uniqueItems`。
 *
 * 因此不需要安装 `ajv`、`jsonschema` 之类依赖即可运行。
 *
 * 语义约定：
 * - `enum` 与 `uniqueItems` 用**结构化**比较（键顺序无关），不是引用比较；
 * - `minLength` / `maxLength` 按 Unicode **码位**计数（JSON Schema 的定义如此）；
 * - `integer` 排除布尔值（JSON 的 `true` 不是整数）；
 * - `$ref` 的 `~1` / `~0` 反转义顺序为 `~1` 后 `~0`（JSON Pointer 规范）。
 *
 * 健壮性：无法解析的 `$ref` 会产出一条校验问题，而不是抛出异常中断整轮校验。
 *
 * @module character-extraction/scripts/schema-validator
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { JsonSchema, SchemaMap, SchemaViolation } from './types.ts'
import { codePointLength, compareStrings, errorMessage, isPlainObject, repr, stripBom } from './util.ts'

type TypeCheck = (value: unknown) => boolean

const TYPE_CHECKS: Record<string, TypeCheck> = {
  object: (value) => isPlainObject(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === 'number',
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
}

/**
 * 不同 JSON 类型的可读名称，用于诊断消息。
 * @param value - 任意值。
 * @returns `object` / `array` / `string` / `integer` / `number` / `boolean` / `null` 等。
 */
export function typeName(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean'
  if (isPlainObject(value)) return 'object'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value
}

/** 键名排序后的规范化序列化，使结构化比较不受键顺序影响。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareStrings)
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

/**
 * 结构化相等（键顺序无关），用于 `enum` 与 `uniqueItems` 的比较。
 * @param left - 左值。
 * @param right - 右值。
 * @returns 是否相等。
 */
export function structuralEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object') return false
  if (left === null || right === null) return false
  return canonical(left) === canonical(right)
}

/**
 * 读取 schema 目录下全部 `*.json`，按文件名索引。
 * @param schemaDir - schema 目录。
 * @returns 文件名 → schema。
 * @throws 目录为空、文件不可读或 JSON 非法时抛出。
 */
export async function loadSchemas(schemaDir: string): Promise<SchemaMap> {
  const names = (await readdir(schemaDir)).filter((name) => name.endsWith('.json')).sort(compareStrings)
  const schemas: SchemaMap = {}

  for (const name of names) {
    const raw = await readFile(path.join(schemaDir, name), 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(stripBom(raw))
    } catch (error) {
      throw new Error(`schema 文件 JSON 非法（${name}）：${errorMessage(error)}`)
    }
    if (!isPlainObject(parsed)) throw new Error(`schema 文件不是对象（${name}）`)
    schemas[name] = parsed as JsonSchema
  }

  if (Object.keys(schemas).length === 0) throw new Error(`schema 目录为空：${schemaDir}`)
  return schemas
}

/**
 * 解析 `$ref`。
 * @param ref - `$ref` 值，文件内指针（`#/...`）或同级文件名。
 * @param schema - 当前 schema（用于解析文件内指针）。
 * @returns 命中的子 schema（`target`）或同级文件名（`targetFile`）。
 */
export function resolveRef(ref: string, schema: JsonSchema): { target?: JsonSchema; targetFile?: string } {
  if (!ref.startsWith('#')) return { targetFile: ref }

  let node: unknown = schema
  for (const rawToken of ref.slice(2).split('/')) {
    if (rawToken === '') continue
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isPlainObject(node)) return {}
    node = node[token]
  }
  return isPlainObject(node) ? { target: node as JsonSchema } : {}
}

/**
 * 递归校验一个实例。错误累积在传入的 `errors` 数组里，便于一次报出全部问题。
 * @param instance - 待校验值。
 * @param schema - 当前 schema。
 * @param schemas - 全部 schema（解析同级文件 `$ref`）。
 * @param currentFile - 当前 schema 的文件名（仅用于诊断）。
 * @param path - 当前 JSON 路径。
 * @param errors - 累积的问题列表。
 * @returns 同一个 `errors` 列表。
 */
export function validateInstance(
  instance: unknown,
  schema: unknown,
  schemas: SchemaMap,
  currentFile: string,
  path = '$',
  errors: SchemaViolation[] = [],
): SchemaViolation[] {
  if (!isPlainObject(schema)) return errors
  const node = schema as JsonSchema

  const ref = node.$ref
  if (typeof ref === 'string') {
    const resolved = resolveRef(ref, node)
    if (resolved.target !== undefined) {
      return validateInstance(instance, resolved.target, schemas, currentFile, path, errors)
    }
    if (resolved.targetFile !== undefined) {
      const target = schemas[resolved.targetFile]
      if (target === undefined) {
        errors.push({ path, message: `无法解析 $ref：${ref}` })
        return errors
      }
      return validateInstance(instance, target, schemas, resolved.targetFile, path, errors)
    }
    errors.push({ path, message: `无法解析 $ref：${ref}` })
    return errors
  }

  const expected = node.type
  if (typeof expected === 'string' && expected in TYPE_CHECKS) {
    if (!TYPE_CHECKS[expected]!(instance)) {
      errors.push({ path, message: `类型应为 ${expected}，实际为 ${typeName(instance)}` })
      return errors
    }
  }

  const enumValues = node.enum
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => structuralEqual(candidate, instance))) {
    errors.push({
      path,
      message: `取值必须是 ${enumValues.map((value) => repr(value)).join(' / ')} 之一，实际为 ${repr(instance)}`,
    })
  }

  if (typeof instance === 'string') {
    const pattern = node.pattern
    if (typeof pattern === 'string') {
      let matched = false
      try {
        matched = new RegExp(pattern, 'u').test(instance)
      } catch (error) {
        errors.push({ path, message: `pattern 非法 ${pattern}：${errorMessage(error)}` })
        matched = true
      }
      if (!matched) errors.push({ path, message: `不匹配 pattern ${pattern}：${repr(instance)}` })
    }

    const minLength = node.minLength
    if (typeof minLength === 'number' && codePointLength(instance) < minLength) {
      errors.push({ path, message: `长度小于 minLength=${minLength}：${repr(instance)}` })
    }

    const maxLength = node.maxLength
    if (typeof maxLength === 'number' && codePointLength(instance) > maxLength) {
      const head = [...instance].slice(0, 60).join('')
      errors.push({
        path,
        message: `长度 ${codePointLength(instance)} 超过 maxLength=${maxLength}：${repr(head)}`,
      })
    }
  }

  if (typeof instance === 'number') {
    const minimum = node.minimum
    if (typeof minimum === 'number' && instance < minimum) {
      errors.push({ path, message: `小于 minimum=${minimum}：${repr(instance)}` })
    }
  }

  if (isPlainObject(instance)) {
    const required = node.required
    if (Array.isArray(required)) {
      for (const key of required) {
        if (!(key in instance)) errors.push({ path, message: `缺少必填字段 ${key}` })
      }
    }

    const properties = isPlainObject(node.properties) ? (node.properties as Record<string, JsonSchema>) : {}
    for (const [key, value] of Object.entries(instance)) {
      const child = `${path}.${key}`
      if (key in properties) {
        validateInstance(value, properties[key], schemas, currentFile, child, errors)
        continue
      }
      const extra = node.additionalProperties
      if (extra === false) {
        errors.push({ path: child, message: `不允许的额外字段 ${key}` })
      } else if (isPlainObject(extra)) {
        validateInstance(value, extra, schemas, currentFile, child, errors)
      }
    }
  }

  if (Array.isArray(instance)) {
    if (node.uniqueItems === true) {
      const seen: unknown[] = []
      for (const item of instance) {
        if (seen.some((candidate) => structuralEqual(candidate, item))) {
          errors.push({ path, message: `数组元素重复：${repr(item)}` })
        }
        seen.push(item)
      }
    }
    const items = node.items
    if (isPlainObject(items)) {
      instance.forEach((item, index) => {
        validateInstance(item, items, schemas, currentFile, `${path}[${index}]`, errors)
      })
    }
  }

  return errors
}
