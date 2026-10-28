
import { Migration } from '@mikro-orm/migrations';

export class Migration202610280002 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS uq_wager_reversal_type;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_reversal_type
      ON wager_transactions (reference_transaction_id, kind)
      WHERE kind IN ('REFUND', 'ROLLBACK')
        AND status IN (
          'PENDING',
          'PENDING_REFERENCE',
          'PROCESSED'
        );
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      ADD CONSTRAINT ck_wager_result_balance
      CHECK (
        result_balance IS NULL
        OR result_balance >= 0
      );
    `);

    this.addSql(`
      CREATE INDEX idx_wager_wallet_created
      ON wager_transactions (wallet_id, created_at);
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS idx_wager_wallet_created;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP CONSTRAINT IF EXISTS ck_wager_result_balance;
    `);

    this.addSql(`
      DROP INDEX IF EXISTS uq_wager_reversal_type;
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_reversal_type
      ON wager_transactions (reference_transaction_id, kind)
      WHERE kind IN ('REFUND', 'ROLLBACK')
        AND status = 'PROCESSED';
    `);
  }
}
