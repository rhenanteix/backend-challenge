
import type { MoneyProps } from '../../domain/money/money.js';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status:
    | 'PROCESSED'
    | 'REJECTED'
    | 'PENDING_REFERENCE';
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}
