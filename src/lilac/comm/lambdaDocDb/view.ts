import { Logger } from '../../../../boot/util/logger';
import { DocDbIndex, DocDbItem, DocDbKey, Fired, LambdaDocDb, Ops } from './base';
import { GetCommand as DdbGet, GetCommandOutput as DdbGetOutput, QueryCommand as DdbQry, QueryCommandOutput as DdbQryOutput, ScanCommand as DdbScn, ScanCommandOutput as DdbScnOutput } from '@aws-sdk/lib-dynamodb';

// Consider checking error.name === 'ProvisionedThroughputExceededException'

export type OpGetArgs<I extends DocDbItem, L extends number = 1> = (ops: Ops) => {}
  & { logger: Logger }
  
  & (|{ // Get/Qry
      
      /** Properties to match on - implies get/query, and must exactly conform to some index */
      props: { [K in keyof I]?: Json } // Would be nice to force the user to supply at least 1 key field for get queries...
      offset?: {
        /** Direction to iterate through results */
        direction: '+' | '-',
        
        /** The sort key of the item after which to begin returning items (excludes the 1st item) */
        head: null | number | string
      }
      
    }|{ // Scn
      
      
      /** Properties to filter on - implies scan; can apply to any properties */
      filter?: { [K in string]: Json },
      
      // Note scans don't support iteration direction (since they're detached from any index!)
      // Note that for Get/Qry, we supply a basic interface for paging - the user just supplies a
      // *value*, and we compute that the value they supplied pertains to the index we compute for
      // supporting their query! For Scn there's no computed index, so the user would really have
      // to manually provide the full LastEvaluatedKey - kinda messy, and Scn should probably only
      // be used for full traversal; all indices? So not providing any offset behaviour here
      
    })
    
  & {
      
      /** defaults to 1 - use `Infinity` for limitless querying! */
      limit?: L
      
    };

export class LambdaDocDbViewer<I extends DocDbItem, Key extends DocDbKey<I>> extends LambdaDocDb<I, Key> {
  
  public get(args: OpGetArgs<I, 1>):      Fired<I>;
  public get(args: OpGetArgs<I, number>): Fired<I[]>;
  public get(args: OpGetArgs<I, number>): Fired<I | I[]> {
    
    const prepCmd = this.getPreparedCmd(args); // Note `prepCmd` is either a "get" or "query" command!
    const origLimit = prepCmd.limit;
    const isSingleItem = origLimit === 1; // Note it's possible for the ddb command to be a Query, even if the limit is 1, as Queries are needed to search by non-main index!
    
    // Note this `state` tracks the "fired" values from potentially multiple underlying queries, so
    // that if the logical top-level query loop is cancelled, the current in-flight query can also
    // be cancelled
    const state = {
      cnt: 0,
      state: { active: true },
      curFired: null as null | Fired<any>, // Tracks the current in-flight query
      cancel: () => (state.state.active = false, state.curFired!.cancel()) // Note this will return the latest batch query in the series
    };
    
    const resultPrm = (async () => {
      
      const batches: I[][] = [];
      while (true) {
        
        const fired = state.curFired = this.getFired({ ...prepCmd, atLeastOne: isSingleItem });
        const { items, evalKey } = await fired;
        
        batches.push(items);
        state.cnt += items.length;
        const remaining = prepCmd.limit - state.cnt;
        
        // If we've retrieved the requested number of results, exit
        if (state.cnt >= prepCmd.limit) break;
        
        // No `evalKey` indicates there are no more results available
        if (!evalKey) break;
        
        // Check if the current fired command is active - if not, abort
        if (!state.state.active) break;
        
        // Mutate `prepCmd` so that it is offset after the latest query
        const props = prepCmd.cmd.props as Obj<any>;
        Object.assign(props, {
          ...(remaining !== Infinity && { Limit: remaining }),
          ScanIndexForward:  true,
          ExclusiveStartKey: evalKey
        });
        
      }
      
      const results = batches.flat(1);
      
      // In the "many" case, return all results
      if      (origLimit > 1)   return results;
      
      // Note this case is unnecessary - if `origLimit === 1`, we passed `atLeastOne: true` to `this.getFired`!
      // // "single" case - missing error if no results
      // else if (!results.length) throw Error('ddb missing');
      
      // Return a single value in the "single" case
      else                      return results[0];
      
    })();
    return Object.assign(resultPrm, state);
    
  }
  
