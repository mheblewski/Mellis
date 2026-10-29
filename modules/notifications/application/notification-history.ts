import type { PushNotificationPayload, PushNotificationType } from '@modules/notifications/domain/push-notification';

/** A sent notification as the caregiver saw it; the bell in the app lists these. */
export interface NotificationHistoryEntry {
  /** Same for every device of the patient: the second device's send does not add a row. */
  dedupeKey: string;
  patientId: string;
  type: PushNotificationType;
  title: string;
  body: string;
  payload: PushNotificationPayload;
}

export interface NotificationHistoryRecorder {
  record(entry: NotificationHistoryEntry): Promise<void>;
}
