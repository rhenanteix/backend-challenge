
import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

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


test('não sofre erro de ponto flutuante', () => {
  const a = Money.from({ amount: '0.10', currency: 'BRL' });
  const b = Money.from({ amount: '0.20', currency: 'BRL' });

  expect(a.add(b).toJSON().amount).toBe('0.30');
});

test('rejeita notação científica', () => {
  expect(() => Money.from({
    amount: '1e3',
    currency: 'BRL',
  })).toThrow();
});

test('não modifica os operandos', () => {
  const a = Money.from({ amount: '10.00', currency: 'BRL' });
  const b = Money.from({ amount: '5.00', currency: 'BRL' });

  const result = a.add(b);

  expect(a.toJSON().amount).toBe('10.00');
  expect(b.toJSON().amount).toBe('5.00');
  expect(result.toJSON().amount).toBe('15.00');
});

test('suporta resultado negativo interno', () => {
  const a = Money.from({ amount: '5.00', currency: 'BRL' });
  const b = Money.from({ amount: '10.00', currency: 'BRL' });

  expect(a.subtract(b).toJSON().amount).toBe('-5.00');
});

