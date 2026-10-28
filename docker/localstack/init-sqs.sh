
#!/bin/bash
set -euo pipefail

echo "Creating SQS queues..."

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_URL=$(awslocal sqs get-queue-url \
  --queue-name wager-transactions-dlq.fifo \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

REDRIVE_POLICY=$(printf \
  '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' \
  "$DLQ_ARN")

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes \
  FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=60,RedrivePolicy="$REDRIVE_POLICY"

echo "SQS queues created."
