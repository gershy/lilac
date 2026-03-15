import { Fact, rootFact } from '@gershy/disk';
import proc from '@gershy/util-nodejs-proc';
import { Context, PetalTerraform, Registry } from '../main.ts';
import tryWithHealing from '@gershy/util-try-with-healing';
import retry from '@gershy/util-retry';
import { RegionTerm } from '../util/aws.ts';
import { skip } from '@gershy/clearing';
import http, { NetProc } from '@gershy/util-http';
import { regions as awsRegions } from '../util/aws.ts';
import { SuperIterable } from '../util/superIterable.ts';
import Logger from '@gershy/logger';

export namespace Soil {
  
  export type LocalStackAwsService = never
    // These types are recognized by localStack
    // May need to add (or removes) services as localStack evolves
    | 'acm' | 'apigateway' | 'cloudformation' | 'cloudwatch' | 'config' | 'dynamodb'
    | 'dynamodbstreams' | 'ec2' | 'es' | 'events' | 'firehose' | 'iam' | 'kinesis' | 'kms'
    | 'lambda' | 'logs' | 'opensearch' | 'redshift' | 'resource' | 'resourcegroupstaggingapi'
    | 'route53' | 'route53resolver' | 's3' | 's3control' | 'scheduler' | 'secretsmanager' | 'ses'
    | 'sns' | 'sqs' | 'ssm' | 'stepfunctions' | 'sts' | 'support' | 'swf' | 'transcribe';
  
  export type BaseArgs = { registry: Registry<any> };
  export class Base {

    protected registry: Registry<any>;
    constructor(args: BaseArgs) {
      this.registry = args.registry;
    }
    
    public async getTerraformPetals(context: Context): Promise<{ [K in 'boot' | 'main']: () => SuperIterable<PetalTerraform.Base> }> {
      
      throw Error('not implemented');
      
    }
    
  };
  
  export type LocalStackArgs = BaseArgs & {
    aws: {
      region: RegionTerm,
    },
    localStackDocker?: {
      image?: `localstack/localstack${':' | ':latest' | '@'}${string}`, // E.g. 'localstack/localstack:latest'
      containerName?: string,
      port?: number,
    }
  };
  export class LocalStack extends Base {
    
    private static localStackInternalPort = 4566;
    
    private aws: LocalStackArgs['aws'];
    private localStackDocker: NonNullable<Required<LocalStackArgs['localStackDocker']>>;
    private procArgs: { cwd: Fact, env: Obj<string> | NodeJS.ProcessEnv };
    
    constructor(args: LocalStackArgs) {
      
      super(args);
      this.aws = args.aws;
      this.localStackDocker = {
        image: 'localstack/localstack:latest',
        port: LocalStack.localStackInternalPort,
        containerName: 'gershyLilacLocalStack'
      }[merge](args.localStackDocker ?? {});
      this.procArgs = { cwd: rootFact, env: process.env };
      
    }
    
    private getAwsServices() {
      
      // Note that "overhead" services are essential for initializing localstack:
      // - s3 + ddb used for terraform state locking
      // - sts is used for credential validation
      // - iam is needed for role creation
      const overheadAwsServices: LocalStackAwsService[] = [ 's3', 'dynamodb', 'sts', 'iam' ];
      return new Set([ ...overheadAwsServices, ...this.registry.getAwsServices() ]);
      
    };
    
