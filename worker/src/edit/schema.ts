// The part of JSON Schema the public vault's record schemas use (its schema/*.schema.json, which
// its tools/validate.mjs checks every page's front matter against with Ajv), checked the way Ajv
// checks it and said in Ajv's words, so a page edited on the site is refused for what the vault's
// check would refuse. Ajv itself compiles schemas to code, which a Worker can't run. A schema
// with a keyword this doesn't know is reported, never passed over.

type Schema = Record<string, unknown>

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
])
const KNOWN = new Set([
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "contains",
  "uniqueItems",
  "minItems",
  "maxItems",
])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  if (isObject(value)) return "object"
  return typeof value // string, boolean; a YAML date is a Date: an object, but not a plain one
}

function hasType(value: unknown, type: string): boolean {
  const actual = typeOf(value)
  if (type === "number") return actual === "number" || actual === "integer"
  return actual === type
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What in `value` doesn't match `schema`, as "<path> <what>", like Ajv's errors. */
export function schemaProblems(schema: Schema, value: unknown, at = ""): string[] {
  const where = at || "/"
  const problems: string[] = []
  for (const keyword of Object.keys(schema))
    if (!KNOWN.has(keyword) && !ANNOTATIONS.has(keyword))
      return [`${where} uses ${keyword}, which the site can't check: ask an admin to commit it`]
  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
    if (!types.some((type) => hasType(value, type))) return [`${where} must be ${types.join(",")}`]
  }
  if ("const" in schema && !equal(value, schema.const))
    problems.push(`${where} must be equal to constant`)
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => equal(value, option)))
    problems.push(`${where} must be equal to one of the allowed values`)
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
      problems.push(`${where} must match pattern "${schema.pattern}"`)
    const length = [...value].length
    if (typeof schema.minLength === "number" && length < schema.minLength)
      problems.push(`${where} must NOT have fewer than ${schema.minLength} characters`)
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      problems.push(`${where} must NOT have more than ${schema.maxLength} characters`)
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      problems.push(`${where} must be >= ${schema.minimum}`)
    if (typeof schema.maximum === "number" && value > schema.maximum)
      problems.push(`${where} must be <= ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (isObject(schema.items))
      value.forEach((item, index) =>
        problems.push(...schemaProblems(schema.items as Schema, item, `${at}/${index}`)),
      )
    if (
      isObject(schema.contains) &&
      !value.some((item) => !schemaProblems(schema.contains as Schema, item).length)
    )
      problems.push(`${where} must contain at least 1 valid item(s)`)
    if (schema.uniqueItems === true)
      for (let i = value.length - 1; i > 0; i--) {
        const j = value.findIndex((item, index) => index < i && equal(item, value[i]))
        if (j >= 0) {
          problems.push(
            `${where} must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
          )
          break
        }
      }
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      problems.push(`${where} must NOT have fewer than ${schema.minItems} items`)
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      problems.push(`${where} must NOT have more than ${schema.maxItems} items`)
  }
  if (isObject(value)) {
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : [])
      if (!(key in value)) problems.push(`${where} must have required property '${key}'`)
    const properties = isObject(schema.properties) ? schema.properties : {}
    for (const [key, item] of Object.entries(value)) {
      if (isObject(properties[key]))
        problems.push(...schemaProblems(properties[key] as Schema, item, `${at}/${key}`))
      else if (schema.additionalProperties === false)
        problems.push(`${where} must NOT have additional properties`)
    }
  }
  return problems
}
