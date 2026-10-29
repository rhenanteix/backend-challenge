
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { DomainError } from '../../domain/shared/domain-error.js';

@Injectable()
export class WalletQueries {
  constructor(private readonly em: EntityManager) {}

  async findById(walletId: string) {
    const rows = await this.em.getConnection().execute(
      `SELECT id, player_id, currency,
              balance::text AS balance, version,
              created_at, updated_at
       FROM wallets
       WHERE id = ?`,
      [walletId],
    );

    if (!rows.length) {
      throw new DomainError('WALLET_NOT_FOUND');
    }

    const row = rows[0];

    return {
      walletId: row.id,
      playerId: row.player_id,
      balance: {
        amount: row.balance,
        currency: row.currency,
      },
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async ledger(walletId: string, cursor?: string, limit = 20) {
    await this.findById(walletId);

    const pageSize = Math.min(Math.max(limit, 1), 100);

    let cursorDate: string | undefined;
    let cursorId: string | undefined;

    if (cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, 'base64url').toString('utf8'),
        );

        if (
          typeof decoded.createdAt !== 'string' ||
          typeof decoded.id !== 'string' ||
          !Number.isFinite(Date.parse(decoded.createdAt))
        ) {
          throw new Error('Invalid cursor');
        }

        cursorDate = decoded.createdAt;
        cursorId = decoded.id;
      } catch {
        throw new DomainError('INVALID_CURSOR');
      }
    }

    const rows = await this.em.getConnection().execute(
      `SELECT id, transaction_id, direction,
              amount::text AS amount, currency,
              balance_before::text AS balance_before,
              balance_after::text AS balance_after,
              created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = ?
         AND (
           ?::timestamptz IS NULL
           OR (created_at, id) <
              (?::timestamptz, ?::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [
        walletId,
        cursorDate ?? null,
        cursorDate ?? null,
        cursorId ?? null,
        pageSize + 1,
      ],
    );

    const hasMore = rows.length > pageSize;
    const items = rows.slice(0, pageSize);
    const last = items.at(-1);

    return {
      items: items.map(row => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: {
          amount: row.amount,
          currency: row.currency,
        },
        balanceBefore: {
          amount: row.balance_before,
          currency: row.currency,
        },
        balanceAfter: {
          amount: row.balance_after,
          currency: row.currency,
        },
        createdAt: row.created_at,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: new Date(last.created_at).toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null,
    };
  }

  async reconcile(walletId: string) {
    const rows = await this.em.getConnection().execute(
      `SELECT
         w.id,
         w.currency,
         w.balance::text AS stored_balance,
         COALESCE(
           SUM(
             CASE
               WHEN l.direction = 'CREDIT' THEN l.amount
               ELSE -l.amount
             END
           ), 0
         )::text AS ledger_balance,
         COUNT(l.id)::int AS entry_count
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l
         ON l.wallet_id = w.id
       WHERE w.id = ?
       GROUP BY w.id, w.currency, w.balance`,
      [walletId],
    );

    if (!rows.length) {
      throw new DomainError('WALLET_NOT_FOUND');
    }

    const row = rows[0];

    return {
      walletId: row.id,
      currency: row.currency,
      storedBalance: row.stored_balance,
      ledgerBalance: row.ledger_balance,
      entryCount: row.entry_count,
      reconciled:
        row.stored_balance === row.ledger_balance,
    };
  }
}
