import { Lilac, LilacContext } from '../lilac';
import { TfResource } from '../provider/awsTf';
import { aws, tf } from '../util';

export type S3Action = `s3:${'ListBucket' | 'GetObject'}`;
export type DynamodbAction = `dynamodb:${'Query' | 'Put' | 'Delete'}`;
export type LogAction = `logs:${'CreateLogGroup' | 'CreateLogStream' | 'PutLogEvents'}`;
export type StsAction = `sts:${'AssumeRole'}`;
export type EnactPolicy = {
  effect: 'Allow' | 'Deny',
} & (
  | { action: StsAction,             principal: { service: string } }
  | { action: Array<S3Action>,       resource: Array<`arn:aws:s3:${string}`>       }
  | { action: Array<DynamodbAction>, resource: Array<`arn:aws:dynamodb:${string}`> }
  | { action: Array<LogAction>,      resource: Array<`arn:aws:logs:${string}`>     }
);

export class Role extends Lilac {
  private name: string;
  private assumePolicies: EnactPolicy[];
  private enactPolicies: EnactPolicy[];
  
  constructor(props: { name: string, assumePolicies: EnactPolicy[], enactPolicies: EnactPolicy[] }) {
    super();
    this.name = props.name;
    this.assumePolicies = props.assumePolicies;
    this.enactPolicies = props.enactPolicies;
  }
  
  public * getDependencies(ctx: LilacContext) {
    yield* super.getDependencies(ctx);
  }
  
  async getTfEntities0(ctx: LilacContext) {
    
    const role = new TfResource('awsIamRole', this.name, {
      name: `${ctx.pfx}-${this.name}`,
      assumeRolePolicy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: this.assumePolicies }))
    });
    const policy = new TfResource('awsIamPolicy', this.name, {
      name: `${ctx.pfx}-${this.name}`,
      policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: this.enactPolicies }))
    });
    const attach = new TfResource('awsIamRolePolicyAttachment', this.name, {
      // No need to insert context.stage here!
      role:      role.tfRefp('name'),
      policyArn: policy.tfRefp('arn')
    });
    return [ role, policy, attach ];
    
  }
};