  private getPreparedCmd(args: OpGetArgs<I, number>) {
    
    // Determines to build a ddb Get, Query or Scan based on the request args
    // - Resolves to Get if `args.props` is given, with limit 1
    // - Resolves to Query if `args.props` is given, and any other limit
    // - Resolve to Scan if `args.filter` is given
    
    const { ops, getEncodedVals } = LambdaDocDb.makeOps();
    
    const args0 = args(ops);
    
    if ('props' in args0) { // "props" indicates Get or Qry
      
      const { logger, props, offset, limit = 1 } = args0;
      const propKeys = Object.keys(props);
      if (propKeys.length > 2) throw Error('ddb query props invalid')[mod]({ props });
      
      // Determining which index to use is not trivial and should be extensible!
      const indexCriteria = [ ...(function*(): Generator<(index: DocDbIndex<I>) => boolean, undefined> {
        
        // We always need the index to match on the partition key
        if (true)                  yield index => index.key[0] === propKeys[0];
        
        // If the consumer specified a sort key, we need to ensure we use an index supporting it
        if (propKeys.length === 2) yield index => index.key[1] === propKeys[1];
        
        // If the consumer specified an offset head, we need to use the main index (and the main
        // index needs to include a sort key)
        // This is based on our current opinionated narrowing of ddb functionality, which is that
        // offsets can only be applied to the $main index!
        if (offset?.head)          yield index => index.type === '$main' && index.key.length === 2;
        
      })() ];
      
      const indices = [ { key: this.key, type: '$main' as const, name: '$main' as const }, ...this.indices ];
      const index = indices.find(index => indexCriteria.every(fn => fn(index)));
      if (!index) throw Error('ddb unsupported query args')[mod]({ availableIndices: indices, props, offset });
      
      const [ partAttr, sortAttr = null ] = this.key as [ string | number, undefined | string | number ];
      const cmd = (index.type === '$main' && propKeys.length === index.key.length && !offset)
        ? { ddbType: 'Get' as const, Cls: DdbGet, props: {
            TableName: this.table,
            Key: props,
            ...getEncodedVals()
          }}
        : { ddbType: 'Query' as const, Cls: DdbQry, props: {
            TableName: this.table,
            ...(index.name !== '$main' && { IndexName: index.name }), // No index specified when using primary index
            KeyConditionExpression: ops.and(propKeys.map(prop => ops.eql(prop, props[prop]!))).v,
            
            // TODO: the main requirement for "offset" is for swept essay edits (i.e. the only edits
            // we need are the ones not already included in the sweep, therefore we are offsetting
            // into the edits table) - this use-case is untested as of yet!!
            ...(offset?.direction && { ScanIndexForward: offset.direction === '+' }),
            ...(offset?.head      && { ExclusiveStartKey: { [partAttr]: props[partAttr], [sortAttr!]: offset.head } }),
            Limit: limit,
            ...getEncodedVals()
          }};
      
      return { logger, limit, key: props, index: index.name, cmd };
      
    } else { // No props - "filter", instead, and implies Scn
      
      const { logger, filter = {}, limit = 1 } = args0;
      
      const cmd = { ddbType: 'Scan' as const, Cls: DdbScn, props: {
        TableName: this.table,
        ...(filter[count]() && { FilterExpression: ops.and(filter[toArr]((v, k) => ops.eql(k, v))).v }),
        Limit: limit,
        ...getEncodedVals()
      }};
      
      return { logger, limit, filter, cmd };
      
    }
    
  }
  private getFired(args: {
    logger: Logger,
    limit: number,
    key?: Obj<any>,
    filter?: Obj<any>,
    index?: string,
    cmd: any,
    atLeastOne?: boolean
  }): Fired<{ items: I[], evalKey: null | Obj<string> }> {
    
    // Examines the content of `args`, and determines whether to use a DdbQry or DdbGet to fulfill
    // the specific request.
    
    const { atLeastOne = false } = args;
    const ctx = { term: 'get', table: this.table, ...args[slice]([ 'index', 'key', 'filter' ]), atLeastOne };
    
    const { Cls, props } = args.cmd;
    const cmd = new Cls(props);
    return this.fire(cmd, args.logger, ctx, (logger, res: DdbGetOutput | DdbQryOutput) => {
      
      const { Item = null, Items = [], LastEvaluatedKey: evalKey = null }: { Item: null | I, Items: I[], LastEvaluatedKey: null | Obj<string> } = res as any;
      const itemsRaw = [ ...Items, ...(Item ? [ Item ] : []) ];
      const now = this.ttl ? Date.now() : -Infinity;
      const items = this.ttl
        ? itemsRaw.filter(i => ((i as any).ttl * 1000) >= now) // Explicitly filter out expired items
        : itemsRaw;
      
      if (atLeastOne && !items.length) throw Error('ddb missing')[mod]({ log: { term: 'reject' } });
      logger.log({ $$: 'result', num: items.length, item0: items[0] ?? null });
      
      return { items, evalKey };
      
    });
    
  }
  
};

// const viewer = new LambdaDocDbViewer({
//   table: 'lol',
//   key: [ 'key' ],
//   indices: []
// });
// viewer.get(ops => ({ logger: Logger.dummy, props: {} }))          .then(v => {});
// viewer.get(ops => ({ logger: Logger.dummy, props: {}, limit: 1 })).then(v => {});
// viewer.get(ops => ({ logger: Logger.dummy, props: {}, limit: 2 })).then(v => {});
