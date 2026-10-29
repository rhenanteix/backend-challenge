
import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Serializa operações concorrentes com a mesma chave
 * de idempotência, independentemente da wallet.
 *
 * O lock é liberado automaticamente ao finalizar
 * a transação PostgreSQL.
 */
export async function lockIdempotencyKey(
  tx: EntityManager,
  key: string,
): Promise<void> {
  if (!key?.trim()) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  await tx.getConnection().execute(
    `SELECT pg_advisory_xact_lock(
      hashtextextended(?, 0)
    )`,
    [key],
    'all',
    tx.getTransactionContext(),
  );
}
