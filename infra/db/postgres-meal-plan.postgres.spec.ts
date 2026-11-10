import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresMealPlanRepository } from './postgres-meal-plan.repository';
import { PostgresMealPlanChatRepository } from './postgres-meal-plan-chat.repository';
import { configurePostgresIntegrationEnvironment, truncatePublicTablesForIntegrationTests } from './postgres-test-isolation';

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe.sequential : describe.skip;

configurePostgresIntegrationEnvironment(process.env);

// Migration 103: a planned meal stays out of everything that reads meals, and each push is claimed once.
describePostgres('meal plan (PostgreSQL)', () => {
  let pool: Pool;
  let repository: PostgresMealPlanRepository;
  const now = new Date('2026-11-10T11:00:00.000Z');
  const meal = (time: string) => ({ kind: 'MEAL' as const, title: 'Obiad', planned_at: `2026-11-10T${time}:00.000Z`, items: [{ name: 'Ziemniaki', carbs_g: 26, protein_g: null, fat_g: null }] });

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    repository = new PostgresMealPlanRepository(pool);
  });
  beforeEach(() => truncatePublicTablesForIntegrationTests(pool));
  afterAll(async () => {
    await truncatePublicTablesForIntegrationTests(pool);
    await pool?.end();
  });

  async function patient(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO patients (id, display_name) VALUES ($1::uuid, 'p')`, [id]);
    return id;
  }

  it('stores a plan and lists it without touching meal records or events', async () => {
    const id = await patient();
    const plan = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30'), { ...meal('14:00'), kind: 'MOVEMENT', title: 'WF', items: [] }] });
    const listed = await repository.listBetween(id, '2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z');
    expect(listed.map((entry) => entry.title)).toEqual(['Obiad', 'WF']);
    expect(listed[0].items[0].carbs_g).toBe(26);
    expect(listed[0].lead_minutes).toBe(20);
    expect(plan.entries).toHaveLength(2);
    const counts = await pool.query(`SELECT (SELECT count(*) FROM meal_records WHERE patient_id = $1::uuid)::int AS meals, (SELECT count(*) FROM events WHERE patient_id = $1::uuid)::int AS events`, [id]);
    expect(counts.rows[0]).toEqual({ meals: 0, events: 0 });
  });

  it('skips, removes and restores one entry; removed entries leave the list', async () => {
    const id = await patient();
    const { entries } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30')] });
    expect((await repository.setStatus(id, entries[0].id, 'SKIPPED', null))?.status).toBe('SKIPPED');
    expect(await repository.listPushCandidates(now, 120, 60)).toEqual([]);
    await repository.setStatus(id, entries[0].id, 'REMOVED', null);
    expect(await repository.listBetween(id, '2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z')).toEqual([]);
    await repository.setStatus(id, entries[0].id, 'PLANNED', null);
    expect(await repository.listBetween(id, '2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z')).toHaveLength(1);
  });

  it('does not change another patient\'s entry', async () => {
    const id = await patient();
    const other = await patient();
    const { entries } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30')] });
    expect(await repository.setStatus(other, entries[0].id, 'REMOVED', null)).toBeNull();
    expect((await repository.getEntry(id, entries[0].id))?.status).toBe('PLANNED');
  });

  it('removes only what is still to come', async () => {
    const id = await patient();
    const { plan_id } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('10:00'), meal('11:30')] });
    expect(await repository.removePlan(id, plan_id, null, now)).toBe(1);
    const left = await repository.listBetween(id, '2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z');
    expect(left.map((entry) => entry.planned_at)).toEqual(['2026-11-10T10:00:00.000Z']);
  });

  it('claims each push once and lists only what may still need one', async () => {
    const id = await patient();
    const { entries } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30'), { ...meal('20:00'), title: 'Kolacja' }] });
    const candidates = await repository.listPushCandidates(now, 120, 60);
    expect(candidates.map((entry) => entry.title)).toEqual(['Obiad']);
    await expect(repository.claimReminder(entries[0].id, now)).resolves.toBe(true);
    await expect(repository.claimReminder(entries[0].id, now)).resolves.toBe(false);
    await expect(repository.claimMissed(entries[0].id, now)).resolves.toBe(true);
    await expect(repository.claimMissed(entries[0].id, now)).resolves.toBe(false);
    expect(await repository.listPushCandidates(now, 120, 60)).toEqual([]);
  });

  it('carries the phone switch default', async () => {
    const column = await pool.query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'patient_devices' AND column_name = 'meal_plan_push_enabled'`);
    expect(column.rows[0].column_default).toBe('true');
  });

  describe('cards read in chat (migration 104)', () => {
    const TZ = 'Europe/Warsaw';
    const proposal = (title = 'Obiad') => ({ lead_minutes: 20, macros_source: 'FILE' as const, times_to_check: [], rules_to_remember: ['Owoc dają na wynos.'], applied_rules: [], unread: [], entries: [{ kind: 'MEAL' as const, title, date: '2026-11-10', time: '12:30', items: [] }] });
    const planOf = (title = 'Obiad') => ({ lead_minutes: 20, entries: [{ ...meal('11:30'), title }] });
    const keys = (title = 'obiad') => [{ kind: 'MEAL', title, date: '2026-11-10' }];
    const beforeMeal = new Date('2026-11-09T10:00:00.000Z');

    async function card(patientId: string, conversationId = randomUUID(), userMessageId = randomUUID()) {
      return repository.insertProposal({ patientId, conversationId, userMessageId, proposal: proposal() });
    }
    const accept = (patientId: string, record: { id: string; conversation_id: string }, title = 'Obiad') => repository.acceptProposal({
      patientId, conversationId: record.conversation_id, proposalId: record.id, userId: null, plan: planOf(title), skippedPast: 0, replacedKeys: keys(title.toLowerCase()), now: beforeMeal, timeZone: TZ,
    });

    it('stores nothing in the plan until the card is confirmed, once whoever is first', async () => {
      const id = await patient();
      const record = await card(id);
      expect(await repository.listBetween(id, '2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z')).toEqual([]);
      const first = await accept(id, record);
      expect(first.status).toBe('ACCEPTED');
      expect(first.proposal?.plan_id).toBeTruthy();
      const second = await accept(id, record);
      expect(second.status).toBe('ALREADY_ACCEPTED');
      expect(await repository.listBetween(id, '2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z')).toHaveLength(1);
    });

    it('a newer card replaces the open one, and a replaced card cannot be confirmed', async () => {
      const id = await patient();
      const conversation = randomUUID();
      const older = await card(id, conversation);
      const newer = await card(id, conversation);
      const listed = await repository.listProposalsForConversation(id, conversation);
      expect(listed.map((row) => row.status)).toEqual(['SUPERSEDED', 'PROPOSED']);
      expect((await accept(id, older)).status).toBe('NOT_OPEN');
      expect((await accept(id, newer)).status).toBe('ACCEPTED');
    });

    it('a failed attempt\'s card disappears', async () => {
      const id = await patient();
      const record = await card(id);
      await repository.discardForUserMessage(id, record.user_message_id);
      expect(await repository.listProposalsForConversation(id, record.conversation_id)).toEqual([]);
      expect(await repository.getProposal(id, record.conversation_id, record.id)).toBeNull();
    });

    it('replaces the same title on the same day only, so activities added later keep the meals', async () => {
      const id = await patient();
      await accept(id, await card(id), 'Obiad');
      expect(await repository.countReplaced(id, keys('obiad'), beforeMeal, TZ)).toBe(1);
      expect(await repository.countReplaced(id, keys('kolacja'), beforeMeal, TZ)).toBe(0);
      await accept(id, await card(id), 'Kolacja');
      await accept(id, await card(id), 'Obiad');
      const titles = (await repository.listBetween(id, '2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z')).map((entry) => entry.title).sort();
      expect(titles).toEqual(['Kolacja', 'Obiad']);
    });

    it('reads earlier times and the names of phones with the switch on', async () => {
      const id = await patient();
      await accept(id, await card(id));
      const times = await repository.listEarlierTimes(id);
      expect(times.map((row) => row.title)).toEqual(['Obiad']);
      expect(await repository.patientName(id)).toBe('p');
      expect(await repository.listReminderRecipients(id)).toEqual([]);
    });

    it('remembers a card\'s rules once, for all caregivers, and forgets them on request', async () => {
      const id = await patient();
      const record = await card(id);
      const remembered = await repository.rememberProposalRules(id, record.conversation_id, record.id, null);
      expect(remembered?.rules_remembered).toBe(true);
      await repository.rememberProposalRules(id, record.conversation_id, record.id, null);
      const notes = await repository.listNotes(id, 'PLAN_RULE');
      expect(notes.map((note) => note.text)).toEqual(['Owoc dają na wynos.']);
      expect(await repository.updateNoteText(id, notes[0].id, 'Owoce na wynos.')).toBe(true);
      expect((await repository.listNotes(id))[0].text).toBe('Owoce na wynos.');
      expect(await repository.removeNote(id, notes[0].id)).toBe(true);
      expect(await repository.listNotes(id)).toEqual([]);
      expect(await repository.removeNote(id, notes[0].id)).toBe(false);
    });

    it('keeps a food note\'s food and portion', async () => {
      const id = await patient();
      await repository.addNote(id, { kind: 'FOOD', text: 'Zwykle zostaje na talerzu: Buraczki', food_name: 'Buraczki', portion: 'NONE' }, null);
      await repository.addNote(id, { kind: 'FOOD', text: 'Zwykle zostaje na talerzu: Buraczki', food_name: 'Buraczki', portion: 'NONE' }, null);
      const [note, ...rest] = await repository.listNotes(id, 'FOOD');
      expect(rest).toEqual([]);
      expect(note).toMatchObject({ food_name: 'Buraczki', portion: 'NONE' });
    });

    it('stores the answers about the dose and the meal, and each question is claimed once', async () => {
      const id = await patient();
      const { entries } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30')] });
      const entry = entries[0];
      expect((await repository.setDoseAnswer(id, entry.id, 'THIS_MEAL', null))?.dose_answer).toBe('THIS_MEAL');
      expect((await repository.setDoseAnswer(id, entry.id, null, null))?.dose_answer).toBeNull();
      const asked = new Date('2026-11-10T12:00:00.000Z');
      expect(await repository.claimEatenAsk(entry.id, asked, false)).toBe(true);
      expect(await repository.claimEatenAsk(entry.id, asked, false)).toBe(false);
      expect(await repository.claimEatenAsk(entry.id, asked, true)).toBe(true);
      const answered = await repository.setEatenAnswer(id, entry.id, 'UNKNOWN', null, asked);
      expect(answered).toMatchObject({ eaten_answer: 'UNKNOWN', eaten_answered_at: asked.toISOString() });
      expect((await repository.listEatenCandidates(asked, 90)).map((row) => row.id)).toEqual([entry.id]);
      expect(await repository.listEatenCandidates(new Date('2026-11-10T14:00:00.000Z'), 90)).toEqual([]);
    });

    it('finds an activity only in its last half hour, until its push', async () => {
      const id = await patient();
      const { entries } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [{ kind: 'MOVEMENT', title: 'WF', planned_at: '2026-11-10T13:45:00.000Z', items: [] }, meal('13:40')] });
      const movement = entries.find((entry) => entry.kind === 'MOVEMENT')!;
      expect(await repository.listMovementCandidates(new Date('2026-11-10T13:00:00.000Z'), 30)).toEqual([]);
      const soon = new Date('2026-11-10T13:20:00.000Z');
      expect((await repository.listMovementCandidates(soon, 30)).map((row) => row.id)).toEqual([movement.id]);
      expect(await repository.claimReminder(movement.id, soon)).toBe(true);
      expect(await repository.listMovementCandidates(soon, 30)).toEqual([]);
    });

    it('a note the chat offers stays out until confirmed, and is not offered twice', async () => {
      const id = await patient();
      const message = randomUUID();
      const note = { text: 'Zwykle zostaje na talerzu: Buraczki', food_name: 'Buraczki', portion: 'NONE' as const };
      expect((await repository.offerFoodNote({ patientId: id, userMessageId: message, note })).status).toBe('OFFERED');
      expect(await repository.listNotes(id)).toEqual([]);
      const [offered] = await repository.listOfferedNotes(id, [message]);
      expect(offered.confirmed_at).toBeNull();
      expect(await repository.confirmNote(id, offered.id, null)).toBe(true);
      expect((await repository.listNotes(id)).map((row) => row.text)).toEqual([note.text]);
      expect((await repository.offerFoodNote({ patientId: id, userMessageId: randomUUID(), note })).status).toBe('ALREADY_REMEMBERED');
    });

    it('moves a meal and starts its pushes over', async () => {
      const id = await patient();
      const { entries } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30')] });
      await repository.claimReminder(entries[0].id, beforeMeal);
      const moved = await repository.setPlannedAt(id, entries[0].id, '2026-11-11T12:00:00.000Z', null);
      expect(moved).toMatchObject({ planned_at: '2026-11-11T12:00:00.000Z', reminder_sent_at: null });
    });

    it('pauses what is to come and takes back only the pause', async () => {
      const id = await patient();
      const { entries } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30'), meal('12:30'), { ...meal('13:30'), planned_at: '2026-11-20T13:30:00.000Z' }] });
      await repository.setStatus(id, entries[0].id, 'SKIPPED', null);
      expect(await repository.pausePlan(id, '2026-11-12T00:00:00.000Z', null, beforeMeal)).toBe(1);
      expect(await repository.resumePlan(id, null, beforeMeal)).toBe(1);
      const rows = await repository.listBetween(id, '2026-11-10T00:00:00.000Z', '2026-11-30T00:00:00.000Z');
      expect(rows.map((row) => row.status)).toEqual(['SKIPPED', 'PLANNED', 'PLANNED']);
    });

    it('knows which entries exist, for "Dodaj tylko nowe"', async () => {
      const id = await patient();
      await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30')] });
      const keys = await repository.listExistingKeys(id, [{ kind: 'MEAL', title: 'obiad', date: '2026-11-10' }, { kind: 'MEAL', title: 'kolacja', date: '2026-11-10' }], beforeMeal, TZ);
      expect([...keys]).toEqual(['MEAL|obiad|2026-11-10']);
    });
  });
  // Migration 110: the planned meal's chat, its accepted change and the shared plate.
  it('keeps a planned meal\'s chat, replaces its dishes once accepted and shares its plate', async () => {
    const chat = new PostgresMealPlanChatRepository(pool);
    const id = await patient();
    const { entries } = await repository.createPlan(id, null, { lead_minutes: 20, entries: [meal('11:30')] });
    const entryId = entries[0].id;
    expect(entries[0].plate).toBeNull();
    expect(entries[0].menu_changed).toBe(false);

    const withPlate = await repository.setPlate(id, entryId, { foods: { Ziemniaki: { portion: { half: {} } } } }, null);
    expect(withPlate?.plate).toEqual({ foods: { Ziemniaki: { portion: { half: {} } } } });
    expect(await repository.setPlate(await patient(), entryId, {}, null)).toBeNull();

    const sent = await chat.insertUserMessage({ patientId: id, entryId, content: 'zamiast ziemniaków ryż', plateSummary: 'Ziemniaki (połowa) 13 g', authorUserId: null, idempotencyKey: 'k1' });
    const again = await chat.insertUserMessage({ patientId: id, entryId, content: 'zamiast ziemniaków ryż', plateSummary: null, authorUserId: null, idempotencyKey: 'k1' });
    expect(again.id).toBe(sent.id);
    expect(sent.plate_summary).toBe('Ziemniaki (połowa) 13 g');
    expect(await chat.hasReply(entryId, sent.id)).toBe(false);
    const photoId = await chat.insertPhoto({ patientId: id, entryId, contentType: 'image/jpeg', byteSize: 4, sha256: 'x', userId: null });
    expect(await chat.countPhotosOfEntry(id, entryId, [photoId])).toBe(1);
    expect(await chat.countPhotosOfEntry(await patient(), entryId, [photoId])).toBe(0);
    expect((await chat.getPhoto(id, entryId, photoId))?.content_type).toBe('image/jpeg');
    const withPhoto = await chat.insertUserMessage({ patientId: id, entryId, content: '', photoIds: [photoId], plateSummary: null, authorUserId: null, idempotencyKey: 'k-photo' });
    expect(withPhoto.photo_ids).toEqual([photoId]);
    const proposal = { items: [{ name: 'Ryż', grams: 100, carbs_g: 28, protein_g: 2.5, fat_g: 0.3, source: 'ESTIMATE' as const }], carbs_g: 28, protein_g: 2.5, fat_g: 0.3, confidence: 'MEDIUM' as const, assumptions: '', proposal_id: null };
    await chat.insertAssistantMessage({ patientId: id, entryId, replyToMessageId: sent.id, content: 'Zamieniam.', question: null, proposal });
    await chat.insertAssistantMessage({ patientId: id, entryId, replyToMessageId: sent.id, content: 'Drugi raz.', question: null, proposal: null });
    const messages = await chat.listMessages(id, entryId);
    expect(messages.map((message) => message.role)).toEqual(['USER', 'USER', 'ASSISTANT']);
    const reply = messages.find((message) => message.role === 'ASSISTANT')!;
    expect(reply.proposal?.carbs_g).toBe(28);

    const changed = await repository.replaceItems(id, entryId, [{ name: 'Ryż 100 g', carbs_g: 28, protein_g: 2.5, fat_g: 0.3 }], null);
    expect(changed?.items.map((item) => item.name)).toEqual(['Ryż 100 g']);
    expect(changed?.menu_changed).toBe(true);
    expect(changed?.plate).toEqual({});
    await chat.markAccepted(entryId, reply.id);
    expect((await chat.getMessage(id, entryId, reply.id))?.accepted_at).not.toBeNull();
    // The menu's own dishes are kept from the first change on.
    await repository.replaceItems(id, entryId, [{ name: 'Kasza', carbs_g: 20, protein_g: null, fat_g: null }], null);
    const menu = await pool.query(`SELECT menu_items FROM meal_plan_entries WHERE id = $1::uuid`, [entryId]);
    expect(menu.rows[0].menu_items[0].name).toBe('Ziemniaki');

    await repository.setStatus(id, entryId, 'SKIPPED', null);
    expect(await repository.replaceItems(id, entryId, [{ name: 'Ryż', carbs_g: 28, protein_g: null, fat_g: null }], null)).toBeNull();
  });
});
