import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';

const API_URL =
  process.env.TEST_API_URL ?? 'http://127.0.0.1:3000';

type Kind = 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';

type WalletContext = {
  walletId: string;
  playerId: string;
  roundId: string;
  providerId: string;
  gameId: string;
};

type WagerResult = {
  transactionId: string;
  status: string;
  balance: {
    amount: string;
    currency: string;
  };
  failureCode?: string;
  idempotentReplay: boolean;
};

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

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Resposta inválida em ${path}: HTTP ${response.status} ${text}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} em ${path}: ${JSON.stringify(data)}`,
    );
  }

  return data;
}

async function createWallet(): Promise<WalletContext> {
  const playerId = randomUUID();

  const result = await postJson('/wallets', {
    playerId,
    currency: 'BRL',
    initialBalance: '100.00',
  });

  expect(result.walletId).toBeTruthy();

  return {
    walletId: result.walletId,
    playerId,
    roundId: `round-${randomUUID()}`,
    providerId: 'jungle-provider',
    gameId: 'slot-lifecycle',
  };
}

function makeOperation(
  ctx: WalletContext,
  kind: Kind,
  amount: string,
  referenceExternalTransactionId?: string,
) {
  const externalTransactionId =
    `${kind.toLowerCase()}-${randomUUID()}`;

  const idempotencyKey =
    `lifecycle-${randomUUID()}`;

  const body = {
    providerId: ctx.providerId,
    externalTransactionId,
    playerId: ctx.playerId,
    walletId: ctx.walletId,
    roundId: ctx.roundId,
    gameId: ctx.gameId,
    kind,
    money: {
      amount,
      currency: 'BRL',
    },
    ...(referenceExternalTransactionId
      ? { referenceExternalTransactionId }
      : {}),
  };

  return {
    externalTransactionId,
    idempotencyKey,
    body,
  };
}

async function submit(
  operation: ReturnType<typeof makeOperation>,
): Promise<WagerResult> {
  return postJson(
    '/wagering/transactions',
    operation.body,
    { 'Idempotency-Key': operation.idempotencyKey },
  );
}

async function assertBalance(
  db: Client,
  walletId: string,
  expected: number,
) {
  const result = await db.query(
    'SELECT balance FROM wallets WHERE id = $1',
    [walletId],
  );

  expect(result.rows).toHaveLength(1);
  expect(Number(result.rows[0].balance)).toBe(expected);
}

async function assertLedger(
  db: Client,
  transactionId: string,
  direction: 'DEBIT' | 'CREDIT',
  amount: number,
  before: number,
  after: number,
) {
  const result = await db.query(
    `SELECT direction, amount, balance_before, balance_after
     FROM wallet_ledger_entries
     WHERE transaction_id = $1`,
    [transactionId],
  );

  expect(result.rows).toHaveLength(1);

  const entry = result.rows[0];

  expect(entry.direction).toBe(direction);
  expect(Number(entry.amount)).toBe(amount);
  expect(Number(entry.balance_before)).toBe(before);
  expect(Number(entry.balance_after)).toBe(after);
}

async function assertReconciliation(
  walletId: string,
  expectedBalance: number,
  expectedEntries: number,
) {
  const result = await postJson(
    `/wallets/${walletId}/reconciliation`,
    {},
  );

  expect(result.reconciled).toBe(true);
  expect(Number(result.storedBalance)).toBe(expectedBalance);
  expect(Number(result.ledgerBalance)).toBe(expectedBalance);
  expect(Number(result.entryCount)).toBe(expectedEntries);
}

describe('Ciclo financeiro completo', () => {
  it('BET → WIN → REFUND com Ledger e reconciliação', async () => {
    const db = await getDatabase();

    try {
      const ctx = await createWallet();

      await assertBalance(db, ctx.walletId, 100);

      const bet = makeOperation(ctx, 'BET', '20.00');
      const betResult = await submit(bet);

      expect(betResult.status).toBe('PROCESSED');
      expect(Number(betResult.balance.amount)).toBe(80);

      await assertBalance(db, ctx.walletId, 80);
      await assertLedger(
        db, betResult.transactionId,
        'DEBIT', 20, 100, 80,
      );

      const win = makeOperation(ctx, 'WIN', '35.00');
      const winResult = await submit(win);

      expect(winResult.status).toBe('PROCESSED');
      expect(Number(winResult.balance.amount)).toBe(115);

      await assertBalance(db, ctx.walletId, 115);
      await assertLedger(
        db, winResult.transactionId,
        'CREDIT', 35, 80, 115,
      );

      const refund = makeOperation(
        ctx,
        'REFUND',
        '20.00',
        bet.externalTransactionId,
      );

      const refundResult = await submit(refund);

      expect(refundResult.status).toBe('PROCESSED');
      expect(Number(refundResult.balance.amount)).toBe(135);

      await assertBalance(db, ctx.walletId, 135);
      await assertLedger(
        db, refundResult.transactionId,
        'CREDIT', 20, 115, 135,
      );

      const reference = await db.query(
        `SELECT reference_transaction_id
         FROM wager_transactions
         WHERE id = $1`,
        [refundResult.transactionId],
      );

      expect(reference.rows[0].reference_transaction_id)
        .toBe(betResult.transactionId);

      await assertReconciliation(ctx.walletId, 135, 4);

      console.log('Ciclo BET/WIN/REFUND aprovado:', {
        walletId: ctx.walletId,
        balance: 135,
        ledgerEntries: 4,
      });
    } finally {
      await db.end();
    }
  }, 30000);

  it('ROLLBACK de BET restaura o saldo inicial', async () => {
    const db = await getDatabase();

    try {
      const ctx = await createWallet();

      const bet = makeOperation(ctx, 'BET', '15.00');
      const betResult = await submit(bet);

      expect(betResult.status).toBe('PROCESSED');

      const rollback = makeOperation(
        ctx,
        'ROLLBACK',
        '15.00',
        bet.externalTransactionId,
      );

      const rollbackResult = await submit(rollback);

      expect(rollbackResult.status).toBe('PROCESSED');
      expect(Number(rollbackResult.balance.amount)).toBe(100);

      await assertLedger(
        db, rollbackResult.transactionId,
        'CREDIT', 15, 85, 100,
      );

      await assertBalance(db, ctx.walletId, 100);
      await assertReconciliation(ctx.walletId, 100, 3);

      console.log('ROLLBACK aprovado:', ctx.walletId);
    } finally {
      await db.end();
    }
  }, 30000);

  it('rejeita REFUND duplicado sem duplicar crédito', async () => {
    const db = await getDatabase();

    try {
      const ctx = await createWallet();

      const bet = makeOperation(ctx, 'BET', '10.00');
      await submit(bet);

      const refund1 = makeOperation(
        ctx, 'REFUND', '10.00',
        bet.externalTransactionId,
      );

      const first = await submit(refund1);
      expect(first.status).toBe('PROCESSED');

      const refund2 = makeOperation(
        ctx, 'REFUND', '10.00',
        bet.externalTransactionId,
      );

      const second = await submit(refund2);

      expect(second.status).toBe('REJECTED');
      expect(second.failureCode)
        .toBe('REFERENCE_ALREADY_REVERSED');

      const rejectedLedger = await db.query(
        `SELECT id FROM wallet_ledger_entries
         WHERE transaction_id = $1`,
        [second.transactionId],
      );

      expect(rejectedLedger.rows).toHaveLength(0);

      await assertBalance(db, ctx.walletId, 100);
      await assertReconciliation(ctx.walletId, 100, 3);
    } finally {
      await db.end();
    }
  }, 30000);

  it('replay idempotente não gera nova movimentação', async () => {
    const db = await getDatabase();

    try {
      const ctx = await createWallet();

      const bet = makeOperation(ctx, 'BET', '12.00');

      const first = await submit(bet);
      const replay = await submit(bet);

      expect(first.status).toBe('PROCESSED');
      expect(first.idempotentReplay).toBe(false);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transactionId)
        .toBe(first.transactionId);

      await assertBalance(db, ctx.walletId, 88);

      const transactions = await db.query(
        `SELECT id FROM wager_transactions
         WHERE idempotency_key = $1`,
        [bet.idempotencyKey],
      );

      expect(transactions.rows).toHaveLength(1);

      await assertReconciliation(ctx.walletId, 88, 2);
    } finally {
      await db.end();
    }
  }, 30000);
});
