
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';

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
    created_at: Date;
    processed_at: Date | null;
    attempts: number;
};

type WalletRow = {
    id: string;
    player_id: string;
    currency: string;
    balance: string;
    version: number;
    created_at: Date;
    updated_at: Date;
};

@Injectable()
export class RetryPendingReferences {
    private readonly logger = new Logger(RetryPendingReferences.name);
    private running = false;

    constructor(private readonly em: EntityManager) { }

    @Cron('*/10 * * * * *')
    async run(): Promise<void> {
        if (process.env.PENDING_RETRY_ENABLED !== 'true') return;
        if (this.running) return;

        this.running = true;

        try {
            const connection = this.em.fork().getConnection();

            const candidates = await connection.execute<{ id: string }[]>(
                `SELECT id
         FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE'
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY created_at, id
         LIMIT 20`,
            );

            for (const candidate of candidates) {
                try {
                    await this.reconcile(candidate.id);
                } catch (error: unknown) {
                    const message =
                        error instanceof Error ? error.message : String(error);

                    this.logger.error(
                        `Pending reconciliation failed: transactionId=${candidate.id} reason=${message}`,
                    );
                }
            }
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : String(error);

            this.logger.error(`Pending worker unavailable: ${message}`);
        } finally {
            this.running = false;
        }
    }

