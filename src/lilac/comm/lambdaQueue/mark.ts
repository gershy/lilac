import { SendMessageCommand as Msg } from '@aws-sdk/client-sqs';
import { LambdaQueue } from './base';
import { Logger } from '../../../../boot/util/logger';

export class LambdaQueueMarker<Args extends Json> extends LambdaQueue<Args> {
  
  public async put(args: { logger: Logger, args: Args }) {
    
    // TODO: Logging??
    
    const body = args.args;
    const url = process.env.queue_url!;
    return args.logger.scope('sqs.put', { url, args: body }, () => this.sqsClient.send(new Msg({
      QueueUrl: url, // Note the Queue Lilac ensures this is available on its handler
      MessageBody: JSON.stringify(body)
    })));
    
  }
  
};