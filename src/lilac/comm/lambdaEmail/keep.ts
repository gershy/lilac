import { LambdaEmailViewer } from './view';
import { LambdaEmailMarker } from './mark';

export class LambdaEmailKeeper {
  
  private consumer: LambdaEmailViewer;
  private producer: LambdaEmailMarker;
  constructor(args: { domain: string }) {
    this.consumer = new LambdaEmailViewer(args);
    this.producer = new LambdaEmailMarker(args);
  }
  
  read(args: any) { return this.consumer.read(args); }
  send(args: any) { return this.producer.send(args); }
  
}