import proc from '@gershy/nodejs-proc';
import { Context, PetalTerraform, Registry } from '../main.ts';
import retry from '@gershy/util-retry';
import { RegionTerm } from '../util/aws.ts';
import { skip } from '@gershy/clearing';
import http, { NetProc } from '@gershy/util-http';
import { regions as awsRegions } from '../util/aws.ts';
import { SuperIterable } from '../util/superIterable.ts';
import type Logger from '@gershy/logger';

export namespace Soil {
  
  export type PetalProjArgs = { s3Name: string, ddbName: string };
  export type PetalProjResult = {
    [K in 'boot' | 'main']: (args: PetalProjArgs) => SuperIterable<PetalTerraform.Base>
  };
  
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
    
    public async getTerraformPetals(ctx: Context): Promise<PetalProjResult> {
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
    private procArgs: { env: Obj<string> | NodeJS.ProcessEnv };
    
    constructor(args: LocalStackArgs) {
      
      super(args);
      this.aws = args.aws;
      this.localStackDocker = {
        image: 'localstack/localstack:latest',
        port: LocalStack.localStackInternalPort,
        containerName: 'gershyLilacLocalStack'
      }[merge](args.localStackDocker ?? {});
      this.procArgs = { env: process.env };
      
    }
    
    private getAwsServices() {
      
      // Note that "overhead" services are essential for initializing localstack:
      // - s3 + ddb used for terraform state locking
      // - sts is used for credential validation
      // - iam is needed for role creation
      const overheadAwsServices: LocalStackAwsService[] = [ 's3', 'dynamodb', 'sts', 'iam' ];
      return new Set([ ...overheadAwsServices, ...this.registry.getAwsServices() ]);
      
    }
    
    private async getDockerContainers() {
      
      const { containerName } = this.localStackDocker;
      const dockerPs = await proc(`docker ps -a --filter "name=${containerName}" --format "{{.Names}},{{.State}}"`, this.procArgs);
      return dockerPs
        .output
        .split('\n')
        [map](v => v.trim() || skip)
        [map](v => v[cut](',', 1) as [ string, 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' ])
        [map](([ name, state ]) => ({ name, state }))
        
        // Exclude containers which match the `docker ps` filter but don't have the prefix
        [map](v => (v.name === containerName || v.name[hasHead](`${containerName}-`)) ? v : skip);
      
    }
    
    public run(args: { logger: Logger }) { return args.logger.scope('localStack', {}, async logger => {
      
      // Run a localStack container in docker, enabling `terraform apply` on an aws-like target
      
      const { image, port, containerName } = this.localStackDocker;
      const awsServices = this.getAwsServices();
      
      await logger.scope('dockerDeploy', { image, containerName, port }, async logger => {
        
        await proc('docker info', this.procArgs).catch(({ output }) => Error('docker unavailable')[fire]({ output }) );
        logger.log({ $$: 'dockerActive' });
        
        const containers = await this.getDockerContainers();
        let state = containers.find(c => c.name === containerName)?.state ?? 'nonexistent';
        
        // First if a container already exists ensure it's compatible with our given config
        if ([ 'running', 'paused', 'exited' ][has](state)) {
          
          const isExistingContainerReusable = await (async () => {
            
            const { output: inspectJson } = await proc(`docker inspect ${containerName}`, this.procArgs);
            
            const [ containerInfo ] = JSON.parse(inspectJson) as Array<{
              Config: { Image: string, Env: string[] },
              HostConfig: { PortBindings: { [key: string]: Array<{ HostPort: string }> } }
            }>;
            console.log('DOCKER INSPECT', containerInfo);
            
            const containerImage = containerInfo.Config.Image;
            const containerEnv = containerInfo.Config.Env[toObj](v => v[cut]('=', 1));
            const containerPort = Number(containerInfo.HostConfig.PortBindings[`${LocalStack.localStackInternalPort}/tcp`]?.[0]?.HostPort ?? 0);
            const services = (containerEnv.SERVICES ?? '').split(',').sort().join(',');
            
            return true
              && containerImage              === image
              && containerPort               === port
              && containerEnv.DEFAULT_REGION === this.aws.region
              && services                    === awsServices[toArr](v => v).sort().join(',');
            
          })();
          
          if (isExistingContainerReusable) {
            
            if (state === 'paused') await proc(`docker unpause ${containerName}`, this.procArgs);
            if (state === 'exited') await proc(`docker start ${containerName}`, this.procArgs);
            
            logger.log({ $$: 'containerReused' });
            state = 'running';
            
          } else {
            
            await this.end({ containers });
            logger.log({ $$: 'previousLocalStackRemoved', containers });
            state = 'nonexistent';
            
          }
          
        }
        
        if (state === 'nonexistent') {
          
          const runCmd = String[baseline](`
            | docker run
            | --rm
            | -d
            | --privileged${'' /* TODO: consider removing? */}
            | --name ${containerName}
            | -p ${port}:${LocalStack.localStackInternalPort}
            | -v /var/run/docker.sock:/var/run/docker.sock
            | -e SERVICES=${awsServices[toArr](v => v).join(',')}
            | -e DEFAULT_REGION=${this.aws.region}
            | ${image}
          `).split('\n')[map](ln => ln.trim() || skip).join(' ');
          await proc(runCmd, this.procArgs);
          
          state = 'running';
          
        }
        
        if (state !== 'running') throw Error('container state unexpected')[mod]({ state });
        
      });
      
      const readyEndpoint = {
        $req: null as any,
        $res: null as any as { code: number, body: { services?: any[] } },
        netProc: { proto: 'http' as const, addr: 'localhost', port },
        path: [ '_localstack', 'health' ],
        method: 'get' as const
      };
      const { val: { services } } = await retry({
        
        // TODO: If the container already exists, it seems its "s3" and "sts" services become unavailable when we try to reinitialize Soil pointing at it??
        
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
      }).catch(err => err[fire]({ numErrs: err.errs.length, errs: null }));
      logger.log({ $$: 'localStackActive', services });
      
      return {
        aws: { services: [ ...awsServices ], region: this.aws.region, },
        netProc: { proto: 'http', addr: 'localhost', port } as NetProc,
        url: `http://localhost:${port}`
      };
      
    }); }
    
    public async end(args?: { containers?: Awaited<ReturnType<Soil.LocalStack['getDockerContainers']>> }) {
      
      const containers = args?.containers ?? await this.getDockerContainers();
      await proc(`docker rm -f ${containers.map(c => c.name).join(' ')}`, this.procArgs)
        .catch(err => {
          console.log('ERROR ENDING LOCALSTACK DOCKER CONTAINER:\n', err.output);
          return;
        });
      
      return containers;
      
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
        main: function*(args) {
          
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
              bucket:        args.s3Name,
              key:           `tf`,
              dynamodbTable: args.ddbName,
              usePathStyle:  true,
              
              // Point the S3 backend at LocalStack when testing
              endpoints: awsServices[toObj](svc => [ svc, localStackUrl ]),
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
  
  export type AwsCloudArgs = BaseArgs & {
    aws: {
      region: RegionTerm,
      accessKey: {
        id: string,
        '!secret': string
      }
    }
  };
  export class AwsCloud extends Base {
    
    private aws: AwsCloudArgs['aws'];
    
    constructor(args: AwsCloudArgs) {
      super(args);
      this.aws = args.aws;
    }
    
    public async getTerraformPetals(ctx: Context) {
      
      const { aws } = this;
      return {
        
        boot: function*() {
          
          const tfAwsCredsFile = new PetalTerraform.File('creds.ini', String[baseline](`
            | [default]
            | aws_region            = ${aws.region}
            | aws_access_key_id     = ${aws.accessKey.id}
            | aws_secret_access_key = ${aws.accessKey['!secret']}
          `));
          yield tfAwsCredsFile;
          yield new PetalTerraform.Terraform({
            $requiredProviders: {
              aws: {
                source: 'hashicorp/aws',
                version: `~> 5.0`
              }
            }
          });
          yield new PetalTerraform.Provider('aws', {
            
            sharedCredentialsFiles: [ tfAwsCredsFile.refStr() ],
            profile: 'default', // References a section within the credentials file
            region: aws.region,
            
          });
          
        },
        main: function*(args) {
          
          const credFileProfile = 'default';
          const tfAwsCredsFile = new PetalTerraform.File('creds.ini', String[baseline](`
            | [${credFileProfile}]
            | aws_region            = ${aws.region}
            | aws_access_key_id     = ${aws.accessKey.id}
            | aws_secret_access_key = ${aws.accessKey['!secret']}
          `));
          yield tfAwsCredsFile;
          
          yield new PetalTerraform.Terraform({
            $requiredProviders: {
              aws: {
                source: 'hashicorp/aws',
                version: `~> 5.0` // Consider parameterizing??
              }
            },
            '$backend.s3': {
              
              sharedCredentialsFiles: [ tfAwsCredsFile.refStr() ],
              profile:                credFileProfile,
              region:                 aws.region,
              encrypt:                true,
              bucket:                args.s3Name,
              key:                   `tf`,
              dynamodbTable:         args.ddbName
              
            }
          });
          for (const { term } of awsRegions) yield new PetalTerraform.Provider('aws', {
            
            sharedCredentialsFiles: [ tfAwsCredsFile.refStr() ],
            profile:                credFileProfile,
            region:                 term,
            
            // Omit the alias for the default provider!
            ...(term !== aws.region && { alias: term.split('-').join('_') }),
            
          });
          
        }
        
      };
      
      
    }
    
  };
  
};
