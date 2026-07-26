import proc from '@gershy/nodejs-proc';
import { Garden, PetalTerraform } from '../main.ts';
import retry from '@gershy/util-retry';
import '@gershy/clearing';
import http from '@gershy/util-http';
import { regions as awsRegions } from '../util/aws.ts';
import { APIGatewayClient, GetRestApisCommand, type RestApi } from '@aws-sdk/client-api-gateway';
import type { AwsRegionTerm } from '../util/aws.ts';
import type Logger from '@gershy/logger';

const { skip } = clearing;

const map:      typeof cl.map      = cl.map;
const cut:      typeof cl.cut      = cl.cut;
const fire:     typeof cl.fire     = cl.fire;
const hasHead:  typeof cl.hasHead  = cl.hasHead;
const has:      typeof cl.has      = cl.has;
const toObj:    typeof cl.toObj    = cl.toObj;
const toArr:    typeof cl.toArr    = cl.toArr;
const baseline: typeof cl.baseline = cl.baseline;
const mod:      typeof cl.mod      = cl.mod;
const group:    typeof cl.group    = cl.group;

export namespace Soil {
  
  export type PetalProjArgs = { s3Name: string, ddbName: string };
  export type PetalProjResult = {
    [K in 'boot' | 'main']: (args: PetalProjArgs) => Loopable<PetalTerraform.Base>
  };
  
  export type LocalStackAwsService = never
    // These types are recognized by localStack
    // May need to add (or removes) services as localStack evolves
    | 'acm' | 'apigateway' | 'apigatewayv2' | 'cloudformation' | 'cloudwatch' | 'config' | 'dynamodb'
    | 'dynamodbstreams' | 'ec2' | 'es' | 'events' | 'firehose' | 'iam' | 'kinesis' | 'kms'
    | 'lambda' | 'logs' | 'opensearch' | 'redshift' | 'resource' | 'resourcegroupstaggingapi'
    | 'route53' | 'route53resolver' | 's3' | 's3control' | 'scheduler' | 'secretsmanager' | 'ses'
    | 'sns' | 'sqs' | 'ssm' | 'stepfunctions' | 'sts' | 'support' | 'swf' | 'transcribe';
  
  export type BaseArgs = { logger: Logger, garden: Garden<any, any> };
  export type AwsClientConfig = {
    region: string,
    endpoint?: string,
    credentials?: { accessKeyId: string, secretAccessKey: string }
  };
  
  export abstract class Base {
    
    protected logger: Logger;
    protected garden: Garden<any, any>;
    constructor(args: BaseArgs) {
      this.logger = args.logger;
      this.garden = args.garden;
    }
    
    public abstract getAwsClientConfig(): AwsClientConfig;
    public abstract getTerraformPetals(): Promise<PetalProjResult>;
    
    // Note the Soil's region is the *default* region - Flowers can vary by region within a Soil!
    public getRegion(): AwsRegionTerm & { _noOverride: true } { return this.getAwsClientConfig().region as any; }
    
  };
  
  export type LocalStackArgs = BaseArgs & {
    localStackDocker?: {
      image?: `localstack/localstack${':' | ':latest' | '@'}${string}`, // E.g. 'localstack/localstack:latest'
      containerName?: string,
      port?: number,
    }
  };
  export class LocalStack extends Base {
    
    protected static localStackInternalPort = 4566;
    
    protected localStackDocker: NonNullable<Required<LocalStackArgs['localStackDocker']>>;
    
    constructor(args: LocalStackArgs) {
      
      super({ ...args, logger: args.logger.kid('localStack') });
      
      this.localStackDocker = {
        image: 'localstack/localstack:latest',
        port: LocalStack.localStackInternalPort,
        containerName: 'gershyLilacLocalStack',
        ...args.localStackDocker
      };
      
    }
    
    public getAwsClientConfig(region?: AwsRegionTerm) {
      const netProc = this.getLocalStackNetProc();
      return {
        region: region ?? this.garden.defaults.region,
        endpoint: `${netProc.proto}://${netProc.addr}:${netProc.port}`
      };
    }
    public getLocalStackNetProc() {
      const { port } = this.localStackDocker;
      return { proto: 'http', addr: 'localhost', port };
    }
    
    protected getAwsServices() {
      
      // Note that "overhead" services are essential for initializing localstack:
      // - s3 + ddb used for terraform state locking
      // - sts is used for credential validation
      // - iam is needed for role creation
      const overheadAwsServices: LocalStackAwsService[] = [ 's3', 'dynamodb', 'sts', 'iam' ];
      return new Set([ ...overheadAwsServices, ...this.garden.seedBank.getAwsServices() ]);
      
    }
    
