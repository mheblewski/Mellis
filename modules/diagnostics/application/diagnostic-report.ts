import { isDiagnosticCode } from './diagnostic-events';

/** Everything below is already free of names, addresses, keys, doses and readings; only codes, counts and times. */
export interface DiagnosticPatientFacts {
  loop_kind: string;
  loop_version: string | null;
  profile_timezone: string | null;
  source: { enabled: boolean; has_token: boolean; auth_mode: string | null; version: string | null; last_observed_at: string | null; credentials_updated_at: string | null } | null;
  newest_by_type: Array<{ type: string; at: string }>;
}

export interface DiagnosticDeviceFacts {
  /** One line per phone, however many patients it is registered for. */
  phones: Array<{ platform: string; app_version: string | null; patients: number; active: boolean; last_seen_at: string | null }>;
  paired_devices: { active: number; revoked: number; newest_seen_at: string | null };
  watches: { active: number; newest_used_at: string | null };
}

export interface DiagnosticCountRow { name: string; count: number }

export interface DiagnosticCommandFacts {
  by_status: DiagnosticCountRow[];
  /** Newest first. Times only: never the dose, the carbs, Trio's message or the signature. */
  recent: Array<{ source: string; status: string; authorized_at: string; sent_at: string | null; answered_at: string | null; matched_at: string | null }>;
}

export interface DiagnosticAiRow {
  provider: string;
  model: string;
  task_type: string;
  status: string;
  error_code: string | null;
  attempts: number;
  p50_ms: number | null;
  p95_ms: number | null;
  tokens: number | null;
}

export interface DiagnosticJobRow { job_type: string; status: string; count: number; oldest_at: string | null; max_attempts: number | null }

export interface DiagnosticEventTotal { level: string; event: string; count: number; last_at: string }

export interface DiagnosticTimelineRow {
  source: string;
  level: string;
  event: string;
  fields: Record<string, unknown>;
  count: number;
  first_at: string;
  last_at: string;
  duration_ms_max: number | null;
}

export interface DiagnosticReportStore {
  newestMigration(): Promise<string | null>;
  patients(): Promise<DiagnosticPatientFacts[]>;
  devices(): Promise<DiagnosticDeviceFacts>;
  pushFacts(since: string): Promise<{ outbox_open: number; outbox_errors: DiagnosticCountRow[]; notifications: DiagnosticCountRow[] }>;
  commands(since: string): Promise<DiagnosticCommandFacts>;
  ai(since: string): Promise<DiagnosticAiRow[]>;
  jobs(since: string): Promise<DiagnosticJobRow[]>;
  eventTotals(since: string): Promise<DiagnosticEventTotal[]>;
  /** Warnings and errors since `problemsSince`, and everything since `recentSince`; newest first, at most `limit`. */
  timeline(problemsSince: string, recentSince: string, limit: number): Promise<DiagnosticTimelineRow[]>;
}

const DAY_MS = 24 * 3_600_000;
export const DIAGNOSTIC_TIMELINE_LIMIT = 300;

const yesNo = (value: boolean): string => (value ? 'tak' : 'nie');

/** A value from a database or the environment, printed only when it has the shape of a code. */
function code(value: unknown): string {
  return isDiagnosticCode(value) ? value : '?';
}

function zone(value: string | null): string {
  return value && /^[A-Za-z0-9_+\-/]{1,64}$/.test(value) ? value : '?';
}

function age(iso: string | null, now: Date): string {
  if (!iso) return 'nigdy';
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 0) return `za ${-minutes} min`;
  if (minutes < 120) return `${minutes} min temu`;
  if (minutes < 2880) return `${Math.round(minutes / 60)} h temu`;
  return `${Math.round(minutes / 1440)} dni temu`;
}

const counts = (rows: DiagnosticCountRow[]): string => (rows.length === 0 ? 'brak' : rows.map((row) => `${code(row.name)} ${row.count}`).join(', '));

/** Each part stands alone: a query that fails leaves a note in the report, and the rest is still there. */
async function part(lines: string[], title: string, build: () => Promise<string[]>): Promise<void> {
  lines.push('', title);
  try {
    lines.push(...await build());
  } catch (error) {
    lines.push(`  (nie udało się odczytać: ${code(error instanceof Error ? (error as Error & { code?: unknown }).code ?? error.name : 'UNKNOWN')})`);
  }
}

