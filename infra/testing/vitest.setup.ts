import { configurePostgresIntegrationEnvironment } from '../db/postgres-test-isolation';
import { configureOfflineProviderEnvironment } from './offline-providers';

configureOfflineProviderEnvironment(process.env);
configurePostgresIntegrationEnvironment(process.env);
