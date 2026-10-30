import { DomainError } from '../../../domain/shared/domain-error.js';
import { InvalidWagerMessageError } from './invalid-wager-message.error.js';

export type WagerErrorClassification = {
  category: 'PERMANENT' | 'TRANSIENT';
  code: string;
};

const PERMANENT_DOMAIN_CODES = new Set([
  'IDEMPOTENCY_CONFLICT',
  'EXTERNAL_TRANSACTION_CONFLICT',
  'WALLET_PLAYER_MISMATCH',
  'CURRENCY_MISMATCH',
  'IDEMPOTENCY_KEY_REQUIRED',
  'OPENING_IS_INTERNAL',
]);

export function classifyWagerError(
  error: unknown,
): WagerErrorClassification {
  if (error instanceof InvalidWagerMessageError) {
    return {
      category: 'PERMANENT',
      code: error.code,
    };
  }

  if (error instanceof DomainError) {
    return {
      category: PERMANENT_DOMAIN_CODES.has(error.code)
        ? 'PERMANENT'
        : 'TRANSIENT',
      code: error.code,
    };
  }

  return {
    category: 'TRANSIENT',
    code: error instanceof Error
      ? error.message
      : 'UNKNOWN_ERROR',
  };
}