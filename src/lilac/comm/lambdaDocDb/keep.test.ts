import niceRegex from '../../../../boot/util/niceRegex';
import { DocDbArgs, DocDbItem, DocDbKey } from './base';
import { LambdaDocDbKeeper as RealLambdaDocDbKeeper } from './keep';
import { DynamoDBDocumentClient as DdbClient } from '@aws-sdk/lib-dynamodb';

const getVolume = (table: string): { items: any[] } => (process as any).getVolume(`docDb:${table}`, () => ({ items: [] }));
const mockDdbClient = <I extends DocDbItem, K extends DocDbKey<I>>(ddb: DocDbArgs<I, K>) => {
  
  // Note a general principle of these mock clients is that data in the volume can be mutated at
  // will, but any values queried and returned to the consumer from the current volume state must
  // be deeply-copied so that the consumer isn't exposed to any mutation behaviour
  
  const indices = [ { key: ddb.key, type: '$main' as const, name: '$main' as const }, ...ddb.indices ];
  
  const ddbStringCompare = (a: string, b: string) => {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    
    const len = Math.min(ba.length, bb.length);
    for (let i = 0; i < len; i++) if (ba[i] !== bb[i]) return ba[i] - bb[i];
    
    return ba.length - bb.length;
  };
  const getKeyVals = (input: any, v: { [K: string]: string }) => v[mapk]((v, k) => [
    // Maps an object of aliased keys/vals to its original representation
    input.ExpressionAttributeNames[k],
    input.ExpressionAttributeValues[v],
  ]);
  const parseVal = (input: any, rec: Obj<any>, val: any) => {
    
    if (!isForm(val, String)) return val;
    
    // This regex captures stuff like `'(thingy1 + baddy2)'`
    const sumReg = niceRegex(String.baseline(`
      | ^[(]                        [)]$
      |     [^ +()]+         [^())]+
      |             [ ][+][ ]
    `));
    if (sumReg.test(val)) return val
      .slice(1, -1)
      .split(' + ')
      [map](v => parseVal(input, rec, v))
      .reduce((m, v) => m + v, 0);
    
    if (val[hasHead](':data')) { return input.ExpressionAttributeValues[val]; }
    if (val[hasHead]('#prop')) { return rec[input.ExpressionAttributeNames[val]]; }
    
    throw Error('ddb parse val unrecognized')[mod]({ val });
    
  };
  const objMatch = (key: Obj<any>, item: Obj<any>) => {
    for (const [ k, v ] of Object.entries(key)) {
      if (!item[has](k)) return false;
      if (item[k] !== v) return false;
    }
    return true;
  };
  
  const client = { send: async (cmd: any) => {
    
    const type = cmd.$ddbType ?? getFormName(cmd);
    const input = cmd.input;
    
    // For commands like TransactWrite there's no specific table in use
    const table = (input.TableName as string) ?? null;
    
    if (type !== 'TransactWriteCommand' && !table) throw Error('owww');
    
    const volume = table ? getVolume(table) : { items: [] };
    const search = (t: 'find' | 'filter', key: any) => volume.items[t](item => objMatch(key, item)) ?? null;
    
    if (type === 'GetCommand') {
      
      const item = volume.items.find(item => objMatch(input.Key as Obj<string>, item));
      return { Item: item ? {}[merge](item) : null };
      
    } else if (type === 'QueryCommand') {
      
      // Note that KeyConditionExpression is often simply of the form:
      // `#partitionKey = :val1 AND #sortKey = :val2`, although the condition applied to the sort
      // key can theoretically be more complicated - e.g. `#sortKey BETWEEN :val1 AND :val2`, or
      // `begins_with(#sortKey, :pfx)`
      
      const cond: string = input.KeyConditionExpression;
      if (!/^[#][a-zA-Z0-9]+ = [:][a-zA-Z0-9]+( AND [#][a-zA-Z0-9]+ = [:][a-zA-Z0-9]+)*?$/.test(cond))
        throw Error('complex ddb key condition not supported yet')[mod]({ cond });
      
      const condKey = cond
        .split(' AND ')
        [toObj](eq => eq[cut]('=', 1)[map](v => v.trim()) as [ string, string ]);
      
      // Sort by index (TODO: what if the user wants to sort by secondary index?)
      const indexName: string = input.IndexName ?? '$main';
      const index = indices.find(ind => ind.name === indexName);
      if (!index) throw Error('ddb index name invalid')[mod]({ ddb, indexName });
      
      const key = getKeyVals(input, condKey);
      let condSearch: any[] = [ ...volume.items ];
      
      condSearch = condSearch.filter(item => objMatch(key, item));
      
      // Sort if the index has a sort key
      if (index.key.length === 2) condSearch = condSearch.sort((a, b) => {
        
        // Compare the sort key of a and b
        const aa = a[index.key[1]];
        const bb = b[index.key[1]];
        
        if (isForm(aa, Number)) return aa - bb;
        if (isForm(aa, String)) return ddbStringCompare(aa, bb);
        return 0;
        
      });
      
      // Reverse if scan was requested backwards
      if (input.ScanIndexForward === false) condSearch.reverse();
      
      // Apply exclusive start key if required
      const startKey: null | Obj<string> = input.ExclusiveStartKey ?? null;
      if (startKey) {
        
        // Assuming the object keys are in the correct order - not necessarily true!
        const [ partKey, sortKey ] = index.key as string[];
        const partVal = startKey[partKey];
        const sortVal = startKey[sortKey];
        const start = condSearch.findIndex(val => val[partKey] === partVal && val[sortKey] === sortVal);
        
        condSearch = start > -1 ? condSearch.slice(start + 1) : []
        
      }
      
      // TODO: Really we should try to estimate limiting by 1mb response size; in the meantime
      // simply limiting to 111 items lol
      const origFound = condSearch;
      const limitedResults = condSearch.slice(0, Math.min(input.Limit as number, 111)); // Mocks limited results based on physical constraints of ddb
      const lastEval = (() => {
        
        // No last eval key if we exhausted all available items!
        if (limitedResults.length >= origFound.length) return null;
        
        const last = origFound[limitedResults.length];
        const [ pk, sk ] = index.key;
        return { [pk]: last[pk], [sk!]: last[sk] };
        
      })();
      
      return { Items: limitedResults.map(v => ({})[merge](v)), LastEvaluatedKey: lastEval };
      
    } else if (type === 'PutCommand') {
      
      const item: Obj<any> = input.Item;
      const key = ddb.key[toObj](k => [ k, item[k] ]);
      
      const existing = search('find', key) ?? null;
      if (existing) volume.items[rem](existing);
      volume.items.push(item);
      
      return { Attributes: null }; // Whether to return `item` is determined by `input.ReturnValues` ('NONE' by default)
      
    } else if (type === 'DeleteCommand') {
      
      const key: Obj<string> = input.Key;
      const existing = search('find', key) ?? null;
      if (existing) volume.items[rem](existing);
      
      return { Attributes: null }; // Look at `input.ReturnValues`??
      
    } else if (type === 'UpdateCommand') {
      
      const key: Obj<string> = input.Key;
      
      // Note that `props` can't have properties from the key
      const existing = search('find', key);
      
      type UpdateType = (typeof updateTypes)[number];
      const updateTypes = [ 'set', 'remove' ] as const;
      const upds: { type: UpdateType, str: string }[] = (() => {
        
        const updateReg = new RegExp(`(${updateTypes.map(v => v[upper]()).join('|')})`);
        const updateStuff = (input.UpdateExpression as string).split(updateReg)[map](v => v.trim() || skip);
        
        const upds: { type: UpdateType, str }[] = [];
        for (let i = 0; i < updateStuff.length; i += 2) {
          
          const type = updateStuff[i][lower]() as any;
          const str  = updateStuff[i + 1];
          
          if (!updateTypes.includes(type as any)) throw Error('update type unexpected')[mod]({ updateType: type, input });
          upds.push({ type, str })
          
        }
        return upds;
        
      })();
      
      const propsArr = upds.map(({ type, str }) => {
        
        if (type === 'set') return str
          .trim()
          .split(',')
          [toObj](eq => {
            const [ k, v ] = eq.trim()[cut]('=', 1)[map](v => v.trim()) as [ string, string ];
            return [
              input.ExpressionAttributeNames[k],
              parseVal(input, existing ?? {}, v) as Json
            ];
          });
        
        else if (type === 'remove') return str
          .trim()
          .split(',')
          [toObj](attrName => [ input.ExpressionAttributeNames[attrName], skip ]);
        
        throw Error('ow');
        
      });
      
      const props = propsArr.reduce((m, v) => m[merge](v), {});
      
      const conditionValid = (() => {
        
        const exp = input.ConditionExpression as string;
        if (!exp) return true;
        
        // TODO: For now can only handle "key/value eq/gte/lte AND chains"
        if (!/^([#]prop[0-9]+ = [:]data[0-9]+)(AND [#]prop[0-9]+ (<=|>=|=) [:]data[0-9]+)*/.test(exp))
          throw Error('unsupported condition expression')[mod]({ exp });
        
        const conditions = exp.split(' AND ')[map]((condition: string) => {
          condition = condition.trim();
          const [ , key, comparator, val ] = condition.match(/([#]prop[0-9]+) (<=|>=|=) ([:]data[0-9]+)/)!;
          return { key, val, comparator: comparator as '<=' | '=' | '>=' };
        });

        for (const { key, val, comparator } of conditions) {

          const k = input.ExpressionAttributeNames[key];
          const v = input.ExpressionAttributeValues[val];

          const result = {
            '=':  existing?.[k] === v,
            '>=': existing?.[k] >=  v,
            '<=': existing?.[k] <=  v
          }[comparator];

          if (!result) return false;

        }

        return true;

      })();
      if (!conditionValid) throw Error('mock ddb condition')[mod]({ name: 'ConditionalCheckFailedException', existing, input });
      
      // Natively, ddb will update or create
      const item = existing ?? ((i = { ...key, ...props }) => (volume.items.push(i), i))();

      Object.assign(item, props);
      
      return { Attributes: (input.ReturnValues ?? 'NONE') === 'NONE' ? null : {}[merge](item) };
      
    } else if (type === 'TransactWriteCommand') {
      
      const cmds = input.TransactItems[map](trwCmd => {
        
        const k = Object.keys(trwCmd)[0];
        return {
          $ddbType: `${k}Command`,
          input: trwCmd[k]
        };
        
      });
      
      const tables: string[] = [ ...new Set<string>(cmds[map](cmd => cmd.input.TableName)) ].filter(v => !!v);
      
      const itemsBackup = tables[toObj](t => [ t, JSON.stringify(getVolume(t).items) ]);
      
      try {
        
        await Promise.all(cmds[map](cmd => client.send(cmd)));
        
        // TODO: Look into mocking the return value better
        return { ItemCollectionMetrics: {} };
        
      } catch(err: any) {
        
        // TODO: Look into how TransactWrite marshals errors from its inner commands into a
        // resulting error
        
        // Rollback by replacing effected tables with their snapshots
        for (const [ k, v ] of itemsBackup as Itr<typeof itemsBackup>) { getVolume(k).items = JSON.parse(v); }
        
        throw err;
        
      }
      
    }
    
    throw Error(`Holy cow ddb op not supported: "${type}"`)[mod]({ input });
    
  }};
  
  return client;
  
};

export class LambdaDocDbKeeper<I extends DocDbItem, Key extends DocDbKey<I>> extends RealLambdaDocDbKeeper<I, Key> {
  
  constructor(args: DocDbArgs<I, Key> & { ddbClient?: DdbClient }) {
    // Consider mocking `ddbClient` instead of overriding methods...
    super({
      ...args,
      ddbClient: mockDdbClient(args) as any
    });
  }
  
};
