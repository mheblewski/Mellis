import { describe, expect, it } from 'vitest';
import { needsTerazSiteRules, TERAZ_SITE_RULES } from './ai-gateway.service';

const context = (...contents: string[]) => ({ conversation_context: { messages: contents.map((content) => ({ content })) } });

describe('site rules for a conversation from Teraz', () => {
  it('apply only to a conversation seeded with a suspected site', () => {
    expect(needsTerazSiteRules(context('Z ekranu Teraz, 12:40. Glukoza 284 mg/dL. Od 2 godzin glukoza jest powyżej 250. Warto sprawdzić wkłucie i zmierzyć ketony.'))).toBe(true);
    expect(needsTerazSiteRules(context('Z ekranu Teraz, 12:40. Glukoza 66 mg/dL. Glukoza jest poniżej 70.'))).toBe(false);
    expect(needsTerazSiteRules(context('Warto sprawdzić wkłucie?'))).toBe(false);
    expect(needsTerazSiteRules({})).toBe(false);
  });

  it('say what the diabetologist asked for', () => {
    for (const rule of ['1.5 mmol/l', 'vomiting', 'doctor', 'pen', 'site change', 'correction']) expect(TERAZ_SITE_RULES).toContain(rule);
  });
});
