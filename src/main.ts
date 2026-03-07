// TODO:

// A more generic (beyond just tf) provider is very hard to support due to the multiplicity of
// provider/petal combos - e.g. "api" flower would need to support ,api.getCloudformationPetals,
// api.getTerraformPetals, etc... supporting just terraform for now

// Watch out when working lilac into an npm dependency, need to allow the user a way to declare
// their absolute repo path (so "<repo>/..." filenames work in any setup!)

// Can region be dealt with any better??

// Support test-mode (Flowers need to be able to do setup, share config, write to volumes, etc)

import { PetalTerraform } from './petal/terraform/terraform.ts';
import Logger from './util/logger.ts';
import { Fact } from '@gershy/disk';
import { regions as awsRegions } from './util/aws.ts';
import { isCls, skip } from '@gershy/clearing';
import procTerraform from './util/procTerraform.ts';

const { File, Provider, Terraform } = PetalTerraform;

export type Context = {
  
  name: string, // Name of the system/garden
  logger: Logger,
  fact: Fact,
  patioFact: Fact,
  
  aws: {
    accountId: string,
    accessKey: { id: string, '!secret': string },
    region: string
  },
  maturity:   string,
  debug:      boolean,
  pfx:        string // Establishes a namespace for all resources provisioned for the particular app
  
  // // Throttlers:
  // // - webpack: shell "webpack" commands
  // // - zipFile: jszipping files
  // throttlers: { [K in 'webpack' | 'zipFile']: Throttler }
  
};

export class Flower {
  constructor() {}
  public * getDependencies(): Generator<Flower> {
    yield this;
  }
  public getPetals(ctx: Context): Iterable<PetalTerraform.Base> | AsyncIterable<PetalTerraform.Base> {
    throw Error('not implemented');
  }
};

type RegistryFlowers<R extends Registry<any>, M extends 'real' | 'test'> = R extends Registry<infer Flowers>
  ? { [K in keyof Flowers]: Flowers[K][M] }
  : never;

export class Registry<Flowers extends Obj<{ real: typeof Flower, test: typeof Flower }> = Obj<never>> {
  
  private flowers: Flowers;
  constructor(flowers: Flowers) {
    this.flowers = {}[merge](flowers);
  }
  
  add<MoreFlowers extends Obj<{ real: typeof Flower, test: typeof Flower }>>(flowers: MoreFlowers): Registry<Omit<Flowers, keyof MoreFlowers> & MoreFlowers> {
    return new Registry({ ...this.flowers, ...flowers } as any);
  }
  get<Mode extends 'real' | 'test'>(mode: Mode): RegistryFlowers<Registry<Flowers>, Mode> {
    return this.flowers[map]((v) => v[mode]);
  }
  
};

export class Garden<Reg extends Registry<any>> {
  
  // Note this class currently is coupled to terraform logic
  
  private ctx: Context;
  private registry: Reg;
  private define: (ctx: Context, flowers: RegistryFlowers<Reg, 'real' | 'test'>) => Iterable<Flower> | AsyncIterable<Flower>;
  constructor(args: {
    
    name: string, // Name of the system/garden
    logger: Logger,
    fact: Fact, // The fact within which generated iac will be stored
    patioFact: Fact, // A subset of generated iac may be intended for source-control (e.g. .terraform.lock.hcl) - this fact should point within a source-controlled repo to maintain any such iac
    
    aws: {
      accountId: string,
      accessKey: { id: string, '!secret': string },
      region: string
    },
    maturity: string,
    debug:    boolean,
    pfx:      string, // Establishes a namespace for all resources provisioned for the particular app
    
    registry: Reg,
    define:   Garden<Reg>['define']
    
  }) {
    
    const { define, registry, ...ctx } = args;
    this.ctx = ctx;
    this.registry = registry;
    this.define = define;
    
  }
  
  private async * getPetals<Mode extends 'real' | 'test'>(mode: Mode) {
    
    const seenFlowers = new Set<Flower>();
    const seenPetals = new Set<PetalTerraform.Base>();
    for await (const topLevelFlower of this.define(this.ctx, this.registry.get(mode) as RegistryFlowers<Reg, Mode>)) {
      
      for (const flower of topLevelFlower.getDependencies()) {
        
        if (seenFlowers.has(flower)) continue;
        seenFlowers.add(flower);
        
        for await (const petal of flower.getPetals(this.ctx)) {
          
          if (seenPetals.has(petal)) continue;
          yield petal;
          
        }
        
      }
      
    }
    
  }
  
