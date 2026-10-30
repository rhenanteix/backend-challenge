import { describe, expect, test } from 'bun:test';

import {
  classifyWagerError,
} from '../../../src/infrastructure/messaging/errors/classify-wager-error.js';

import {
  InvalidWagerMessageError,
} from '../../../src/infrastructure/messaging/errors/invalid-wager-message.error.js';

import {
  DomainError,
  InsufficientFundsError,
} from '../../../src/domain/shared/domain-error.js';

describe('Classificação de erros SQS', () => {
  test('deve classificar conflito de idempotência como permanente', () => {
    const result = classifyWagerError(
      new DomainError('IDEMPOTENCY_CONFLICT'),
    );

    expect(result).toEqual({
      category: 'PERMANENT',
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  test('deve classificar conflito de transação externa como permanente', () => {
    const result = classifyWagerError(
      new DomainError('EXTERNAL_TRANSACTION_CONFLICT'),
    );

    expect(result.category).toBe('PERMANENT');
  });

  test('deve classificar JSON inválido como permanente', () => {
    const result = classifyWagerError(
      new InvalidWagerMessageError('INVALID_MESSAGE_JSON'),
    );

    expect(result).toEqual({
      category: 'PERMANENT',
      code: 'INVALID_MESSAGE_JSON',
    });
  });

  test('deve classificar conflito de Inbox como permanente', () => {
    const result = classifyWagerError(
      new InvalidWagerMessageError('INBOX_PAYLOAD_CONFLICT'),
    );

    expect(result.category).toBe('PERMANENT');
  });

  test('deve tratar carteira não encontrada como transitório', () => {
    const result = classifyWagerError(
      new DomainError('WALLET_NOT_FOUND'),
    );

    expect(result).toEqual({
      category: 'TRANSIENT',
      code: 'WALLET_NOT_FOUND',
    });
  });

  test('deve tratar falha de banco como transitória', () => {
    const result = classifyWagerError(
      new Error('ECONNREFUSED'),
    );

    expect(result).toEqual({
      category: 'TRANSIENT',
      code: 'ECONNREFUSED',
    });
  });

  test('não deve classificar erro de saldo insuficiente como permanente automaticamente', () => {
    const result = classifyWagerError(
      new InsufficientFundsError(),
    );

    expect(result.category).toBe('TRANSIENT');
  });

  test('deve tratar erros desconhecidos como transitórios', () => {
    const result = classifyWagerError(
      { unexpected: true },
    );

    expect(result).toEqual({
      category: 'TRANSIENT',
      code: 'UNKNOWN_ERROR',
    });
  });
});
