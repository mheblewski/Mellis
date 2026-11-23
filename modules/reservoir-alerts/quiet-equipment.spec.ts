import { describe, expect, it } from 'vitest';
import { afterQuietItems, beforeQuietItems, gathered, type EquipmentNow } from './application/quiet-equipment';

const TZ = 'Europe/Warsaw';
const at = new Date('2026-11-22T21:30:00+01:00');
const end = new Date('2026-11-23T07:00:00+01:00');
const on = { reservoir: true, battery: true, site: true };
const base: EquipmentNow = {
  reservoir_units: 60, reservoir_level: 'normal', reservoir_hours_left: 40, reservoir_changed_at: null,
  battery_percent: 80, pump_read_at: '2026-11-22T21:25:00+01:00', site_changed_at: '2026-11-21T19:00:00+01:00',
};

describe('before quiet hours', () => {
  it('says nothing when everything lasts past the end + 1 h', () => {
    expect(beforeQuietItems(base, on, at, end, TZ)).toEqual([]);
  });

  it('warns about a reservoir that runs out at night, with the clock in the phone zone', () => {
    const items = beforeQuietItems({ ...base, reservoir_units: 9, reservoir_level: 'alarm', reservoir_hours_left: 5.5 }, on, at, end, TZ);
    expect(items).toEqual([{ title: 'Zbiornik może się skończyć ok. 3:00', body: 'Zostało 9 j. Godziny ciszy trwają do 7:00.', line: 'Zbiornik: zostało 9 j, może się skończyć ok. 3:00.' }]);
  });

  it('counts the hour after the end, and leaves out what the phone has off or a stale pump', () => {
    // Runs out 7:45: within end + 1 h.
    expect(beforeQuietItems({ ...base, reservoir_hours_left: 10.25 }, on, at, end, TZ)).toHaveLength(1);
    expect(beforeQuietItems({ ...base, reservoir_hours_left: 11 }, on, at, end, TZ)).toHaveLength(0);
    expect(beforeQuietItems({ ...base, reservoir_hours_left: 5 }, { ...on, reservoir: false }, at, end, TZ)).toHaveLength(0);
    expect(beforeQuietItems({ ...base, reservoir_hours_left: 5, pump_read_at: '2026-11-22T10:00:00+01:00' }, on, at, end, TZ)).toHaveLength(0);
  });

  it('gathers battery and a site due at night into one push', () => {
    const items = beforeQuietItems({ ...base, battery_percent: 14, site_changed_at: '2026-11-20T02:10:00+01:00' }, on, at, end, TZ);
    expect(items.map((item) => item.title)).toEqual(['Bateria pompy: 14%', 'Wkłucie skończy 3 dni o 2:10']);
    expect(gathered(items, 'Przed godzinami ciszy')).toEqual({ title: 'Przed godzinami ciszy', body: 'Bateria pompy: 14%.\nWkłucie skończy 3 dni o 2:10.' });
  });
});

describe('after quiet hours', () => {
  const morning = new Date('2026-11-23T07:00:30+01:00');
  const heldAt = '2026-11-23T01:00:00+01:00';
  const fresh = { pump_read_at: '2026-11-23T06:58:00+01:00' };

  it('sends what is still true with fresh numbers, and leaves out what was dealt with', () => {
    const held = [
      { type: 'reservoir_low', held_at: heldAt, title: 'Wymień zbiornik insuliny', body: 'Zostało 12 j, wystarczy na ok. 8 godz.' },
      { type: 'battery_low', held_at: heldAt, title: 'Słaba bateria pompy', body: 'Zostało 22%. Naładuj lub wymień baterię.' },
    ];
    const now = { ...base, ...fresh, reservoir_units: 6, reservoir_level: 'alarm' as const, reservoir_hours_left: 4.2, battery_percent: 95 };
    const { items, emptyReservoir } = afterQuietItems(held, now, morning, TZ);
    expect(emptyReservoir).toBe(false);
    expect(items.map((item) => item.line)).toEqual(['Zbiornik: zostało 6 j, wystarczy na ok. 4 godz.']);
    expect(afterQuietItems(held, { ...now, reservoir_changed_at: '2026-11-23T05:00:00+01:00' }, morning, TZ).items).toHaveLength(0);
  });

  it('keeps the held text when the pump was not read, and flags an empty reservoir', () => {
    const held = [{ type: 'reservoir_low', held_at: heldAt, title: 'Wymień zbiornik insuliny', body: 'Zostało 8 j, wystarczy na ok. 6 godz.' }];
    expect(afterQuietItems(held, { ...base, pump_read_at: null }, morning, TZ).items[0]!.title).toBe('Wymień zbiornik insuliny');
    expect(afterQuietItems(held, { ...base, ...fresh, reservoir_units: 0, reservoir_level: 'alarm' }, morning, TZ)).toEqual({ items: [], emptyReservoir: true });
  });

  it('leaves out a site changed in the night', () => {
    const held = [{ type: 'site_change', held_at: heldAt, title: 'Wkłucie ma już 3 dni', body: 'b' }];
    expect(afterQuietItems(held, { ...base, site_changed_at: '2026-11-19T21:00:00+01:00' }, morning, TZ).items.map((item) => item.title)).toEqual(['Wkłucie ma już 3 dni']);
    expect(afterQuietItems(held, { ...base, site_changed_at: '2026-11-23T02:00:00+01:00' }, morning, TZ).items).toHaveLength(0);
  });
});
