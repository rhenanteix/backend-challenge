
import { SQSClient } from '@aws-sdk/client-sqs';
import { Provider } from '@nestjs/common';
import { SQS_CLIENT } from './sqs.constants.js';

export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  useFactory: () => {
    return new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT || undefined,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey:
          process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  },
};
