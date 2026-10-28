
import { Money } from '../money/money.js';
import {
  DomainError,
  InsufficientFundsError,
  ReversalInsufficientFundsError,
} from '../shared/domain-error.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  transactionId: string;
  ledgerEntryId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at?: Date;
  }): Wallet {
    const at = props.at ?? new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      Money.zero(props.initialBalance.currency),
      1,
      new Date(at),
      new Date(at),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(
    props: WalletMovement,
    reversal = false,
  ): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    this.assertPositive(props.money);

    if (this._balance.isLessThan(props.money)) {
      if (reversal) {
        throw new ReversalInsufficientFundsError();
      }
      throw new InsufficientFundsError();
    }

    return this.move(props, LedgerDirection.Debit);
  }

  credit(props: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    this.assertPositive(props.money);

    return this.move(props, LedgerDirection.Credit);
  }

  private move(
    props: WalletMovement,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    const before = this._balance;

    const after = direction === LedgerDirection.Credit
      ? before.add(props.money)
      : before.subtract(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = new Date(props.at);

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH');
    }
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new DomainError('INVALID_MOVEMENT_AMOUNT');
    }
  }


  openingCredit(props: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    this.assertPositive(props.money);

    if (this._version !== 1 || !this._balance.isZero()) {
      throw new DomainError('INVALID_OPENING_STATE');
    }

    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: this._balance.add(props.money),
      createdAt: props.at,
    });

    this._balance = entry.balanceAfter;
    this._updatedAt = new Date(props.at);

    return entry;
  }

}
