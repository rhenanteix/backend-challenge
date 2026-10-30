
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
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

import { ProcessWagerTransaction } from '../../../application/use-cases/process-wager.js';

import type { ProcessWagerInput } from '../../../application/use-cases/process-wager.types.js';

import {
  SQS_CLIENT,
  WAGER_CONSUMER_NAME,
} from '../sqs.constants.js';

/**
 * Contrato das mensagens recebidas pelo SQS.
 */
type WagerEnvelope = {
  schemaVersion: 1;
  eventId: string;
  payload: ProcessWagerInput;
};

/**
 * Representação do registro da Inbox.
 */
type InboxRow = {
  payload_hash: string;
  processed_at: Date | null;
};

/**
 * Erro de mensagem inválida.
 *
 * Não devemos processar nem confirmar mensagens
 * que não respeitam o contrato.
 */
class InvalidWagerMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerMessageError';
  }
}

/**
 * Serialização determinística.
 *
 * Ordena as chaves dos objetos para que a ordem
 * original das propriedades não altere o hash.
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
 * Hash SHA-256 do payload de negócio.
 */
function calculatePayloadHash(
  payload: ProcessWagerInput,
): string {
  const canonicalJson = JSON.stringify(
    canonicalize(payload),
  );

  return createHash('sha256')
    .update(canonicalJson)
    .digest('hex');
}

/**
 * Validação básica do envelope.
 *
 * O caso de uso continua responsável pelas
 * validações financeiras e de domínio.
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

  // https://stackoverflow.com/questions/57280207/typescript-cannot-cast-down-to-generic-recordstring-string-type
  const payload = envelope.payload as unknown as ProcessWagerInput;

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
    payload: payload as WagerEnvelope['payload'],
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

  private loopPromise?: Promise<void>;

  constructor(
    @Inject(SQS_CLIENT)
    private readonly sqs: SQSClient,

    private readonly em: EntityManager,

    private readonly processor: ProcessWagerTransaction,
  ) {}

  /**
   * Inicia o consumidor junto com o NestJS.
   */
  async onModuleInit(): Promise<void> {
    if (process.env.SQS_CONSUMER_ENABLED !== 'true') {
      this.logger.log('SQS consumer disabled');
      return;
    }

    const queueName =
      process.env.SQS_WAGER_QUEUE_NAME ??
      'wager-transactions.fifo';

    const result = await this.sqs.send(
      new GetQueueUrlCommand({
        QueueName: queueName,
      }),
    );

    if (!result.QueueUrl) {
      throw new Error('SQS_QUEUE_URL_NOT_FOUND');
    }

    this.queueUrl = result.QueueUrl;
    this.running = true;

    this.logger.log(
      `SQS consumer started for ${queueName}`,
    );

    this.loopPromise = this.poll();
  }

  /**
   * Interrompe novos recebimentos.
   */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  /**
   * Loop principal.
   *
   * Uma mensagem por recebimento facilita
   * o controle de falhas e do visibility timeout.
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
   * Trata erros sem encerrar o loop.
   *
   * Falhas não recebem ACK e serão entregues
   * novamente pelo SQS.
   */
  private async handleSafely(
    message: Message,
  ): Promise<void> {
    try {
      await this.handle(message);
    } catch (error) {
      const code =
        error instanceof Error
          ? error.message
          : String(error);

      this.logger.error(
        `SQS processing failed: messageId=${message.MessageId} code=${code}`,
      );

      // Sem DeleteMessage:
      // a mensagem permanece elegível para retry.
      // A redrive policy enviará à DLQ quando
      // o limite de recebimentos for atingido.
    }
  }

  /**
   * Processamento transacional da mensagem.
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

    /**
     * Cada mensagem utiliza seu próprio
     * EntityManager.
     */
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
       *
       * A PK composta impede duplicidade
       * de (consumer_name, message_id).
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
       * 2. Bloquear registro da Inbox.
       *
       * Dois workers não podem processar
       * simultaneamente o mesmo eventId.
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
       * 3. Comparar o hash.
       *
       * Mesmo eventId com payload diferente
       * é conflito, não replay.
       */
      if (inbox.payload_hash !== payloadHash) {
        throw new InvalidWagerMessageError(
          'INBOX_PAYLOAD_CONFLICT',
        );
      }

      /**
       * 4. Mensagem já processada.
       *
       * Não executamos a operação financeira
       * novamente.
       */
      if (inbox.processed_at) {
        this.logger.log(
          `Duplicate message detected: ${envelope.eventId}`,
        );

        return;
      }

      /**
       * 5. Processamento financeiro.
       *
       * Utiliza a MESMA transação PostgreSQL
       * aberta pela Inbox.
       */
      await this.processor.executeInTransaction(
        tx,
        envelope.payload,
      );

      /**
       * 6. Marcar a Inbox como processada.
       *
       * Se qualquer operação anterior falhar,
       * toda a transação será revertida.
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
     *
     * Se o processo morrer antes deste ponto,
     * a mensagem será entregue novamente,
     * mas a Inbox impedirá novo débito.
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
