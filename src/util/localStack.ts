/*
TODO: DELEEEETE

import proc from '@gershy/util-nodejs-proc';
import { rootFact } from '@gershy/disk';
import http from '@gershy/util-http';
import tryWithHealing from '@gershy/util-try-with-healing';
import { Context } from '../main.ts';
import retry from '@gershy/util-retry';
import { skip } from '@gershy/clearing';
import tcpPing from './tcpPing.ts';

export type AwsService = never
  // These types are recognized by localStack
  // May need to add (or removes) services as localStack evolves
  | 'acm'
  | 'apigateway'
  | 'cloudformation'
  | 'cloudwatch'
  | 'config'
  | 'dynamodb'
  | 'dynamodbstreams'
  | 'ec2'
  | 'es'
  | 'events'
  | 'firehose'
  | 'iam'
  | 'kinesis'
  | 'kms'
  | 'lambda'
  | 'logs'
  | 'opensearch'
  | 'redshift'
  | 'resource'
  | 'resourcegroupstaggingapi'
  | 'route53'
  | 'route53resolver'
  | 's3'
  | 's3control'
  | 'scheduler'
  | 'secretsmanager'
  | 'ses'
  | 'sns'
  | 'sqs'
  | 'ssm'
  | 'stepfunctions'
  | 'sts'
  | 'support'
  | 'swf'
  | 'transcribe';

export type LocalStackArgs = {
  context: Context,
  awsServices: AwsService[],
  localStackDocker?: {
    image?: `localstack/localstack${':' | ':latest' | '@'}${string}`, // E.g. 'localstack/localstack:latest'
    containerName?: string,
    port?: number,
  }
};
export default (args: LocalStackArgs) => args.context.logger.scope('localStack', {}, async logger => {
  
  const localStackInternalPort = 4566;
  const { context, localStackDocker } = args;
  const { image = 'localstack/localstack:latest', port = localStackInternalPort, containerName = 'gershyLilacMockAws' } = localStackDocker ?? {};
  const procArgs = { cwd: rootFact, env: process.env };
  
  // Deploy localstack to docker
  await proc('docker info', procArgs).catch(({ output }) => { throw Error('docker unavailable')[mod]({ output }) });
  logger.log({ $$: 'dockerActiveConfirmed' });
  
  // Note that "overhead" services are essential for initializing localstack:
  // - s3 + ddb used for terraform state locking
  // - sts is used for credential validation
  // - iam is needed for role creation
  const overheadAwsServices: AwsService[] = [ 's3', 'dynamodb', 'sts', 'iam' ];
  const awsServices = new Set([ ...overheadAwsServices, ...args.awsServices ]);
  
  await tryWithHealing({
    fn: () => {
      const runCmd = String[baseline](`
        | docker run
        |   --rm
        |   -d
        |   --privileged
        |   --name ${containerName}
        |   -p ${port}:${localStackInternalPort}
        |   -v /var/run/docker.sock:/var/run/docker.sock${'' /* Socket is better for non-WSL setups (TODO verify this?); it will be ignored if DOCKER_HOST is also provided * /}
        |   -e SERVICES=${awsServices[toArr](v => v).join(',')}
        |   -e DEFAULT_REGION=${context.aws.region}
        |   ${image}
      `).split('\n')[map](ln => ln.trim() || skip).join(' ');
      return proc(runCmd, procArgs);
    },
    canHeal: err => err.output.includes('already in use'),
    heal: async () => {
      // Kill any pre-existing container
      await proc(`docker rm -f ${containerName}`, procArgs);
      logger.log({ $$: 'preexistingKilled' });
    }
  });
  
  // accept, reject, settle, finish
  logger.log({ $$: 'containerActive' });
  
  const readyEndpoint = {
    $req: null as any,
    $res: null as any as { code: number, body: { services?: any[] } },
    netProc: { proto: 'http' as const, addr: 'localhost', port },
    path: [ '_localstack', 'health' ],
    method: 'get' as const
  };
  const { val: { services } } = await retry({
    attempts: 20,
    delay: n => Math.min(500, 50 * n),
    fn: async () => {
      
      // Retry all failures and non-200s
      const res = await http(readyEndpoint, {} as any).catch(err => err[fire]({ retry: true }));
      if (res.code !== 200) throw Error('unhealthy')[mod]({ retry: true });
      
      const { ya = [], no = [] } = (res.body.services as { [K in AwsService]: 'disabled' | 'available' })
        [group](v => v === 'available' ? 'ya' : 'no')
        [map](group => (group as any)[toArr]((v, k) => k) as AwsService[]);
      
      const missingServices = no[map](svc => awsServices.has(svc) ? svc : skip);
      if (missingServices.length)
        throw Error('services unavailable')[mod]({ missingServices })[mod]({ retry: true });
      
      return { services: ya };
      
    },
    retryable: err => !!err.retry,
  });
  logger.log({ $$: 'result',  });
  
  return {
    
    awsServices: [ ...awsServices ],
    netProc: { proto: 'http' as const, addr: 'localhost', port },
    end: async () => proc(`docker rm -f ${containerName}`, procArgs)
    
  };
  
});
*/