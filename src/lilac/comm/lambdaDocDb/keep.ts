import { Logger } from '../../../../boot/util/logger';
import { DocDbItem, DocDbKey, Fired, LambdaDocDb, OpData, Ops } from './base';
import { LambdaDocDbViewer, OpGetArgs } from './view';
import { LambdaDocDbMarker, OpPutArgs, OpRemArgs } from './mark';
import { UpdateCommand as DdbUpd, PutCommandOutput as DdbUpdOutput } from '@aws-sdk/lib-dynamodb';

export type OpUpdArgs<I extends DocDbItem, Key extends DocDbKey<I>, R extends boolean = false> = (ops: Ops) => {
  logger: Logger,
  check?: OpData,
  
  // Defines the key and update values; the key is extracted based on the keeper's key, and the
  // update values are all values other than the key; note ddb PutItem cannot be used to update any
  // value in the item's key!
  props: { [K in Key[number]]: Json } & { [K in keyof I]?: Json & (I[K] | OpData<I[K]>) },
  retrieve?: R
};

export class LambdaDocDbKeeper<I extends DocDbItem, Key extends DocDbKey<I>> extends LambdaDocDb<I, Key> {
  protected viewer: LambdaDocDbViewer<I, Key>;
  protected marker: LambdaDocDbMarker<I, Key>;
  constructor(...args: ConstructorParameters<typeof LambdaDocDb<I, Key>>) {
    super(...args);
    this.viewer = new LambdaDocDbViewer({ ddbClient: this.ddbClient, ...args[0] });
    this.marker = new LambdaDocDbMarker({ ddbClient: this.ddbClient, ...args[0] });
  }
  
  public get(args: OpGetArgs<I, 1>):      Fired<I>;
  public get(args: OpGetArgs<I, number>): Fired<I[]>;
  public get(args: unknown): unknown      { return this.viewer.get(args as any) as any; }
  
  public put(args: OpPutArgs<I>) { return this.marker.put(args); }
  
  // Updates are consume+produce in one operation, therefore defined directly on the accessor
  public upd(args: OpUpdArgs<I, Key, false>):   Fired<void>;
  public upd(args: OpUpdArgs<I, Key, boolean>): Fired<I>;
  public upd(args: OpUpdArgs<I, Key, boolean>): unknown {
    
    // Currently this is an `upsert` - if no item exists, it will be created
    // TODO: Simply use `{ ConditionExpression: 'attribute_exists(<any primary index prop>)' }`
    
    const { ops, getEncodedVals } = LambdaDocDb.makeOps();
    const { logger, props, check = null, retrieve = false } = args(ops);
    
    const key = props[slice](this.key);
    const upd = props[slash](this.key);
    
    const entries = Object.entries(upd)[map](([ k, v ]) => `${ops.asProp(k)} = ${ops.asData(v)}`);
    
    // If there's nothing to update, either return `skip` (if no retrieval requested), otherwise
    // substitute with a get!
    if (entries[empty]()) {
      logger.log({ $$: 'ddb.upd.nop', retrieve });
      return retrieve
        ? this.get(ops => ({ logger, props: key }))
        : skip;
    }
    
    const cmd = Object.assign(new DdbUpd({
      TableName: this.table,
      Key: key,
      ...(check && { ConditionExpression: ops.asData(check) }),
      UpdateExpression: `SET ${entries.join(', ')}`,
      ReturnValues: retrieve ? 'ALL_NEW' : 'NONE', // 'NONE' | `${'ALL' | 'UPDATED'}_${'OLD' | 'NEW'}`
      ...getEncodedVals(),
    }), { ddbType: 'Update' });
    
    const ctx = { term: 'upd', table: this.table, key, retrieve };
    return this.fire(cmd, logger, ctx, (logger, res: DdbUpdOutput) => {
      
      if (!retrieve) { logger.log({ $$: 'result', item: '<not retrieved>' }); return skip; }
      
      // If `retrieve === true` we require the item to exist with a valid ttl
      const item = res.Attributes;
      if (!item)                                      throw Error('ddb missing')[mod]({ log: { term: 'reject' } });
      if (this.ttl && (item.ttl * 1000) < Date.now()) throw Error('ddb missing')[mod]({ log: { term: 'reject' } });
      
      logger.log({ $$: 'result', item });
      return item;
      
    });
    
  }
  
  public rem(args: OpRemArgs<I, Key>) { return this.marker.rem(args); }
  
};

// This typing forces LambdaDocDbKeeper to implement everything from the viewer and marker classes
// Note `Rekey` filters out private properties so the comparison is clearer
type Rekey<V extends {}> = { [K in keyof V]: V[K] };
type ViewProto = Rekey<typeof LambdaDocDbViewer.prototype>;
type MarkProto = Rekey<typeof LambdaDocDbMarker.prototype>;
type KeepProto = Rekey<typeof LambdaDocDbKeeper.prototype>;
type Test<V extends ViewProto & MarkProto> = V;
type TestResult = Test<KeepProto>;

// const m = new LambdaDocDbKeeper({
//   table: 'test',
//   key: [ 'hi' ],
//   indices: []
// });
// m.upd(ops => ({ logger: Logger.dummy, props: { hi: 'hi' } }))                 .then(v => {});
// m.upd(ops => ({ logger: Logger.dummy, props: { hi: 'hi' }, retrieve: false })).then(v => {});
// m.upd(ops => ({ logger: Logger.dummy, props: { hi: 'hi' }, retrieve: true })) .then(v => {});