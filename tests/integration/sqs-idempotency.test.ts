import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Client } from 'pg';

const WALLET_ID =
  process.env.TEST_WALLET_ID ??
  'def73aba-1dc1-4b87-ae00-db7c37173259';

const PLAYER_ID =
  process.env.TEST_PLAYER_ID ??
  'a8fa6122-c11c-42c7-be2d-44a832c93202';

const QUEUE_URL =
  process.env.TEST_SQS_QUEUE_URL ??
  'http://localhost:4566/000000000000/wager-transactions.fifo';

const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

async function getDatabase() {
  const db = new Client({
    host: 'localhost',
    port: 5432,
    user: 'jungle',
    password: process.env.TEST_DB_PASSWORD ?? 'jungle_dev_password',
    database: 'jungle_wagering',
  });

  await db.connect();
  return db;
}

describe('SQS - Idempotência', () => {
  it('não deve debitar duas vezes a mesma transação', async () => {
    const db = await getDatabase();

    try {
      const initial = await db.query(
        'SELECT balance FROM wallets WHERE id = $1',
        [WALLET_ID],
      );

      expect(initial.rows).toHaveLength(1);

      const initialBalance = Number(initial.rows[0].balance);

      const key = `test-idem-${randomUUID()}`;

      const payload = {
        providerId: 'jungle-provider',
        externalTransactionId: key,
        idempotencyKey: key,
        playerId: PLAYER_ID,
        walletId: WALLET_ID,
        roundId: `round-${randomUUID()}`,
        gameId: 'slot-test',
        kind: 'BET',
        money: {
          amount: '5.00',
          currency: 'BRL',
        },
      };

      for (let i = 0; i < 2; i++) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: QUEUE_URL,
            MessageGroupId: `test-group-${i}`,
            MessageDeduplicationId: randomUUID(),
            MessageBody: JSON.stringify({
              schemaVersion: 1,
              eventId: randomUUID(),
              payload,
            }),
          }),
        );
      }

      let transactionCount = 0;

      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await db.query(
          `SELECT COUNT(*)::int AS total
           FROM wager_transactions
           WHERE idempotency_key = $1
             AND status = 'PROCESSED'`,
          [key],
        );

        transactionCount = result.rows[0].total;

        if (transactionCount === 1) break;

        await new Promise((resolve) =>
          setTimeout(resolve, 1000),
        );
      }

      expect(transactionCount).toBe(1);

      const final = await db.query(
        'SELECT balance FROM wallets WHERE id = $1',
        [WALLET_ID],
      );

      const finalBalance = Number(final.rows[0].balance);

      expect(finalBalance).toBe(initialBalance - 5);
    } finally {
      await db.end();
    }
  });
});
