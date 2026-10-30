import { describe, expect, test } from 'vitest';
import { Money } from '../money/money.js';
import { Wallet } from './wallet.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

const brl = (amount: string) =>
  Money.from({ amount, currency: 'BRL' });

function createWallet(balance = '100.00'): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function movement(amount: string) {
  return {
    transactionId: crypto.randomUUID(),
    ledgerEntryId: crypto.randomUUID(),
    money: brl(amount),
    at: new Date(),
  };
}

describe('Wallet', () => {
  test('deve debitar uma aposta', () => {
    const wallet = createWallet();
    const entry = wallet.debit(movement('25.00'));

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('deve creditar um prêmio', () => {
    const wallet = createWallet();
    const entry = wallet.credit(movement('50.00'));

    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('deve rejeitar saldo insuficiente', () => {
    const wallet = createWallet();

    expect(() =>
      wallet.debit(movement('150.00')),
    ).toThrow('INSUFFICIENT_FUNDS');

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('deve distinguir reversão sem saldo', () => {
    const wallet = createWallet('10.00');

    expect(() =>
      wallet.debit(movement('20.00'), true),
    ).toThrow('REVERSAL_INSUFFICIENT_FUNDS');
  });

  test('não permite moeda diferente', () => {
    const wallet = createWallet();

    expect(() =>
      wallet.credit({
        ...movement('10.00'),
        money: Money.from({
          amount: '10.00',
          currency: 'USD',
        }),
      }),
    ).toThrow('CURRENCY_MISMATCH');
  });

  test('não altera saldo após movimento inválido', () => {
    const wallet = createWallet();

    expect(() =>
      wallet.credit(movement('0.00')),
    ).toThrow('INVALID_MOVEMENT_AMOUNT');

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

test('crédito de abertura mantém versão 1', () => {
  const wallet = Wallet.open({
    id: 'wallet-opening',
    playerId: 'player-opening',
    initialBalance: brl('100.00'),
  });

  const entry = wallet.openingCredit(movement('100.00'));

  expect(wallet.balance.toJSON().amount).toBe('100.00');
  expect(wallet.version).toBe(1);
  expect(entry.isBalanced()).toBe(true);
});

