
import {
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from '../sqs.constants.js';

type OutboxRow = {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  attempts: number;
};

@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  private publishing = false;
  private destinationUrl?: string;

  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT)
    private readonly sqs: SQSClient,
  ) {}

  @Cron('*/5 * * * * *')
  async publishBatch(): Promise<void> {
    if (process.env.SQS_OUTBOX_ENABLED !== 'true') return;
    if (this.publishing) return;

    this.publishing = true;

    try {
      const queueUrl = await this.getDestinationUrl();

      await this.em.fork().transactional(async tx => {
        const connection = tx.getConnection();
        const context = tx.getTransactionContext();

        const execute = <T = unknown>(
          sql: string,
          params: unknown[] = [],
        ) =>
          connection.execute(
            sql,
            params,
            'all',
            context,
          ) as Promise<T>;

        const events = await execute<OutboxRow[]>(
          `SELECT id, aggregate_id, event_type,
                  payload, attempts
           FROM outbox_messages
           WHERE published_at IS NULL
             AND (
               next_attempt_at IS NULL
               OR next_attempt_at <= now()
             )
           ORDER BY occurred_at
           FOR UPDATE SKIP LOCKED
           LIMIT 20`,
        );

        for (const event of events) {
          try {
            await this.sqs.send(
              new SendMessageCommand({
                QueueUrl: queueUrl,
                MessageBody:
                  typeof event.payload === 'string'
                    ? event.payload
                    : JSON.stringify(event.payload),
                MessageGroupId: event.aggregate_id,
                MessageDeduplicationId: event.id,
              }),
            );

            await execute(
              `UPDATE outbox_messages
               SET published_at = now()
               WHERE id = ?`,
              [event.id],
            );
          } catch (error) {
            this.logger.error(
              `Outbox publish failed: ${event.id}`,
              error,
            );

            const nextAttempts = event.attempts + 1;
            const delaySeconds = Math.min(
              300,
              2 ** Math.min(nextAttempts, 8),
            );

            await execute(
              `UPDATE outbox_messages
               SET attempts = ?,
                   next_attempt_at =
                     now() + (? * interval '1 second')
               WHERE id = ?`,
              [
                nextAttempts,
                delaySeconds,
                event.id,
              ],
            );
          }
        }
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Outbox publish failed: ${message}`);
    } finally {
      this.publishing = false;
    }
  }

  private async getDestinationUrl(): Promise<string> {
    if (this.destinationUrl) return this.destinationUrl;

    const queueName = process.env.SQS_EVENTS_QUEUE_NAME;

    if (!queueName) {
      throw new Error('SQS_EVENTS_QUEUE_NAME_REQUIRED');
    }

    const result = await this.sqs.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );

    if (!result.QueueUrl) {
      throw new Error('SQS_EVENTS_QUEUE_NOT_FOUND');
    }

    this.destinationUrl = result.QueueUrl;
    return result.QueueUrl;
  }
}