    protected async getDockerContainers() {
      
      const { containerName } = this.localStackDocker;
      const dockerPs = await proc(`docker ps -a --filter "name=${containerName}" --format "{{.Names}},{{.State}}"`);
      return dockerPs
        .output
        .split('\n')
        [map](v => v.trim() || skip)
        [map](v => v[cut](',', 1) as [ string, 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' ])
        [map](([ name, state ]) => ({ name, state }))
        
        // Exclude containers which match the `docker ps` filter but don't have the prefix
        [map](v => (v.name === containerName || v.name[hasHead](`${containerName}-`)) ? v : skip);
      
    }
    
    public run() { return this.logger.scope('run', {}, async logger => {
      
      // Run a localStack container in docker, enabling `terraform apply` on an aws-like target
      
      const { image, port, containerName } = this.localStackDocker;
      const awsServices = this.getAwsServices();
      
      await logger.scope('dockerDeploy', { image, containerName, port }, async logger => {
        
        await proc('docker info').catch(({ output }) => Error('docker unavailable')[fire]({ output }) );
        logger.log({ $$: 'dockerActive' });
        
        const containers = await this.getDockerContainers();
        let state = containers.find(c => c.name === containerName)?.state ?? 'nonexistent';
        
        // First if a container already exists ensure it's compatible with our given config
        if ([ 'running', 'paused', 'exited' ][has](state)) {
          
          const isExistingContainerReusable = await (async () => {
            
            const { output: inspectJson } = await proc(`docker inspect ${containerName}`);
            
            const [ containerInfo ] = JSON.parse(inspectJson) as Array<{
              Config: { Image: string, Env: string[] },
              HostConfig: { PortBindings: { [key: string]: Array<{ HostPort: string }> } }
            }>;
            logger.log({ $$: 'reusableCheck', containerInfo });
            
            const containerImage = containerInfo.Config.Image;
            const containerEnv = containerInfo.Config.Env[toObj](v => v[cut]('=', 1));
            const containerPort = Number(containerInfo.HostConfig.PortBindings[`${LocalStack.localStackInternalPort}/tcp`]?.[0]?.HostPort ?? 0);
            const services = (containerEnv.SERVICES ?? '').split(',').sort().join(',');
            
            return true
              && containerImage              === image
              && containerPort               === port
              && containerEnv.DEFAULT_REGION === this.garden.defaults.region
              && services                    === awsServices[toArr](v => v).sort().join(',');
            
          })();
          
          if (isExistingContainerReusable) {
            
            if (state === 'paused') await proc(`docker unpause ${containerName}`);
            if (state === 'exited') await proc(`docker start ${containerName}`);
            
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
            | -e DEFAULT_REGION=${this.garden.defaults.region}
            | ${image}
          `).split('\n')[map](ln => ln.trim() || skip).join(' ');
          await proc(runCmd);
          
          state = 'running';
          
        }
        
        if (state !== 'running') throw Error('container state unexpected')[mod]({ state });
        
      });
      
      const { val: { services } } = await retry({
        
        // TODO: If the container already exists, it seems its "s3" and "sts" services become unavailable when we try to reinitialize Soil pointing at it??
        
        attempts: 20,
        delayMs: n => Math.min(500, 50 * n),
        fn: async () => {
          
          // Retry all failures and non-200s
          const res = await http({
            netProc: { proto: 'http' as const, addr: 'localhost', port },
            path: [ '_localstack', 'health' ],
            method: 'get' as const
          }).catch(err => err[fire]({ retry: true }));
          if (res.code !== 200) throw Error('unhealthy')[mod]({ retry: true });
          
          const { ya = [], no = [] } = (res.body.services as { [K in LocalStackAwsService]: 'disabled' | 'available' })
            [group](v => v === 'available' ? 'ya' : 'no')
            [map](group => (group as any)[toArr]((v, k) => k) as LocalStackAwsService[]);
          
          const missingServices = no[map](svc => awsServices.has(svc) ? svc : skip);
          if (missingServices.length)
            throw Error('services unavailable')[mod]({ missingServices })[mod]({ retry: true });
          
          return { res, services: ya };
          
        },
        retry: err => !!err.retry
        
      }).catch(err => err[fire]({ numErrs: err.errs.length, errs: null }));
      logger.log({ $$: 'result', services });
      
      return {
        netProc: this.getLocalStackNetProc(),
        getApis: async () => {
          const client = new APIGatewayClient(this.getAwsClientConfig());
          const apiRes = await client.send(new GetRestApisCommand({}));
          const apis = (apiRes.items ?? []) as (RestApi & { id: string, name: string })[];
          return apis[toObj](api => [ api.name, api ]);
        }
      };
      
    }); }
    
    public async end(args?: { containers?: Awaited<ReturnType<Soil.LocalStack['getDockerContainers']>> }) {
      
      return this.logger.scope('end', {}, async logger => {
        
        const containers = args?.containers ?? await this.getDockerContainers();
        await proc(`docker rm -f ${containers.map(c => c.name).join(' ')}`).catch(err => {
          logger.log({ $$: 'glitch', cmdOutput: err.output });
          return;
        });
        return containers;
        
      });
      
      
    }
    
    public async getTerraformPetals() {
      
      const garden = this.garden;
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
            
            region:                    garden.defaults.region,
            skipCredentialsValidation: true,
            skipRequestingAccountId:   true,
            accessKey:                 'test', // Dummy credentials make it impossible for aws requests to succeed
            secretKey:                 'test',
            s3UsePathStyle:            true,   // Otherwise requests can go to "bucket.s3.amazonaws.com", outside localStack
            
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
            $backend$s3: {
              region:        garden.defaults.region,
              encrypt:       true,
              bucket:        args.s3Name,
              key:           'tf',
              dynamodbTable: args.ddbName,
              usePathStyle:  true,
              
              // Point the S3 backend at LocalStack when testing
              endpoints: awsServices[toObj](svc => [ svc, localStackUrl ]),
            }
          });
          
          for (const { term } of awsRegions) yield new PetalTerraform.Provider('aws', {
            
            region:                    term,
            skipCredentialsValidation: true,
            skipRequestingAccountId:   true,
            accessKey:                 'test',
            secretKey:                 'test',
            
            // Omit the alias for the default provider!
            ...(term !== garden.defaults.region && { alias: term.split('-').join('_') }),
            
            // Point providers at LocalStack when testing
            s3UsePathStyle: true,
            $endpoints: awsServices[toObj](svc => [ svc, localStackUrl ])
            
          });
          
        }
      };
      
    }
    
  };
  
  export type AwsCloudArgs = BaseArgs & { auth: { id: string, '!secret': string } };
  export class AwsCloud extends Base {
    
    protected auth: AwsCloudArgs['auth'];
    
    constructor(args: AwsCloudArgs) {
      super(args);
      this.auth = args.auth;
    }
    
    public getAwsClientConfig(region?: AwsRegionTerm) {
      return {
        region: region ?? this.garden.defaults.region,
        credentials: {
          accessKeyId: this.auth.id,
          secretAccessKey: this.auth['!secret']
        }
      };
    }
    public async getTerraformPetals() {
      
      const garden = this.garden;
      const auth = this.auth;
      return {
        
        boot: function*() {
          
          const tfAwsCredsFile = new PetalTerraform.File('creds.ini', String[baseline](`
            | [default]
            | aws_region            = ${garden.defaults.region}
            | aws_access_key_id     = ${auth.id}
            | aws_secret_access_key = ${auth['!secret']}
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
            region: garden.defaults.region
            
          });
          
        },
        main: function*(args) {
          
          const credFileProfile = 'default';
          const tfAwsCredsFile = new PetalTerraform.File('creds.ini', String[baseline](`
            | [${credFileProfile}]
            | aws_region            = ${garden.defaults.region}
            | aws_access_key_id     = ${auth.id}
            | aws_secret_access_key = ${auth['!secret']}
          `));
          yield tfAwsCredsFile;
          
          yield new PetalTerraform.Terraform({
            $requiredProviders: {
              aws: {
                source: 'hashicorp/aws',
                version: `~> 5.0` // Consider parameterizing??
              }
            },
            $backend$s3: {
              
              sharedCredentialsFiles: [ tfAwsCredsFile.refStr() ],
              profile:                credFileProfile,
              region:                 garden.defaults.region,
              encrypt:                true,
              bucket:                 args.s3Name,
              key:                    'tf',
              dynamodbTable:          args.ddbName
              
            }
          });
          for (const { term } of awsRegions) yield new PetalTerraform.Provider('aws', {
            
            sharedCredentialsFiles: [ tfAwsCredsFile.refStr() ],
            profile:                credFileProfile,
            region:                 term,
            
            // Omit the alias for the default provider!
            ...(term !== garden.defaults.region && { alias: term.split('-').join('_') }),
            
            $defaultTags: {
              tags: {
                lilacName:   garden.term,
                lilacPrefix: garden.pfx
              }
            }
            
          });
          
        }
        
      };
      
      
    }
    
  };
  
};
