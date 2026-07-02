// TODO:

// A more generic (beyond just tf) provider is very hard to support due to the multiplicity of
// provider/petal combos - e.g. "api" flower would need to support ,api.getCloudformationPetals,
// api.getTerraformPetals, etc... supporting just terraform for now

// Support test-mode (Flowers need to be able to do setup, share config, write to volumes, etc)

import { PetalTerraform } from './petal/terraform/terraform.ts';
import { tempFact, type Fact } from '@gershy/disk';
import  '@gershy/clearing';
import tryWithHealing from '@gershy/util-try-with-healing';
import phrasing from '@gershy/util-phrasing';
import { Soil } from './soil/soil.ts';
import proc from '@gershy/nodejs-proc';
import Logger from '@gershy/logger';
import type { SuperIterable } from './util/superIterable.ts';

const { isCls, skip } = cl;
const toArr:    typeof cl.toArr    = cl.toArr;
const allObj:   typeof cl.allObj   = cl.allObj;
const has:      typeof cl.has      = cl.has;
const map:      typeof cl.map      = cl.map;
const mod:      typeof cl.mod      = cl.mod;
const walk:     typeof cl.walk     = cl.walk;
const merge:    typeof cl.merge    = cl.merge;
const upper:    typeof cl.upper    = cl.upper;
const baseline: typeof cl.baseline = cl.baseline;
export type Context = {
  
  name:       string,  // Name of the system/garden
  logger:     Logger,
  fact:       Fact,    // Root of the infrastructure directory
  patioFact:  Fact,    // Fact within version control, for any version-controlled infra files (e.g. .terraform.lock.hcl)
  shedFact:   Fact,    // Storage directory for arbitrary binaries associated with infra (e.g. terraform providers)
  maturity:   string,  // TODO: A Lilac run has a maturity? Or a single Lilac build supports multiple maturities?
  debug:      boolean,
  pfx:        string   // Establishes a namespace for all resources provisioned for the particular app
  
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
  
  protected computedPetals: Map<Context['pfx'], Promise<PetalTerraform.Base[]>>;
  constructor() {
    this.computedPetals = new Map();
  }
  public * getDependencies(): Generator<Flower> {
    yield this;
  }
  public getPetals(ctx: Context & { soil: Soil.Base }): Promise<PetalTerraform.Base[]> & { _noOverride: true } { // Extending with `{ _noOverride: true }` is an informal hack to make this a final method
    
    if (!this.computedPetals.get(ctx.pfx)) this.computedPetals.set(ctx.pfx, (async () => {
      
      const petals: PetalTerraform.Base[] = [];
      for await (const petal of await this.computePetals(ctx))
        petals.push(petal);
      
      return petals;
      
    })());
    
    const p = this.computedPetals.get(ctx.pfx)!;
    return p as any as (typeof p) & { _noOverride: true };
    
  }
  public async computePetals(ctx: Context & { soil: Soil.Base }): Promise<SuperIterable<PetalTerraform.Base>> {
    throw Error('logic missing');
  }
  public async cultivate() {
    
    // This function is called once all Flowers for a given Garden have been constructed, but
    // before any petals have been generated. This step exists to allow Flowers which reference
    // each other via functions to run such functions only after all reference targets are certain
    // to be initialized. E.g. the following compiles without errors, but unexpectedly fails with
    // `v` being uninitialized:
    // 
    //    | const fn = () => v;
    //    | console.log(fn());
    //    | const v = 'abc';
    
  }
  
};
export type FlowerCtor = (new (...args: any[]) => Flower) & {
  getAwsServices: () => Iterable<Soil.LocalStackAwsService>
};

type RegistryFlowers<R extends Registry<any>, M extends 'real' | 'test'> = R extends Registry<infer Flowers>
  ? { [K in keyof Flowers]: Flowers[K][M] }
  : never;

export class Registry<Flowers extends Obj<{ real: FlowerCtor, test: FlowerCtor }> = Obj<never>> {
  
  // Note maintaining a duality of classes for each Flower (one for testing, one for remote deploy)
  // keeps test functionality out of deployed code bundles. If a single class supported both test
  // and prod functionality they would be bundled together, inflating prod
  
  protected flowers: Flowers;
  constructor(flowers: Flowers) {
    this.flowers = {}[merge](flowers) as Flowers; // TODO: I think the typing looseness here is that `merge` uses `DeepMerge`, which doesn't handle generic indexes well; `Flowers` uses a generic index
  }
  
