
import { Migration } from '@mikro-orm/migrations';

export class Migration202610300001 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        uq_wager_active_reversal_reference
      ON wager_transactions (
        provider_id,
        reference_external_transaction_id,
        kind
      )
      WHERE kind IN ('REFUND', 'ROLLBACK')
        AND status IN (
          'PENDING',
          'PENDING_REFERENCE',
          'PROCESSED'
        );
    `);
    }

    async down(): Promise<void> {
        this.addSql(`
      DROP INDEX IF EXISTS
        uq_wager_active_reversal_reference;
    `);
    }
}
