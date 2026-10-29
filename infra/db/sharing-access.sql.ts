/**
 * What a membership (caregiver_relationships, alias `r`) may do, as SQL (ported from sharing stage 2 for the
 * self-hosted server, the community-self-hosted plan). Owners may do everything. Others: a permission is off
 * only when it is literally false (rows from before migration 090 without the key keep full access).
 */

export type MemberScope = 'any' | 'glucose' | 'care' | 'glucose_alerts';

const NOT_FALSE = (alias: string, key: string) => `${alias}.permissions->'${key}' IS DISTINCT FROM 'false'::jsonb`;

export function memberAllowsSql(alias: string, scope: MemberScope): string {
  const scoped = {
    any: 'true',
    // The dashboard: someone allowed glucose or the AI and meals sees it.
    glucose: `(${NOT_FALSE(alias, 'glucose_alerts')} OR ${NOT_FALSE(alias, 'ai_chat_meals')})`,
    care: NOT_FALSE(alias, 'ai_chat_meals'),
    // Glucose alerts (rescue carbs, predicted lows) and Live Activities.
    glucose_alerts: NOT_FALSE(alias, 'glucose_alerts'),
  }[scope];
  return `(${alias}.is_owner OR ${scoped})`;
}

/**
 * A device row (alias `d`) of a member allowed `scope` pushes. Rows without a user (before migration 070) get nothing
 * (sharing audit #22): migration 091 gave them their only member or switched them off, and the app registers again.
 */
export function caregiverDeviceSql(scope: MemberScope): string {
  return `(d.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM caregiver_relationships r WHERE r.user_id = d.user_id AND r.patient_id = d.patient_id AND ${memberAllowsSql('r', scope)}
))`;
}
