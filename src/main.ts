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
import proc, { type ProcOpts } from '@gershy/nodejs-proc';
import Logger from '@gershy/logger';
import type { NetProc } from '@gershy/util-http';
import retry from '@gershy/util-retry';

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

export type HttpApi = {
  netProc: NetProc,
  path: string[],
  method: 'head' | 'get' | 'post' | 'patch' | 'put' | 'delete'
};

// Consider: switch to a map of absolute service identifiers? `${AccountId}/cfDistro/global/${Pfx}-${string}` | `${AccountId}/apiGw/${AwsRegion}/${Pfx}-${string}`
export type Service = never
  | { type: 'domain',   httpApi: HttpApi }
  | { type: 'apiGw',    regionTerm: string, httpApi: HttpApi }
  | { type: 'cfDistro', globalTerm: string, httpApi: HttpApi };

export type ServiceMap = Obj<{
  addr: string,
  port?: number,
  http?: { path?: string[] }
}>;

export type Context = {
  
  name:       string,  // Name of the system/garden
  logger:     Logger,
  fact:       Fact,    // Root of the infrastructure directory
  patioFact:  Fact,    // Fact within version control, for any version-controlled infra files (e.g. .terraform.lock.hcl)
  shedFact:   Fact,    // Storage directory for arbitrary binaries associated with infra (e.g. terraform providers)
  maturity:   string,  // TODO: A Lilac run has a maturity? Or a single Lilac build supports multiple maturities?
  debug:      boolean,
  pfx:        string,  // Establishes a namespace for all resources provisioned for the particular app
  
  // The "progressive" service map is populated gradually - i.e. only after a Garden has been grown (at which point, e.g., an apigw name has resolved to an actual execute-api)
  progressiveServiceMap: ServiceMap
  
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
  // Note: This is also becoming less relevant, shifting away from localstack
  public static getAwsServices(): readonly Soil.LocalStackAwsService[] { return []; }
  
  protected computedPetals: null | Promise<PetalTerraform.Base[]>;
  constructor(/* All Flower subclasses must accept a single Object argument! (As it is auto-populated by the SeedBank) */) {
    this.computedPetals = null;
  }
  public getServiceMapTf(): ServiceMap { return {}; }
  public * getDependencies(): Generator<Flower> {
    yield this;
  }
  public getPetals(): Promise<PetalTerraform.Base[]> & { _noOverride: true } {
    
    if (!this.computedPetals)
      this.computedPetals = Promise.resolve(this.computePetals()[cl.toArr](v => v));
    
    return this.computedPetals as (typeof this.computedPetals) & { _noOverride: true };
    
  }
  public computePetals(): Loopable<PetalTerraform.Base> {
    throw Error('logic missing');
  }
  public async cultivate(serviceMap: ServiceMap) {
    
    // This function is called once all Flowers for a given Garden have been constructed, but
    // before any petals have been generated. This step allows Flowers to act on the global state
    // of all Flowers. At also solves referential issues like the following...
    //    | const fn = () => v;
    //    | console.log(fn());
    //    | const v = 'abc';
    // ... where typescript thinks `v` is available, but at runtime it fails as uninitialized.
    // Within `cultivate`, references to other Flowers in the Garden are guaranteed to resolve!
    
  }
  
};
export type FlowerCtor = (new (args: any) => Flower) & {
  getAwsServices: () => Iterable<Soil.LocalStackAwsService>
};

type SeedBankFlowers<R extends SeedBank<any>, M extends 'real' | 'test'> = R extends SeedBank<infer Flowers>
  ? { [K in keyof Flowers]: Flowers[K][M] }
  : never;

export class SeedBank<Flowers extends { [K: string]: { real: FlowerCtor, test: FlowerCtor } } = Obj<never>> {
  
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
  
  add<MoreFlowers extends Obj<{ real: typeof Flower, test: typeof Flower }>>(flowers: MoreFlowers): SeedBank<Omit<Flowers, keyof MoreFlowers> & MoreFlowers> {
    return new SeedBank({ ...this.flowers, ...flowers } as any);
  }
  get<Mode extends 'real' | 'test'>(context: Context, soil: Soil.Base, mode: Mode): SeedBankFlowers<SeedBank<Flowers>, Mode> {
    
    return this.flowers[map]((v) => {
      
      // This function returns a Flower constructor that automatically assigns `context` and `soil` properties
      const Flower = v[mode];
      return function(args: Obj<any>) {
        return new Flower({ context, soil, ...args });
      } as any as typeof Flower;
      
    });
  }
  
};

