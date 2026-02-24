import { Logger } from '../../../../boot/util/logger';

export class LambdaEmailViewer {
  
  protected domain: string;
  constructor(args: { domain: string }) {
    this.domain = args.domain;
  }
  
  public read(args: { logger: Logger }) {
    
    const { logger, ...more } = args;
    
    return logger.scope('email.consume', {}, logger => {
      throw Error('not implemented');
    });
    
  }
  
}