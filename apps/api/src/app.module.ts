import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '@infra/db/database.module';
import { validateApiEnvironment } from '@infra/config/environment';
import { ApiService } from './application/api.service';
import { BearerPrincipalGuard } from './auth/bearer-principal.guard';
import { CognitoAuthService } from './auth/cognito-auth.service';
import { PatientController } from './controllers/patient.controller';
import { MeController } from './controllers/me.controller';
import { AppConfigController } from './controllers/app-config.controller';
import { DevicesController } from './controllers/devices.controller';
import { LiveEventsController } from './live-events/live-events.controller';
import { LiveEventsService } from './live-events/live-events.service';
import { DeviceAuthService } from './application/device-auth.service';
import { PatientPermissionGuard } from './auth/patient-permission.guard';
import { DeviceAccountController, DevicePeopleController, DeviceSetupController } from './controllers/device-auth.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateApiEnvironment }), DatabaseModule],
  controllers: [
    PatientController,
    MeController,
    AppConfigController,
    DevicesController,
    LiveEventsController,
    DeviceSetupController,
    DeviceAccountController,
    DevicePeopleController,
  ],
  providers: [ApiService, BearerPrincipalGuard, PatientPermissionGuard, CognitoAuthService, DeviceAuthService, LiveEventsService],
})
export class ApiAppModule {}