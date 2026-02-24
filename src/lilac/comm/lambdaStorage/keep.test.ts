import { LambdaStorageArgs } from './base';
import { LambdaStorageKeeper as RealLambdaStorageKeeper } from './keep';

const getVolume = (bucket: string): { objs: Obj<{ data: string | Buffer, meta: any }> } => (process as any).getVolume(`s3:${bucket}`, () => ({ objs: {} }));

const mockS3Client = (args: { bucket: string, baseKey: null | string }) => {
  
  return { send: cmd => {
    
    // TODO: Is `getFormName` risky to use with typescript compilation, i.e., the classname info is
    // possibly erased??
    const type = cmd.$ddbType ?? getFormName(cmd);
    const { input } = cmd;
    const volume = getVolume(args.bucket);
    
    // TODO: What if `cmd.input.Bucket !== args.bucket`? It's like... an iam permission issue? Can
    // probably ignore this case??
    
    if (type === 'GetObjectCommand') {
      
      const result = volume.objs[at](input.Key, null);
      if (result === null) throw Error('NoSuchKey')[mod]({ name: 'NoSuchKey', Code: 'NoSuchKey' });
      
      return {
        Body: {
          transformToByteArray: async () => Buffer.from(result.data),
          transformToString:    async () => result.data.toString('utf8'),
        },
        ContentLength: Buffer.byteLength(result.data),
        ContentType: result.meta.type,
        Metadata: {},
        $metadata: {
          httpStatusCode: 200
        }
      };
      
    } else if (type === 'PutObjectCommand') {
      
      volume.objs[input.Key] = { data: input.Body, meta: { type: input.ContentType } };
      return {
        // TODO: More stuff??
        $metadata: {
          httpStatusCode: 200
        }
      };
      
    } else if (type === 'DeleteObjectCommand') {
      
      // Note that deleting missing keys is considered a successful no-op in S3!
      delete volume.objs[input.Key];
      
      return {
        // TODO: More stuff??
        $metadata: {
          httpStatusCode: 200
        }
      };
      
    }
    
    throw Error('command unexpected')[mod]({ type, cmd });
    
  }};
  
};

export class LambdaStorageKeeper extends RealLambdaStorageKeeper {
  
  constructor(args: LambdaStorageArgs) {
    // Consider mocking `ddbClient` instead of overriding methods...
    super({ ...args, s3Client: mockS3Client(args) as any });
  }
  
};