export class Garden<SB extends SeedBank<any>> {
  
  // Note this class currently is coupled to terraform logic
  
  protected context:    Context;
  protected seedBank:   SB;
  protected def:        (context: Context, flowers: SeedBankFlowers<SB, 'real' | 'test'>) => Loopable<Flower>;
  protected tfProcArgs: { timeoutMs: number, env: Obj<string> };
  
  constructor(args: {
    
    context:  Context,
    seedBank: SB,
    define:   Garden<SB>['def']
    
  }) {
    
    const { define, seedBank, context } = args;
    this.context = context;
    this.seedBank = seedBank;
    this.def = define;
    
    // Settings passed to all `terraform` proc calls
    const verbosity: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'none' = this.context.debug ? 'debug' : 'none';
    this.tfProcArgs = {
      timeoutMs: 0, // Disable timeouts - last thing we need is a timeout corrupting a terraform action!
      env: {
        ...process.env,
        TF_LOG:             verbosity === 'none' ? '' : verbosity[cl.upper](),
        TF_DATA_DIR:        '',
        TF_CLI_CONFIG_FILE: ''
      } as Obj<string>
    };
    
  }
  
  protected async * getPetals<Mode extends 'real' | 'test' = 'real'>(soil: Soil.Base, mode?: Mode) {
    
    // TODO: We always use the "real" flowers from the seed bank - this is part of the shift to
    // localStack; we always generate genuine terraform and apply it to the docker localStack.
    // Eventually may want to support ultra-lightweight dockerless/localStackless js flower mocks;
    // that would be the time to add "fake" flowers alongside each real flower, and start
    // conditionally calling `this.registry.get('fake')`... (will need an additional `mode: 'real' | 'fake'` arg here)
    
    const seenFlowers = new Set<Flower>();
    for await (const topLevelFlower of await this.def(this.context, this.seedBank.get(this.context, soil, mode ?? 'real') as SeedBankFlowers<SB, Mode>))
      for (const flower of topLevelFlower.getDependencies())
        seenFlowers.add(flower);
    
    // Now we've exhaustively referenced all Flowers - we can cultivate them
    
    const flowers = seenFlowers[toArr](v => v);
    const serviceMap = flowers.reduce((m, v) => Object.assign(m, v.getServiceMapTf()), {} as ServiceMap);
    await Promise.all(flowers[map](f => f.cultivate(serviceMap)));
    
    // Yield all unique petals of all flowers
    const seenPetals = new Set<PetalTerraform.Base>();
    for (const flower of seenFlowers) {
      for await (const petal of await flower.getPetals()) {
        if (seenPetals.has(petal)) continue;
        seenPetals.add(petal);
        yield petal;
      }
    }
    
  }
  
