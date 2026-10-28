
import { Money } from '../money/money.js';
import {
  DomainError,
  InvalidTransactionStateError,
} from '../shared/domain-error.js';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'status' | 'referenceTransactionId' |
  'failureCode' | 'processedAt'
>;

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: string,
    private _processedAt?: Date,
  ) {}

  static create(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError('OPENING_IS_INTERNAL');
    }

    if (!props.money.isPositive()) {
      throw new DomainError('INVALID_TRANSACTION_AMOUNT');
    }

    const requiresReference = [
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ].includes(props.kind);

    if (
      requiresReference &&
      !props.referenceExternalTransactionId
    ) {
      throw new DomainError('REFERENCE_REQUIRED');
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(
    state: WagerTransactionState,
  ): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt
        ? new Date(state.processedAt)
        : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt)
      : undefined;
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return [
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ].includes(this.kind);
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  markProcessed(
    referenceId: string | undefined,
    at: Date,
  ): void {
    this.assertActive();
    this._referenceTransactionId = referenceId;
    this._processedAt = new Date(at);
    this._status = WagerTransactionStatus.Processed;
  }

  markPendingReference(): void {
    this.assertActive();
    if (!this.requiresReference()) {
      throw new DomainError('REFERENCE_NOT_REQUIRED');
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: string): void {
    this.assertActive();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: string): void {
    this.assertActive();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new DomainError('REFERENCE_REQUIRED');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;

      case WagerTransactionKind.Loss:
        throw new DomainError('TRANSACTION_HAS_NO_LEDGER');
    }
  }

  private assertActive(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError();
    }
  }
}
