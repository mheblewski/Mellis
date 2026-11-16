import { plainText } from '@modules/context/application/time-range-normalization';

/**
 * A chat question about the therapy settings (therapy-settings-card.v1, docs/product/therapy-settings-cards/HANDOFF.md):
 * "Jaką bazę ma Janek?", "Jakie jest ICR o 13:00?", "Pokaż ICR i ISF razem", "Jakie ustawienia obowiązują o 18:30?".
 * Read by code, so the card shows exactly the settings and the hour asked; the model only writes the text under it.
 * Questions about doses, delivered insulin, history, judgements of a setting or what-ifs are not this card.
 */
export const THERAPY_SETTINGS_REQUEST_POLICY = {
  version: 'therapy-settings-request.v1',
  max_question_length: 120,
  /** "A ISF?", "bazę i cel", "ICR i ISF o 7:00": a bare list of settings is a question too. */
  max_bare_words: 6,
  /** A short reply after a settings card ("a o 18?", "a ISF?") asks for the same card with one thing changed. */
  max_follow_up_length: 60,
} as const;

export type TherapySettingKey = 'BASAL' | 'ICR' | 'ISF' | 'TARGET';
export const THERAPY_SETTING_ORDER: TherapySettingKey[] = ['BASAL', 'ICR', 'ISF', 'TARGET'];

export type TherapySettingsLayout = 'OVERVIEW' | 'SINGLE' | 'COMBO' | 'AT_ONE' | 'AT_MANY';

export interface TherapySettingsHour {
  hour: number;
  minute: number;
  /** "o 7" with no part of the day: 7:00 is shown; the card says so when 19:00 has another value. */
  ambiguous: boolean;
}

export type TherapySettingsRequest =
  | {
    kind: 'CARD';
    layout: TherapySettingsLayout;
    /** In the card's order (BASAL, ICR, ISF, TARGET). */
    settings: TherapySettingKey[];
    /** Null: now. */
    at: TherapySettingsHour | null;
  }
  /** Max IOB, max bolus, SMB, autosens…: not in the profile Mellis gets. Answered by code with a fixed text. */
  | { kind: 'NOT_IN_PROFILE' }
  /** "Zmień ICR na 7": settings are changed in the loop. Answered by code with a fixed text. */
  | { kind: 'CHANGE_REQUEST' };

/** The previous answer's settings card, as far as a follow-up needs it. */
export interface TherapySettingsFollowUp {
  settings: TherapySettingKey[];
  /** True when the card showed all four as "ustawienia". */
  all: boolean;
  /** Null: the card was about now. */
  at: { hour: number; minute: number } | null;
}

const SETTING_WORDS: Array<[TherapySettingKey, RegExp]> = [
  ['BASAL', /\b(?:baz(?:a|e|y|ie|ach|ami|om|owa|owe|owej|owy|owych)?|bazal\w*|basal\w*)\b/],
  ['ICR', /\b(?:icr|przelicznik\w*(?!\s+korek)|carb\s+ratio|wspolczynnik\w*\s+weglowodan\w*|weglowodan\w*\s+na\s+(?:jednostk\w*|1\s*j\w*))\b/],
  ['ISF', /\b(?:isf|wrazliwos\w*|korekt\w*|korekcj\w*)\b/],
  ['TARGET', /\b(?:cel|celu|cele|target\w*|docelow\w*)\b/],
];
const ALL_WORDS = /\b(?:ustawien\w*|ustawienia|profil\w*|parametr\w*|nastaw\w*)\b/;

