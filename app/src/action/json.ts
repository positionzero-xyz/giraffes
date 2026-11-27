export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export function parseJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const parsed = parseJsonValue(item);
      if (parsed === undefined) return undefined;
      out.push(parsed);
    }
    return out;
  }
  if (typeof value !== "object") return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const out: { [key: string]: JsonValue } = {};
  for (const [key, field] of Object.entries(value)) {
    const parsed = parseJsonValue(field);
    if (parsed === undefined) return undefined;
    Object.defineProperty(out, key, { value: parsed, writable: true, enumerable: true, configurable: true });
  }
  return out;
}

const isJsonObject = (value: JsonValue): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseJsonObject(value: unknown): JsonObject | undefined {
  const parsed = parseJsonValue(value);
  return parsed !== undefined && isJsonObject(parsed) ? parsed : undefined;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isJsonObject(value)) throw new Error("unreachable JSON value");
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

export const canonicalJsonObject = (value: JsonObject): string => canonicalJson(value);
