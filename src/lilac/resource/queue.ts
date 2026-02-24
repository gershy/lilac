import capitalize from '../../../boot/util/capitalize';
import { TfEntity, TfResource } from '../provider/awsTf';
import { LambdaQueueMarker } from '../comm/lambdaQueue/mark';
import { Lilac, LilacContext } from '../lilac';
import { aws, tf } from '../util';
import { Lambda, LambdaQueue } from './lambda';

export class Queue<Event extends Json> extends Lilac {
  
  protected name: string;
  protected handler: LambdaQueue<any, any, any, any>; // TODO: Not necessarily a LambdaQueue, rather anything that implements "sqs consumer", i.e., has a terraform event source mapping for sqs
  protected accessors: { mode: 'mark', lambda: Lambda<any, any, any, any, any> }[]; // TODO: Only access type is "mark", as in, "produce"??
  constructor(args: { name: string, handler: LambdaQueue<any, any, any, any> }) {
    super();
    this.name = args.name;
    this.handler = args.handler;
    this.accessors = [];
  }
  
  public * getDependencies(ctx: LilacContext) {
    yield* super.getDependencies(ctx);
    yield* this.handler.getDependencies(ctx);
  }
  
  addAccessor(ctx: LilacContext, mode: 'mark', lambda: Lambda<any, any, any, any, any>) {
    
    this.accessors.push({ mode, lambda });
    
    if (mode === 'mark') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaQueue/mark::LambdaQueueMarker',
        form: LambdaQueueMarker,
        args: [ {} ]
      } as JsfnInst<typeof LambdaQueueMarker<Event>>;
      
    }
    
    throw Error('bad mode')[mod]({ mode });
    
  }
  
  async getTfEntities0(ctx: LilacContext) {
    
    const entities: TfEntity[] = [];
    const addEntity = (ent: TfEntity) => { entities.push(ent); return ent; };
    
    const queue = addEntity(new TfResource('awsSqsQueue', this.name, {
      name: `${ctx.pfx}-${this.name}`,
    }));
    
    // Make sure the lambda can reference the queue (TODO: how  does this work if we try to generalize `this.handler` from specifically a Lambda??)
    // TODO: There's some ugliness with how `lambda.envVars` gets set. For example an apigw sets
    // env.soktUrl on all its handlers, and Queue sets env.queueUrl on its handler. But this means
    // lambdas only need comms information about the lilac whose context they're created in. A
    // queue-handling lambda may easily want to write to a socket, but can't - because it wasn't
    // created as a handler for the socket's apigw. Probably need something like an "entrypoints"
    // registry - apigw and async handlers like queues are all entrypoints to a proj ("app"). These
    // entrypoints should probably be referenced roughly like `registry.addAccessor('apigw')`, and
    // the `registry.addAccessor` method can set the env vars on the lambda. This will avoid every
    // http lambda blindly needing to be assigned httpUrl and soktUrl env vars (which are only
    // actually used by lambdas that need to fire sokt events), and enables a scenario like "lambda
    // queue handler talks to apigw sokt"!
    Object.assign(this.handler.envVars, {
      queueUrl: `${tf.embed(queue.tfRef('id'))}`
    });
    
    // Set up event mapping for the handler to consume sqs
    const sqsConsumePolicyName = capitalize([ 'lambdaQueue', this.handler.getName(), 'consume', this.name ]);
    const sqsConsumeTfEnt =      await this.handler          .getTfEntities(ctx).then(ents => ents.find(ent => ent.getType() === 'awsLambdaFunction')!);
    const sqsConsumeRoleTfEnt =  await this.handler.getRole().getTfEntities(ctx).then(ents => ents.find(ent => ent.getType() === 'awsIamRole')!);
    
    const sqsConsumePolicy = addEntity(new TfResource('awsIamPolicy', sqsConsumePolicyName, {
      name: `${ctx.pfx}-${sqsConsumePolicyName}`,
      policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
        effect: capitalize('allow'),
        action: [
          // These actions are necessary for the sqs consumer
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:ChangeMessageVisibility'
        ],
        resource: [ `${tf.embed(queue.tfRef('arn'))}` ]
      }]}))
    }));
    const handlerConsumeSqsPolicyAttachment = addEntity(new TfResource('awsIamRolePolicyAttachment', sqsConsumePolicyName, {
      role:      sqsConsumeRoleTfEnt.tfRefp('name'),
      policyArn: sqsConsumePolicy.tfRefp('arn')
    }));
    const mapping = addEntity(new TfResource('awsLambdaEventSourceMapping', this.name, {
      eventSourceArn: queue.tfRefp('arn'),
      functionName: sqsConsumeTfEnt.tfRefp('arn'),
      batchSize: 1,
    }));
    
    for (const { mode, lambda } of this.accessors) {
      
      const roleTfEnt = await lambda.getRole().getTfEntities(ctx).then(ents => ents.find(ent => ent.getType() === 'awsIamRole')!);
      
      const lambdaPolicyName = capitalize([ 'lambdaQueue', lambda.getName(), this.name ]);
      const lambdaPolicy = addEntity(new TfResource('awsIamPolicy', lambdaPolicyName, {
        name: `${ctx.pfx}-${lambdaPolicyName}`,
        policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
          
          effect: capitalize('allow'),
          action: [
            ...([ 'mark', 'keep' ][has](mode) ? [ 'sqs:SendMessage' ] : []),
            
            // ...([ 'view', 'keep' ][has](mode)         ? [] : []) // No "view" actions at the moment...
          ],
          resource: [ `${tf.embed(queue.tfRef('arn'))}` ]
          
        }]}))
      }));
      
      const lambdaPolicyAttachment = addEntity(new TfResource('awsIamRolePolicyAttachment', lambdaPolicyName, {
        role:      roleTfEnt.tfRefp('name'),
        policyArn: lambdaPolicy.tfRefp('arn')
      }));
      
      // Make sure the lambda knows where to find the queue (see above comment)
      Object.assign(lambda.envVars, {
        queueUrl: `${tf.embed(queue.tfRef('id'))}`
      });
      
    }
    
    return entities;
    
  }
  
};