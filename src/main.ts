// TODO:

// A more generic (beyond just tf) provider is very hard to support due to the multiplicity of
// provider/petal combos - e.g. "api" flower would need to support ,api.getCloudformationPetals,
// api.getTerraformPetals, etc... supporting just terraform for now

// Watch out when working lilac into an npm dependency, need to allow the user a way to declare
// their absolute repo path (so "<repo>/..." filenames work in any setup!)

// Can region be dealt with any better??

// Support test-mode (Flowers need to be able to do setup, share config, write to volumes, etc)

import { PetalTerraform } from './petal/terraform/terraform.ts';
import type Logger from '@gershy/logger';
import type { Fact } from '@gershy/disk';
import { isCls, skip } from '@gershy/clearing';
import procTerraform from './util/procTerraform.ts';
import tryWithHealing from '@gershy/util-try-with-healing';
import phrasing from '@gershy/util-phrasing';
import { Soil } from './soil/soil.ts';
import { SuperIterable } from './util/superIterable.ts';

export type Context = {
  
  name:       string, // Name of the system/garden
  logger:     Logger,
  fact:       Fact,
  patioFact:  Fact,
  maturity:   string, // TODO: A Lilac run has a maturity? Or a single Lilac build supports multiple maturities?
  debug:      boolean,
  pfx:        string // Establishes a namespace for all resources provisioned for the particular app
  
  // // Throttlers:
  // // - webpack: shell "webpack" commands
  // // - zipFile: jszipping files
  // throttlers: { [K in 'webpack' | 'zipFile']: Throttler }
  
};

export class Flower {
  
  // TODO: The downside of having this static is that different instances may use different
  // services - e.g. api gateway instance may have "useEdge: true", in which case we'd like to
  // include cloudfront and omit it otherwise... but having it on the instance is annoying since
  // we want to enumerate all services *before* instantiating any Flowers... probably better this
  // way? And heirarchical design can probably avoid most unecessary service inclusion...
  // TODO: The naming of these services is coupled to LocalStack - consider using Lilac-scoped
  // naming, and add a translation layer from Lilac->LocalStack in Soil.LocalStack?
  public static getAwsServices(): Soil.LocalStackAwsService[] { return []; }
  
  constructor() {}
  public * getDependencies(): Generator<Flower> {
    yield this;
  }
  public getPetals(ctx: Context): SuperIterable<PetalTerraform.Base> {
    throw Error('not implemented');
  }
  
};

type RegistryFlowers<R extends Registry<any>, M extends 'real' | 'test'> = R extends Registry<infer Flowers>
  ? { [K in keyof Flowers]: Flowers[K][M] }
  : never;

export class Registry<Flowers extends Obj<{ real: typeof Flower, test: typeof Flower }> = Obj<never>> {
  
  // Note that maintaining a duality of classes for each Flower (one for testing, one for remote
  // deploy) is essential to keep test functionality out of deployed code bundles. If a single
  // class supported both test and prod functionality, these two pieces of functionality would
  // always be bundled together.
  
  private flowers: Flowers;
  constructor(flowers: Flowers) {
    this.flowers = {}[merge](flowers);
  }
  
