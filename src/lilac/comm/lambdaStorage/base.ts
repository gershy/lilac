import { S3Client } from '@aws-sdk/client-s3';

export type LambdaStorageArgs = {
  bucket: string,
  baseKey: null | string
};
export class LambdaStorage {
  
  protected readonly s3Client: S3Client;
  protected readonly bucket: string;
  protected readonly baseKey: null | string;
  // protected readonly ttl: boolean; // S3 does have ttl-like rules for deleting old objects - "bucket-level lifecycle rules"
  constructor(args: LambdaStorageArgs & { s3Client?: S3Client }) {
    this.s3Client = args.s3Client ?? new S3Client({});
    this.bucket = args.bucket;
    this.baseKey = args.baseKey;
  }
  
  protected key(relKey: string) { return this.baseKey ? `${this.baseKey}/${relKey}` : relKey; }
  
};