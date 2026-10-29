/**
 * The patient's age for AI prompts, from the year of birth set in the app ("Rok urodzenia", patients.birth_year).
 * Prompts state it instead of assuming a child: portions, doses, settings and caution follow the age. The age is the
 * difference of years, so it can be one year more than the true age before the birthday; prompts say "about".
 */
export type PatientAgeGroup = 'CHILD' | 'TEEN' | 'ADULT';

export interface PatientAge {
  birth_year: number;
  age_years: number;
  age_group: PatientAgeGroup;
}

export function patientAge(birthYear: number | null | undefined, now: Date): PatientAge | null {
  if (typeof birthYear !== 'number' || !Number.isInteger(birthYear)) return null;
  const ageYears = now.getUTCFullYear() - birthYear;
  if (ageYears < 0 || ageYears > 125) return null;
  return {
    birth_year: birthYear,
    age_years: ageYears,
    age_group: ageYears < 13 ? 'CHILD' : ageYears < 18 ? 'TEEN' : 'ADULT',
  };
}

/** One line for an English system prompt. */
export function patientAgeInstruction(age: PatientAge | null): string {
  if (!age) {
    return 'Patient age: not known (no year of birth set). Do not assume a child or an adult; where the age matters (portion sizes, doses, settings), say what you assumed.';
  }
  const about = `about ${age.age_years} (born ${age.birth_year})`;
  switch (age.age_group) {
    case 'CHILD':
      return `Patient age: ${about}, a child. Portions, doses, settings and studies are for a child of this age; err on the conservative side.`;
    case 'TEEN':
      return `Patient age: ${about}, a teenager. Portions, doses, settings and studies are for a teenager of this age (puberty can raise insulin needs); err on the conservative side.`;
    case 'ADULT':
      return `Patient age: ${about}, an adult. Portions, doses, settings and studies are for an adult; still err on the conservative side.`;
  }
}

/** One line for a Polish system prompt (meal chat, WBT suggestion). */
export function patientAgeInstructionPl(age: PatientAge | null): string {
  if (!age) {
    return 'Wiek pacjenta: nieznany (nie podano roku urodzenia). Nie zakładaj, że to dziecko ani dorosły; gdy wiek ma znaczenie (porcja, dawka), napisz, co przyjąłeś.';
  }
  const about = `ok. ${age.age_years} ${polishYears(age.age_years)} (rocznik ${age.birth_year})`;
  switch (age.age_group) {
    case 'CHILD':
      return `Wiek pacjenta: ${about}, dziecko. Porcje i dawki dobieraj do dziecka w tym wieku; bądź ostrożny.`;
    case 'TEEN':
      return `Wiek pacjenta: ${about}, nastolatek. Porcje i dawki dobieraj do nastolatka w tym wieku; bądź ostrożny.`;
    case 'ADULT':
      return `Wiek pacjenta: ${about}, osoba dorosła. Porcje i dawki dobieraj do dorosłego; nadal bądź ostrożny.`;
  }
}

/** "rok", "lata" or "lat" after a number of years. */
export function polishYears(years: number): string {
  if (years === 1) return 'rok';
  const lastDigit = years % 10;
  const lastTwo = years % 100;
  return lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'lata' : 'lat';
}
