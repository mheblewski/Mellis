import { describe, expect, it } from 'vitest';
import { parseSettingChange } from './settings-replay.controller';

describe('parseSettingChange', () => {
  it('accepts a named change', () => {
    expect(parseSettingChange({ setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 })).toEqual({ setting: 'BASAL', from: '00:00', to: '01:00', value: 0.1 });
  });
  it('refuses anything else', () => {
    expect(() => parseSettingChange({ setting: 'DIA', from: '00:00', to: '01:00', value: 1 })).toThrow();
    expect(() => parseSettingChange({ setting: 'ISF', from: '24:00', to: '01:00', value: 1 })).toThrow();
    expect(() => parseSettingChange({ setting: 'ISF', from: '00:00', to: '01:00', value: 'x' })).toThrow();
  });
});
