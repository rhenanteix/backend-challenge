
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { DomainError } from '../../domain/shared/domain-error.js';

@Injectable()
export class WagerQueries {
  constructor(private readonly em: EntityManager) {}

  async findById(transactionId: string) {
    const rows = await this.em.getConnection().execute(
      `SELECT id, provider_id, external_transaction_id,
              wallet_id, player_id, round_id, game_id,
              kind, amount::text AS amount, currency,
              status, failure_code,
              result_balance::text AS result_balance,
              reference_transaction_id,
              created_at, processed_at
       FROM wager_transactions
       WHERE id = ?`,
      [transactionId],
    );

    if (!rows.length) {
      throw new DomainError('TRANSACTION_NOT_FOUND');
    }

    return this.toResponse(rows[0]);
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ) {
    const rows = await this.em.getConnection().execute(
      `SELECT id, provider_id, external_transaction_id,
              wallet_id, player_id, round_id, game_id,
              kind, amount::text AS amount, currency,
              status, failure_code,
              result_balance::text AS result_balance,
              reference_transaction_id,
              created_at, processed_at
       FROM wager_transactions
       WHERE provider_id = ?
         AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );

    if (!rows.length) {
      throw new DomainError('TRANSACTION_NOT_FOUND');
    }

    return this.toResponse(rows[0]);
  }

  private toResponse(row: any) {
    return {
      transactionId: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: {
        amount: row.amount,
        currency: row.currency,
      },
      status: row.status,
      failureCode: row.failure_code,
      resultBalance: row.result_balance === null
        ? null
        : {
            amount: row.result_balance,
            currency: row.currency,
          },
      referenceTransactionId: row.reference_transaction_id,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }
}
