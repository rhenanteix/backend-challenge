import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SQSClient,
  SendMessageCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { Client } from 'pg';

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function getDatabase(): Promise<Client> {
  const connectionString =
    process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

  const db = connectionString
    ? new Client({ connectionString })
    : new Client({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      user:
        process.env.DB_USER ??
        process.env.DB_USERNAME ??
        'jungle',
      password:
        process.env.TEST_DB_PASSWORD ??
        process.env.DATABASE_PASSWORD ??
        process.env.DB_PASSWORD,
      database:
        process.env.DB_NAME ?? 'jungle_wagering',
    });

  await db.connect();
  return db;
}

describe('SQS - Retry e recuperação', () => {
  it(
    'reprocessa uma BET após a carteira ficar disponível',
    async () => {
      const db = await getDatabase();

      try {
        const walletId = randomUUID();
        const playerId = randomUUID();
        const eventId = randomUUID();
        const externalTransactionId = `retry-${randomUUID()}`;
        const idempotencyKey = `retry-key-${randomUUID()}`;

        const queueName =
          process.env.SQS_WAGER_QUEUE_NAME ??
          'wager-transactions.fifo';

        const queue = await sqs.send(
          new GetQueueUrlCommand({ QueueName: queueName }),
        );

        if (!queue.QueueUrl) {
          throw new Error('Fila SQS não encontrada');
        }

        const attributes = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: queue.QueueUrl,
            AttributeNames: ['VisibilityTimeout'],
          }),
        );

        const visibilityTimeout = Number(
          attributes.Attributes?.VisibilityTimeout ?? 60,
        );

        // O consumidor sobrescreve o timeout para 60 segundos.
        expect(visibilityTimeout).toBeGreaterThan(0);

        const payload = {
          providerId: 'jungle-provider',
          externalTransactionId,
          idempotencyKey,
          playerId,
          walletId,
          roundId: `round-${randomUUID()}`,
          gameId: 'slot-retry',
          kind: 'BET',
          money: {
            amount: '10.00',
            currency: 'BRL',
          },
        };

        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queue.QueueUrl,
            MessageGroupId: `retry-${walletId}`,
            MessageDeduplicationId: eventId,
            MessageBody: JSON.stringify({
              schemaVersion: 1,
              eventId,
              payload,
            }),
          }),
        );

        console.log('BET enviada para carteira inexistente:', walletId);

        // Aguarda o primeiro recebimento pelo consumidor.
        // Não basta consultar a tabela de transações,
        // pois a falha provoca rollback do processamento.
        const firstDeadline = Date.now() + 15000;
        let firstDeliveryObserved = false;

        while (Date.now() < firstDeadline) {
          const state = await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: queue.QueueUrl,
              AttributeNames: [
                'ApproximateNumberOfMessagesNotVisible',
              ],
            }),
          );

          if (
            Number(
              state.Attributes
                ?.ApproximateNumberOfMessagesNotVisible ?? 0,
            ) > 0
          ) {
            firstDeliveryObserved = true;
            break;
          }

          await sleep(500);
        }

        expect(
          firstDeliveryObserved,
          'Consumidor não recebeu a mensagem inicialmente',
        ).toBe(true);

        // A mensagem não deve gerar transação enquanto
        // a carteira estiver ausente.
        const before = await db.query(
          `SELECT id FROM wager_transactions
           WHERE idempotency_key = $1`,
          [idempotencyKey],
        );

        expect(before.rows).toHaveLength(0);

        // Recuperação controlada da dependência:
        // criar carteira de integração com o UUID esperado.
        // O saldo inicial é zero para não exigir OPENING.
        await db.query(
          `INSERT INTO wallets (
             id, player_id, currency, balance,
             version, created_at, updated_at
           )
           VALUES ($1, $2, 'BRL', 0, 1, now(), now())`,
          [walletId, playerId],
        );

        // BET exige saldo disponível. Provisionamos saldo
        // inicial com uma operação financeira válida via API
        // somente se houver suporte para walletId externo.
        // Como não há, usamos crédito de teste e registramos
        // o OPENING correspondente para preservar o Ledger.
        const openingId = randomUUID();
        const openingExternalId = `opening-${randomUUID()}`;

        await db.query('BEGIN');

        try {
          await db.query(
            `INSERT INTO wager_transactions (
              id, provider_id, external_transaction_id,
              idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id,
              kind, amount, currency, status,
              result_balance, attempts, created_at, processed_at
            )
            VALUES (
              $1, 'system', $2, $3, $4,
              $5, $6, 'opening', 'system',
              'OPENING', 100, 'BRL', 'PROCESSED',
              100, 0, now(), now()
            )`,
            [
              openingId,
              openingExternalId,
              `opening-${randomUUID()}`,
              randomUUID().replaceAll('-', ''),
              walletId,
              playerId,
            ],
          );

          await db.query(
            `INSERT INTO wallet_ledger_entries (
              id, wallet_id, transaction_id,
              direction, amount, currency,
              balance_before, balance_after, created_at
            )
            VALUES (
              $1, $2, $3,
              'CREDIT', 100, 'BRL',
              0, 100, now()
            )`,
            [randomUUID(), walletId, openingId],
          );

          await db.query(
            `UPDATE wallets
             SET balance = 100, updated_at = now()
             WHERE id = $1`,
            [walletId],
          );

          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        }

        console.log('Carteira recuperada:', walletId);

        // Espera reentrega. A janela inclui o timeout
        // de visibilidade configurado no consumidor.
        const deadline = Date.now() + 95000;
        let processed = false;

        while (Date.now() < deadline) {
          const result = await db.query(
            `SELECT id, status, result_balance
             FROM wager_transactions
             WHERE idempotency_key = $1`,
            [idempotencyKey],
          );

          if (result.rows[0]?.status === 'PROCESSED') {
            processed = true;
            break;
          }

          await sleep(1000);
        }

        expect(
          processed,
          'BET não foi processada após a recuperação',
        ).toBe(true);

        const transactions = await db.query(
          `SELECT id FROM wager_transactions
           WHERE idempotency_key = $1`,
          [idempotencyKey],
        );

        expect(transactions.rows).toHaveLength(1);

        const ledger = await db.query(
          `SELECT direction, amount
           FROM wallet_ledger_entries
           WHERE transaction_id = $1`,
          [transactions.rows[0].id],
        );

        expect(ledger.rows).toHaveLength(1);
        expect(ledger.rows[0].direction).toBe('DEBIT');
        expect(Number(ledger.rows[0].amount)).toBe(10);

        const wallet = await db.query(
          `SELECT balance FROM wallets WHERE id = $1`,
          [walletId],
        );

        expect(Number(wallet.rows[0].balance)).toBe(90);

        console.log('Retry e recuperação aprovados:', {
          walletId,
          finalBalance: 90,
          transactions: 1,
          ledgerDebits: 1,
        });
      } finally {
        await db.end();
      }
    },
    125000,
  );
});
