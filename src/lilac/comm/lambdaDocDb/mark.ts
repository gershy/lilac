import { Logger } from '../../../../boot/util/logger';
import { DocDbItem, DocDbKey, LambdaDocDb, Ops } from './base';
import { PutCommand as DdbPut, PutCommandOutput as DdbPutOutput, DeleteCommand as DdbRem, DeleteCommandOutput as DdbDelOutput, BatchWriteCommand as DdbBatchMrk } from '@aws-sdk/lib-dynamodb';

// Consider checking error.name === 'ProvisionedThroughputExceededException'

export type OpPutArgs<I extends DocDbItem> = (ops: Ops) => {
  /** Entire item payload */
  logger: Logger,
  props: { [K in keyof I]: Json },
};
export type OpRemArgs<I extends DocDbItem, Key extends DocDbKey<I>> = (ops: Ops) => {
  logger: Logger,
  props: { [K in Key[number]]: Json } | { [K in Key[number]]: Json }[]
};

export class LambdaDocDbMarker<I extends DocDbItem, Key extends DocDbKey<I>> extends LambdaDocDb<I, Key> {
  // Consider making `opts.logger` mandatory! (Callers can pass Logger.dummy themselves if desired)
  
  public put(args: OpPutArgs<I>) {
    
    // Currently this is an `upsert` - any existing item with the same key will be overwritten
    // TODO: Simply use `{ ConditionExpression: 'attribute_not_exists(<any primary index prop>)' }`
    
    const { ops, getEncodedVals } = LambdaDocDb.makeOps();
    const { logger, props } = args(ops);
    
    const payload = Object.assign(new DdbPut({
      TableName: this.table,
      Item: props,
      ...getEncodedVals()
    }), { ddbType: 'Put' });
    
    const ctx = { term: 'put', table: this.table, item: props };
    return this.fire(payload, logger, ctx, (logger, res: DdbPutOutput) => undefined as void);
    
  }
  
  public rem(args: OpRemArgs<I, Key>) {
    
    const { ops, getEncodedVals } = LambdaDocDb.makeOps();
    const { logger, props: key } = args(ops);
    
    const cmd = isForm(key, Array)
      ? Object.assign(new DdbBatchMrk({
          RequestItems: {
            [this.table]: key.map(key => ({ DeleteRequest: { Key: key } }))
          }
        }), { ddbType: 'BatchWrite' })
      : Object.assign(new DdbRem({
          TableName: this.table,
          Key: key,
          ...getEncodedVals(),
        }), { ddbType: 'Delete' });
    
    const ctx = { term: isForm(key, Array) ? 'remArr' : 'rem', table: this.table, key };
    return this.fire(cmd, logger, ctx, (logger, res: DdbDelOutput) => skip as void);
    
  }
  
};
