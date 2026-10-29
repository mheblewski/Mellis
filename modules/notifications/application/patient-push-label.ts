/**
 * Which patient a push is about, for a phone that gets pushes for more than one patient: the title starts with the
 * patient's name ("Janek · Możliwe niedocukrzenie"). A phone of one patient's caregiver keeps the plain title.
 */
export interface PatientPushLabeler {
  /** The patient's name when this push token is registered for more than one patient, else null. */
  labelFor(pushToken: string, patientId: string): Promise<string | null>;
}

export function withPatientLabel(title: string, label: string | null): string {
  const name = label?.trim();
  return name ? `${name} · ${title}` : title;
}