/** The server's half of the report: plain text the person reads before sending it. Polish labels, codes as they are. */
export async function buildDiagnosticReport(store: DiagnosticReportStore, env: NodeJS.ProcessEnv, now: Date = new Date(), uptimeSeconds: number | null = process.uptime()): Promise<string> {
  const since = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
  const flag = (name: string): string => code((env[name] ?? '').trim() || 'brak');
  const lines: string[] = [`RAPORT SERWERA (${now.toISOString()})`];

  await part(lines, 'SERWER', async () => [
    `  Wersja: ${code(env.MELLIS_VERSION?.trim() || 'brak')} · ostatnia migracja: ${code((await store.newestMigration())?.replace(/\.sql$/, ''))} · Node ${code(process.version)} ${uptimeSeconds === null ? '' : ` · działa od ${Math.round(uptimeSeconds / 60)} min`}`,
    `  Logowanie: ${flag('AUTH_MODE')} · AI: ${flag('AI_PROVIDER')} · klucz OpenAI: ${yesNo(!!env.OPENAI_API_KEY?.trim())} · klucz Anthropic: ${yesNo(!!env.ANTHROPIC_API_KEY?.trim())} · głos na serwerze: ${flag('VOICE_TRANSCRIPTION_ENABLED')}`,
    `  Powiadomienia: ${flag('PUSH_PROVIDER')} · sandbox: ${flag('APNS_USE_SANDBOX')} · zdalne polecenia: ${flag('REMOTE_COMMANDS_ENABLED')} · pobieranie z Nightscouta: ${flag('NIGHTSCOUT_SYNC_ENABLED')}`,
    `  Strefa czasowa procesu: ${zone(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
  ]);

  await part(lines, 'PODOPIECZNI', async () => {
    const patients = await store.patients();
    if (patients.length === 0) return ['  brak'];
    return patients.flatMap((patient, index) => {
      const source = patient.source;
      return [
        `  Podopieczny ${index + 1}: pętla ${code(patient.loop_kind)}${patient.loop_version ? ` ${code(patient.loop_version)}` : ''} · strefa profilu ${zone(patient.profile_timezone)}`,
        source
          ? `    Nightscout: włączony ${yesNo(source.enabled)}, token ${yesNo(source.has_token)}, sposób ${code(source.auth_mode ?? 'brak')}, wersja ${code(source.version ?? 'brak')}, ostatnie dane ${age(source.last_observed_at, now)}, token zmieniony ${age(source.credentials_updated_at, now)}`
          : '    Nightscout: brak źródła',
        `    Najnowsze wpisy: ${patient.newest_by_type.length === 0 ? 'brak' : patient.newest_by_type.map((row) => `${code(row.type)} ${age(row.at, now)}`).join(', ')}`,
      ];
    });
  });

  await part(lines, 'TELEFONY I ZEGARKI', async () => {
    const facts = await store.devices();
    return [
      ...facts.phones.map((phone, index) => `  Telefon ${index + 1}: ${code(phone.platform)}, wersja ${code(phone.app_version?.replace(/[ ()·]+/g, '_').replace(/_+$/, '') ?? 'brak')}, podopiecznych ${phone.patients}, aktywny ${yesNo(phone.active)}, ostatnio ${age(phone.last_seen_at, now)}`),
      `  Połączone urządzenia: aktywne ${facts.paired_devices.active}, odłączone ${facts.paired_devices.revoked}, ostatnio ${age(facts.paired_devices.newest_seen_at, now)}`,
      `  Zegarki: aktywne ${facts.watches.active}, ostatnio ${age(facts.watches.newest_used_at, now)}`,
    ];
  });

  await part(lines, 'POWIADOMIENIA (7 dni)', async () => {
    const facts = await store.pushFacts(since(7));
    return [
      `  Czekają na ponowienie: ${facts.outbox_open}`,
      `  Błędy kolejki: ${counts(facts.outbox_errors)}`,
      `  Stany powiadomień: ${counts(facts.notifications)}`,
    ];
  });

  await part(lines, 'ZDALNE POLECENIA (30 dni, bez dawek)', async () => {
    const facts = await store.commands(since(30));
    return [
      `  Stany: ${counts(facts.by_status)}`,
      ...facts.recent.map((command) => `  ${command.authorized_at} ${code(command.source)} → ${code(command.status)} (wysłano ${command.sent_at ?? '-'}, odpowiedź ${command.answered_at ?? '-'}, dopasowano ${command.matched_at ?? '-'})`),
    ];
  });

  await part(lines, 'ZADANIA W TLE (24 h)', async () => {
    const rows = await store.jobs(since(1));
    if (rows.length === 0) return ['  brak'];
    return rows.map((row) => `  ${code(row.job_type)} ${code(row.status)}: ${row.count}, najstarsze ${age(row.oldest_at, now)}, najwięcej prób ${row.max_attempts ?? 0}`);
  });

  await part(lines, 'AI (7 dni, bez treści)', async () => {
    const rows = await store.ai(since(7));
    if (rows.length === 0) return ['  brak'];
    return rows.map((row) => `  ${code(row.provider)} ${code(row.model)} ${code(row.task_type)} ${code(row.status)}${row.error_code ? ` ${code(row.error_code)}` : ''}: prób ${row.attempts}, czas p50 ${row.p50_ms ?? '-'} ms, p95 ${row.p95_ms ?? '-'} ms, tokenów ${row.tokens ?? '-'}`);
  });

  await part(lines, 'ZDARZENIA (14 dni, liczba i ostatni raz)', async () => {
    const rows = await store.eventTotals(since(14));
    if (rows.length === 0) return ['  brak'];
    return rows.map((row) => `  ${row.level} ${code(row.event)}: ${row.count}, ostatnio ${row.last_at}`);
  });

  await part(lines, 'PRZEBIEG (ostrzeżenia i błędy z 3 dni, wszystko z ostatnich 2 h; najnowsze na górze)', async () => {
    const rows = await store.timeline(since(3), new Date(now.getTime() - 2 * 3_600_000).toISOString(), DIAGNOSTIC_TIMELINE_LIMIT);
    if (rows.length === 0) return ['  brak'];
    return rows.map((row) => {
      const fields = Object.entries(row.fields).map(([key, value]) => `${key}=${String(value)}`).join(' ');
      const repeat = row.count > 1 ? ` ×${row.count} (od ${row.first_at})` : '';
      const duration = row.duration_ms_max !== null ? ` max ${row.duration_ms_max} ms` : '';
      return `  ${row.last_at} ${row.source} ${row.level} ${code(row.event)}${fields ? ` ${fields}` : ''}${repeat}${duration}`;
    });
  });

  return `${lines.join('\n')}\n`;
}