/** Settings that exist in the loop but are not in the Nightscout profile Mellis reads. */
const NOT_IN_PROFILE = /\b(?:max\w*|maks\w*|maksymaln\w*)\s+(?:iob|bolus\w*|baz\w*|basal\w*|cob|smb)\b|\bautosens\w*|\buam\b|\bdynamic\w*\s+isf\b|\bdynamiczn\w*\s+isf\b|\b(?:ustawien\w*|limit\w*)\s+smb\b|\bsmb\s+(?:wlaczon\w*|wylaczon\w*|ustawion\w*)/;
/** Changing a setting, not asking about one. */
const CHANGE = /\b(?:zmien\w*|zmienic|ustaw|ustawcie|ustawic|zwieksz\w*|zmniejsz\w*|podnies\w*|podniesc|obniz(?!a\b)\w*|podwyzsz\w*|wpisz\w*|popraw\w*)\b/;
const WHAT_IF = /\bco\s+(?:jesli|jezeli|gdyby|by)\b|\bgdyby\b|\bjakby\b|\bprzelicz(?!nik)\w*/;
/** Delivered insulin, doses, past values, judgements and definitions: other answers. */
const NOT_THIS_CARD = new RegExp([
  /\b(?:poszl\w*|poszedl|podal\w*|podano|dal[aoy]?|dostal\w*|podawal\w*|zuzy\w*|wlecial\w*|zeszl\w*)\b/.source,
  /\bile\s+(?:bazy|insuliny|na|dac|podac|jednostek)\b|\bna\s+\d+\s*(?:g|gram\w*)\b/.source,
  /\b(?:bolus\w*|dawk\w*|podac|podaj(?!\s+(?:mi\s+)?(?:baz|icr|isf|cel|ustaw|profil|przelicz|wrazliw))\w*|dac|daj)\b/.source,
  /\b(?:byl[aoy]?|wczoraj\w*|przedwczoraj\w*|tydzien|tygodni\w*|miesia\w*|kiedys|poprzedni\w*|historia)\b/.source,
  /\bza\s+(?:wysok|nisk|duz|mal|slab|mocn|agresyw)\w*|\bzbyt\b|\bdlaczego\b|\bczemu\b|\bpo\s+co\b|\bwplyw\w*|\bco\s+to\b|\bczym\s+jest\b|\bco\s+oznacza\w*|\bco\s+znacz\w*|\bjak\s+(?:dziala|liczy|sie\s+liczy|dobrac|ustawic|obliczyc)\b/.source,
  /\b(?:dobrze|dobr[aey]|poprawn\w*|optymaln\w*|sugest\w*|sugeruj\w*|propon\w*|polec\w*|warto|powinn\w*|trzeba|ocen\w*)\b/.source,
  /\b(?:tymczasow\w*|temp|override\w*|nadpisan\w*|tryb\w*)\b/.source,
  /\bw\s+(?:jakim\s+|tym\s+)?celu\b|\bile\s+(?:razy|korekt\w*)\b/.source,
  // Settings of the app, not of the therapy.
  /\b(?:ustawien\w*|profil\w*)\s+(?:w\s+)?(?:powiadomien|alarm|aplikacj|apk|telefon|kont|dostep|mellis|prywatn|jezyk|widzet|widget|zegark|uzytkownik|rodzic|opiekun|nightscout)\w*/.source,
].join('|'));
const ASKS = /\b(?:jak[aiey]\w*|ile\s+wynos\w*|ile\s+ma\b|pokaz\w*|podaj\s+(?:mi\s+)?|wyswietl\w*|przypomnij\w*|sprawdz\w*|obowiazuj\w*|wynosi)\b/;
/** "czy …" asks for a judgement or a yes/no, unless it asks to be shown ("czy możesz pokazać ICR?"). */
const YES_NO = /^(?:a\s+)?czy\b/;

const NIGHT = /\bw\s+nocy\b|\bnoca\b|\bnad\s+ranem\b/;
const MORNING = /\brano\b|\bz\s+rana\b|\bprzed\s+poludniem\b/;
const AFTERNOON = /\bpo\s+poludniu\b|\bpopoludni\w*|\bwieczor\w*|\bwieczorem\b/;

