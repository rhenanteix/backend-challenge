#!/usr/bin/env bash
set -euo pipefail

export AWS_PAGER=""

WALLET_ID="def73aba-1dc1-4b87-ae00-db7c37173259"
PLAYER_ID="a8fa6122-c11c-42c7-be2d-44a832c93202"
QUEUE_URL="http://localhost:4566/000000000000/wager-transactions.fifo"
ENDPOINT="http://localhost:4566"

send_bet() {
  local EVENT_ID="$1"
  local AMOUNT="$2"
  local GROUP_ID="$3"

  local BODY
  BODY=$(cat <<JSON
{
  "schemaVersion": 1,
  "eventId": "$EVENT_ID",
  "payload": {
    "providerId": "jungle-provider",
    "externalTransactionId": "idem-conflict-001",
    "idempotencyKey": "idem-conflict-001",
    "playerId": "$PLAYER_ID",
    "walletId": "$WALLET_ID",
    "roundId": "round-conflict-001",
    "gameId": "slot-001",
    "kind": "BET",
    "money": {
      "amount": "$AMOUNT",
      "currency": "BRL"
    }
  }
}
JSON
)

  aws --no-cli-pager \
    --endpoint-url="$ENDPOINT" \
    sqs send-message \
    --region us-east-1 \
    --queue-url "$QUEUE_URL" \
    --message-group-id "$GROUP_ID" \
    --message-deduplication-id "$EVENT_ID" \
    --message-body "$BODY"
}

echo "Enviando BET válida de R$ 5,00..."
send_bet "event-conflict-a-001" "5.00" "conflict-group-a"

echo "Aguardando a primeira operação..."
sleep 5

echo "Enviando BET conflitante de R$ 10,00..."
send_bet "event-conflict-b-001" "10.00" "conflict-group-b"

echo "Aguardando processamento..."
sleep 5

echo "Transações:"
docker exec jungle-postgres psql -U jungle -d jungle_wagering -c "
SELECT external_transaction_id, idempotency_key,
       status, amount, result_balance
FROM wager_transactions
WHERE idempotency_key = 'idem-conflict-001';
"

echo "Saldo:"
docker exec jungle-postgres psql -U jungle -d jungle_wagering -c "
SELECT id, balance, version
FROM wallets
WHERE id = '$WALLET_ID';
"

echo "Inbox:"
docker exec jungle-postgres psql -U jungle -d jungle_wagering -c "
SELECT message_id, processed_at
FROM inbox_messages
WHERE message_id IN (
  'event-conflict-a-001',
  'event-conflict-b-001'
);
"
