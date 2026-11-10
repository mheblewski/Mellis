import { describe, expect, it } from 'vitest';
import { parseFoodNote, readNoteText } from './patient-notes';

describe('patient notes', () => {
  it('makes a food note in its own words', () => {
    expect(parseFoodNote({ food_name: ' Buraczki ', portion: 'NONE' })).toEqual({ food_name: 'Buraczki', portion: 'NONE', text: 'Zwykle zostaje na talerzu: Buraczki' });
    expect(parseFoodNote({ food_name: 'Ziemniaki', portion: 'HALF' }).text).toBe('Zwykle zjada połowę: Ziemniaki');
    expect(() => parseFoodNote({ food_name: '', portion: 'NONE' })).toThrow('food_name');
    expect(() => parseFoodNote({ food_name: 'x', portion: 'ALL' })).toThrow('portion');
  });

  it('reads text a caregiver corrected', () => {
    expect(readNoteText('  Kompot   jest słodzony. ')).toBe('Kompot jest słodzony.');
    expect(() => readNoteText('  ')).toThrow('required');
    expect(() => readNoteText('x'.repeat(201))).toThrow('longer');
  });
});
