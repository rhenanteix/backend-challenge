
import { createHash } from 'node:crypto';
import type { ProcessWagerInput } from './process-wager.types.js';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;

  return `{${Object.keys(obj)
    .filter(key => obj[key] !== undefined)
    .sort()
    .map(key =>
      `${JSON.stringify(key)}:${canonicalize(obj[key])}`,
    )
    .join(',')}}`;
}

export function createPayloadHash(
  input: ProcessWagerInput,
): string {
  const payload = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    referenceExternalTransactionId:
      input.referenceExternalTransactionId ?? null,
  };

  return createHash('sha256')
    .update(canonicalize(payload))
    .digest('hex');
}
