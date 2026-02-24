import { Logger } from '../../../../boot/util/logger';
import { LambdaStorage } from './base';
import { PutObjectCommand as Put, DeleteObjectCommand as Rem, DeleteObjectsCommand as RemArr } from '@aws-sdk/client-s3';

export class LambdaStorageMarker extends LambdaStorage {
  
  public async put(args: { logger: Logger, key: string, data: string | Buffer, type?: string }) {
    
    const { logger, key, data, type = 'application/octet-stream' } = args;
    
    const bucket = this.bucket;
    const fullKey = this.key(key);
    return logger.scope('s3.put', { bucket, key: fullKey, type, size: data.length }, () => this.s3Client.send(new Put({
      Bucket: bucket,
      Key: fullKey,
      Body: data,
      ContentType: type
    })));
    
  }
  
  public async rem(args: { logger: Logger, key: string | string[] }) {
    
    const { logger, key } = args;
    
    const bucket = this.bucket;
    const isArr = isForm(key, Array);
    const ctx = {
      bucket,
      ...(isArr
        ? { firstFewKeys: key.slice(0, 3).map(k => this.key(k)), totalKeys: key.length }
        : { key: this.key(key) }
      )
    };
    return logger.scope(`s3.${isArr ? 'remArr' : 'rem'}`, ctx, async () => {
      
      const res = isArr
        ? await this.s3Client.send(new RemArr({
            Bucket: bucket,
            Delete: {
              Objects: key.map(k => ({ Key: this.key(k) })),
              Quiet: true // Don't return deleted keys
            }
          }))
        : await this.s3Client.send(new Rem({ Bucket: bucket, Key: this.key(key) }))
      
      const errs = (res as any).Errors ?? [];
      if (errs.length) throw Error('s3 failed')[mod]({ res, errs });
      
    });
    
  }
  
};