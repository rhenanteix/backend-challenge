
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Client } from 'pg';

const API_URL =
  process.env.TEST_API_URL ?? 'http://127.0.0.1:3000';

const SQS_ENDPOINT =
  process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566';

const QUEUE_URL =
  process.env.TEST_SQS_QUEUE_URL ??
  'http://localhost:4566/000000000000/wager-transactions.fifo';

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: SQS_ENDPOINT,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(
  assertion: () => Promise<void>,
  label: string,
  timeoutMs = 25000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }

  console.error(`Timeout aguardando: ${label}`);
  throw lastError ?? new Error(`Timeout: ${label}`);
}

async function getDatabase(): Promise<Client> {
  const connectionString =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL;

  const db = connectionString
    ? new Client({ connectionString })
    : new Client({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      user:
        process.env.DB_USER ??
        process.env.DB_USERNAME ??
        process.env.POSTGRES_USER ??
        'jungle',
      password:
        process.env.TEST_DB_PASSWORD ??
        process.env.DATABASE_PASSWORD ??
        process.env.DB_PASSWORD ??
        process.env.POSTGRES_PASSWORD,
      database:
        process.env.DB_NAME ??
        process.env.POSTGRES_DB ??
        'jungle_wagering',
    });

  await db.connect();
  return db;
}

describe('SQS - Concorrência financeira', () => {
  it(
    'processa duas mensagens e aplica somente um débito',
    async () => {
      const db = await getDatabase();

      try {
        // 1. Criar uma carteira exclusiva.
        const playerId = randomUUID();

        const response = await fetch(`${API_URL}/wallets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            playerId,
            currency: 'BRL',
            initialBalance: '100.00',
          }),
        });

        if (!response.ok) {
          throw new Error(
            `Erro ao criar carteira: HTTP ${response.status} - ${await response.text()}`,
          );
        }

        const wallet = (await response.json()) as {
          walletId: string;
        };

        expect(wallet.walletId).toBeTruthy();

        const walletId = wallet.walletId;
        const key = `concurrency-${randomUUID()}`;

        console.log('Carteira criada:', walletId);

        // 2. Montar uma única operação financeira.
        const payload = {
          providerId: 'jungle-provider',
          externalTransactionId: key,
          idempotencyKey: key,
          playerId,
          walletId,
          roundId: `round-${randomUUID()}`,
          gameId: 'slot-concurrency',
          kind: 'BET',
          money: {
            amount: '5.00',
            currency: 'BRL',
          },
        };

        // Dois eventos distintos representando a mesma BET.
        const eventIds = [randomUUID(), randomUUID()];

        // 3. Enviar mensagens em grupos FIFO distintos.
        const sentMessages = await Promise.all(
          eventIds.map((eventId, index) =>
            sqs.send(
              new SendMessageCommand({
                QueueUrl: QUEUE_URL,
                MessageGroupId: `concurrency-${index}-${key}`,
                MessageDeduplicationId: eventId,
                MessageBody: JSON.stringify({
                  schemaVersion: 1,
                  eventId,
                  payload,
                }),
              }),
            ),
          ),
        );

        const sqsMessageIds = sentMessages.map(result => {
          if (!result.MessageId) {
            throw new Error('SQS não retornou MessageId');
          }
          return result.MessageId;
        });

        console.log('Mensagens SQS enviadas:', sqsMessageIds);

        // 4. Aguardar a transação financeira.
        await waitUntil(
          async () => {
            const result = await db.query(
              `SELECT id, status
               FROM wager_transactions
               WHERE idempotency_key = $1`,
              [key],
            );

            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].status).toBe('PROCESSED');
          },
          'transação BET processada',
        );

        // 5. Verificar a Inbox.
        //
        // O consumidor pode persistir o MessageId do SQS
        // ou o eventId do envelope. Identificamos qual
        // convenção está em uso sem alterar o consumidor.
        const candidateIds = [...sqsMessageIds, ...eventIds];

        await waitUntil(
          async () => {
            const result = await db.query(
              `SELECT message_id, processed_at
               FROM inbox_messages
               WHERE message_id = ANY($1::varchar[])`,
              [candidateIds],
            );

            const foundIds = new Set(
              result.rows.map(row => String(row.message_id)),
            );

            const sqsMatches = sqsMessageIds.filter(
              id => foundIds.has(id),
            );

            const eventMatches = eventIds.filter(
              id => foundIds.has(id),
            );

            const matchedRows =
              sqsMatches.length === 2
                ? result.rows.filter(row =>
                  sqsMessageIds.includes(row.message_id),
                )
                : eventMatches.length === 2
                  ? result.rows.filter(row =>
                    eventIds.includes(row.message_id),
                  )
                  : [];

            expect(
              matchedRows.length,
              `Inbox: encontrados ${result.rows.length} registros; ` +
              `SQS MessageId=${sqsMatches.length}, eventId=${eventMatches.length}`,
            ).toBe(2);

            for (const row of matchedRows) {
              expect(row.processed_at).not.toBeNull();
            }
          },
          'duas mensagens processadas na Inbox',
        );

        // 6. Confirmar que existe uma única BET.
        const transactions = await db.query(
          `SELECT id, amount, status, kind
           FROM wager_transactions
           WHERE idempotency_key = $1`,
          [key],
        );

        expect(transactions.rows).toHaveLength(1);

        const transaction = transactions.rows[0];

        expect(transaction.kind).toBe('BET');
        expect(transaction.status).toBe('PROCESSED');
        expect(Number(transaction.amount)).toBe(5);

        // 7. Confirmar um único débito no Ledger.
        const ledger = await db.query(
          `SELECT direction, amount,
                  balance_before, balance_after
           FROM wallet_ledger_entries
           WHERE transaction_id = $1
             AND wallet_id = $2`,
          [transaction.id, walletId],
        );

        expect(ledger.rows).toHaveLength(1);
        expect(ledger.rows[0].direction).toBe('DEBIT');
        expect(Number(ledger.rows[0].amount)).toBe(5);
        expect(Number(ledger.rows[0].balance_before)).toBe(100);
        expect(Number(ledger.rows[0].balance_after)).toBe(95);

        // 8. Confirmar saldo final.
        const finalWallet = await db.query(
          `SELECT balance, version
           FROM wallets
           WHERE id = $1`,
          [walletId],
        );

        expect(finalWallet.rows).toHaveLength(1);
        expect(Number(finalWallet.rows[0].balance)).toBe(95);
        expect(Number(finalWallet.rows[0].version)).toBe(2);

        // 9. Verificar também o total de débitos da carteira.
        const debits = await db.query(
          `SELECT COUNT(*)::int AS total
           FROM wallet_ledger_entries
           WHERE wallet_id = $1
             AND direction = 'DEBIT'`,
          [walletId],
        );

        expect(debits.rows[0].total).toBe(1);

        console.log('Resultado financeiro validado:', {
          walletId,
          transactionId: transaction.id,
          financialTransactions: transactions.rows.length,
          ledgerDebits: debits.rows[0].total,
          balance: finalWallet.rows[0].balance,
          version: finalWallet.rows[0].version,
        });
      } finally {
        await db.end();
      }
    },
    40000,
  );
});
