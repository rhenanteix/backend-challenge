
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ApplicationModule } from '../../application/application.module.js';
import { sqsClientProvider } from './sqs.client.js';
import { WagerConsumer } from './workers/wager-consumer.js';
import { OutboxPublisher } from './publishers/outbox-publisher.js';

@Module({
  imports: [
    ApplicationModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    sqsClientProvider,
    WagerConsumer,
    OutboxPublisher,
  ],
})
export class MessagingModule {}
