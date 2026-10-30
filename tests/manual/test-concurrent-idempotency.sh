
#!/usr/bin/env bash
set -euo pipefail

export AWS_PAGER=""

WALLET_ID="${1:?Informe o walletId}"
PLAYER_ID="${2:?Informe o playerId}"

UUID_REGEX='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

if [[ ! "$WALLET_ID" =~ $UUID_REGEX ]]; then
  echo "ERRO: walletId inválido: $WALLET_ID"
  exit 1
fi

if [[ ! "$PLAYER_ID" =~ $UUID_REGEX ]]; then
  echo "ERRO: playerId inválido: $PLAYER_ID"
  exit 1
fi

QUEUE_URL="http://localhost:4566/000000000000/wager-transactions.fifo"
ENDPOINT="http://localhost:4566"

send_bet() {
  local EVENT_ID="$1"
  local GROUP_ID="$2"
  local DEDUP_ID="$3"

  local BODY

  BODY=$(cat <<EOF
{
  "schemaVersion": 1,
  "eventId": "$EVENT_ID",
  "payload": {
    "providerId": "jungle-provider",
    "externalTransactionId": "idem-concurrent-002",
    "idempotencyKey": "idem-concurrent-002",
    "playerId": "$PLAYER_ID",
    "walletId": "$WALLET_ID",
    "roundId": "round-idem-001",
    "gameId": "slot-001",
    "kind": "BET",
    "money": {
      "amount": "5.00",
      "currency": "BRL"
    }
  }
}
EOF
)

  aws --no-cli-pager \
    --endpoint-url="$ENDPOINT" \
    sqs send-message \
    --region us-east-1 \
    --queue-url "$QUEUE_URL" \
    --message-group-id "$GROUP_ID" \
    --message-deduplication-id "$DEDUP_ID" \
    --message-body "$BODY" \
    --output json \
    > "/tmp/${EVENT_ID}.json"
}

echo "Enviando duas mensagens concorrentes..."

send_bet \
  "event-idem-a-002" \
  "idem-group-a" \
  "idem-dedup-a-002" &

PID_A=$!

send_bet \
  "event-idem-b-002" \
  "idem-group-b" \
  "idem-dedup-b-002" &

PID_B=$!

wait "$PID_A"
wait "$PID_B"

echo "As duas mensagens foram enviadas."

echo "Mensagem A:"
cat /tmp/event-idem-a-002.json

echo "Mensagem B:"
cat /tmp/event-idem-b-002.json

echo
echo "Aguardando processamento..."
sleep 5

echo
echo "Transações:"
docker exec jungle-postgres \
  psql -U jungle -d jungle_wagering -c "
SELECT
  id,
  external_transaction_id,
  idempotency_key,
  status,
  amount,
  result_balance
FROM wager_transactions
WHERE wallet_id = '$WALLET_ID'
ORDER BY created_at;
"

echo
echo "Saldo:"
docker exec jungle-postgres \
  psql -U jungle -d jungle_wagering -c "
SELECT id, balance, version
FROM wallets
WHERE id = '$WALLET_ID';
"

echo
echo "Ledger:"
docker exec jungle-postgres \
  psql -U jungle -d jungle_wagering -c "
SELECT direction, amount, balance_before, balance_after
FROM wallet_ledger_entries
WHERE wallet_id = '$WALLET_ID'
ORDER BY created_at;
"

echo
echo "Verificação da idempotência:"
docker exec jungle-postgres \
  psql -U jungle -d jungle_wagering -c "
SELECT
  COUNT(*) AS transaction_count
FROM wager_transactions
WHERE wallet_id = '$WALLET_ID'
  AND idempotency_key = 'idem-concurrent-002';
"
