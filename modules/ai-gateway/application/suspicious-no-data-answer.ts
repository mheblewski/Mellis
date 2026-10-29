/**
 * Safety net for "no data" answers (anomaly audit 2026-10-19): an AI answer that says the data is missing or absent
 * ("nie mam danych", "brak odczytów", "nie było bolusa", "IOB nieznane", ...) while the patient's database holds that
 * kind of data for the window the answer is about. Such answers are flagged for the owner's daily review, never changed
 * or blocked. Only the claim's canonical words and event counts are recorded, never patient values.
 */

export const SUSPICIOUS_NO_DATA_DETECTOR_VERSION = 'suspicious-no-data-answer.v1';

/** What the answer says is missing. ANY_DATA: data in general ("nie mam danych", "nie mam dostępu"). */
export type NoDataClaimKind = 'ANY_DATA' | 'GLUCOSE' | 'BOLUS' | 'SMB' | 'INSULIN' | 'BASAL' | 'IOB_COB';

export interface NoDataClaim {
  kind: NoDataClaimKind;
  /** Canonical words of the claim ("nie mam danych", "brak odczytów"), without the words between them. */
  phrase: string;
}

/** Events in the answer's window, by kind (counts only). */
export interface PatientDataCounts {
  glucose_readings: number;
  boluses: number;
  smbs: number;
  temp_basals: number;
  loop_snapshots: number;
}

export interface SuspiciousNoDataFlag {
  type: 'SUSPICIOUS_NO_DATA_ANSWER';
  detector_version: string;
  /** Claims whose kind of data the database has in the window. */
  claims: NoDataClaim[];
  /** ANALYSED_RANGE: the range of a time-range analysis; LAST_24H: the 24 h before the question of a direct reply. */
  window_basis: 'ANALYSED_RANGE' | 'LAST_24H';
  window_from: string;
  window_to: string;
  counts: PatientDataCounts;
}

// Lower-case, Polish letters folded one to one (same length), so a match maps back to the original text.
const FOLD: Record<string, string> = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z', '’': "'" };
const fold = (text: string) => [...text.toLowerCase()].map((char) => FOLD[char] ?? char).join('');

/** Negations that start a claim (folded); up to two words may stand between them and the noun. */
const NEGATIONS = [
  'nie mam', 'nie posiadam', 'nie widze', 'nie widac', 'nie ma', 'nie bylo', 'nie byl', 'nie byla', 'brak', 'brakuje',
  'nie znalazl\\w*', 'nie odnotowano', 'nie zarejestrowano', 'nie dotarl\\w*', 'nie wczytal\\w*', 'zadnych', 'zadnego', 'zadnej',
  "i don't have", 'i do not have', "i can't see", 'i cannot see', 'i do not see', "i don't see", 'there (?:was|were|is|are) no',
];
/** Short negations that must stand right before the noun ("no data"; Polish "no" is also a particle: "no to bolus..."). */
const TIGHT_NEGATIONS = ['no', 'missing'];

/** Nouns of the claim (folded) and the kind of data each one names. */
const NOUNS: Array<[string, NoDataClaimKind]> = [
  ['danych', 'ANY_DATA'], ['data', 'ANY_DATA'],
  ['odczyt\\w*', 'GLUCOSE'], ['pomiar\\w*', 'GLUCOSE'], ['cgm', 'GLUCOSE'], ['glukoz\\w*', 'GLUCOSE'], ['cukr\\w*', 'GLUCOSE'],
  ['readings?', 'GLUCOSE'], ['glucose', 'GLUCOSE'], ['sensor data', 'GLUCOSE'],
  ['bolus\\w*', 'BOLUS'],
  ['smb\\w*', 'SMB'], ['mikrobolus\\w*', 'SMB'],
  ['insulin\\w*', 'INSULIN'],
  ['baz[aey]', 'BASAL'], ['bazal\\w*', 'BASAL'], ['bazow\\w*', 'BASAL'], ['basal\\w*', 'BASAL'], ['temp basal\\w*', 'BASAL'],
  ['iob', 'IOB_COB'], ['cob', 'IOB_COB'],
];
const NOUN_KIND = (noun: string): NoDataClaimKind => NOUNS.find(([pattern]) => new RegExp(`^(?:${pattern})$`).test(noun))?.[1] ?? 'ANY_DATA';

