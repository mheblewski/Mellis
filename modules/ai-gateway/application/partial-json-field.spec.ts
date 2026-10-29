import { describe, expect, it } from 'vitest';
import { readStreamingJsonStringField } from './partial-json-field';

describe('readStreamingJsonStringField', () => {
  const full = JSON.stringify({
    assistant_message: 'Glikemia: **86%** w zakresie.\nPo obiedzie "skok" do 182 mg/dl 🍕',
    follow_up_candidates: [{ question: 'assistant_message?', kind: 'WHY' }],
    conversation_title: null,
  });

  it('returns the value written so far at every prefix and the whole value at the end', () => {
    const expected = 'Glikemia: **86%** w zakresie.\nPo obiedzie "skok" do 182 mg/dl 🍕';
    let previous = '';
    for (let length = 0; length <= full.length; length += 1) {
      const value = readStreamingJsonStringField(full.slice(0, length), 'assistant_message');
      if (value === null) {
        expect(previous).toBe('');
        continue;
      }
      // Never shows a broken escape or half an emoji, and never goes back.
      expect(expected.startsWith(value)).toBe(true);
      expect(value.length).toBeGreaterThanOrEqual(previous.length);
      previous = value;
    }
    expect(previous).toBe(expected);
  });

  it('is null until the field starts', () => {
    expect(readStreamingJsonStringField('', 'assistant_message')).toBeNull();
    expect(readStreamingJsonStringField('{"assistant_mess', 'assistant_message')).toBeNull();
    expect(readStreamingJsonStringField('{"assistant_message":', 'assistant_message')).toBeNull();
    expect(readStreamingJsonStringField('{"assistant_message":"', 'assistant_message')).toBe('');
  });

  it('finds a field after other fields and skips nested keys with the same name', () => {
    const json = '{"question":null,"meta":{"reply":"nested"},"items":[1,{"reply":"x"}],"reply":"Dwa kawałki pizzy';
    expect(readStreamingJsonStringField(json, 'reply')).toBe('Dwa kawałki pizzy');
  });

  it('is null while an earlier value is still incomplete', () => {
    expect(readStreamingJsonStringField('{"question":"Ile', 'reply')).toBeNull();
    expect(readStreamingJsonStringField('{"count":12', 'reply')).toBeNull();
  });

  it('decodes \\u escapes and holds back half of an escaped or raw surrogate pair', () => {
    const escaped = '{"reply":"Za\\u017c\\u00f3\\u0142\\u0107 \\ud83c\\udf55 ok"}';
    expect(readStreamingJsonStringField(escaped, 'reply')).toBe('Zażółć 🍕 ok');
    expect(readStreamingJsonStringField(escaped.slice(0, escaped.indexOf('\\udf55')), 'reply')).toBe('Zażółć ');
    expect(readStreamingJsonStringField('{"reply":"a\\u01', 'reply')).toBe('a');
    expect(readStreamingJsonStringField('{"reply":"pizza ' + '🍕'.charAt(0), 'reply')).toBe('pizza ');
  });

  it('is null when the field is not a string', () => {
    expect(readStreamingJsonStringField('{"reply":null,', 'reply')).toBeNull();
  });
});
