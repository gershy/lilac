export class LambdaEmailKeeper {
  private domain: string;
  constructor(args: { domain: string }) {
    this.domain = args.domain;
  }
  public async read(args: any) {
    const { logger, ...email } = args;
    logger.log({ msg: 'view email', domain: this.domain, email });
  }
  public async send(args: any) {
    const { logger, ...email } = args;
    logger.log({ msg: 'mark email', domain: this.domain, email });
  }
};