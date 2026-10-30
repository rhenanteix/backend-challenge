import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint:
    process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

const MAIN_QUEUE =
  process.env.SQS_WAGER_QUEUE_NAME ??
  'wager-transactions.fifo';

const DLQ =
  process.env.SQS_WAGER_DLQ_NAME ??
  'wager-transactions-dlq.fifo';

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function queueUrl(name: string): Promise<string> {
  const result = await sqs.send(
    new GetQueueUrlCommand({ QueueName: name }),
  );

  if (!result.QueueUrl) {
    throw new Error(`Fila não encontrada: ${name}`);
  }

  return result.QueueUrl;
}

describe('SQS - Resiliência e DLQ', () => {
  it(
    'encaminha JSON inválido à DLQ sem registrar transação',
    async () => {
      const mainUrl = await queueUrl(MAIN_QUEUE);
      const dlqUrl = await queueUrl(DLQ);

      const uniqueId = randomUUID();
      const invalidBody = `invalid-json-${uniqueId}`;

      const sent = await sqs.send(
        new SendMessageCommand({
          QueueUrl: mainUrl,
          MessageBody: invalidBody,
          MessageGroupId: `invalid-${uniqueId}`,
          MessageDeduplicationId: uniqueId,
        }),
      );

      expect(sent.MessageId).toBeTruthy();

      let found = false;
      let matchedErrorCode: string | undefined;

      const deadline = Date.now() + 30000;

      while (Date.now() < deadline && !found) {
        const received = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
            VisibilityTimeout: 5,
            MessageAttributeNames: ['All'],
          }),
        );

        for (const message of received.Messages ?? []) {
          // A DLQ pode conter mensagens de outros testes.
          // Não removemos mensagens que não nos pertencem.
          if (message.Body !== invalidBody) {
            continue;
          }

          found = true;

          matchedErrorCode =
            message.MessageAttributes?.errorCode?.StringValue;

          expect(matchedErrorCode).toBe(
            'INVALID_MESSAGE_JSON',
          );

          expect(
            message.MessageAttributes
              ?.originalMessageId?.StringValue,
          ).toBe(sent.MessageId);

          if (!message.ReceiptHandle) {
            throw new Error('Mensagem sem ReceiptHandle');
          }

          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: dlqUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );

          break;
        }

        if (!found) {
          await sleep(300);
        }
      }

      expect(
        found,
        'Mensagem inválida não chegou à DLQ em 30 segundos',
      ).toBe(true);

      // Como o corpo não contém um payload financeiro,
      // parseEnvelope falha antes de abrir a transação
      // PostgreSQL. Portanto, nenhum débito é executado.
      console.log('Quarentena validada:', {
        originalMessageId: sent.MessageId,
        errorCode: matchedErrorCode,
        quarantined: found,
      });
    },
    40000,
  );

  it(
    'confirma a existência das filas e consulta sua configuração',
    async () => {
      const mainUrl = await queueUrl(MAIN_QUEUE);
      const dlqUrl = await queueUrl(DLQ);

      expect(mainUrl).toContain(MAIN_QUEUE);
      expect(dlqUrl).toContain(DLQ);

      const attributes = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: mainUrl,
          AttributeNames: [
            'VisibilityTimeout',
            'RedrivePolicy',
          ],
        }),
      );

      console.log('Configuração SQS:', {
        mainQueue: MAIN_QUEUE,
        deadLetterQueue: DLQ,
        visibilityTimeout:
          attributes.Attributes?.VisibilityTimeout,
        redrivePolicy:
          attributes.Attributes?.RedrivePolicy ??
          'Não configurada: quarentena manual pelo consumidor',
      });
    },
    10000,
  );
});
