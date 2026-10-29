/**
 * answer-push-text.v1: the push that says GlucoMind's answer is ready. The body is the answer's beginning as plain text
 * (Markdown marks, links and emoji bullets dropped, lines joined), cut at a word near ANSWER_PUSH_BODY_MAX_CHARS. The
 * lock screen shows about four lines; the whole answer is one tap away.
 */
export const ANSWER_READY_PUSH_TITLE = 'Odpowiedź gotowa';
export const ANSWER_FAILED_PUSH_TITLE = 'Nie udało się odpowiedzieć';
export const ANSWER_FAILED_PUSH_BODY = 'Nie mogę teraz przygotować odpowiedzi. Otwórz rozmowę i spróbuj ponownie.';
export const ANSWER_READY_FALLBACK_BODY = 'Otwórz rozmowę, aby ją przeczytać.';
export const ANSWER_PUSH_BODY_MAX_CHARS = 160;

export function answerPushBody(content: string, maxChars = ANSWER_PUSH_BODY_MAX_CHARS): string {
  const plain = content
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
  if (!plain) return ANSWER_READY_FALLBACK_BODY;
  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace >= maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s,;:–—-]+$/, '')}…`;
}