  public async prepare(/* Note this only pertains to "real" mode */) {
    
    return this.ctx.logger.scope('garden.prepare', {}, async logger => {
      
      type SetupTfProjArgs = {
        term: string,
        logger: Logger,
        fact: Fact,
        setup: (fact: Fact, mainWritable: { write: (data: string | Buffer) => Promise<void>, end: () => Promise<void> }) => Promise<void>
      };
      const setupTfProj = async (args: SetupTfProjArgs) => args.logger.scope('tf', { proj: this.ctx.name, tf: args.term }, async logger => {
        
        // Allows a terraform project to be defined in terms of a function which writes to main.tf,
        // and adds any arbitrary additional files to the terraform project
        
        // Clean up previous terraform
        await logger.scope('files.reset', {}, async logger => {
          
          // We only want to update iac - need to preserve terraform state management
          const tfFilesToPreserve = new Set([
            '.terraform',
            '.terraform.lock.hcl',
            'terraform.tfstate',
            'terraform.tfstate.backup'
          ]);
          const kids = await args.fact.getKids();
          await Promise.all(kids[toArr]((kid, k) => tfFilesToPreserve.has(k) ? skip : kid.rem()));
          
        });
        
        // Write new terraform
        await logger.scope('files.generate', {}, async logger => {
          
          const stream = await args.fact.kid([ 'main.tf' ]).getDataHeadStream();
          await args.setup(args.fact, stream);
          await stream.end(); // TODO: @gershy/disk should allow `await headStream.end()`
          
        });
        
        return args.fact;
        
      });
      
      // We generate *two* terraform projects for every logical project - overall we want a
      // terraform project which saves its state in the cloud; in order to do this we need to first
      // provision the cloud storage engines to save the terraform state. The "boot" tf project
      // takes care of this, and "main" uses the storage engine provisioned by "boot"!
      return Promise[allObj]({
        
        bootFact: setupTfProj({
          term: 'boot',
          logger,
          fact: this.ctx.fact.kid([ 'boot' ]),
          setup: async (fact, mainWritable) => {
            
            await mainWritable.write(String[baseline](`
              | terraform {
              |   required_providers {
              |     aws = {
              |       source  = "hashicorp/aws"
              |       version = "~> 5.0"
              |     }
              |   }
              | }
              | provider "aws" {
              |   shared_credentials_files = [ "creds.ini" ]
              |   profile                  = "default"
              |   region                   = "ca-central-1"
              | }
              | resource "aws_s3_bucket" "tf_state" {
              |   bucket = "${this.ctx.pfx}-tf-state"
              | }
              | resource "aws_s3_bucket_ownership_controls" "tf_state" {
              |   bucket = aws_s3_bucket.tf_state.bucket
              |   rule {
              |     object_ownership = "ObjectWriter"
              |   }
              | }
              | resource "aws_s3_bucket_acl" "tf_state" {
              |   bucket = aws_s3_bucket.tf_state.bucket
              |   acl = "private"
              |   depends_on = [ aws_s3_bucket_ownership_controls.tf_state ]
              | }
              | resource "aws_dynamodb_table" "tf_state" {
              |   name         = "${this.ctx.pfx}-tf-state"
              |   billing_mode = "PAY_PER_REQUEST"
              |   hash_key     = "LockID"
              |   attribute {
              |     name = "LockID"
              |     type = "S"
              |   }
              | }
            `));
            
            await fact.kid([ 'creds.ini' ]).setData(String[baseline](`
              | [default]
              | aws_region            = ${this.ctx.aws.region}
              | aws_access_key_id     = ${this.ctx.aws.accessKey.id}
              | aws_secret_access_key = ${this.ctx.aws.accessKey['!secret']}
            `));
            
          }
        }),
        
        mainFact: setupTfProj({
          term: 'main',
          logger,
          fact: this.ctx.fact.kid([ 'main' ]),
          setup: async (fact, mainWritable) => {
            
            const garden = this;
            const iteratePetals = async function*() {
              
              const tfAwsCredsFile = new File('creds.ini', String[baseline](`
                | [default]
                | aws_region            = ${garden.ctx.aws.region}
                | aws_access_key_id     = ${garden.ctx.aws.accessKey.id}
                | aws_secret_access_key = ${garden.ctx.aws.accessKey['!secret']}
              `));
              yield tfAwsCredsFile;
              
              const terraform = new Terraform({
                $requiredProviders: {
                  aws: {
                    source: 'hashicorp/aws',
                    version: `~> 5.0` // Consider parameterizing??
                  }
                },
                '$backend.s3': {
                  region: garden.ctx.aws.region,
                  encrypt:       true,
                  
                  // Note references not allowed in terraform.backend!!
                  bucket:        `${garden.ctx.pfx}-tf-state`,
                  key:           `tf`,
                  
                  dynamodbTable: `${garden.ctx.pfx}-tf-state`,  // Dynamodb table is aws-account-wide
                  sharedCredentialsFiles: [ tfAwsCredsFile.tfRef() ],
                  profile: 'default', // References a section within the credentials file
                }
              });
              yield terraform;
              
              for (const { term } of awsRegions) yield new Provider('aws', {
                
                sharedCredentialsFiles: [ tfAwsCredsFile.tfRef() ],
                profile: 'default', // References a section within the credentials file
                region: term,
                
                // Omit the alias for the default provider!
                ...(term !== garden.ctx.aws.region && { alias: term.split('-').join('_') })
                
              });
              
              yield* garden.getPetals('real');
              
            };
            
            const patioTfHclFact = garden.ctx.patioFact.kid([ 'main', '.terraform.lock.hcl' ]);
            const tfHclData = await patioTfHclFact.getData('str');
            if (tfHclData) await fact.kid([ '.terraform.lock.hcl' ]).setData(tfHclData);
            
            for await (const petal of iteratePetals()) {
              
              const result = await (async () => {
                const result = await petal.getResult();
                if (!isCls(result, Object)) return { tf: result, files: {} };
                return { files: {}, ...result };
              })();
              
              if (result.tf) await mainWritable.write(`${result.tf}\n`);
              
              await Promise.all(result.files[toArr]((data, kfp) => fact.kid(kfp.split('/')).setData(data)));
              
            }
            
          }
        })
        
      });
      
    });
    
  }
  
