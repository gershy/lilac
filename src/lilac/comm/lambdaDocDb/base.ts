import { DynamoDBClient as Ddb } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient as DdbClient, DynamoDBDocumentClientCommand, TransactWriteCommand as DdbTransactCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '../../../../boot/util/logger';

export type DocDbItem = { [k: string]: Json };
export type DocDbKey<I extends DocDbItem, K = ObjKeys<I>> = [ K ] | [ K, K ];
export type DocDbIndex<I extends DocDbItem> = never
  | { type: '$main',            name: '$main', key: DocDbKey<I> }                // Main index has no name
  | { type: 'all' | 'keysOnly', name: string,  key: DocDbKey<I> }; // Other indices must have a name
export type DocDbArgs<I extends DocDbItem, K extends DocDbKey<I>> = { table: string, key: K, indices: DocDbIndex<I>[], ttl?: boolean };

export type OpProp<OrigType = any> = { $: 'prop', v: string, $ot: string }; // string & { _: 'opProp' };
export type OpData<OrigType = any> = { $: 'data', v: string, $ot: OrigType }; // string & { _: 'opData' };
export type Ops = ReturnType<typeof LambdaDocDb.makeOps>['ops'];

export type Fired<V> = Promise<V> & {
  state: { active: boolean },
  cancel: () => DynamoDBDocumentClientCommand<any, any, any, any, any> & { ddbType: string }
};

export class LambdaDocDb<I extends DocDbItem, Key extends DocDbKey<I>> {
  
  public static makeOps = () => {
    
    const state = {
      propMap: new Map<string, OpProp>(),
      dataMap: new Map<Json, OpData>()
    };
    const ops = {
      prop: (prop: string) => {
        if (prop[hasHead]('#')) return { $: 'prop' as const, v: prop } as OpProp;
        if (!state.propMap.has(prop)) state.propMap.set(prop, { $: 'prop' as const, v: `#prop${state.propMap.size}` } as any);
        return state.propMap.get(prop)!;
      },
      data: (data: Json) => {
        if (!state.dataMap.has(data)) state.dataMap.set(data, { $: 'data' as const, v: `:data${state.dataMap.size}` } as any);
        return state.dataMap.get(data)!;
      },
      
      isDdbVal: (v): v is OpProp | OpData => isForm(v, Object) && [ 'prop', 'data' ][has](v.$),
      asProp: v => (ops.isDdbVal(v) ? v : ops.prop(v)).v,
      asData: v => (ops.isDdbVal(v) ? v : ops.data(v)).v,
      
      props: (props: Obj<Json | OpData>) => {
        return props[mapk]((v, k) => [ ops.asProp(k), ops.asData(v) ]);
      },
      sum: (vals: (Json | OpProp | OpData)[]): OpData<number> => {
        return { $: 'data' as const, v: `(${vals[map](v => ops.asData(v)).join(' + ')})` } as any;
      },
      eql: (prop: string | OpProp, v: Json | OpData): OpData<boolean> => {
        return { $: 'data' as const, v: `${ops.asProp(prop)} = ${ops.asData(v)}` } as any;
      },
      lte: (prop: string | OpProp, v: Json | OpData): OpData<boolean> => {
        return { $: 'data' as const, v: `${ops.asProp(prop)} <= ${ops.asData(v)}` } as any;
      },
      gte: (prop: string | OpProp, v: Json | OpData): OpData<boolean> => {
        return { $: 'data' as const, v: `${ops.asProp(prop)} >= ${ops.asData(v)}` } as any;
      },
      and: (vals: (Json | OpProp | OpData)[]): OpData<boolean> => {
        // Consider: ddb condition "AND" is different in KeyConditionExpression vs other
        // conditional expressions - no parenthesization in the former, but yes in the latter
        return { $: 'data' as const, v: `${vals[map](v => ops.asData(v)).join(' AND ')}` } as any;
      },
      hasProp: (prop: string | OpProp): OpData<boolean> => {
        return { $: 'data' as const, v: `attribute_exists(${ops.asProp(prop)})` } as any;
      }
    };
    
    return {
      ops,
      getEncodedVals: () => {
        const propEnts = [ ...state.propMap.entries() ];
        const dataEnts = [ ...state.dataMap.entries() ];
        
        // Prevent the user from adding more vals after getting the encoded values
        const errs = {
          has:     () => { throw Error('encoded vals finalized'); },
          get:     () => { throw Error('encoded vals finalized'); },
          entries: () => { throw Error('encoded vals finalized'); },
        } as any;
        state.propMap = state.dataMap = errs;
        
        return {
          ...(propEnts.length && { ExpressionAttributeNames:  propEnts[toObj](([ str,  prop ]) => [ prop.v, str  ]) }),
          ...(dataEnts.length && { ExpressionAttributeValues: dataEnts[toObj](([ json, prop ]) => [ prop.v, json ]) }),
        };
      }
    };
    
  };
  
