
import { describe, expect, test } from 'vitest';
import { Money } from '../money/money.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction.js';
import { ReversalPolicy } from './reversal-policy.js';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.js';

function transaction(
  kind: Kind,
  referenceExternalTransactionId?: string,
) {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    payloadHash: 'hash-123',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({
      amount: '25.00',
      currency: 'BRL',
    }),
    referenceExternalTransactionId,
    createdAt: new Date(),
  });
}

describe('WagerTransaction', () => {
  test('nasce como PENDING', () => {
    const bet = transaction(Kind.Bet);
    expect(bet.status).toBe(Status.Pending);
  });

  test('BET gera direção DEBIT', () => {
    expect(transaction(Kind.Bet).ledgerDirectionFor())
      .toBe(LedgerDirection.Debit);
  });

  test('WIN gera direção CREDIT', () => {
    expect(transaction(Kind.Win).ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
  });

  test('LOSS não gera ledger', () => {
    const loss = transaction(Kind.Loss);
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow();
  });

  test('REFUND exige referência', () => {
    expect(() => transaction(Kind.Refund))
      .toThrow('REFERENCE_REQUIRED');
  });

  test('ROLLBACK inverte uma BET', () => {
    const bet = transaction(Kind.Bet);
    bet.markProcessed(undefined, new Date());

    const rollback = transaction(
      Kind.Rollback,
      bet.externalTransactionId,
    );

    ReversalPolicy.validate(rollback, bet);

    expect(rollback.ledgerDirectionFor(bet))
      .toBe(LedgerDirection.Credit);
  });

  test('REFUND válido referencia BET processada', () => {
    const bet = transaction(Kind.Bet);
    bet.markProcessed(undefined, new Date());

    const refund = transaction(
      Kind.Refund,
      bet.externalTransactionId,
    );

    expect(() =>
      ReversalPolicy.validate(refund, bet),
    ).not.toThrow();
  });

  test('transação terminal não pode mudar de estado', () => {
    const bet = transaction(Kind.Bet);
    bet.markProcessed(undefined, new Date());

    expect(() =>
      bet.reject('ANY_ERROR'),
    ).toThrow('INVALID_TRANSACTION_STATE');
  });

  test('payload divergente não é replay', () => {
    const bet = transaction(Kind.Bet);

    expect(bet.matchesPayload('hash-123')).toBe(true);
    expect(bet.matchesPayload('another-hash')).toBe(false);
  });

  test('referência ausente fica pendente', () => {
    const refund = transaction(Kind.Refund, 'missing-bet');

    refund.markPendingReference();

    expect(refund.status).toBe(Status.PendingReference);
  });
});