  private terraformInit(fact: Fact, args?: {}) { return this.ctx.logger.scope('execTf.init', {}, async logger => {
    
    // Consider if we ever want to pass "-reconfigure" and "-migrate-state" options; these are
    // useful if we are moving backends (e.g. one aws account to another), and want to move our
    // full iac definition too
    
    // TODO: Some terraform commands fail when offline - can this be covered up?
    
    const result = await procTerraform(fact, `terraform init -input=false`);
    logger.log({ $$: 'result', logFp: result.logDb.toString(), msg: result.output });
    return result;
    
  }); }
  private terraformPlan(fact: Fact, args?: {}) { return this.ctx.logger.scope('execTf.plan', {}, async logger => {
    
    const result = await procTerraform(fact, `terraform plan -input=false`);
    logger.log({ $$: 'result', logFp: result.logDb.toString(), msg: result.output });
    return result;
    
  }); }
  private terraformApply(fact: Fact, args?: {}) { return this.ctx.logger.scope('execTf.apply', {}, async logger => {
    
    const result = await procTerraform(fact, `terraform apply -input=false -auto-approve`);
    logger.log({ $$: 'result', logFp: result.logDb.toString(), msg: result.output });
    return result;
    
  }); }
  
  public async grow(mode: 'real' | 'test') {
    
    // - Avoid tf preventing deletions on populated dbs - e.g. s3 tf needs "force_destroy = true"
    // - Note `terraform init` generates a ".terraform.lock.hcl" file - this should be checked into
    //   consumer's source control! May need consumers to provide an optional `repoFact`, and if
    //   present after `terraform init` we can copy the ".terraform.lock.hcl" file
    
    // Note that test mode does not involve any iac - it all runs locally
    if (mode === 'test') throw Error('test mode not implemented yet');
    
    const { bootFact, mainFact } = await this.prepare();
    
    type TryWithHealingArgs<T> = {
      fn: () => Promise<T>,
      canHeal: (err: any) => boolean,
      heal: () => Promise<any>
    };
    const tryWithHealing = async <T>(args: TryWithHealingArgs<T>): Promise<T> => {
      
      const { fn, heal, canHeal } = args;
      
      return fn().catch(async err => {
        if (!canHeal(err)) throw err;
        await heal();
        return fn();
      });
      
    };
    const logicalApply = (args: { bootFact: Fact, mainFact: Fact }) => {
      
      return tryWithHealing({
        
        fn: () => this.terraformApply(args.mainFact),
        canHeal: err => (err.output as string ?? '')[has]('please run "terraform init"'),
        heal: () => tryWithHealing({
          
          fn: async () => {
            await this.terraformInit(args.mainFact);
            await this.ctx.patioFact.kid([ 'main', '.terraform.lock.hcl' ]).setData(
              await args.mainFact.kid([ '.terraform.lock.hcl' ]).getData('str')
            );
          },
          canHeal: err => true,
          heal: () => tryWithHealing({
            
            fn: () => this.terraformApply(args.bootFact),
            canHeal: err => (err.output as string ?? '')[has]('please run "terraform init"'),
            heal: () => this.terraformInit(args.bootFact)
            
          })
          
        })
        
      });
      
    };
    
    // TODO: HEEERE do `logicalApply` instead!
    await this.terraformInit(bootFact);
    
    // const result = await logicalApply({ mainFact, bootFact });
    //const result = await execTf.init(bootFact);
    
  }
  
};

export * from './petal/terraform/terraform.ts';