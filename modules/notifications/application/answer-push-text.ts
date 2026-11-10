/**
 * answer-push-text.v1: the push that says GlucoMind's answer is ready. The body is the answer's beginning as plain text
 * (Markdown marks, links and emoji bullets dropped, lines joined), cut at a word near ANSWER_PUSH_BODY_MAX_CHARS. The
 * lock screen shows about four lines; the whole answer is one tap away.
 */
export const ANSWER_READY_PUSH_TITLE = 'Odpowiedź gotowa';
export const ANSWER_FAILED_PUSH_TITLE = 'Nie udało się odpowiedzieć';
export const ANSWER_FAILED_PUSH_BODY = 'Mellis nie może teraz odpowiedzieć. Otwórz rozmowę i spróbuj ponownie.';
export const ANSWER_READY_FALLBACK_BODY = 'Dotknij, aby przeczytać odpowiedź.';
export const ANSWER_PUSH_BODY_MAX_CHARS = 160;

/** The clarifying-question push (F1): the question's beginning, or the fallback when there is no text. */
export const QUESTION_PUSH_TITLE = 'Pytanie od Mellis';
export const QUESTION_PUSH_FALLBACK_BODY = 'Odpowiedz w rozmowie, a Mellis dokończy analizę.';
export const QUESTION_PUSH_BODY_MAX_CHARS = 120;

/** A dose in the text: a number with "j" or "g" as its unit ("2 j", "1,5 j", "15 g", "2j"). */
const DOSE_PATTERN = /\d+(?:[.,]\d+)?\s?[jg](?![\p{L}\d])/u;

/**
 * The answer's beginning, unless it names a dose: then the plain "Dotknij…" line, so the lock screen never shows a dose
 * (possibly cut) out of its context. The check covers a few characters past the cut, so a dose split by it counts too.
 */
export function answerPushBody(content: string, maxChars = ANSWER_PUSH_BODY_MAX_CHARS): string {
  const plain = plainPushText(content);
  if (!plain) return ANSWER_READY_FALLBACK_BODY;
  if (DOSE_PATTERN.test(plain.slice(0, maxChars + 8))) return ANSWER_READY_FALLBACK_BODY;
  return cutAtWord(plain, maxChars);
}

export function questionPushBody(questionText: unknown, maxChars = QUESTION_PUSH_BODY_MAX_CHARS): string {
  const plain = typeof questionText === 'string' ? plainPushText(questionText) : '';
  return plain ? cutAtWord(plain, maxChars) : QUESTION_PUSH_FALLBACK_BODY;
}

function plainPushText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cutAtWord(plain: string, maxChars: number): string {
  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace >= maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s,;:–—-]+$/, '')}…`;
}
