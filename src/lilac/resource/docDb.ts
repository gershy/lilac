import capitalize from '../../../boot/util/capitalize';
import snakeCase from '../../../boot/util/snakeCase';
import { TfEntity, TfResource } from '../provider/awsTf';
import { DocDbItem, DocDbKey } from '../comm/lambdaDocDb/base';
import { LambdaDocDbKeeper } from '../comm/lambdaDocDb/keep';
import { LambdaDocDbViewer } from '../comm/lambdaDocDb/view';
import { LambdaDocDbMarker } from '../comm/lambdaDocDb/mark';
import { Lilac, LilacContext } from '../lilac';
import { aws, tf } from '../util';
import { Lambda } from './lambda';

export type DocDbDataType = 'bln' | 'num' | 'bin' | 'str';
export class DocDb<I extends DocDbItem, K extends DocDbKey<I>> extends Lilac {
  
  private name: string;
  private key: DocDbKey<I>;
  private indices: { name: string, key: DocDbKey<I>, type: 'all' | 'keysOnly' }[];
  private accessors: { mode: 'view' | 'mark' | 'keep', lambda: Lambda<any, any, any, any, any> }[];
  private ttl: boolean;
  private propTypes: { [K: string]: DocDbDataType };
  
  constructor(args: {
    $item?: I,
    name: string,
    key: K,
    indices?: { name?: string, key: DocDbKey<I>, type: 'all' | 'keysOnly' }[],
    ttl?: boolean,
    propTypes?: { [K: string]: DocDbDataType }
  }) {
    
    super();
    
    const indices = (args.indices ?? [])[map](ind => ({
      ['name' as any]: '',
      ...ind,
      name: ind.name ?? capitalize(ind.key).replace(/[^a-zA-Z0-9_.-]/g, '')
    }));
    const badIndex = indices.find(ind => /[^a-zA-Z0-9_.-]/.test(ind.name));
    if (badIndex) throw Error('bad index name')[mod]({ db: args.name, badIndex });
    
    this.name = args.name;
    this.key = args.key;
    this.indices = indices;
    this.ttl = args.ttl ?? false;
    this.accessors = [];
    this.propTypes = args.propTypes ?? {};
    
  }
  
  public getName(ctx: LilacContext) { return `${ctx.pfx}-${this.name}`; }
  public getKey(ctx: LilacContext) { return [ ...this.key ] as K; }
  
  public * getDependencies(ctx: LilacContext) {
    yield* super.getDependencies(ctx);
    for (const { lambda } of this.accessors) yield* lambda.getDependencies(ctx);
  }
  
  public getAccessorConfig(ctx: LilacContext) {
    return { table: this.getName(ctx), key: this.key, indices: this.indices, ttl: this.ttl };
  }
  