  getAwsServices() {
    const services = new Set<Soil.LocalStackAwsService>();
    for (const [ _, { real } ] of this.flowers[walk]())
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
  
  protected ctx:        Context;
  protected reg:        Reg;
  protected def:        (ctx: Context, flowers: RegistryFlowers<Reg, 'real' | 'test'>) => SuperIterable<Flower>;
  protected tfProcArgs: { timeoutMs: number, env: Obj<string> };
  
  constructor(args: {
    
    context:  Context,
    registry: Reg,
    define:   Garden<Reg>['def']
    
  }) {
    
    const { define, registry, context } = args;
    this.ctx = context;
    this.reg = registry;
    this.def = define;
    this.tfProcArgs = {
      timeoutMs: 0,
      env: {
        ...process.env,
        TF_LOG:             'DEBUG',
        TF_DATA_DIR:        '',
        TF_CLI_CONFIG_FILE: ''
      } as Obj<string>
    };
    
  }
  
  protected async * getPetals(soil: Soil.Base) {
    
    // TODO: We always use the "real" flowers from the registry - this is part of the shift to
    // localStack; we always generate genuine terraform and apply it to the docker localStack.
    // Eventually may want to support ultra-lightweight dockerless/localStackless js flower mocks;
    // that would be the time to add "fake" flowers alongside each real flower, and start
    // conditionally calling `this.registry.get('fake')`...
    
    const seenFlowers = new Set<Flower>();
    for await (const topLevelFlower of await this.def(this.ctx, this.reg.get('real') as RegistryFlowers<Reg, 'real'>))
      for (const flower of topLevelFlower.getDependencies())
        seenFlowers.add(flower);
    
    // Now we've exhaustively referenced all Flowers - we can cultivate them
    await Promise.all(seenFlowers[toArr](f => f.cultivate()));
    
    // Yield all unique petals of all flowers
    const seenPetals = new Set<PetalTerraform.Base>();
    for (const flower of seenFlowers) {
      for await (const petal of await flower.getPetals({ ...this.ctx, soil })) {
        if (seenPetals.has(petal)) continue;
        seenPetals.add(petal);
        yield petal;
      }
    }
    
  }
  
  public async genTerraform(soil: Soil.Base) {
    
    const soilTfPetalsPrm = soil.getTerraformPetals(this.ctx);
    
    return this.ctx.logger.scope('garden.genTerraform', {}, async logger => {
      
      type SetupTfProjArgs = {
        term: string,
        logger: Logger,
        fact: Fact,
        setup: (fact: Fact, writePetalTfAndFiles: <T extends PetalTerraform.Base>(petal: T) => Promise<T>) => Promise<void>
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
          await args.setup(args.fact, async petal => {
            
            // Include a utility function the caller can use to easily write petals
            const { tf, files = {} } = await petal.getResult().then(tf => isCls(tf, String) ? { tf } : tf);
            
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
          setup: async (fact, writePetalTfAndFiles) => {
            
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
              billingMode: phrasing('camel->snake', 'payPerRequest')[upper](),
              hashKey:     'LockID',
              $attribute:  { name: 'LockID', type: 'S' }
            }));
            
          }
        }),
        
        mainFact: setupTfProj({
          term: 'main',
          logger,
          fact: this.ctx.fact.kid([ 'main' ]),
          setup: async (fact, writePetalTfAndFiles) => {
            
            // Include the soil's infrastructure
            const { main } = await soilTfPetalsPrm;
            for await (const petal of await main({ s3Name, ddbName })) await writePetalTfAndFiles(petal);
            
            for await (const petal of this.getPetals(soil)) await writePetalTfAndFiles(petal);
            
            // Propagate any terraform lock found in version control
            const patioTfHclFact = this.ctx.patioFact.kid([ 'main', '.terraform.lock.hcl' ]);
            const tfHclData = await patioTfHclFact.getData('str');
            if (tfHclData) await fact.kid([ '.terraform.lock.hcl' ]).setData(tfHclData);
            
          }
        }),
        
      });
      
    });
    
  }
  
  // TODO: Write terraform output to logs??
  protected async terraformInit(args: { logger: Logger, fact: Fact }) {
    
    // Consider if we ever want to pass "-reconfigure" and "-migrate-state" options; these are
    // useful if we are moving backends (e.g. one aws account to another), and want to move our
    // full iac definition too
    
    const { logger, fact } = args;
    
    // Ensure the mirror directory exists in the shed
    const mirrorFact = this.ctx.shedFact.kid([ 'lilacTerraformMirror' ]);
    await mirrorFact.kid([ 'note.txt' ]).setData(`Root of terraform mirror for @gershy/lilac`);
    
    return logger.scope('execTf.init', { fact: fact.fsp() }, async logger => {
      
      const { output: result } = await tryWithHealing({
        fn: () => logger.scope('attempt', {}, async logger => {
          
          const configFact = tempFact.kid([ `${Math.random().toString(36).slice(2)}.terraform.rc` ]);
          await configFact.setData(String[baseline](`
            | provider_installation {
            |   filesystem_mirror {
            |     path = "${mirrorFact.fsp().replaceAll('\\', '/')}"
            |   }
            | }
          `));
          
          return proc(`terraform init -input=false`, {}[merge](this.tfProcArgs)[merge]({
            cwd: fact,
            env: { TF_CLI_CONFIG_FILE: configFact.fsp() }
          })).finally(() => configFact.rem());
          
        }),
        canHeal: err => (err?.output ?? '')[has]('Could not retrieve the list of available versions for provider'),
        heal: () => logger.scope('mirror', { fsp: mirrorFact.fsp() }, async logger => {
          
          const { output: result } = await proc(`terraform providers mirror "${mirrorFact.fsp().replaceAll('\\', '/')}"`, { cwd: fact, timeoutMs: 0 });
          logger.log({ $$: 'result', result });
          
        })
      });
      
      logger.log({ $$: 'result', result });
      
      return result;
    
    }).catch(async err => {
      
      const logFact = this.ctx.shedFact.kid([ '.log', `garden-tf-init-${+new Date()}.txt` ]);
      await logFact.setData([
        'Error:',
        err.message,
        '\nOutput:',
        err.output ?? '<no output>'
      ].join('\n')).catch(err => {});
      
      throw err;
      
    });
    
  }
  protected terraformPlan(args: { logger: Logger, fact: Fact }) {
    const { logger, fact } = args;
    return logger.scope('execTf.plan', { fact: fact.fsp() }, async logger => {
      
      const { output: result } = await proc(`terraform plan -input=false`, {}[merge](this.tfProcArgs)[merge]({
        cwd: fact,
      }))
      logger.log({ $$: 'result', result });
      return result;
      
    }).catch(async err => {
      
      const logFact = this.ctx.shedFact.kid([ '.log', `garden-tf-plan-${+new Date()}.txt` ]);
      await logFact.setData([
        'Error:',
        err.message,
        '\nOutput:',
        err.output ?? '<no output>'
      ].join('\n')).catch(err => {});
      
      throw err;
      
    });
  }
  protected terraformApply(args: { logger: Logger, fact: Fact }) {
    
    const { logger, fact } = args;
    return logger.scope('execTf.apply', { fact: fact.fsp() }, async logger => {
      
      // TODO: On failure, write log to shedFact?
      const { output: result } = await proc(`terraform apply -input=false -auto-approve`, {}[merge](this.tfProcArgs)[merge]({
        cwd: fact
      }));
      logger.log({ $$: 'result', result });
      return result;
      
    }).catch(async err => {
      
      const logFact = this.ctx.shedFact.kid([ '.log', `garden-tf-apply-${+new Date()}.txt` ]);
      await logFact.setData([
        'Error:',
        err.message,
        '\nOutput:',
        err.output ?? '<no output>'
      ].join('\n')).catch(err => {});
      
      throw err;
      
    });
    
  }
  
  public async grow(deploy: { type: 'real', soil: Soil.Base } | { type: 'test' }) {
    
    if (deploy.type === 'test') throw Error('not implemented')[mod]({ type: 'test' }); // TODO: Can be nice to have local service mocks!
    
    const { bootFact, mainFact } = await this.genTerraform(deploy.soil);
    
    // Init+apply both "boot" and "main", in optimistic fashion
    const isHealableTerraformApply = err => /run[^a-zA-Z0-9]+terraform init/.test(err.output as string ?? '');
    
    const err = new Error('');
    await this.ctx.logger.scope('grow.tf', { type: deploy.type, soil: cl.getClsName(deploy.soil) }, async logger => {
      
      await tryWithHealing({
        
        fn: () => this.terraformApply({ logger: Logger.dummy, fact: mainFact }),
        canHeal: isHealableTerraformApply,
        heal: () => tryWithHealing({
          
          fn: async () => {
            await this.terraformInit({ logger: Logger.dummy, fact: mainFact });
            await this.ctx.patioFact.kid([ 'main', '.terraform.lock.hcl' ]).setData(
              await mainFact.kid([ '.terraform.lock.hcl' ]).getData('str')
            );
          },
          canHeal: err => true,
          heal: () => tryWithHealing({
            
            fn: () => this.terraformApply({ logger: Logger.dummy, fact: bootFact }),
            canHeal: isHealableTerraformApply,
            heal: () => this.terraformInit({ logger: Logger.dummy, fact: bootFact })
            
          })
          
        })
        
      });
      
    }).catch(cause => err[cl.fire]({ msg: 'grow failed', cause }));
    
  }
  
};

export * from './petal/terraform/terraform.ts';
export * from './soil/soil.ts';