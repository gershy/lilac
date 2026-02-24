import { Logger } from '../../../../boot/util/logger';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

export class LambdaEmailMarker {
  
  protected domain: string;
  constructor(args: { domain: string }) {
    this.domain = args.domain;
  }
  
  // Note the term "local" describes the part of the email before the "@"
  send(args: { logger: Logger, senderLocal: string, to: string[], cc: string[], bcc: string[], subject: string, body: string }) {
    
    return args.logger.scope('email.produce', {}, async logger => {
      
      const isHtml = false;
      const sesClient = new SESClient();
      
      const charset = { Charset: 'utf-8'[upper]() };
      await sesClient.send(new SendEmailCommand({
        Source: `${args.senderLocal}@${this.domain}`,
        // ReplyToAddresses: [ `${args.senderLocal}@${this.domain}` ],
        Destination: {
          ToAddresses: args.to,
          CcAddresses: args.cc,
          BccAddresses: args.bcc
        },
        Message: {
          Subject: { ...charset, Data: args.subject },
          Body: { [isHtml ? 'Text' : 'Html']: { ...charset, Data: args.body } }
        }
      }));
      
    });
    
  }
  
}