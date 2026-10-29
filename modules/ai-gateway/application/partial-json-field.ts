/**
 * Reads one top-level string field out of a JSON object that is still being streamed, so the caregiver can see an answer
 * while the model is writing it. Structured outputs put the answer field first (assistant_message, reply), which makes
 * its value readable long before the object closes.
 *
 * Returns the decoded value written so far (escapes resolved, an escape cut in half left out), or null while the field
 * has not started. Only the top level is searched: a nested key with the same name is skipped.
 */
export function readStreamingJsonStringField(partialJson: string, field: string): string | null {
  let index = skipWhitespace(partialJson, 0);
  if (partialJson[index] !== '{') return null;
  index += 1;

  for (;;) {
    index = skipWhitespace(partialJson, index);
    if (index >= partialJson.length) return null;
    if (partialJson[index] === ',') {
      index += 1;
      continue;
    }
    if (partialJson[index] === '}') return null;
    if (partialJson[index] !== '"') return null;

    const key = readString(partialJson, index);
    if (!key.complete) return null;
    index = skipWhitespace(partialJson, key.end);
    if (partialJson[index] !== ':') return null;
    index = skipWhitespace(partialJson, index + 1);
    if (index >= partialJson.length) return null;

    if (key.value === field) {
      if (partialJson[index] !== '"') return null;
      return readString(partialJson, index).value;
    }

    const valueEnd = skipValue(partialJson, index);
    if (valueEnd === null) return null;
    index = valueEnd;
  }
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && (text[index] === ' ' || text[index] === '\n' || text[index] === '\r' || text[index] === '\t')) index += 1;
  return index;
}

/** Decodes the JSON string starting at the opening quote; `complete` is false while its closing quote has not arrived. */
function readString(text: string, openingQuote: number): { value: string; end: number; complete: boolean } {
  let value = '';
  let index = openingQuote + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') return { value, end: index + 1, complete: true };
    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }
    const escape = text[index + 1];
    if (escape === undefined) break;
    if (escape === 'u') {
      const hex = text.slice(index + 2, index + 6);
      if (hex.length < 4) break;
      const code = Number.parseInt(hex, 16);
      if (Number.isNaN(code)) break;
      // A high surrogate waits for its low half, so a split emoji never shows as a broken character.
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.slice(index + 6, index + 12);
        if (low.length < 6) break;
        const lowCode = low.startsWith('\\u') ? Number.parseInt(low.slice(2), 16) : Number.NaN;
        if (Number.isNaN(lowCode)) break;
        value += String.fromCharCode(code, lowCode);
        index += 12;
        continue;
      }
      value += String.fromCharCode(code);
      index += 6;
      continue;
    }
    value += ESCAPES[escape] ?? escape;
    index += 2;
  }
  // A raw emoji cut between two deltas ends in a lone high surrogate until its second half arrives.
  const last = value.charCodeAt(value.length - 1);
  return { value: last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value, end: text.length, complete: false };
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

/** End index of the complete JSON value starting at `from`, or null while it is still incomplete. */
function skipValue(text: string, from: number): number | null {
  const first = text[from];
  if (first === '"') {
    const string = readString(text, from);
    return string.complete ? string.end : null;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    let index = from;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        const string = readString(text, index);
        if (!string.complete) return null;
        index = string.end;
        continue;
      }
      if (char === '{' || char === '[') depth += 1;
      if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return null;
  }
  // Number, true, false or null: ends at the next delimiter (absent while it is still streaming).
  let index = from;
  while (index < text.length && !',}] \n\r\t'.includes(text[index] as string)) index += 1;
  return index < text.length ? index : null;
}
