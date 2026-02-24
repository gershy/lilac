import capitalize from '../../../boot/util/capitalize';
import kebabCase from '../../../boot/util/kebabCase';
import { TfEntity, TfResource } from '../provider/awsTf';
import { LambdaStorageKeeper } from '../comm/lambdaStorage/keep';
import { LambdaStorageMarker } from '../comm/lambdaStorage/mark';
import { LambdaStorageViewer } from '../comm/lambdaStorage/view';
import { Lilac, LilacContext } from '../lilac';
import { aws, tf } from '../util';
import { Lambda } from './lambda';

export class Storage extends Lilac {
  
  protected name: string;
  protected bucket: null | TfResource;
  protected accessors: { mode: 'view' | 'mark' | 'keep', baseKey: null | string, lambda: Lambda<any, any, any, any, any> }[];
  constructor(args: { name: string }) {
    super();
    this.name = args.name;
    this.bucket = null;
    this.accessors = [];
  }
  
  public * getDependencies(ctx: LilacContext) {
    yield* super.getDependencies(ctx);
    // for (const { lambda } of this.accessors) yield* lambda.getDependencies(ctx);
  }
  public getName(ctx: LilacContext) { return `${ctx.pfx}-${kebabCase(this.name)}` }
  public getBucket(ctx: LilacContext) {
    if (!this.bucket)
      this.bucket = new TfResource('awsS3Bucket', this.name, {
        bucket: this.getName(ctx),
        tags: {
          system: ctx.term,
          maturity: ctx.maturity
        },
        forceDestroy: true // Make it easy to `terraform destroy`
      });
    
    return this.bucket;
  }
  
  public getAccessorConfig(ctx: LilacContext, baseKey: null | string) {
    return { bucket: this.getName(ctx), baseKey };
  }
  
  addAccessor(ctx: LilacContext, mode: 'view', baseKey: null | string, lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaStorageViewer>;
  addAccessor(ctx: LilacContext, mode: 'mark', baseKey: null | string, lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaStorageMarker>;
  addAccessor(ctx: LilacContext, mode: 'keep', baseKey: null | string, lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaStorageKeeper>;
  addAccessor(ctx: LilacContext, mode: 'view' | 'mark' | 'keep', baseKey: null | string, lambda: Lambda<any, any, any, any, any>): any {
    
    this.accessors.push({ mode, baseKey, lambda });
    
    if (mode === 'keep') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaStorage/keep::LambdaStorageKeeper',
        form: LambdaStorageKeeper,
        args: [ this.getAccessorConfig(ctx, baseKey) ]
      } as JsfnInst<typeof LambdaStorageKeeper>;
      
    } else if (mode === 'view') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaStorage/view::LambdaStorageViewer',
        form: LambdaStorageViewer,
        args: [ this.getAccessorConfig(ctx, baseKey) ]
      } as JsfnInst<typeof LambdaStorageViewer>;
      
    } else if (mode === 'mark') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaStorage/mark::LambdaStorageMarker',
        form: LambdaStorageMarker,
        args: [ this.getAccessorConfig(ctx, baseKey) ]
      } as JsfnInst<typeof LambdaStorageMarker>;
      
    }
    
    throw Error('bad mode')[mod]({ mode });
    
  }
  
  async getTfEntities0(ctx: LilacContext) {
    
    const entities: TfEntity[] = [];
    const addEntity = (ent: TfEntity) => { entities.push(ent); return ent; };
    
    const bucket = addEntity(this.getBucket(ctx));
    
    const ownership = addEntity(new TfResource('awsS3BucketOwnershipControls', this.name, {
      bucket: bucket.tfRefp('bucket'),
      $rule: {
        objectOwnership: capitalize('objectWriter')
      }
    }));
    
    const accessControlList = addEntity(new TfResource('awsS3BucketAcl', this.name, {
      bucket: bucket.tfRefp('bucket'),
      acl: 'private',
      dependsOn: [ ownership.tfRefp() ]
    }));
    
    for (const { mode, baseKey, lambda } of this.accessors) {
      
      const roleTfEnt = await lambda.getRole().getTfEntities(ctx).then(ents => ents.find(ent => ent.getType() === 'awsIamRole')!);
      
      const lambdaPolicyName = capitalize([ 'lambdaStorage', lambda.getName(), this.name ]);
      const lambdaPolicy = addEntity(new TfResource('awsIamPolicy', lambdaPolicyName, {
        name: `${ctx.pfx}-${lambdaPolicyName}`,
        policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
          effect: capitalize('allow'),
          action: [
            
            's3:ListBucket', // Always include this??
            ...([ 'view', 'keep' ][has](mode) ? [ 's3:GetObject', ] : []),
            ...([ 'mark', 'keep' ][has](mode) ? [ 's3:PutObject', 's3:DeleteObject' ] : []),
            // ...([ 'keep' ][has](mode)         ? [] : [])
            
          ],
          resource: [
            `${tf.embed(bucket.tfRef('arn'))}`, // Consider: this is redundant unless using s3:ListObject, s3:GetBucketLocation, etc??
            `${tf.embed(bucket.tfRef('arn'))}/${baseKey ?? '*'}`,
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