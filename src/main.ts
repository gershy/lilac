// TODO:

// A more generic (beyond just tf) provider is very hard to support due to the multiplicity of
// flower/provider combos - e.g. "api" flower would need to support api.getTfEntities,
// api.getCloudformationEntities, etc... supporting just terraform for now

// Watch out when working lilac into an npm dependency, need to allow the user a way to declare
// their absolute repo path (so "<repo>/..." filenames work in any setup!)

// Can region be dealt with any better??

import { TfEntity, TfFile, TfProvider, TfResource, TfTerraform } from './terraform.ts';
import Logger from './util/logger.ts';
import Throttler from './util/throttler.ts';
import { rootEnt } from '@gershy/disk';
import path from 'node:path';
import { regions as awsRegions } from './util/aws.ts';
type Ent = typeof rootEnt; // Consider importing from @gershy/dar? ("data-at-rest"... ewwww?)

export type Context = {
  
  name: string, // Name of the system/garden
  
  logger: Logger,
  fp: Ent,
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

export class Lilac {
  constructor() {}
  public * getDependencies(): Generator<Lilac> {
    yield this;
  }
  public getTfEntities(ctx: Context): Iterable<TfEntity> | AsyncIterable<TfEntity> {
    throw Error('not implemented');
  }
};

type RegistryLilacs<R extends Registry<any>, M extends 'real' | 'test'> = R extends Registry<infer Lilacs>
  ? { [K in keyof Lilacs]: Lilacs[K][M] }
  : never;

export class Registry<Lilacs extends Obj<{ real: typeof Lilac, test: typeof Lilac }> = Obj<never>> {
  
  private lilacs: Lilacs;
  constructor(lilacs: Lilacs) {
    this.lilacs = {}[merge](lilacs);
  }
  
  add<MoreLilacs extends Obj<{ real: typeof Lilac, test: typeof Lilac }>>(lilacs: MoreLilacs): Registry<Omit<Lilacs, keyof MoreLilacs> & MoreLilacs> {
    return new Registry({ ...this.lilacs, ...lilacs } as any);
  }
  get<Mode extends 'real' | 'test'>(mode: Mode): RegistryLilacs<Registry<Lilacs>, Mode> {
    return this.lilacs[map]((v) => v[mode]);
  }
  
};

export class Garden<Reg extends Registry<any>> {
  
  private ctx: Context;
  private registry: Reg;
  private define: (ctx: Context, lilacs: RegistryLilacs<Reg, 'real' | 'test'>) => Iterable<Lilac> | AsyncIterable<Lilac>;
  constructor(args: {
    
    name: string, // Name of the system/garden
  
    logger: Logger,
    fp: Ent,
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
  
  private async getAllTf(mode: 'real' | 'test') {
    
    const flatLilacs = new Set<Lilac>();
    for await (const lilac of this.define(this.ctx, this.registry.get(mode) as any))
      for (const dep of lilac.getDependencies())
        flatLilacs.add(dep);
    
    return Promise.all(
      flatLilacs
        [toArr](async lilac => {
          
          const ents = new Set<TfEntity>();
          for await (const ent of lilac.getTfEntities(this.ctx)) {
            ents.add(ent);
          }
          return [ ...ents ];
          
        }))
        .then(tfEnts => tfEnts.flat(1));
    
  }
  
  public async grow(mode: 'real' | 'test') {
    
    return this.ctx.logger.scope('grow', {}, async logger => {
      
      const tfAwsCredsFile = new TfFile('creds.ini', String[baseline](`
        | [default]
        | aws_region            = ${this.ctx.aws.region}
        | aws_access_key_id     = ${this.ctx.aws.accessKey.id}
        | aws_secret_access_key = ${this.ctx.aws.accessKey['!secret']}
      `));
      
      const tfEntities = await this.getAllTf(mode);
      
      const appEnts = [
        
        // Include the credentials file
        tfAwsCredsFile,
        
        new TfTerraform({
          $requiredProviders: {
            aws: {
              source: 'hashicorp/aws',
              version: `~> 5.0` // Consider parameterizing??
            }
          },
          '$backend.s3': {
            region: this.ctx.aws.region,
            encrypt:       true,
            
            // Note references not allowed in terraform.backend!!
            bucket:        `${this.ctx.pfx}-tf-state`,
            key:           `tf`,
            
            dynamodbTable: `${this.ctx.pfx}-tf-state`,  // Dynamodb table is aws-account-wide
            sharedCredentialsFiles: [ tfAwsCredsFile.tfRef() ],
            profile: 'default', // References a section within the credentials file
          }
        }),
        
        // Terraform determines the "default" provider as the one without an "alias" property
        ...awsRegions[map](({ term }) => new TfProvider('aws', {
          
          sharedCredentialsFiles: [ tfAwsCredsFile.tfRef() ],
          profile: 'default', // References a section within the credentials file
          region: term,
          
          // Omit the alias for the default provider!
          ...(term !== this.ctx.aws.region && { alias: term.split('-').join('_') })
          
        })),
        
        // Include all app-specific entities (TODO: de-duplicated by hash?? When is this actually useful?)
        ...tfEntities
        
      ];
      
      // TODO: HEEERE just generated `appEnts`, this list of all terraform blocks (including
      // provider, etc) to be included in the monolithic tf file - note some of these terraform
      // entities are *TfFiles* - i.e. they're written separately from the monolith
      // - Continue pulling in logic from realessay's `iacTf.ts`
      
    });
    
  }
  
};

export * from './terraform.ts';