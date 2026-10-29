import { PushNotificationProvider } from './push-notification-provider';
import { PushNotificationEnvelope } from '@modules/notifications/domain/push-notification';

export class FakePushNotificationProvider implements PushNotificationProvider {
  readonly sent: PushNotificationEnvelope[] = [];

  async send(notification: PushNotificationEnvelope): Promise<void> {
    this.sent.push(notification);
  }
}
