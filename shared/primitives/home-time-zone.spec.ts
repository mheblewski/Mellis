import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_TIME_ZONE, resolveHomeTimeZone } from './home-time-zone';

describe('resolveHomeTimeZone', () => {
  it('uses TZ when it is a real zone other than UTC', () => {
    expect(resolveHomeTimeZone({ TZ: 'America/New_York' })).toBe('America/New_York');
    expect(resolveHomeTimeZone({ TZ: ' Europe/Berlin ' })).toBe('Europe/Berlin');
  });

  it('falls back to Europe/Warsaw for an unset, empty, UTC or invalid TZ', () => {
    expect(DEFAULT_HOME_TIME_ZONE).toBe('Europe/Warsaw');
    expect(resolveHomeTimeZone({})).toBe('Europe/Warsaw');
    expect(resolveHomeTimeZone({ TZ: '' })).toBe('Europe/Warsaw');
    expect(resolveHomeTimeZone({ TZ: 'UTC' })).toBe('Europe/Warsaw');
    expect(resolveHomeTimeZone({ TZ: 'Not/AZone' })).toBe('Europe/Warsaw');
  });
});