    private async reconcile(transactionId: string): Promise<void> {
        await this.em.fork().transactional(async (tx) => {
            const execute = <T = unknown>(
                sql: string,
                params: unknown[] = [],
            ): Promise<T> =>
                tx.getConnection().execute(
                    sql,
                    params,
                    'all',
                    tx.getTransactionContext(),
                ) as Promise<T>;

            // Identifica a carteira antes de adquirir bloqueios.
            const candidates = await execute<{ wallet_id: string }[]>(
                `SELECT wallet_id
         FROM wager_transactions
         WHERE id = ?
           AND status = 'PENDING_REFERENCE'`,
                [transactionId],
            );

            if (!candidates.length) return;

            // Mesma ordem de bloqueio do processamento financeiro:
            // wallet -> transação pendente.
            const wallets = await execute<WalletRow[]>(
                `SELECT * FROM wallets WHERE id = ? FOR UPDATE`,
                [candidates[0].wallet_id],
            );

            if (!wallets.length) {
                throw new Error('WALLET_NOT_FOUND');
            }

            const pendingRows = await execute<TxRow[]>(
                `SELECT *
         FROM wager_transactions
         WHERE id = ?
         FOR UPDATE`,
                [transactionId],
            );

            const pendingRow = pendingRows[0];

            if (!pendingRow || pendingRow.status !== Status.PendingReference) {
                return;
            }

            const operation = this.hydrate(pendingRow);
            const walletRow = wallets[0];

            const wallet = Wallet.rehydrate({
                id: walletRow.id,
                playerId: walletRow.player_id,
                currency: walletRow.currency,
                balance: Money.rehydrate({
                    amount: walletRow.balance,
                    currency: walletRow.currency,
                }),
                version: walletRow.version,
                createdAt: walletRow.created_at,
                updatedAt: walletRow.updated_at,
            });

            const refs = await execute<TxRow[]>(
                `SELECT *
         FROM wager_transactions
         WHERE provider_id = ?
           AND external_transaction_id = ?`,
                [
                    operation.providerId,
                    operation.referenceExternalTransactionId,
                ],
            );

            const referenceRow = refs[0];

            if (!referenceRow || referenceRow.status === Status.PendingReference) {
                await this.retryOrFail(execute, pendingRow);
                return;
            }

            if (referenceRow.status === Status.Pending) {
                await this.retryOrFail(execute, pendingRow);
                return;
            }

            const reference = this.hydrate(referenceRow);

            let failureCode: string | undefined;
            let entry: ReturnType<Wallet['credit']> | undefined;

            if (reference.status !== Status.Processed) {
                failureCode = 'REFERENCE_NOT_PROCESSED';
            } else {
                try {
                    ReversalPolicy.validate(operation, reference);

                    const duplicates = await execute<{ id: string }[]>(
                        `SELECT id
             FROM wager_transactions
             WHERE provider_id = ?
               AND reference_external_transaction_id = ?
               AND kind = ?
               AND id <> ?
               AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')`,
                        [
                            operation.providerId,
                            operation.referenceExternalTransactionId,
                            operation.kind,
                            operation.id,
                        ],
                    );

                    if (duplicates.length) {
                        throw new DomainError('REFERENCE_ALREADY_REVERSED');
                    }

                    const direction = operation.ledgerDirectionFor(reference);

                    const movement = {
                        transactionId: operation.id,
                        ledgerEntryId: randomUUID(),
                        money: operation.money,
                        at: new Date(),
                    };

                    entry =
                        direction === LedgerDirection.Credit
                            ? wallet.credit(movement)
                            : wallet.debit(movement, true);
                } catch (error: unknown) {
                    if (!(error instanceof DomainError)) throw error;
                    failureCode = error.code;
                }
            }

            const processedAt = new Date();

            if (failureCode) {
                operation.reject(failureCode);
            } else {
                operation.markProcessed(reference.id, processedAt);
            }

            const balance = wallet.balance.toJSON();

            await execute(
                `UPDATE wager_transactions
         SET status = ?,
             reference_transaction_id = ?,
             failure_code = ?,
             result_balance = ?,
             processed_at = ?,
             next_attempt_at = NULL
         WHERE id = ?
           AND status = 'PENDING_REFERENCE'`,
                [
                    operation.status,
                    reference.id,
                    operation.failureCode ?? null,
                    balance.amount,
                    failureCode ? null : processedAt,
                    operation.id,
                ],
            );

            if (entry) {
                await execute(
                    `UPDATE wallets
           SET balance = ?,
               version = ?,
               updated_at = ?
           WHERE id = ?`,
                    [
                        balance.amount,
                        wallet.version,
                        wallet.updatedAt,
                        wallet.id,
                    ],
                );

                await execute(
                    `INSERT INTO wallet_ledger_entries (
             id, wallet_id, transaction_id, direction,
             amount, currency, balance_before,
             balance_after, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

            await this.enqueue(
                execute,
                operation.id,
                failureCode
                    ? 'WagerTransactionRejected'
                    : 'WagerTransactionProcessed',
                {
                    transactionId: operation.id,
                    walletId: wallet.id,
                    providerId: operation.providerId,
                    status: operation.status,
                    failureCode,
                },
            );

            if (entry) {
                await this.enqueue(
                    execute,
                    wallet.id,
                    'WalletBalanceChanged',
                    {
                        walletId: wallet.id,
                        transactionId: operation.id,
                        direction: entry.direction,
                        money: entry.money.toJSON(),
                        balanceBefore: entry.balanceBefore.toJSON(),
                        balanceAfter: entry.balanceAfter.toJSON(),
                        walletVersion: wallet.version,
                    },
                );
            }

            this.logger.log(
                `Pending reference resolved: transactionId=${operation.id} status=${operation.status}`,
            );
        });
    }

    private async retryOrFail(
        execute: <T = unknown>(
            sql: string,
            params?: unknown[],
        ) => Promise<T>,
        row: TxRow,
    ): Promise<void> {
        const attempts = row.attempts + 1;
        const maxAttempts = 20;

        if (attempts >= maxAttempts) {
            await execute(
                `UPDATE wager_transactions
         SET status = 'FAILED',
             failure_code = 'REFERENCE_TIMEOUT',
             attempts = ?,
             next_attempt_at = NULL
         WHERE id = ?
           AND status = 'PENDING_REFERENCE'`,
                [attempts, row.id],
            );

            await this.enqueue(
                execute,
                row.id,
                'WagerTransactionFailed',
                {
                    transactionId: row.id,
                    status: Status.Failed,
                    failureCode: 'REFERENCE_TIMEOUT',
                },
            );

            return;
        }

        const delaySeconds = Math.min(
            300,
            2 ** Math.min(attempts, 8),
        );

        await execute(
            `UPDATE wager_transactions
       SET attempts = ?,
           next_attempt_at =
             now() + (? * interval '1 second')
       WHERE id = ?
         AND status = 'PENDING_REFERENCE'`,
            [attempts, delaySeconds, row.id],
        );
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

    private async enqueue(
        execute: <T = unknown>(
            sql: string,
            params?: unknown[],
        ) => Promise<T>,
        aggregateId: string,
        eventType: string,
        data: Record<string, unknown>,
    ): Promise<void> {
        const eventId = randomUUID();
        const occurredAt = new Date();

        await execute(
            `INSERT INTO outbox_messages (
         id, aggregate_id, event_type,
         payload, occurred_at, attempts
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
        );
    }
}
