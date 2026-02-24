import { HttpArgs, HttpReq, HttpRes } from '../../../boot/util/http';
import { formatNetProc, NetProc } from '../../../boot/util/jargon/http';

export class HttpLambda<Req extends HttpReq, Res extends HttpRes> {
  
  // A Comm enabling http queries to http-accessible Lambdas
  
  private netProc: NetProc;
  private path: string[];
  private method: HttpReq['method'];
  constructor(args: { netProc: NetProc, path: string[], method: HttpReq['method'] }) {
    this.netProc = args.netProc;
    this.path = args.path;
    this.method = args.method;
  }
  getUrl() { return `${formatNetProc(this.netProc)}${this.path.length ? `/${this.path.join('/')}` : ''}`; }
  getHttpArgs() {
    return {
      // $req: null as any as Req,
      // $res: null as any as Res,
      netProc: this.netProc,
      path: this.path,
      method: this.method
      // query: {} as { [K: string]: never }
    } as any as HttpArgs<Req, Res>;
  }
};