import { Logger } from '../../../../boot/util/logger';
import { LambdaStorage } from './base';
import { GetObjectCommand as Get, ListObjectsV2Command as GetKeys } from '@aws-sdk/client-s3';

export class LambdaStorageViewer extends LambdaStorage {
  
  public async get(args: { logger: Logger, key: string }) {
    
    return args.logger.scope('s3.get', { key: args.key }, async logger => {
      
      try {
        
        // Interestingly in aws, s3:GetObject is not enough - need s3:ListBucket too!
        const res = await this.s3Client.send(new Get({
          Bucket: this.bucket,
          Key: this.key(args.key)
        }));
        
        const arr8 = await res.Body!.transformToByteArray();
        logger.log({ $$: 'result', size: arr8.length });
        return Buffer.from(arr8.buffer, arr8.byteOffset, arr8.byteLength);
        
      } catch (err: any) {
        
        if (err.name === 'NoSuchKey') return Buffer.allocUnsafe(0);
        throw err;
        
      }
      
    });
    
    
  }
  
  public async getKeys(args: { logger: Logger, limit: number /* Use Infinity for all results */ }){
    
    return args.logger.scope('s3.getKeys', { limit: args.limit }, async logger => {
      
      const state = {
        remaining: args.limit,
        token: null as null | string,
        batches: [] as string[][]
      };
      
      while (true) {
        
        const numThisReq = Math.min(state.remaining, 1000); // 1000 is the max request size
        const res = await this.s3Client.send(new GetKeys({
          Bucket: this.bucket,
          MaxKeys: numThisReq,
          ...(state.token && { ContinuationToken: state.token })
        }));
        
        // Note we don't care if `keys[empty]()` - the continuation token is the source-of-truth
        // for terminating the iteration!
        const keys = (res.Contents ?? []).map(obj => obj.Key!);
        
        state.token = res.ContinuationToken ?? null;
        state.remaining = Math.max(0, state.remaining - keys.length);
        state.batches.push(keys)
        
        if (!state.token) break;
        if (state.remaining <= 0) break;
        
      }
      
      const keys = state.batches.flat(1);
      logger.log({ $$: 'result', size: keys.length });
      return keys;
      
    });
    
  }
  
};