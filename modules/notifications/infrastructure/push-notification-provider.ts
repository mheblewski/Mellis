import { PushNotificationEnvelope } from '@modules/notifications/domain/push-notification';

export interface PushNotificationProvider {
  send(notification: PushNotificationEnvelope): Promise<void>;
}