  protected readonly ddbClient: Ddb;
  protected readonly table: string;
  protected readonly key: Key;
  protected readonly indices: DocDbIndex<I>[];
  protected readonly ttl: boolean;
  constructor(args: DocDbArgs<I, Key> & { ddbClient?: DdbClient }) {
    
    const invalidIndex = args.indices.find(ind => new Set(ind.key).size !== ind.key.length);
    if (invalidIndex) throw Error('index repeats key value')[mod]({ invalidIndex });
    
    this.ddbClient = args.ddbClient ?? DdbClient.from(new Ddb());
    this.table = args.table;
    this.key = args.key;
    this.indices = args.indices;
    this.ttl = args.ttl ?? false;
    
  }
  
  protected fire<
    // These types should be manually provided by callers - aws sdk makes it very hard to infer
    // them unfortunately
    Cmd extends DynamoDBDocumentClientCommand<any, any, any, any, any> & { ddbType: string },
    Output extends object = any,
    Fn extends ((l: Logger, v: Output) => any) = ((l: Logger, v: Output) => any)
  >(cmd: Cmd, logger: Logger, ctx: { term: string } & { [K: string]: Json }, processFn: Fn): Fired<ReturnType<Fn>> {
    
    // Executes a native ddb command with standardized logging and error handling
    
    const state = { active: true };
    const prm = Promise.resolve().then(() => {
      
      // A tick went by - did the consumer call `fire(...).cancel()`?
      if (!state.active) return null;
      
      const { term, ...more } = ctx;
      return logger.scope(`ddb.${term}`, more, async logger => {
        
        const val = await this.ddbClient.send(cmd).catch(err => {
          
          // Errors from `ddbClient.send` have varying severity:
          // - Throughput issues (i.e. hot keys) are always considered a glitch
          // - Conditional checks are often used to implement business logic, so lower severity
          // - Tx cancellations also are used to enforce business logic; lower severity!
          
          if (err.name === 'ProvisionedThroughputExceededException') throw Error('ddb throttled')       [mod]({ cause: err, ddb: { type: cmd.ddbType, input: cmd.input }, log: { term: 'glitch' } });
          if (err.name === 'ConditionalCheckFailedException')        throw Error('ddb condition failed')[mod]({ cause: err, ddb: { type: cmd.ddbType, input: cmd.input }, log: { term: 'reject' } });
          if (err.name === 'TransactionCanceledException')           throw Error('ddb tx cancelled')    [mod]({ cause: err, ddb: { type: cmd.ddbType, input: cmd.input }, log: { term: 'reject' } });
          
          // Consider mapping more ddb errors...
          throw err;
          
        });
        
        // TODO: Need automatic retries for these - can't expect all ddb consumers to independently
        // implement partial-failure handling!!
        const unprocessed = (() => null)()
          ?? (val as any)?.UnprocessedItems
          ?? (val as any)?.UnprocessedKeys
          ?? {};
        if (unprocessed[count]() > 0) throw Error('ddb partial')[mod]({ ddb: { type: cmd.ddbType, input: cmd.input }, unprocessed });
        
        // Note errors in `processFn` will have the same heatmapping as native ddb failures - this
        // is intended behaviour!
        return processFn(logger, val!);
        
      })
      
    });
    
    return Object.assign(prm, { state, cancel: () => (state.active = false, cmd) });
    
  };
  
  public atomic(args: () => { logger: Logger, cmds: Fired<any>[] }) {
    
    const { logger, cmds: cmdsActive } = args();
    
    const cmds = cmdsActive[map](cmd => cmd.cancel());
    
    // TransactWrite can consist of Put, Update, Delete, and ConditionCheck ops
    const transactCommand = Object.assign(new DdbTransactCommand({
      TransactItems: cmds[map](cmd => ({ [cmd.ddbType]: cmd.input }))
    }), { ddbType: 'TransactWrite' });
    
    // "transact write" - note "trr" would be for "transact read"
    const ctx = { term: 'trw', tables: [ ...new Set(cmds[map](cmd => cmd.input.TableName)) ] };
    return this.fire(transactCommand, logger, ctx, (logger, res) => undefined as void);
    
  }
  
};
