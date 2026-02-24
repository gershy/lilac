import { WebSocket } from 'ws';
import { ApiGatewayManager as RealApiGatewayManager } from './apiGatewayManager';

export class ApiGatewayManager extends RealApiGatewayManager {
  
  private soktHandlerKey: string;
  
  constructor(args: { soktHandlerKey: string }) {
    
    super({ /* Mock client?? */ } as any);
    this.soktHandlerKey = args.soktHandlerKey;
    
  }
  async socketSend(args: { soktUid: string, payload: Json }) {
    
    // Consider: a better way may be to expose something like a "@/connections" endpoint from the
    // api gateway (basically like "/test/volume"), and hit that api endpoint from here - this
    // would make this implementation much more like real-life aws apigw, and would remove the need
    // for non-json args to this class
    
    const getSokt = (process as any).registryGet(this.soktHandlerKey) as (id: string) => Promise<null | WebSocket>;
    
    const sokt = await getSokt(args.soktUid);
    sokt?.send(JSON.stringify(args.payload));
    
    return { $metadata: { soktFound: !!sokt } } as any;
    
  }
  
};