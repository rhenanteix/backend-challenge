
import { Module } from '@nestjs/common';
import { ApplicationModule } from '../../application/application.module.js';
import { WalletsController } from './controllers/wallets.controller.js';
import { WageringController } from './controllers/wagering.controller.js';
import { ProvidersController } from './controllers/providers.controller.js';
import { HealthController } from './controllers/health.controller.js';

@Module({
  imports: [ApplicationModule],
  controllers: [
    WalletsController,
    WageringController,
    ProvidersController,
    HealthController,
  ],
})
export class HttpModule {}