  public async genTerraform(soil: Soil.Base) {
    
    const soilTfPetalsPrm = soil.getTerraformPetals(this.context);
    
    const outputs = [] as PetalTerraform.Output<any>[];
    
    const { bootFact, mainFact } = await this.context.logger.scope('garden', {}, async logger => {
      
      type SetupTfProjArgs = {
        term: string,
        logger: Logger,
        fact: Fact,
        setup: (fact: Fact, writePetalTfAndFiles: <T extends PetalTerraform.Base>(petal: T) => Promise<T>) => Promise<void>
      };
      const setupTfProj = async (args: SetupTfProjArgs) => args.logger.scope('genTf', { proj: this.context.name, tf: args.term }, async logger => {
        
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
            
            // This function allows a caller to easily write petals into the terraform project
            
            if (cl.inCls(petal, PetalTerraform.Output)) {
              
              // Outputs are collected and processed after the `terraform apply`
              outputs.push(petal);
              
            }
            
            const { tf, files = {} } = await petal.getResult().then(tf => isCls(tf, String) ? { tf } : tf);
            
            // Literal terraform is written to the main.tf stream
            if (tf) await stream.write(`${tf}\n`);
            
            // Non-main.tf terraform-related files are written separately
            await Promise.all(files[toArr]((data, kfp) => args.fact.kid(kfp.split('/')).setData(data)));
            
            return petal;
            
          });
          await stream.end();
          
          // Pull in any version-controlled lock file
          
          const tfFact = args.fact;
          const patioTfHclFact = this.context.patioFact.kid([ tfFact.getCmps().at(-1)!, '.terraform.lock.hcl' ]);
          const tfHclData = await patioTfHclFact.getData('str');
          if (tfHclData) await tfFact.kid([ '.terraform.lock.hcl' ]).setData(tfHclData);
          
        });
        
        return args.fact;
        
      });
      
      // Pick names for the s3 and ddb terraform state persistence entities
      const s3Name = `${this.context.pfx}-tf-state`;
      const ddbName = `${this.context.pfx}-tf-state`;
      
      // We generate *two* terraform projects for every logical project - overall we want a
      // terraform project which saves its state in the cloud; in order to do this we need to first
      // provision the cloud storage engines to save the terraform state. The "boot" tf project
      // takes care of this, and "main" uses the storage engine provisioned by "boot".
      return Promise[allObj]({ // TODO: Can probably switch to `Promise[allObj]([ 'boot', 'main' ][toObj](...))` resulting in `setupTfProj` being inlined
      
        bootFact: setupTfProj({
          term: 'boot',
          logger,
          fact: this.context.fact.kid([ 'boot' ]),
          setup: async (fact, writePetalTfAndFiles) => {
            
            // Include the soil's infrastructure
            const { boot } = await soilTfPetalsPrm;
            for await (const petal of await boot({ s3Name, ddbName })) {
              await writePetalTfAndFiles(petal);
            }
            
            // Create s3 tf state bucket
            const s3 = await writePetalTfAndFiles(new PetalTerraform.Resource('awsS3Bucket', 'tfState', {
              bucket: s3Name,
              forceDestroy: true
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
              name:                      ddbName,
              billingMode:               phrasing('camel->snake', 'payPerRequest')[upper](),
              hashKey:                   'LockID',
              $attribute:                { name: 'LockID', type: 'S' },
              deletionProtectionEnabled: false
            }));
            
          }
        }),
        
        mainFact: setupTfProj({
          term: 'main',
          logger,
          fact: this.context.fact.kid([ 'main' ]),
          setup: async (fact, writePetalTfAndFiles) => {
            
            // Include the soil's infrastructure
            const { main } = await soilTfPetalsPrm;
            for await (const petal of await main({ s3Name, ddbName })) await writePetalTfAndFiles(petal);
            
            for await (const petal of this.getPetals(soil)) await writePetalTfAndFiles(petal);
            
          }
        })
        
      });
      
    });
    
    return { bootFact, mainFact, outputs };
    
  }
  
  protected async logicalTf(args: { logger: Logger, fact: Fact, term: string, cmd: string, opts: ProcOpts, wrap?: <V>(logger: Logger, call: (logger: Logger, opts: Obj<any>) => Promise<V>) => Promise<V> }) {
    
    // Executes a terraform command "logically" - this involves wrapping terraform commands in
    // certain error handling / retry / healing behaviour to overall produce a process with a much
    // smaller surface than a raw terraform command. This harness handles the logging of length
    // terraform shell output (write big files under the `shedFact`; result log includes filepath);
    // the actual "logicalization" is delegated to the provided `wrap` function.
    
    const { logger, fact, term, cmd, opts, wrap = (logger, call) => call(logger, {}) } = args;
    
    const writeLog = async (preamble: string, status: 'accept' | 'reject', output: string) => {
      
      const logFact = this.context.shedFact.kid([ '.log', `garden-tf-${term}-${+new Date()}-${status}.txt` ]);
      try {
        await logFact.setData([
          `Context:`,
          preamble,
          '',
          'Output:',
          output.trim() || '<no output>'
        ].join('\n'));
      } catch (err: any) {
        logger.log({ $$: 'tfLogFailed', fp: logFact.fsp(), msg: err?.message ?? null });
      }
      
      return logFact;
      
    };
    
    return logger.scope('execTf', { term, tfFp: fact.fsp() }, async logger => {
      
      // Resolve the command and options; options come from:
      // 1. Garden-instance-scoped `this.tfProcArgs`                           (e.g. controls log verbosity)
      // 2. Terraform-op-specific args                                         (e.g. controls op-specific env var overrides)
      // 3. User-specific-ops which allow the user to supply arbitrary options (e.g. user wants *this specific command* to be auto-approved)
      
      const resolvedOpts = {}[merge](this.tfProcArgs)[merge]({ cwd: fact, ...opts });
      const output = await wrap(logger, (logger, wrapOpts) => proc(cmd, resolvedOpts[merge](wrapOpts)).then(
        
        // Terraform shell success!
        async ({ cmd, output }) => {
          
          const logFact = await writeLog(`Command \`${cmd}\` succeeded!`, 'accept', output);
          logger.log({ $$: 'result', logFp: logFact.fsp() });
          return output;
          
        },
        
        // Terraform shell failure!
        async err => {
          
          // Main goal here is to write the error to a log, and reduce the size of `err.output` by
          // discarding all non-error info in the output
          
          const cmd   : string        = err.cmd;
          const output: string | null = err.output?.trim?.() ?? null;
          if (output === null) throw err;
          
          const logFact = await writeLog(`Command \`${cmd}\` FAILED!`, 'reject', output);
          
          // Extract the actual error blocks (note tf indents them with '╵' and '│' and '╷')
          const outputErrors = [ ...(output.match(/[╷]\n[│] Error:[^╵]*[╵]/g) ?? []) ]
            .map(block => block.split('\n')[map](ln => ln.slice('| '.length).trim() || skip).join('\n'))
            .join('\n\n');
          
          throw err[cl.mod]({ output: outputErrors, logFp: logFact.fsp() });
          
        }
        
      ));
      
      return output;
      
    });
    
  }
  
  protected async logicalTfInit(args: { logger: Logger, fact: Fact }) {
    
    // `terraform init` "logicalization" is handled by self-healing mirror directory setup
    
    return this.logicalTf({ ...args, term: 'init', cmd: 'terraform init -input=false', opts: {}, wrap: async (logger, call) => {
      
      const mirrorFact = this.context.shedFact.kid([ 'lilacTerraformMirror' ]);
      
      return tryWithHealing({
        fn: () => logger.scope('attempt', {}, async logger => {
          
          const configFact = tempFact.kid([ Math.random().toString(36).slice(2), `terraform.rc` ]);
          await configFact.setData(String[baseline](`
            | provider_installation {
            |   filesystem_mirror {
            |     path = "${mirrorFact.fsp().replaceAll('\\', '/')}"
            |   }
            | }
          `));
          
          const result = await call(logger, { env: { TF_CLI_CONFIG_FILE: configFact.fsp() } })
            .finally(() => configFact.rem());
          
          // The tf lock file resulting from the successful `call` (`terraform init`) should be
          // written to version control - so use `patioFact`!
          const tfFact = args.fact;
          await this.context.patioFact.kid([ tfFact.getCmps().at(-1)!, '.terraform.lock.hcl' ]).setData(
            await tfFact.kid([ '.terraform.lock.hcl' ]).getData('bin')
          );
          
          return result;
          
        }),
        canHeal: err => (err?.output ?? '')[has]('Could not retrieve the list of available versions for provider'),
        heal: () => logger.scope('mirror', { fsp: mirrorFact.fsp() }, async logger => {
          
          // Attempt to heal by setting up the mirror directory
          
          await mirrorFact.kid([ 'note.txt' ]).setData(`Root of terraform mirror for @gershy/lilac`);
          await this.logicalTf({
            logger,
            fact: args.fact,
            term: 'mirror',
            cmd: `terraform providers mirror "${mirrorFact.fsp().replaceAll('\\', '/')}"`,
            opts: {}
          });
          
        })
      });
      
    }});
    
  }
  
  protected async logicalTfPlan_DELETEME(args: { logger: Logger, fact: Fact }) {
    
    return this.logicalTf({ ...args, term: 'plan', cmd: 'terraform plan -input=false', opts: {} });
    
  }
  
  protected async logicalTfApply(args: { logger: Logger, fact: Fact }) {
    
    // TODO: logicalization - `apply` can misleadingly fail under several circumstances:
    // - Variable number of dynamic references, e.g. create unknown # of DNS records and map them
    //   all as redundant targets - terraform cannot handle this in a single pass; need *retry*!s
    
    return this.logicalTf({ ...args, term: 'apply', cmd: 'terraform apply -input=false -auto-approve', opts: {} });
    
  }
  
  protected async logicalTfDestroy(args: { logger: Logger, fact: Fact }) {
    
    // TODO: logicalization - `destroy` can misleadingly fail under several circumstances:
    // - deletion of cloudfront & lambda@edge (I think??) - consider using `wrap` with retry??
    
    return this.logicalTf({ ...args, term: 'destroy', cmd: 'terraform destroy -input=false -auto-approve', opts: {}, wrap: async (logger, call) => {
      
      const { val } = await retry({
        attempts: 100,
        fn: n => logger.scope('attempt', { attemptNum: n }, logger => call(logger, {})),
        retryable: err => /was unable to delete arn:aws:lambda:[^ ]+ because it is a replicated function/.test(err.output ?? ''),
        delay: n => 10 * 1000 // 10 seconds between attempts
      });
      return val;
      
    }});
    
  }
  
  public async grow(deploy: { type: 'real', soil: Soil.Base } | { type: 'test' }) {
    
    if (deploy.type === 'test') throw Error('not implemented')[mod]({ type: 'test' }); // TODO: Can be nice to have local service mocks!
    
    const { bootFact, mainFact, outputs } = await this.genTerraform(deploy.soil);
    
    // Init+apply both "boot" and "main", in optimistic fashion
    const isHealableTerraformApply = err => /run[^a-zA-Z0-9]+terraform init/.test(err.output as string ?? '');
    
    const err = new Error('');
    await this.context.logger.scope('grow', { type: deploy.type, soil: cl.getClsName(deploy.soil) }, async logger => {
      
      // Note that logical individual tf operations are handled by `this.logicalTfXxx` methods;
      // here, we are doing a *logical project spawn* - this involves coordinating the "boot" tf
      // project with the "main" tf project, each of which involves an init+apply.
      
      logger = Logger.dummy; // Make "grow" log as if it were one opaque operation
      
      await tryWithHealing({
        
        fn: () => this.logicalTfApply({ logger, fact: mainFact }),
        canHeal: isHealableTerraformApply,
        heal: () => tryWithHealing({
          
          fn: () => this.logicalTfInit({ logger, fact: mainFact }),
          canHeal: err => true,
          heal: () => tryWithHealing({
            
            fn: () => this.logicalTfApply({ logger, fact: bootFact }),
            canHeal: isHealableTerraformApply,
            heal: () => this.logicalTfInit({ logger, fact: bootFact })
            
          })
          
        })
        
      });
      
    }).catch(cause => err[cl.fire]({ msg: 'grow failed', cause }));
    
    const output = await (async () => {
      
      // Use terraform cli to get output json
      const tfOutputRaw = await this.logicalTf({
        logger: this.context.logger,
        fact: mainFact,
        term: 'output',
        cmd: 'terraform output -json',
        opts: {}
      });
      
      const snakeKeysToCamel = (obj: any) => {
        if (!cl.isCls(obj, Object)) return obj;
        return obj[cl.mapk]((v, k) => [ phrasing('snake->camel', k), snakeKeysToCamel(v) ]);
      };
      
      const tfOutputJson = snakeKeysToCamel(JSON.parse(tfOutputRaw));
      const outputVals = await Promise[cl.allArr](outputs.map(output => output.getOutput(tfOutputJson)));
      
      // Merge all outputs
      return outputVals.reduce((m, v) => {
        if (cl.isCls(v, Object)) m[cl.merge](v);
        else                     m._unknownOutputs.push(v);
        return m;
      }, { _unknownOutputs: [] });
      
    })();
    
    return {
      // Now that `terraform apply` is complete we can compute outputs
      output,
      rake: () => this.context.logger.scope('rake', { type: deploy.type, soil: cl.getClsName(deploy.soil) }, async logger => {
        
        logger = Logger.dummy; // Make "rake" log as if it were one opaque operation
        
        await this.logicalTfDestroy({ logger, fact: mainFact });
        await this.logicalTfDestroy({ logger, fact: bootFact });
        
      }).catch(cause => err[cl.fire]({ msg: 'rake failed', cause }))
    };
    
  }
  
};

export * from './petal/terraform/terraform.ts';
export * from './soil/soil.ts';
export * from './util/aws.ts';