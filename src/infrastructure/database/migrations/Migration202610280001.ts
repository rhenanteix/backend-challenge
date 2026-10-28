
import { Migration } from '@mikro-orm/migrations';

export class Migration202610280001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(20,2) NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT uq_wallet_player_currency
          UNIQUE (player_id, currency),
        CONSTRAINT ck_wallet_balance
          CHECK (balance >= 0),
        CONSTRAINT ck_wallet_version
          CHECK (version >= 1),
        CONSTRAINT ck_wallet_currency
          CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(120) NOT NULL,
        external_transaction_id VARCHAR(200) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(200) NOT NULL,
        game_id VARCHAR(200) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(20,2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(200),
        reference_transaction_id UUID
          REFERENCES wager_transactions(id),
        status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
        failure_code VARCHAR(100),
        result_balance NUMERIC(20,2),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,

        CONSTRAINT uq_wager_provider_external
          UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_idempotency
          UNIQUE (idempotency_key),
        CONSTRAINT ck_wager_amount
          CHECK (amount > 0),
        CONSTRAINT ck_wager_currency
          CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wager_kind
          CHECK (kind IN (
            'OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'
          )),
        CONSTRAINT ck_wager_status
          CHECK (status IN (
            'PENDING','PENDING_REFERENCE',
            'PROCESSED','REJECTED','FAILED'
          )),
        CONSTRAINT ck_wager_reference
          CHECK (
            kind NOT IN ('REFUND','ROLLBACK')
            OR reference_external_transaction_id IS NOT NULL
          ),
        CONSTRAINT ck_wager_attempts
          CHECK (attempts >= 0)
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_reversal_type
      ON wager_transactions (reference_transaction_id, kind)
      WHERE kind IN ('REFUND', 'ROLLBACK')
        AND status = 'PROCESSED';
    `);

    this.addSql(`
      CREATE INDEX idx_wager_pending_reference
      ON wager_transactions (next_attempt_at, created_at)
      WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL
          REFERENCES wager_transactions(id),
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(20,2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(20,2) NOT NULL,
        balance_after NUMERIC(20,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT uq_ledger_transaction_wallet
          UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ck_ledger_direction
          CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ck_ledger_amount
          CHECK (amount > 0),
        CONSTRAINT ck_ledger_balances
          CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ck_ledger_arithmetic
          CHECK (
            (direction = 'CREDIT'
              AND balance_after = balance_before + amount)
            OR
            (direction = 'DEBIT'
              AND balance_after = balance_before - amount)
          )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_cursor
      ON wallet_ledger_entries (wallet_id, created_at, id);
    `);

    this.addSql(`
      CREATE FUNCTION prevent_ledger_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'LEDGER_IMMUTABLE';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(150) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,

        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(150) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,

        CONSTRAINT ck_outbox_attempts
          CHECK (attempts >= 0)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_pending
      ON outbox_messages (next_attempt_at, occurred_at)
      WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS prevent_ledger_mutation();');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
