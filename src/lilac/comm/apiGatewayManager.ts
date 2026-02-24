import { ApiGatewayManagementApiClient as ApiGwClient, PostToConnectionCommand as SocketSend } from '@aws-sdk/client-apigatewaymanagementapi';
import { Logger } from '../../../boot/util/logger';

export class ApiGatewayManager {
  
  private client: ApiGwClient;
  private endpoint: string;
  
  constructor(args: { client?: ApiGwClient }) {
    
    // Note HttpGateway ensures "sokt_url" and "http_url" env vars are available on every lambda
    
    // Even though our overall desire is to send sokt events, we still want to communicate with the
    // management api over http (the management api receives http, and performs sokt actions!)
    this.endpoint = process.env.sokt_url!.replace(/^wss:[/][/]/, 'https://');
    this.client = args.client ?? new ApiGwClient({ endpoint: this.endpoint });
    
  }
  
  socketSend(args: { logger: Logger, soktUid: string, payload: Json }) {
    
    const { logger, soktUid, payload } = args;
    return logger.scope('apigw.socketSend', { endpoint: this.endpoint, soktUid, payload }, async logger => {
      
      const result = await this.client.send(new SocketSend({
        ConnectionId: soktUid,
        Data: isForm(payload, String) ? payload : JSON.stringify(payload)
      }));
      logger.log({ $$: 'result', result: { metadata: result.$metadata[map](v => v ?? null) } });
      
    });
    
  }
  
}