  addAccessor(ctx: LilacContext, mode: 'view', lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaDocDbViewer<I, K>>;
  addAccessor(ctx: LilacContext, mode: 'mark', lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaDocDbMarker<I, K>>;
  addAccessor(ctx: LilacContext, mode: 'keep', lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaDocDbKeeper<I, K>>;
  addAccessor(ctx: LilacContext, mode: 'view' | 'mark' | 'keep', lambda: Lambda<any, any, any, any, any>): any {
    
    this.accessors.push({ mode, lambda });
    
    if (mode === 'keep') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaDocDb/keep::LambdaDocDbKeeper',
        form: LambdaDocDbKeeper,
        args: [ this.getAccessorConfig(ctx) ]
      } as JsfnInst<typeof LambdaDocDbKeeper>;
      
    } else if (mode === 'view') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaDocDb/view::LambdaDocDbViewer',
        form: LambdaDocDbViewer,
        args: [ this.getAccessorConfig(ctx) ]
      } as JsfnInst<typeof LambdaDocDbViewer>;
      
    } else if (mode === 'mark') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaDocDb/mark::LambdaDocDbMarker',
        form: LambdaDocDbMarker,
        args: [ this.getAccessorConfig(ctx) ]
      } as JsfnInst<typeof LambdaDocDbMarker>;
      
    }
    
    throw Error('bad mode')[mod]({ mode });
    
  }
  
  async getTfEntities0(ctx: LilacContext) {
    
    const entities: TfEntity[] = [];
    const addEntity = (ent: TfEntity) => { entities.push(ent); return ent; };
    
    const state = { count: 0 };
    const k = () => `${state.count++}`;
    const ddb = addEntity(new TfResource('awsDynamodbTable', `docDb${capitalize(this.name)}`, {
      
      name: `${ctx.pfx}-${this.name}`,
      billingMode: snakeCase('payPerRequest')[upper](),
      
      hashKey: this.key[0],
      ...(this.key[1] && { rangeKey: this.key[1] }),
      
      // Include all properties of all keys in the table description; dedup keys which repeat
      // across multiple indices
      ...[ ...new Set([ ...this.key, ...this.indices.flatMap(ind => ind.key) ]) ][toObj](keyPart => {
        const ddbType = {
          bln: 'bool' as const,
          num: 'n' as const,
          bin: 'b' as const,
          str: 's' as const,
        }[this.propTypes[has](keyPart) ? this.propTypes[keyPart] : 'str'];
        return [ `$attribute.${k()}`, { name: keyPart, type: ddbType[upper]() } ]
      }),
      
      // Include ttl if specified
      ...(this.ttl && {
        // Don't add an attribute for "ttl" - all attributes are related to *indices*, and we
        // certainly don't want to do any indexing on the ttl!
        // [`$attribute.${k()}`]: { name: 'ttl', type: 'n'.upper() },
        '$ttl':                { attributeName: 'ttl', enabled: true }
      }),
      
      ...this.indices[toObj](({ name, key, type }) => [ `$globalSecondaryIndex.${k()}`, {
        
        name,
        hashKey: key[0],
        ...(key[1] && { rangeKey: key[1] }),
        projectionType: snakeCase(type)[upper](),
        
      }]),
      
      tags: {
        system: ctx.term,
        maturity: ctx.maturity
      }
      
    }));
    
    for (const { mode, lambda } of this.accessors) {
      
      const role = lambda.getRole();
      const roleTfEnt = await lambda.getRole().getTfEntities(ctx).then(ents => ents.find(ent => ent.getType() === 'awsIamRole')!);
      
      const lambdaPolicyName = capitalize([ 'lambdaDocDb', lambda.getName(), this.name ]);
      const lambdaPolicy = addEntity(new TfResource('awsIamPolicy', lambdaPolicyName, {
        name: `${ctx.pfx}-${lambdaPolicyName}`,
        policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
          effect: capitalize('allow'),
          action: [
            'dynamodb:ConditionCheck',
            'dynamodb:TransactWriteItems',
            'dynamodb:TransactGetItems',
            ...([ 'view', 'keep' ][has](mode) ? [ 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:BatchGetItem' ] : []),
            ...([ 'mark', 'keep' ][has](mode) ? [ 'dynamodb:PutItem', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteItem' ] : []),
            ...([ 'keep' ][has](mode)         ? [ 'dynamodb:UpdateItem' ] : []) 
          ],
          resource: [
            // Root ddb arn
            tf.embed(ddb.tfRef('arn')),
            // Include all indices
            ...this.indices[map](({ name }) => `${tf.embed(ddb.tfRef('arn'))}/index/${name}`)
          ]
        }]}))
      }));
      
      const lambdaPolicyAttachment = addEntity(new TfResource('awsIamRolePolicyAttachment', lambdaPolicyName, {
        role:      roleTfEnt.tfRefp('name'),
        policyArn: lambdaPolicy.tfRefp('arn')
      }));
      
    }
    
    return entities;
    
  }
  
};