  getAwsServices() {
    const services = new Set<Soil.LocalStackAwsService>();
    for (const [ k, { real } ] of this.flowers as ObjIterator<Flowers>)
      for (const awsService of real.getAwsServices())
        services.add(awsService);
    return services[toArr](v => v);
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
  private reg: Reg;
  private def: (ctx: Context, flowers: RegistryFlowers<Reg, 'real' | 'test'>) => SuperIterable<Flower>;
  constructor(args: {
    
    context: Context,
    registry: Reg,
    define:   Garden<Reg>['def']
    
  }) {
    
    const { define, registry, context } = args;
    this.ctx = context;
    this.reg = registry;
    this.def = define;
    
  }
  
  private async * getPetals() {
    
    // TODO: We always use the "real" flowers from the registry - this is part of the shift to
    // localStack; we always generate genuine terraform and apply it to the docker localStack.
    // Eventually may want to support ultra-lightweight dockerless/localStackless js flower mocks;
    // that would be the time to add "fake" flowers alongside each real flower, and start
    // conditionally calling `this.registry.get('fake')`...
    
    const seenFlowers = new Set<Flower>();
    const seenPetals = new Set<PetalTerraform.Base>();
    for await (const topLevelFlower of await this.def(this.ctx, this.reg.get('real') as RegistryFlowers<Reg, 'real'>)) {
      
      for (const flower of topLevelFlower.getDependencies()) {
        
        if (seenFlowers.has(flower)) continue;
        seenFlowers.add(flower);
        
        for await (const petal of await flower.getPetals(this.ctx)) {
          
          if (seenPetals.has(petal)) continue;
          yield petal;
          
        }
        
      }
      
    }
    
  }
  
  public async genTerraform(deployTarget: Soil.Base) {
    
    const soilTfPetalsPrm = deployTarget.getTerraformPetals(this.ctx);
    
    return this.ctx.logger.scope('garden.genTerraform', {}, async logger => {
      
      type SetupTfProjArgs = {
        term: string,
        logger: Logger,
        fact: Fact,
        setup: (fact: Fact, mainWritable: { write: (data: string | Buffer) => Promise<void>, end: () => Promise<void> }, writePetalTfAndFiles: <T extends PetalTerraform.Base>(petal: T) => Promise<T>) => Promise<void>
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
          await args.setup(args.fact, stream, async petal => {
            
            // Include a utility function the caller can use to easily write petals
            const { tf, files = {} } = await petal.getResult()
                .then(tf => isCls(tf, String) ? { tf } : tf);
            
            if (tf) await stream.write(`${tf}\n`);
            
            await Promise.all(files[toArr]((data, kfp) => args.fact.kid(kfp.split('/')).setData(data)));
            
            return petal;
            
          });
          await stream.end();
          
        });
        
        return args.fact;
        
      });
      
      // Pick names for the s3 and ddb terraform state persistence entities
      const s3Name = `${this.ctx.pfx}-tf-state`;
      const ddbName = `${this.ctx.pfx}-tf-state`;
      
      // We generate *two* terraform projects for every logical project - overall we want a
      // terraform project which saves its state in the cloud; in order to do this we need to first
      // provision the cloud storage engines to save the terraform state. The "boot" tf project
      // takes care of this, and "main" uses the storage engine provisioned by "boot"!
      return Promise[allObj]({ // TODO: Can probably switch to `Promise[allObj]([ 'boot', 'main' ][toObj](...))` resulting in `setupTfProj` being inlined
      
        bootFact: setupTfProj({
          term: 'boot',
          logger,
          fact: this.ctx.fact.kid([ 'boot' ]),
          setup: async (fact, mainWritable, writePetalTfAndFiles) => {
            
            // Include the soil's infrastructure
            const { boot } = await soilTfPetalsPrm;
            for await (const petal of await boot({ s3Name, ddbName })) await writePetalTfAndFiles(petal);
            
            // Create s3 tf state bucket
            const s3 = await writePetalTfAndFiles(new PetalTerraform.Resource('awsS3Bucket', 'tfState', {
              bucket: s3Name
            }));
            const s3Controls = await writePetalTfAndFiles(new PetalTerraform.Resource('awsS3BucketOwnershipControls', 'tfState', {
              bucket: s3.ref('bucket'),
              $rule: {
                objectOwnership: 'ObjectWriter'
              }
            }));
            await writePetalTfAndFiles(new PetalTerraform.Resource('awsS3BucketAcl', 'tfState', {
              bucket:    s3.ref('bucket'),
              acl:       'private',
              dependsOn: [ s3Controls.ref() ]
            }));
            
            // Create ddb tf state locking table
            await writePetalTfAndFiles(new PetalTerraform.Resource('awsDynamodbTable', 'tfState', {
              name:        ddbName,
              billingMode: phrasing('payPerRequest', 'camel', 'snake')[upper](),
              hashKey:     'LockID',
              $attribute:  { name: 'LockID', type: 'S' }
            }));
            
          }
        }),
        
        mainFact: setupTfProj({
          term: 'main',
          logger,
          fact: this.ctx.fact.kid([ 'main' ]),
          setup: async (fact, mainWritable, writePetalTfAndFiles) => {
            
            // Include the soil's infrastructure
            const { main } = await soilTfPetalsPrm;
            for await (const petal of await main({ s3Name, ddbName })) await writePetalTfAndFiles(petal);
            
            for await (const petal of this.getPetals()) await writePetalTfAndFiles(petal);
            
            // Propagate any terraform lock found in version control
            const patioTfHclFact = this.ctx.patioFact.kid([ 'main', '.terraform.lock.hcl' ]);
            const tfHclData = await patioTfHclFact.getData('str');
            if (tfHclData) await fact.kid([ '.terraform.lock.hcl' ]).setData(tfHclData);
            
          }
        }),
        
      });
      
    });
    
  }
  
  private terraformInit(fact: Fact, args?: {}) { return this.ctx.logger.scope('execTf.init', { fact: fact.fsp() }, async logger => {
    
    // Consider if we ever want to pass "-reconfigure" and "-migrate-state" options; these are
    // useful if we are moving backends (e.g. one aws account to another), and want to move our
    // full iac definition too
    
    // TODO: Some terraform commands fail when offline - can this be covered up? Possibly by
    // checking terraform binaries into the repo? (Cross-platform nightmare though...)
    
    const result = await procTerraform(fact, `terraform init -input=false`, {
      onData: async (mode, data) => logger.log({ $$: 'notice', mode, data }) ?? null
    });
    logger.log({ $$: 'result', logFp: result.logDb.toString(), msg: result.output });
    return result;
    
  }); }
  private terraformPlan(fact: Fact, args?: {}) { return this.ctx.logger.scope('execTf.plan', { fact: fact.fsp() }, async logger => {
    
    const result = await procTerraform(fact, `terraform plan -input=false`);
    logger.log({ $$: 'result', logFp: result.logDb.toString(), msg: result.output });
    return result;
    
  }); }
  private terraformApply(fact: Fact, args?: {}) { return this.ctx.logger.scope('execTf.apply', { fact: fact.fsp() }, async logger => {
    
    const result = await procTerraform(fact, `terraform apply -input=false -auto-approve`);
    logger.log({ $$: 'result', logFp: result.logDb.toString(), msg: result.output });
    return result;
    
  }); }
  
  public async grow(deploy: { type: 'real', soil: Soil.Base } | { type: 'test' }) {
    
    if (deploy.type === 'test') throw Error('not implemented')[mod]({ type: 'test' }); // TODO: Can be nice to have local service mocks!
    
    const { bootFact, mainFact } = await this.genTerraform(deploy.soil);
    
    // Init+apply both "boot" and "main", in optimistic fashion
    const isHealableTerraformApply = err => /run[^a-zA-Z0-9]+terraform init/.test(err.output as string ?? '');
    await tryWithHealing({
      
      fn: () => this.terraformApply(mainFact),
      canHeal: isHealableTerraformApply,
      heal: () => tryWithHealing({
        
        fn: async () => {
          await this.terraformInit(mainFact);
          await this.ctx.patioFact.kid([ 'main', '.terraform.lock.hcl' ]).setData(
            await mainFact.kid([ '.terraform.lock.hcl' ]).getData('str')
          );
        },
        canHeal: err => true,
        heal: () => tryWithHealing({
          
          fn: () => this.terraformApply(bootFact),
          canHeal: isHealableTerraformApply,
          heal: () => this.terraformInit(bootFact)
          
        })
        
      })
      
    });
    
  }
  
};

export * from './petal/terraform/terraform.ts';