/** The hour a text names ("o 13", "o 13:00", "o 18.30", "o 3 w nocy", "13:00"); null when none. */
export function readSettingsHour(text: string): TherapySettingsHour | null {
  if (/\b(?:o\s+)?polnoc\w*/.test(text) && !/\bdo\s+polnoc/.test(text)) return { hour: 0, minute: 0, ambiguous: false };
  if (/\bw\s+poludnie\b|\bo\s+poludniu\b/.test(text)) return { hour: 12, minute: 0, ambiguous: false };
  const match = text.match(/\bo\s+(?:godz(?:inie|\.)?\s+)?(\d{1,2})(?:[:.](\d{2}))?(?![\d,]|\s*(?:g\b|gram|j\b|jedn|mg|%|min|dni|godzin|razy|proc))/)
    ?? text.match(/(?:^|\s)(\d{1,2})[:.](\d{2})\b(?!\s*(?:g\b|j\b|jedn|mg))/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return null;
  if (hour === 24) hour = 0;
  const night = NIGHT.test(text);
  const afternoon = AFTERNOON.test(text);
  const morning = MORNING.test(text);
  if (hour >= 1 && hour <= 12) {
    if (night) return { hour: hour === 12 ? 0 : hour >= 7 ? hour + 12 : hour, minute, ambiguous: false };
    if (afternoon && hour < 12) return { hour: hour + 12, minute, ambiguous: false };
    if (morning) return { hour, minute, ambiguous: false };
    // "o 7:30" with minutes is read as written as well, but an hour alone is how people say both 7 and 19.
    return { hour, minute, ambiguous: hour < 12 && !match[2] };
  }
  return { hour, minute, ambiguous: false };
}

function settingsIn(text: string): TherapySettingKey[] {
  return THERAPY_SETTING_ORDER.filter((key) => SETTING_WORDS.find(([candidate]) => candidate === key)![1].test(text));
}

function layoutOf(settings: TherapySettingKey[], all: boolean, at: TherapySettingsHour | null): TherapySettingsLayout {
  if (at) return !all && settings.length === 1 ? 'AT_ONE' : 'AT_MANY';
  if (all || settings.length === 4) return 'OVERVIEW';
  return settings.length === 1 ? 'SINGLE' : 'COMBO';
}

/**
 * What a chat message asks about the therapy settings, or null for any other message. `followUp` is the previous
 * answer's settings card, when the message replies to one.
 */
export function readTherapySettingsRequest(question: string, followUp: TherapySettingsFollowUp | null = null): TherapySettingsRequest | null {
  const text = plainText(question);
  if (!text || text.length > THERAPY_SETTINGS_REQUEST_POLICY.max_question_length) return null;
  const named = settingsIn(text);
  const all = ALL_WORDS.test(text);
  const words = text.split(/[^a-z0-9:.]+/).filter(Boolean);

  if (NOT_IN_PROFILE.test(text) && (ASKS.test(text) || words.length <= THERAPY_SETTINGS_REQUEST_POLICY.max_bare_words)) return { kind: 'NOT_IN_PROFILE' };
  if (named.length === 0 && !all && !followUp) return null;
  if (WHAT_IF.test(text)) return null;
  // "Zmień ICR na 7" is answered; "jak zmienić…" is a how-to question for the model.
  // "Czy ISF 140 zmniejszy spadki?" asks for a judgement; only "czy możesz zmienić…" stays a request.
  if (CHANGE.test(text)) {
    const judgement = YES_NO.test(text) && !/^(?:a\s+)?czy\s+(?:mo[zg]\w*|da\s+sie)\b/.test(text);
    return (named.length > 0 || all) && !judgement && !/\bjak\b/.test(text) && !NOT_THIS_CARD.test(text) ? { kind: 'CHANGE_REQUEST' } : null;
  }
  if (NOT_THIS_CARD.test(text)) return null;

  const at = readSettingsHour(text);
  const isFollowUp = followUp !== null && text.length <= THERAPY_SETTINGS_REQUEST_POLICY.max_follow_up_length;
  // "a o 18?", "a w nocy o 3?": the previous card's settings at another hour.
  if (named.length === 0 && !all) {
    if (!isFollowUp || !at) return null;
    return { kind: 'CARD', layout: layoutOf(followUp.settings, followUp.all, at), settings: followUp.settings, at };
  }

  const asks = (ASKS.test(text) && !YES_NO.test(text)) || (YES_NO.test(text) && /\bpokaz\w*|\bpodac\s+(?:mi\s+)?(?:jak|ile)\b/.test(text))
    || words.length <= THERAPY_SETTINGS_REQUEST_POLICY.max_bare_words;
  if (!asks) return null;

  const settings = all ? [...THERAPY_SETTING_ORDER] : named;
  // "a ISF?" after a card about 13:00 is the ISF at 13:00.
  const hour = at ?? (isFollowUp && followUp.at ? { ...followUp.at, ambiguous: false } : null);
  return { kind: 'CARD', layout: layoutOf(settings, all, hour), settings, at: hour };
}

/** The fixed reply to a setting the profile does not hold; `loop`: the loop's name in its forms ("z Trio", "w Loopie"). */
export function notInProfileReply(loop: { genitive: string; locative: string }): string {
  return `Tego ustawienia Mellis nie dostaje z ${loop.genitive}. Sprawdź je w ${loop.locative}. Mellis widzi bazę, ICR, ISF, cel i czas działania insuliny.`;
}

/** The fixed reply to a request to change a setting. */
export function changeRequestReply(loop: { locative: string }): string {
  return `Ustawienia zmienia się w ${loop.locative}.`;
}

/**
 * The settings card of the conversation's last answer before `userMessageId` (or before all of `messages`), as a
 * follow-up reads it; null when that answer had none.
 */
export function previousTherapySettingsCard(messages: Array<Record<string, unknown>>, userMessageId?: string): TherapySettingsFollowUp | null {
  const end = userMessageId ? messages.findIndex((message) => String(message.id) === userMessageId) : messages.length;
  const before = messages.slice(0, end < 0 ? messages.length : end);
  const answer = [...before].reverse().find((message) => String(message.role ?? '').toUpperCase() === 'ASSISTANT');
  const card = (answer?.metadata as Record<string, unknown> | null | undefined)?.metric_card as Record<string, unknown> | undefined;
  if (card?.kind !== 'THERAPY_SETTINGS') return null;
  const therapy = card.therapy as Record<string, unknown> | undefined;
  if (!therapy || !Array.isArray(therapy.settings)) return null;
  const settings = THERAPY_SETTING_ORDER.filter((key) => (therapy.settings as Array<Record<string, unknown>>).some((lane) => lane?.key === key));
  if (settings.length === 0) return null;
  const at = typeof therapy.at === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(therapy.at) : null;
  return {
    settings,
    all: therapy.layout === 'OVERVIEW' || (therapy.layout === 'AT_MANY' && settings.length === 4),
    at: therapy.is_now === false && at ? { hour: Number(at[1]), minute: Number(at[2]) } : null,
  };
}
