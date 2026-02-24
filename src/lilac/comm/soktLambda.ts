import { NetProc, formatNetProc } from '../../../boot/util/jargon/http';

export class SoktLambda {
  
  private args: { netProc: NetProc, key: string };
  constructor(args: { netProc: NetProc, key: string }) {
    this.args = args;
  }
  getUrl() {
    // This path corresponds to the fixed path defined by the HttpGateway lilac
    return `${formatNetProc(this.args.netProc)}/api/websocket`;
  }
  
}