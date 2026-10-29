type CanonicalPrimitive = string | number | boolean | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as CanonicalPrimitive;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isPlainObject(value)) {
    const sortedEntries = Object.entries(value)
      .filter(([, currentValue]) => currentValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    const result: Record<string, unknown> = {};
    for (const [key, currentValue] of sortedEntries) {
      result[key] = canonicalize(currentValue);
    }

    return result;
  }

  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}