
import { randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../domain/wagering/wager-transaction.js';
import { ReversalPolicy } from '../../domain/wagering/reversal-policy.js';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry.js';
import { createPayloadHash } from './payload-hash.js';
import { lockIdempotencyKey } from '../../shared/database/idempotency-lock.js';
import type {
  ProcessWagerInput,
  ProcessWagerResult,
} from './process-wager.types.js';

type WalletRow = {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type TxRow = {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: Kind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: Status;
  failure_code: string | null;
  result_balance: string | null;
  created_at: Date;
  processed_at: Date | null;
};

@Injectable()
export class ProcessWagerTransaction {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    return this.em.transactional((tx) =>
      this.executeInTransaction(tx, input),
    );
  }

  /**
   * Participa da transação aberta pelo consumidor SQS.
   * NÃO abre uma nova transação, pois Inbox e operação financeira
   * precisam compartilhar o mesmo commit.
   */
  async executeInTransaction(
    tx: EntityManager,
    input: ProcessWagerInput,
  ): Promise<ProcessWagerResult> {
    if (!input.idempotencyKey?.trim()) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED');
    }

    if (input.kind === Kind.Opening) {
      throw new DomainError('OPENING_IS_INTERNAL');
    }

    const money = Money.from(input.money);
    const hash = createPayloadHash(input);

    // Serializa concorrência por chave E por ID externo, inclusive
    // quando duas requisições apontam para wallets distintas.
    await lockIdempotencyKey(
      tx,
      input.idempotencyKey,
    );

    const db = {
      execute: <T = unknown>(
        sql: string,
        params: unknown[] = [],
      ): Promise<T> =>
        tx.getConnection().execute(
          sql,
          params,
          'all',
          tx.getTransactionContext(),
        ) as Promise<T>,
    };

    // Replay antes de bloquear a wallet: devolve resultado histórico
    // sem depender do saldo corrente ou do estado atual da wallet.
    const existing = await db.execute<TxRow[]>(
      `SELECT * FROM wager_transactions WHERE idempotency_key = ?`,
      [input.idempotencyKey],
    );

    if (existing.length) {
      if (existing[0].payload_hash !== hash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT');
      }
      return this.replay(existing[0]);
    }

    const sameExternal = await db.execute<TxRow[]>(
      `SELECT * FROM wager_transactions
       WHERE provider_id = ? AND external_transaction_id = ?`,
      [input.providerId, input.externalTransactionId],
    );

    if (sameExternal.length) {
      throw new DomainError('EXTERNAL_TRANSACTION_CONFLICT');
    }

    // Validação de domínio somente para novas operações.
    const operation = WagerTransaction.create({
      ...input,
      id: randomUUID(),
      money,
      payloadHash: hash,
      createdAt: new Date(),
    });

      // Serializa operações da mesma wallet.
      const wallets = await db.execute<WalletRow[]>(
        `SELECT * FROM wallets WHERE id = ? FOR UPDATE`,
        [input.walletId],
      );

      const row = wallets[0];
      if (!row) throw new DomainError('WALLET_NOT_FOUND');

      if (row.player_id !== input.playerId) {
        throw new DomainError('WALLET_PLAYER_MISMATCH');
      }

      if (row.currency !== money.currency) {
        throw new DomainError('CURRENCY_MISMATCH');
      }

      const wallet = Wallet.rehydrate({
        id: row.id,
        playerId: row.player_id,
        currency: row.currency,
        balance: Money.rehydrate({
          amount: row.balance,
          currency: row.currency,
        }),
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });

      let reference: WagerTransaction | undefined;
      let status: Status = Status.Processed;
      let failureCode: string | undefined;
      let referenceId: string | undefined;

      if (operation.requiresReference()) {
        const refs = await db.execute<TxRow[]>(
          `SELECT * FROM wager_transactions
           WHERE provider_id = ?
             AND external_transaction_id = ?`,
          [
            input.providerId,
            input.referenceExternalTransactionId,
          ],
        );

        if (!refs.length) {
          status = Status.PendingReference;
        } else {
          reference = this.hydrate(refs[0]);
          referenceId = reference.id;

          if (reference.status !== Status.Processed) {
            status = Status.PendingReference;
          } else {
            try {
              ReversalPolicy.validate(operation, reference);
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
              status = Status.Rejected;
              failureCode = error.code;
            }
          }
        }
      }

      // Reversão já processada do mesmo tipo.
      if (reference && status === Status.Processed) {
        const duplicates = await db.execute<{ id: string }[]>(
          `SELECT id FROM wager_transactions
           WHERE reference_transaction_id = ?
             AND kind = ?
             AND status IN ('PENDING',
                            'PENDING_REFERENCE',
                            'PROCESSED')`,
          [reference.id, operation.kind],
        );

        if (duplicates.length) {
          status = Status.Rejected;
          failureCode = 'REFERENCE_ALREADY_REVERSED';
        }
      }

      let entry: ReturnType<Wallet['credit']> | undefined;

      if (status === Status.Processed && operation.affectsBalance()) {
        try {
          const direction = operation.ledgerDirectionFor(reference);
          const movement = {
            transactionId: operation.id,
            ledgerEntryId: randomUUID(),
            money,
            at: new Date(),
          };

          entry = direction === LedgerDirection.Credit
            ? wallet.credit(movement)
            : wallet.debit(movement, operation.requiresReference());
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          status = Status.Rejected;
          failureCode = error.code;
        }
      }

      if (status === Status.Processed) {
        operation.markProcessed(referenceId, new Date());
      } else if (status === Status.PendingReference) {
        operation.markPendingReference();
      } else {
        operation.reject(failureCode ?? 'BUSINESS_RULE_REJECTED');
      }

      const balance = wallet.balance.toJSON();

      await db.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id,
          idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind,
          amount, currency, reference_external_transaction_id,
          reference_transaction_id, status, failure_code,
          result_balance, attempts, next_attempt_at,
          created_at, processed_at
        ) VALUES (
          ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?
        )`,
        [
          operation.id,
          operation.providerId,
          operation.externalTransactionId,
          operation.idempotencyKey,
          operation.payloadHash,
          operation.walletId,
          operation.playerId,
          operation.roundId,
          operation.gameId,
          operation.kind,
          operation.money.toJSON().amount,
          operation.money.currency,
          operation.referenceExternalTransactionId ?? null,
          operation.referenceTransactionId ?? null,
          operation.status,
          operation.failureCode ?? null,
          balance.amount,
          status === Status.PendingReference ? new Date() : null,
          operation.createdAt,
          operation.processedAt ?? null,
        ],
      );

      if (entry) {
        await db.execute(
          `UPDATE wallets
           SET balance = ?, version = ?, updated_at = ?
           WHERE id = ?`,
          [
            balance.amount,
            wallet.version,
            wallet.updatedAt,
            wallet.id,
          ],
        );

        await db.execute(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction,
            amount, currency, balance_before,
            balance_after, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            entry.id,
            entry.walletId,
            entry.transactionId,
            entry.direction,
            entry.money.toJSON().amount,
            entry.money.currency,
            entry.balanceBefore.toJSON().amount,
            entry.balanceAfter.toJSON().amount,
            entry.createdAt,
          ],
        );
      }

      // Eventos persistidos, nunca publicados aqui.
      const eventType =
        status === Status.Processed
          ? 'WagerTransactionProcessed'
          : status === Status.Rejected
            ? 'WagerTransactionRejected'
            : 'WagerTransactionPendingReference';

      await this.enqueue(tx, operation.id, eventType, {
        transactionId: operation.id,
        walletId: wallet.id,
        providerId: operation.providerId,
        status,
        failureCode,
      });

      if (entry) {
        await this.enqueue(tx, wallet.id, 'WalletBalanceChanged', {
          walletId: wallet.id,
          transactionId: operation.id,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        });
      }

      return {
        transactionId: operation.id,
        status,
        balance,
        failureCode,
        idempotentReplay: false,
      };
  }

  private hydrate(row: TxRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: Money.rehydrate({
        amount: row.amount,
        currency: row.currency,
      }),
      referenceExternalTransactionId:
        row.reference_external_transaction_id ?? undefined,
      referenceTransactionId:
        row.reference_transaction_id ?? undefined,
      status: row.status,
      failureCode: row.failure_code ?? undefined,
      createdAt: row.created_at,
      processedAt: row.processed_at ?? undefined,
    });
  }

  private replay(row: TxRow): ProcessWagerResult {
    return {
      transactionId: row.id,
      status: row.status as ProcessWagerResult['status'],
      balance: {
        amount: row.result_balance ?? (() => { throw new DomainError('HISTORICAL_BALANCE_MISSING'); })(),
        currency: row.currency,
      },
      failureCode: row.failure_code ?? undefined,
      idempotentReplay: true,
    };
  }

  private async enqueue(
    tx: EntityManager,
    aggregateId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const eventId = randomUUID();
    const occurredAt = new Date();

    await tx.getConnection().execute(
      `INSERT INTO outbox_messages (
        id, aggregate_id, event_type, payload,
        occurred_at, attempts
      ) VALUES (?, ?, ?, ?, ?, 0)`,
      [
        eventId,
        aggregateId,
        eventType,
        JSON.stringify({
          eventId,
          eventType,
          aggregateId,
          correlationId: aggregateId,
          version: 1,
          occurredAt: occurredAt.toISOString(),
          data,
        }),
        occurredAt,
      ],
      'all',
      tx.getTransactionContext(),
    );
  }
}
