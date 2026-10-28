
import { EntitySchema } from '@mikro-orm/core';

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balance: { type: 'decimal', precision: 20, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at' },
  },
});

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: string;
  failureCode?: string;
  resultBalance?: string;
  attempts: number;
  nextAttemptAt?: Date;
  createdAt: Date;
  processedAt?: Date;
}

export const WagerTransactionSchema =
  new EntitySchema<WagerTransactionRecord>({
    name: 'WagerTransactionRecord',
    tableName: 'wager_transactions',
    properties: {
      id: { type: 'uuid', primary: true },
      providerId: { type: 'string', fieldName: 'provider_id' },
      externalTransactionId: {
        type: 'string',
        fieldName: 'external_transaction_id',
      },
      idempotencyKey: {
        type: 'string',
        fieldName: 'idempotency_key',
      },
      payloadHash: { type: 'string', fieldName: 'payload_hash' },
      walletId: { type: 'uuid', fieldName: 'wallet_id' },
      playerId: { type: 'uuid', fieldName: 'player_id' },
      roundId: { type: 'string', fieldName: 'round_id' },
      gameId: { type: 'string', fieldName: 'game_id' },
      kind: { type: 'string' },
      amount: { type: 'decimal', precision: 20, scale: 2 },
      currency: { type: 'string', length: 3 },
      referenceExternalTransactionId: {
        type: 'string',
        fieldName: 'reference_external_transaction_id',
        nullable: true,
      },
      referenceTransactionId: {
        type: 'uuid',
        fieldName: 'reference_transaction_id',
        nullable: true,
      },
      status: { type: 'string' },
      failureCode: {
        type: 'string',
        fieldName: 'failure_code',
        nullable: true,
      },
      resultBalance: {
        type: 'decimal',
        precision: 20,
        scale: 2,
        fieldName: 'result_balance',
        nullable: true,
      },
      attempts: { type: 'integer' },
      nextAttemptAt: {
        type: 'datetime',
        fieldName: 'next_attempt_at',
        nullable: true,
      },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
      processedAt: {
        type: 'datetime',
        fieldName: 'processed_at',
        nullable: true,
      },
    },
  });

export const LedgerSchema = new EntitySchema({
  name: 'LedgerRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', length: 3 },
    balanceBefore: {
      type: 'decimal', precision: 20, scale: 2,
      fieldName: 'balance_before',
    },
    balanceAfter: {
      type: 'decimal', precision: 20, scale: 2,
      fieldName: 'balance_after',
    },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
  },
});

export const InboxSchema = new EntitySchema({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: {
      type: 'string', fieldName: 'consumer_name',
      primary: true,
    },
    messageId: {
      type: 'string', fieldName: 'message_id',
      primary: true,
    },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    receivedAt: { type: 'datetime', fieldName: 'received_at' },
    processedAt: {
      type: 'datetime', fieldName: 'processed_at',
      nullable: true,
    },
  },
});

export const OutboxSchema = new EntitySchema({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime', fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: {
      type: 'datetime', fieldName: 'next_attempt_at',
      nullable: true,
    },
    publishedAt: {
      type: 'datetime', fieldName: 'published_at',
      nullable: true,
    },
  },
});

export const databaseEntities = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerSchema,
  InboxSchema,
  OutboxSchema,
];
