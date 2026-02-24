import { SQSClient } from '@aws-sdk/client-sqs';

export type LambdaQueueArgs = {};
export class LambdaQueue<Event extends Json> {
  
  protected readonly sqsClient: SQSClient;
  constructor(args: LambdaQueueArgs & { sqsClient?: SQSClient }) {
    this.sqsClient = args.sqsClient ?? new SQSClient({});
  }
  
};