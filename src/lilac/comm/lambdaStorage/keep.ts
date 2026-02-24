import { Logger } from '../../../../boot/util/logger';
import { LambdaStorage } from './base';
import { LambdaStorageMarker } from './mark';
import { LambdaStorageViewer } from './view';

export class LambdaStorageKeeper extends LambdaStorage {
  protected viewer: LambdaStorageViewer;
  protected marker: LambdaStorageMarker;
  constructor(...args: ConstructorParameters<typeof LambdaStorage>) {
    super(...args);
    this.viewer = new LambdaStorageViewer({ s3Client: this.s3Client, ...args[0] });
    this.marker = new LambdaStorageMarker({ s3Client: this.s3Client, ...args[0] });
  }
  
  public get    (args: { logger: Logger, key: string })                                       { return this.viewer.get(args); }
  public getKeys(args: { logger: Logger, limit: number })                                     { return this.viewer.getKeys(args); }
  public put    (args: { logger: Logger, key: string, data: string | Buffer, type?: string }) { return this.marker.put(args); }
  public rem    (args: { logger: Logger, key: string | string[] })                            { return this.marker.rem(args); }
}