    public run(args: { logger: Logger }) { return args.logger.scope('localStack', {}, async logger => {
      
      // Run a localStack container in docker, enabling `terraform apply` on an aws-like target
      
      const { image, port, containerName } = this.localStackDocker;
      
      // Deploy localstack to docker
      await proc('docker info', this.procArgs).catch(({ output }) => { throw Error('docker unavailable')[mod]({ output }) });
      logger.log({ $$: 'dockerAvailabilityConfirmed' });
      
      // Note that "overhead" services are essential for initializing localstack:
      // - s3 + ddb used for terraform state locking
      // - sts is used for credential validation
      // - iam is needed for role creation
      const awsServices = this.getAwsServices();
      await tryWithHealing({
        
        // TODO HEEERE: allow redeploying to a persistent localStack setup
        
        fn: () => {
          const runCmd = String[baseline](`
            | docker run
            |   --rm
            |   -d
            |   --privileged${'' /* TODO: consider removing? */}
            |   --name ${containerName}
            |   -p ${port}:${LocalStack.localStackInternalPort}
            |   -v /var/run/docker.sock:/var/run/docker.sock${'' /* Socket is better for non-WSL setups (TODO verify this?); it will be ignored if DOCKER_HOST is also provided */}
            |   -e SERVICES=${awsServices[toArr](v => v).join(',')}
            |   -e DEFAULT_REGION=${this.aws.region}
            |   ${image}
          `).split('\n')[map](ln => ln.trim() || skip).join(' ');
          return proc(runCmd, this.procArgs);
        },
        canHeal: err => err.output.includes('already in use'),
        heal: async () => {
          // Kill any pre-existing container
          await proc(`docker rm -f ${containerName}`, this.procArgs);
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
          
          const { ya = [], no = [] } = (res.body.services as { [K in LocalStackAwsService]: 'disabled' | 'available' })
            [group](v => v === 'available' ? 'ya' : 'no')
            [map](group => (group as any)[toArr]((v, k) => k) as LocalStackAwsService[]);
          
          const missingServices = no[map](svc => awsServices.has(svc) ? svc : skip);
          if (missingServices.length)
            throw Error('services unavailable')[mod]({ missingServices })[mod]({ retry: true });
          
          return { services: ya };
          
        },
        retryable: err => !!err.retry,
      });
      logger.log({ $$: 'localStackAvailabilityConfirmed', services });
      
      return {
        
        aws: { services: [ ...awsServices ], region: this.aws.region, },
        netProc: { proto: 'http', addr: 'localhost', port } as NetProc,
        url: `http://localhost:${port}`
        
      };
      
    }); }
    
    public async end() {
      
      await proc(`docker rm -f ${this.localStackDocker.containerName}`, this.procArgs).catch(err => {
        console.log('TODO: ERROR ENDING LOCALSTACK DOCKER CONTAINER:\n', err.output);
        return;
      });
      
    }
    
    public async getTerraformPetals(ctx: Context) {
      
      const { aws } = this;
      
      const awsServices = [ ...this.getAwsServices() ];
      const netProc = { proto: 'http', addr: 'localhost', port: this.localStackDocker.port }
      const localStackUrl = `${netProc.proto}://${netProc.addr}:${netProc.port}`;
      
      return {
        boot: () => [
          
          new PetalTerraform.Terraform({
            $requiredProviders: {
              aws: {
                source: 'hashicorp/aws',
                version: `~> 5.0`
              }
            }
          }),
          
          new PetalTerraform.Provider('aws', {
            
            region:                    aws.region,
            skipCredentialsValidation: true,
            skipRequestingAccountId:   true,
            s3UsePathStyle:            true, // Otherwise requests can go to "bucket.s3.amazonaws.com", outside localStack
            
            // Note our localStack setup always includes s3 and ddb (required for tf state storage)
            $endpoints: awsServices[toObj](svc => [ svc, localStackUrl ])
            
          })
          
        ],
        main: function*() {
          
          yield new PetalTerraform.Terraform({
            $requiredProviders: {
              aws: {
                source: 'hashicorp/aws',
                version: `~> 5.0` // Consider parameterizing??
              }
            },
            '$backend.s3': {
              region:        aws.region,
              encrypt:       true,
              bucket:        `${ctx.pfx}-tf-state`,
              key:           `tf`,
              dynamodbTable: `${ctx.pfx}-tf-state`,
              usePathStyle: true,
              
              // Point the S3 backend at LocalStack when testing
              endpoints: awsServices [toObj](svc => [ svc, localStackUrl ]),
            }
          });
          
          for (const { term } of awsRegions) yield new PetalTerraform.Provider('aws', {
            
            region: term,
            skipCredentialsValidation: true,
            skipRequestingAccountId:   true,
            
            // Omit the alias for the default provider!
            ...(term !== aws.region && { alias: term.split('-').join('_') }),
            
            // Point providers at LocalStack when testing
            s3UsePathStyle: true,
            $endpoints: awsServices[toObj](svc => [ svc, localStackUrl ])
            
          });
          
        }
      };
      
    }
    
  };
  
  export class AwsCloud extends Base {
    
    // TODO: The terraform is commented out in main.ts
    
  };
  
  
};