// Negation, up to two words between, the noun. "Data" right after "w"/"in (the)" is where something is looked for
// ("nie ma w danych bolusa", "nie widzę w danych hipo"), not the claim's noun. Words between that turn the sentence
// into something else ("nie ma potrzeby podawać insuliny", "nie było spadku cukru") end the claim.
const NOUN_GROUP = `(?<!\\b(?:w|we|in)\\s(?:the\\s)?)(${NOUNS.map(([pattern]) => pattern).join('|')})(?![\\p{L}])`;
const CLAIM = new RegExp(`(?<![\\p{L}'])(${NEGATIONS.join('|')})\\s+((?:[\\p{L}'-]+\\s+){0,2}?)${NOUN_GROUP}`, 'gu');
const TIGHT_CLAIM = new RegExp(`(?<![\\p{L}'])(${TIGHT_NEGATIONS.join('|')})\\s+()${NOUN_GROUP}`, 'gu');
const BETWEEN_STOP = /\b(?:potrzeb\w*|powod\w*|sensu|koniecznosc\w*|wskazan\w*|ryzyk\w*|obaw\w*|zagrozen\w*|problem\w*|wplyw\w*|spadk\w*|wzrost\w*|skok\w*|zmian\w*|wahan\w*|need\w*|reason|risk|sign\w*|drop\w*|rise|spike\w*)\b/;
// "nie mam danych o posiłku / aktywności": data the database does not hold as events.
const OTHER_TOPIC_AFTER_DATA = /^\s+(?:o|na temat|dotyczacych|about|on|for)\s+(?:\p{L}+\s+)?(?:posilk|jedzen|jadl|weglowodan|aktywn|wysilk|ruch|chorob|samopoczuc|snu|sen\b|stres|zdjec|meal|food|carb|activit|exercis|sleep|ill)/u;
// Standalone phrases.
const STANDALONE: Array<[RegExp, NoDataClaimKind, string]> = [
  [/(?<![\p{L}])nie mam dostepu(?![\p{L}])/u, 'ANY_DATA', 'nie mam dostępu'],
  [/(?<![\p{L}])(?:i )?(?:do not|don't) have access(?![\p{L}])/u, 'ANY_DATA', "don't have access"],
  [/(?<![\p{L}])(?:iob|cob)(?:\s*(?:i|\/|and)\s*(?:iob|cob))?\s*(?:jest|sa|is|are|:|-)?\s*(?:nieznan\w*|unknown)(?![\p{L}])/u, 'IOB_COB', 'IOB/COB nieznane'],
  [/(?<![\p{L}])(?:nieznan\w*|unknown)\s+(?:iob|cob)(?![\p{L}])/u, 'IOB_COB', 'IOB/COB nieznane'],
  [/(?<![\p{L}])nie znam\s+(?:\p{L}+\s+)?(?:iob|cob)(?![\p{L}])/u, 'IOB_COB', 'nie znam IOB/COB'],
];

/** The answer's claims that data is missing or absent, each kind and phrase once. Pure and cheap: run on every answer. */
export function findNoDataClaims(answer: string): NoDataClaim[] {
  const folded = fold(answer);
  const claims: NoDataClaim[] = [];
  const add = (claim: NoDataClaim) => {
    if (!claims.some((existing) => existing.kind === claim.kind && existing.phrase === claim.phrase)) claims.push(claim);
  };
  for (const match of [...folded.matchAll(CLAIM), ...folded.matchAll(TIGHT_CLAIM)]) {
    const [whole, , between, noun] = match;
    if (BETWEEN_STOP.test(between)) continue;
    const kind = NOUN_KIND(noun);
    const end = match.index + whole.length;
    if (kind === 'ANY_DATA' && OTHER_TOPIC_AFTER_DATA.test(folded.slice(end, end + 40))) continue;
    // The original spelling of the negation and the noun (the fold keeps positions, except for rare letters whose
    // lower case is longer: then the folded words).
    const source = folded.length === answer.length ? answer : folded;
    const negationText = source.slice(match.index, match.index + match[1].length).toLowerCase();
    const nounText = source.slice(end - noun.length, end).toLowerCase();
    add({ kind, phrase: `${negationText} ${nounText}` });
  }
  for (const [pattern, kind, phrase] of STANDALONE) {
    if (pattern.test(folded)) add({ kind, phrase });
  }
  return claims;
}

/** Whether the database holds the kind of data a claim says is missing. */
function contradicted(kind: NoDataClaimKind, counts: PatientDataCounts): boolean {
  switch (kind) {
    case 'GLUCOSE': return counts.glucose_readings > 0;
    case 'BOLUS': return counts.boluses > 0;
    case 'SMB': return counts.smbs > 0;
    case 'INSULIN': return counts.boluses + counts.smbs + counts.temp_basals > 0;
    case 'BASAL': return counts.temp_basals > 0;
    case 'IOB_COB': return counts.loop_snapshots > 0;
    case 'ANY_DATA': return counts.glucose_readings + counts.boluses + counts.smbs + counts.temp_basals > 0;
  }
}

/** The flag for the claims the counts contradict, or null when none is. */
export function evaluateNoDataClaims(args: {
  claims: NoDataClaim[];
  counts: PatientDataCounts;
  windowBasis: SuspiciousNoDataFlag['window_basis'];
  windowFrom: string;
  windowTo: string;
}): SuspiciousNoDataFlag | null {
  const claims = args.claims.filter((claim) => contradicted(claim.kind, args.counts));
  if (claims.length === 0) return null;
  return {
    type: 'SUSPICIOUS_NO_DATA_ANSWER',
    detector_version: SUSPICIOUS_NO_DATA_DETECTOR_VERSION,
    claims,
    window_basis: args.windowBasis,
    window_from: args.windowFrom,
    window_to: args.windowTo,
    counts: args.counts,
  };
}
