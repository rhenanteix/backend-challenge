
import { describe, expect, test } from 'bun:test';
import { Money } from './money';

describe('Money', () => {
  test('soma valores com precisão', () => {
    const a = Money.from({
      amount: '0.10',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '0.20',
      currency: 'BRL',
    });

    expect(a.add(b).toJSON().amount).toBe('0.30');
  });

  test('rejeita valores negativos na entrada', () => {
    expect(() =>
      Money.from({
        amount: '-10.00',
        currency: 'BRL',
      }),
    ).toThrow();
  });

  test('rejeita moedas diferentes', () => {
    const brl = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => brl.add(usd)).toThrow(
      'CURRENCY_MISMATCH',
    );
  });

  test('rejeita mais de duas casas decimais', () => {
    expect(() =>
      Money.from({
        amount: '10.999',
        currency: 'BRL',
      }),
    ).toThrow();
  });
});
