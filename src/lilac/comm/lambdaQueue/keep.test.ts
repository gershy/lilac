import { LambdaQueueKeeper as RealLambdaQueueKeeper } from './keep';

const getVolume = (bucket: string): { objs: Obj<{ data: string | Buffer, meta: any }> } => (process as any).getVolume(`sqs:${bucket}`, () => ({ objs: {} }));

const mockSqsClient = (args: { handlerKey: string }) => {
  
  return { send: async cmd => {
    
    // TODO: Is `getFormName` risky to use with typescript compilation, i.e., the classname info is
    // possibly erased??
    const type = cmd.$ddbType ?? getFormName(cmd);
    
    if (type === 'SendMessageCommand') {
      
      // Simulate async event queuing...
      (async () => {
        
        // The handler is globally registered... super ugly
        try {
          
          await new Promise(r => setTimeout(r, 5 + Math.floor(Math.random() * 10)));
          
          // TODO: Event metadata?
          // TODO: Event batching??
          const fn = (process as any).registryGet(args.handlerKey);
          await fn({ Records: [{ body: cmd.input.MessageBody }] });
          
        } catch (err: any) {
          
          console.log('Mock queue producer seems to have failed', err[limn]());
          
        }
        
      })();
      
      return {};
      
    }
    
    throw Error('command unexpected')[mod]({ type, cmd });
    
  }};
  
};

export type LambdaQueueEvt = { Records: { body: string | Buffer }[] };
export type LamdbaQueueHandler = (evt: LambdaQueueEvt) => Promise<void>;
export type LamdbaQueueRegisteredHandler = { t: 'registeredHandler', key: string };
export class LambdaQueueKeeper extends RealLambdaQueueKeeper<any> {
  
  constructor(args: { handlerKey: string }) { super({ sqsClient: mockSqsClient(args) as any }); }
  
};
