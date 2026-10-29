import { describe, expect, it } from 'vitest';
import { withoutOptionPointer } from './worker.service';

describe('withoutOptionPointer', () => {
  it('drops the closing "choose an option" sentence when the answer ended up without options', () => {
    const text = 'Glukoza spada przy aktywnej insulinie. Najbezpieczniej najpierw szybkie węgle. Wybierz opcję poniżej albo napisz własny plan.';
    expect(withoutOptionPointer(text, false)).toBe('Glukoza spada przy aktywnej insulinie. Najbezpieczniej najpierw szybkie węgle.');
    expect(withoutOptionPointer(text, true)).toBe(text);
    expect(withoutOptionPointer('Podaj 2 j na kanapkę.', false)).toBe('Podaj 2 j na kanapkę.');
  });
});
