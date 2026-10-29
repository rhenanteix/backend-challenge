
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money/money.js';

export interface CreateWalletInput {
  playerId: string;
  currency: string;
  initialBalance: string;
}

@Injectable()
export class CreateWallet {
  constructor(private readonly em: EntityManager) {}

  async execute(input: CreateWalletInput) {
    const initial = Money.from({
      amount: input.initialBalance,
      currency: input.currency,
    });

    const walletId = randomUUID();
    const transactionId = randomUUID();
    const now = new Date();

    return this.em.transactional(async tx => {
      const execute = <T = unknown>(
        sql: string,
        params: unknown[],
      ) => tx.getConnection().execute(
        sql,
        params,
        'all',
        tx.getTransactionContext(),
      ) as Promise<T>;

      await execute(
        `INSERT INTO wallets (
          id, player_id, currency, balance,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [
          walletId,
          input.playerId,
          input.currency,
          initial.toJSON().amount,
          now,
          now,
        ],
      );

      // OPENING é uma transação interna, nunca enviada por provider.
      if (initial.isPositive()) {
        await execute(
          `INSERT INTO wager_transactions (
            id, provider_id, external_transaction_id,
            idempotency_key, payload_hash, wallet_id,
            player_id, round_id, game_id, kind,
            amount, currency, status, result_balance,
            attempts, created_at, processed_at
          ) VALUES (
            ?, 'SYSTEM', ?, ?, ?, ?, ?,
            'OPENING', 'SYSTEM', 'OPENING',
            ?, ?, 'PROCESSED', ?, 0, ?, ?
          )`,
          [
            transactionId,
            `opening:${walletId}`,
            `opening:${walletId}`,
            'internal-opening',
            walletId,
            input.playerId,
            initial.toJSON().amount,
            input.currency,
            initial.toJSON().amount,
            now,
            now,
          ],
        );

        await execute(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction,
            amount, currency, balance_before,
            balance_after, created_at
          ) VALUES (?, ?, ?, 'CREDIT', ?, ?, 0, ?, ?)`,
          [
            randomUUID(),
            walletId,
            transactionId,
            initial.toJSON().amount,
            input.currency,
            initial.toJSON().amount,
            now,
          ],
        );
      }

      return {
        walletId,
        playerId: input.playerId,
        balance: initial.toJSON(),
        version: 1,
        createdAt: now,
      };
    });
  }
}

export async function lockIdempotencyKey(
  tx: EntityManager,
  key: string,
): Promise<void> {
  await tx.getConnection().execute(
    `SELECT pg_advisory_xact_lock(
      hashtextextended(?, 0)
    )`,
    [key],
    'all',
    tx.getTransactionContext(),
  );
}
