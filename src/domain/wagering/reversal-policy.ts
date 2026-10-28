
import { DomainError } from '../shared/domain-error.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

export class ReversalPolicy {
  static validate(
    operation: WagerTransaction,
    reference: WagerTransaction,
  ): void {
    if (!operation.requiresReference()) {
      throw new DomainError('INVALID_REVERSAL_KIND');
    }

    if (
      operation.providerId !== reference.providerId ||
      operation.playerId !== reference.playerId ||
      operation.walletId !== reference.walletId ||
      operation.roundId !== reference.roundId ||
      operation.money.currency !== reference.money.currency
    ) {
      throw new DomainError('REFERENCE_CONTEXT_MISMATCH');
    }

    if (
      operation.referenceExternalTransactionId !==
      reference.externalTransactionId
    ) {
      throw new DomainError('REFERENCE_ID_MISMATCH');
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new DomainError('REFERENCE_NOT_PROCESSED');
    }

    if (!operation.money.equals(reference.money)) {
      throw new DomainError('REVERSAL_AMOUNT_MISMATCH');
    }

    if (
      operation.kind === WagerTransactionKind.Refund &&
      reference.kind !== WagerTransactionKind.Bet
    ) {
      throw new DomainError('INVALID_REFUND_REFERENCE');
    }

    if (
      operation.kind === WagerTransactionKind.Rollback &&
      ![
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ].includes(reference.kind)
    ) {
      throw new DomainError('INVALID_ROLLBACK_REFERENCE');
    }
  }
}
