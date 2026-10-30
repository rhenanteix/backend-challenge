import { createHash } from 'node:crypto';

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
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

import { ProcessWagerTransaction } from '../../../application/use-cases/process-wager.js';

import type { ProcessWagerInput } from '../../../application/use-cases/process-wager.types.js';

import {
  SQS_CLIENT,
  WAGER_CONSUMER_NAME,
} from '../sqs.constants.js';

import { classifyWagerError } from '../errors/classify-wager-error.js';

import { InvalidWagerMessageError } from '../errors/invalid-wager-message.error.js';

type WagerEnvelope = {
  schemaVersion: 1;
  eventId: string;
  payload: ProcessWagerInput;
};

type InboxRow = {
  payload_hash: string;
  processed_at: Date | null;
};

/**
 * Serialização determinística para hashing.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [
          key,
          canonicalize(object[key]),
        ]),
    );
  }

  return value;
}

/**
 * Hash SHA-256 do payload financeiro.
 */
function calculatePayloadHash(
  payload: ProcessWagerInput,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

/**
 * Validação do envelope SQS.
 */
function parseEnvelope(body: string): WagerEnvelope {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidWagerMessageError(
      'INVALID_MESSAGE_JSON',
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new InvalidWagerMessageError(
      'INVALID_WAGER_ENVELOPE',
    );
  }

  const envelope = parsed as Record<string, unknown>;

  if (
    envelope.schemaVersion !== 1 ||
    typeof envelope.eventId !== 'string' ||
    !envelope.eventId.trim() ||
    !envelope.payload ||
    typeof envelope.payload !== 'object' ||
    Array.isArray(envelope.payload)
  ) {
    throw new InvalidWagerMessageError(
      'INVALID_WAGER_ENVELOPE',
    );
  }

  const payload =
    envelope.payload as unknown as ProcessWagerInput;

  if (
    typeof payload.idempotencyKey !== 'string' ||
    !payload.idempotencyKey.trim() ||
    typeof payload.providerId !== 'string' ||
    !payload.providerId.trim() ||
    typeof payload.externalTransactionId !== 'string' ||
    !payload.externalTransactionId.trim() ||
    typeof payload.walletId !== 'string' ||
    !payload.walletId.trim() ||
    typeof payload.playerId !== 'string' ||
    !payload.playerId.trim() ||
    typeof payload.kind !== 'string' ||
    !['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(
      payload.kind,
    ) ||
    !payload.money ||
    typeof payload.money !== 'object' ||
    Array.isArray(payload.money)
  ) {
    throw new InvalidWagerMessageError(
      'INVALID_WAGER_PAYLOAD',
    );
  }

  return {
    schemaVersion: 1,
    eventId: envelope.eventId,
    payload,
  };
}

@Injectable()
export class WagerConsumer
  implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(
    WagerConsumer.name,
  );

  private running = false;

  private queueUrl = '';

  private dlqUrl = '';

  private loopPromise?: Promise<void>;

  constructor(
    @Inject(SQS_CLIENT)
    private readonly sqs: SQSClient,

    private readonly em: EntityManager,

    private readonly processor: ProcessWagerTransaction,
  ) { }

  /**
   * Inicialização das filas.
   */
  async onModuleInit(): Promise<void> {
    if (process.env.SQS_CONSUMER_ENABLED !== 'true') {
      this.logger.log('SQS consumer disabled');
      return;
    }

    const queueName =
      process.env.SQS_WAGER_QUEUE_NAME ??
      'wager-transactions.fifo';

    const dlqName =
      process.env.SQS_WAGER_DLQ_NAME ??
      'wager-transactions-dlq.fifo';

    const queueResult = await this.sqs.send(
      new GetQueueUrlCommand({
        QueueName: queueName,
      }),
    );

    if (!queueResult.QueueUrl) {
      throw new Error('SQS_QUEUE_URL_NOT_FOUND');
    }

    const dlqResult = await this.sqs.send(
      new GetQueueUrlCommand({
        QueueName: dlqName,
      }),
    );

    if (!dlqResult.QueueUrl) {
      throw new Error('SQS_DLQ_URL_NOT_FOUND');
    }

    this.queueUrl = queueResult.QueueUrl;
    this.dlqUrl = dlqResult.QueueUrl;

    this.running = true;

    this.logger.log(
      `SQS consumer started: queue=${queueName} dlq=${dlqName}`,
    );

    this.loopPromise = this.poll();
  }

  /**
   * Encerramento gracioso.
   */
  async onModuleDestroy(): Promise<void> {
    this.running = false;

    await this.loopPromise;
  }

  /**
   * Polling SQS.
   */
  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 10,
            VisibilityTimeout: 60,
            MessageSystemAttributeNames: ['All'],
          }),
        );

        for (const message of result.Messages ?? []) {
          await this.handleSafely(message);
        }
      } catch (error) {
        this.logger.error(
          'SQS polling failed',
          error instanceof Error
            ? error.stack
            : String(error),
        );

        if (this.running) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1000);
          });
        }
      }
    }
  }

  /**
   * Tratamento inteligente de falhas.
   */
  private async handleSafely(
    message: Message,
  ): Promise<void> {
    try {
      await this.handle(message);
    } catch (error) {
      const classification = classifyWagerError(error);

      this.logger.error(
        `SQS processing failed: messageId=${message.MessageId} category=${classification.category} code=${classification.code}`,
      );

      if (classification.category === 'PERMANENT') {
        try {
          await this.quarantine(
            message,
            classification.code,
          );
        } catch (quarantineError) {
          this.logger.error(
            `SQS quarantine failed: messageId=${message.MessageId}`,
            quarantineError instanceof Error
              ? quarantineError.stack
              : String(quarantineError),
          );
        }
      }

      // TRANSIENT: sem ACK.
      // PERMANENT com falha na quarentena: sem ACK.
    }
  }

  /**
   * Encaminha erros permanentes para a DLQ.
   *
   * O ACK acontece somente após o envio
   * da mensagem à fila de quarentena.
   */
  private async quarantine(
    message: Message,
    errorCode: string,
  ): Promise<void> {
    if (
      !message.Body ||
      !message.ReceiptHandle ||
      !message.MessageId
    ) {
      throw new Error('INVALID_SQS_MESSAGE');
    }

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body,
        MessageGroupId:
          message.Attributes?.MessageGroupId ??
          'invalid-wager',
        MessageDeduplicationId:
          `quarantine-${message.MessageId}`,
        MessageAttributes: {
          errorCode: {
            DataType: 'String',
            StringValue: errorCode,
          },
          originalMessageId: {
            DataType: 'String',
            StringValue: message.MessageId,
          },
          failedAt: {
            DataType: 'String',
            StringValue: new Date().toISOString(),
          },
        },
      }),
    );

    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    this.logger.warn(
      `SQS message quarantined: messageId=${message.MessageId} code=${errorCode}`,
    );
  }

  /**
   * Processamento transacional.
   *
   * Inbox + operação financeira compartilham
   * a mesma transação PostgreSQL.
   */
  private async handle(
    message: Message,
  ): Promise<void> {
    if (
      !message.MessageId ||
      !message.Body ||
      !message.ReceiptHandle
    ) {
      throw new InvalidWagerMessageError(
        'INVALID_SQS_MESSAGE',
      );
    }

    const envelope = parseEnvelope(message.Body);

    const payloadHash = calculatePayloadHash(
      envelope.payload,
    );

    const em = this.em.fork();

    await em.transactional(async (tx) => {
      const connection = tx.getConnection();
      const context = tx.getTransactionContext();

      const execute = <T = unknown>(
        sql: string,
        params: unknown[] = [],
      ): Promise<T> =>
        connection.execute(
          sql,
          params,
          'all',
          context,
        ) as Promise<T>;

      /**
       * 1. Registrar recebimento.
       */
      await execute(
        `INSERT INTO inbox_messages (
          consumer_name,
          message_id,
          payload_hash,
          received_at
        )
        VALUES (?, ?, ?, now())
        ON CONFLICT (consumer_name, message_id)
        DO NOTHING`,
        [
          WAGER_CONSUMER_NAME,
          envelope.eventId,
          payloadHash,
        ],
      );

      /**
       * 2. Bloquear a Inbox.
       */
      const rows = await execute<InboxRow[]>(
        `SELECT
          payload_hash,
          processed_at
        FROM inbox_messages
        WHERE consumer_name = ?
          AND message_id = ?
        FOR UPDATE`,
        [
          WAGER_CONSUMER_NAME,
          envelope.eventId,
        ],
      );

      if (!rows.length) {
        throw new Error('INBOX_ROW_NOT_FOUND');
      }

      const inbox = rows[0];

      /**
       * 3. Detectar conflito de payload.
       */
      if (inbox.payload_hash !== payloadHash) {
        throw new InvalidWagerMessageError(
          'INBOX_PAYLOAD_CONFLICT',
        );
      }

      /**
       * 4. Replay de mensagem processada.
       */
      if (inbox.processed_at) {
        this.logger.log(
          `Duplicate message detected: ${envelope.eventId}`,
        );

        return;
      }

      /**
       * 5. Processamento financeiro.
       */
      await this.processor.executeInTransaction(
        tx,
        envelope.payload,
      );

      /**
       * 6. Marcar Inbox como processada.
       */
      await execute(
        `UPDATE inbox_messages
         SET processed_at = now()
         WHERE consumer_name = ?
           AND message_id = ?`,
        [
          WAGER_CONSUMER_NAME,
          envelope.eventId,
        ],
      );
    });

    /**
     * 7. ACK somente após o commit.
     */
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    this.logger.log(
      `SQS message acknowledged: ${message.MessageId}`,
    );
  }
}
