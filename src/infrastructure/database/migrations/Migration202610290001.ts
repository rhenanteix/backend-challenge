
import { Migration } from '@mikro-orm/migrations';

export class Migration202610290001 extends Migration {
  async up(): Promise<void> {
    // Proteção de unicidade dos IDs de entrada.
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        uq_wager_provider_external_v6
      ON wager_transactions (
        provider_id,
        external_transaction_id
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        uq_wager_idempotency_v6
      ON wager_transactions (idempotency_key);
    `);

    // Uma mensagem só pode ser marcada como processada
    // depois de a operação financeira ser concluída.
    this.addSql(`
      ALTER TABLE inbox_messages
      ADD COLUMN IF NOT EXISTS
        processing_started_at timestamptz;
    `);

    this.addSql(`
      ALTER TABLE inbox_messages
      ADD COLUMN IF NOT EXISTS
        last_error text;
    `);

    // Tentativas de referências ainda não disponíveis.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS
        idx_wager_pending_retry_v6
      ON wager_transactions (
        next_attempt_at,
        created_at
      )
      WHERE status = 'PENDING_REFERENCE';
    `);

    // A Outbox poderá ser disputada por múltiplos workers.
    this.addSql(`
      CREATE INDEX IF NOT EXISTS
        idx_outbox_pending_v6
      ON outbox_messages (
        next_attempt_at,
        occurred_at
      )
      WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS idx_outbox_pending_v6;
    `);

    this.addSql(`
      DROP INDEX IF EXISTS idx_wager_pending_retry_v6;
    `);

    this.addSql(`
      ALTER TABLE inbox_messages
      DROP COLUMN IF EXISTS last_error;
    `);

    this.addSql(`
      ALTER TABLE inbox_messages
      DROP COLUMN IF EXISTS processing_started_at;
    `);

    this.addSql(`
      DROP INDEX IF EXISTS uq_wager_idempotency_v6;
    `);

    this.addSql(`
      DROP INDEX IF EXISTS uq_wager_provider_external_v6;
    `);
  }
}
