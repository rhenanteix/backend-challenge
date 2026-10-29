
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

import { ProcessWagerTransaction } from '../../../application/use-cases/process-wager.js';
import type { ProcessWagerInput } from '../../../application/use-cases/process-wager.types.js';
import {
  SQS_CLIENT,
  WAGER_CONSUMER_NAME,
} from '../sqs.constants.js';

type WagerEnvelope = {
  schemaVersion: 1;
  eventId: string;
  payload: ProcessWagerInput;
};

@Injectable()
export class WagerConsumer
  implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerConsumer.name);
  private running = false;
  private queueUrl = '';
  private loopPromise?: Promise<void>;

  constructor(
    @Inject(SQS_CLIENT)
    private readonly sqs: SQSClient,
    private readonly em: EntityManager,
    private readonly processor: ProcessWagerTransaction,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.SQS_CONSUMER_ENABLED !== 'true') {
      return;
    }

    const queueName = process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-events.fifo';  

    const result = await this.sqs.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );

    if (!result.QueueUrl) {
      throw new Error('SQS_QUEUE_URL_NOT_FOUND');
    }

    this.queueUrl = result.QueueUrl;
    this.running = true;
    this.loopPromise = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 10,
            VisibilityTimeout: 60,
            MessageSystemAttributeNames: ['All'],
          }),
        );

        for (const message of result.Messages ?? []) {
          if (!this.running) break;
          await this.handle(message);
        }
      } catch (error) {
        this.logger.error('SQS polling failed', error instanceof Error ? error.stack : String(error));
        if (this.running) {
          await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 1000);
          })
        }
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    if (!message.MessageId || !message.Body) {
      throw new Error('INVALID_SQS_MESSAGE');
    }

    const envelope = JSON.parse(message.Body) as WagerEnvelope;

    if (
      envelope.schemaVersion !== 1 ||
      !envelope.eventId ||
      !envelope.payload
    ) {
      throw new Error('INVALID_WAGER_ENVELOPE');
    }

    const em = this.em.fork();

    await em.transactional(async tx => {
      const connection = tx.getConnection();
      const context = tx.getTransactionContext();

      const execute = <T = unknown>(
        sql: string,
        params: unknown[],
      ) =>
        connection.execute(
          sql,
          params,
          'all',
          context,
        ) as Promise<T>;

      // O ON CONFLICT impede dois consumidores de
      // criarem simultaneamente o mesmo registro.
      await execute(
        `INSERT INTO inbox_messages (
          consumer_name, message_id, payload_hash,
          received_at
        ) VALUES (?, ?, ?, now())
        ON CONFLICT (consumer_name, message_id)
        DO NOTHING`,
        [
          WAGER_CONSUMER_NAME,
          envelope.eventId,
          envelope.eventId,
        ],
      );

      const rows = await execute<Array<{
        processed_at: Date | null;
      }>>(
        `SELECT processed_at
         FROM inbox_messages
         WHERE consumer_name = ?
           AND message_id = ?
         FOR UPDATE`,
        [WAGER_CONSUMER_NAME, envelope.eventId],
      );

      if (!rows.length) {
        throw new Error('INBOX_ROW_NOT_FOUND');
      }

      if (rows[0].processed_at) {
        return;
      }

      await this.processor.executeInTransaction(
        tx,
        envelope.payload,
      );

      await execute(
        `UPDATE inbox_messages
         SET processed_at = now()
         WHERE consumer_name = ?
           AND message_id = ?`,
        [WAGER_CONSUMER_NAME, envelope.eventId],
      );
    });

    // ACK somente após o commit.
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    this.logger.log(
      `Processed SQS message ${message.MessageId}`,
    );
  }
}
