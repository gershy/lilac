import type { AwsRegionTerm } from '@gershy/lilac';
import type { JsfnInstSer } from '@gershy/util-jsfn-encode';

export namespace ServiceMap {
  
  export type Domain = `${string}.${string}`;
  export type DomainMap = {
    [K in `domain/${Domain}`]: {
      port?: number,
      http?: { path?: string[] }
    }
  };

  export type AwsFargateClusterName = string;
  export type AwsFargateFamilyName = string;
  export type AwsFargateMap = {
    [K in `awsFargate/${AwsRegionTerm}/${AwsFargateClusterName}/${AwsFargateFamilyName}`]: { /* nothing! */ }
  };
  
  export type AwsS3Bucket = string;
  export type AwsS3BucketMap = {
    [K in `awsSimpleStorageService/${AwsRegionTerm}/${AwsS3Bucket}`]: { /* nothing! */ }
  };
  
  export type AwsDynamoDbTable = string;
  export type AwsDynamoDbMap = {
    [K in `awsDynamoDb/${AwsRegionTerm}/${AwsDynamoDbTable}`]: { /* nothing! */ }
  };

  export type AwsApiGatewayName = string;
  export type AwsApiGatewayMap = {
    [K in `awsApiGateway/${AwsRegionTerm}/${'http' | 'sokt'}/${AwsApiGatewayName}`]: {
      addr: Domain, // Resolved post-tf-apply
      port?: number,
      http?: { path?: string[] }, // Includes apigw stage name, resolved post-tf-apply
    }
  };

  export type AwsCloudfrontDistributionName = string;
  export type AwsCloudfrontDistributionMap = {
    [K in `awsCloudfrontDistribution/${'http' | 'sokt'}/${AwsCloudfrontDistributionName}`]: {
      addr: Domain, // Resolved post-tf-apply
      port?: number,
      http?: { path?: string[] }
    }
  };

  export type Full = {}
    // & Obj<any>
    & DomainMap
    & AwsFargateMap
    & AwsS3BucketMap
    & AwsDynamoDbMap
    & AwsApiGatewayMap
    & AwsCloudfrontDistributionMap;
  
  export type Key = keyof Full;
  
};

export type PollenInp<Pfx extends string = string> = {
  garden?: { serviceMap: ServiceMap.Full },
  flowerId: ServiceMap.Key & `${Pfx}/${string}`
};

export abstract class Pollen<Def extends Obj<any>> {
  
  // How to subclass:
  // 1. Define the Def scheme, `SubclassPollenDef`
  // 2. Define the class, `class SubclassPollen extends Pollen<SubclassPollenDef>`
  // 3. SubclassPollen should define `sanitizeDef`
  // 4. SubclassPollen should probably override `getJsfnArgs` (if subclass props need serializing)
  
  // TODO:
  // - `getJsfnArgs` typing - forgetting to implement it results in misconfigured serialized pollen
  // - `getJsfnArgs` typing - extraneous props get needlessly serialized
  // - `getJsfnArgs` typing - forgetting specific props results in misconfigured serialized pollen
  
  protected static keyScheme = {
    
    // Public domain names
    domain: {
      key: [ 'addr' ] as const,
      mappedData: {}
    },
    
    // Aws services with networking known fully up-front
    awsFargate: {
      key: [ 'region', 'cluster', 'family' ] as const,
      mappedData: {}
    },
    awsDynamoDb: {
      key: [ 'region', 'table' ] as const,
      mappedData: {}
    },
    
    // Aws services with networking only known post-deploy
    awsApiGateway: {
      key: [ 'region', 'proto', 'name' ] as const,
      mappedData: null as any as {
        addr: ServiceMap.Domain, // Resolved post-tf-apply
        port?: number,
        http?: { path?: string[] }
      }
    },
    awsCloudfrontDistribution: {
      key: [ 'proto', 'name' ] as const,
      mappedData: null as any as {
        addr: ServiceMap.Domain, // Resolved post-tf-apply
        port?: number,
        http?: { path?: string[] }
      }
    }
    
  } satisfies Obj<{ key: string[], mappedData: Obj<any> }>;
  
  protected flowerId: ServiceMap.Key;
  protected garden: { serviceMap: ServiceMap.Full };
  protected defPrm: null | Promise<Def>;
  constructor(inp: PollenInp) {
    
    // Stamen: male
    // Pistil: female
    this.garden = inp.garden ?? { serviceMap: {} };
    this.flowerId = inp.flowerId as any;
    this.defPrm = null;
    
  }
  
  // Note `getDef` initially generates a def representation based on flower id and service map
  // context; there is no fixed schema for the resulting value; `sanitizeDef` ensures the
  // resulting def is fit for whatever kind of pollen this is!
  protected abstract sanitizeDef(def: unknown): Promise<Def>;
  
  protected getDef() { return this.defPrm ??= (() => {
    
    const mappedDef = ({
      ...process[Symbol.for('@gershy/lilac/garden')]?.serviceMap,
      ...this.garden.serviceMap
    } as ServiceMap.Full)[cl.at](this.flowerId, {});
    
    const idPcs = this.flowerId.split('/');
    const type = idPcs[0] as keyof (typeof Pollen.keyScheme);
    const idKeys = [ 'type', ...Pollen.keyScheme[cl.at](type, { key: [] }).key ];
    const implicitDef = idKeys[cl.toObj]((key, n) => [ key, idPcs[n] || null ] as const);
    
    const def = {}
      [cl.merge](mappedDef)
      [cl.merge](implicitDef);
    
    return this.sanitizeDef(def);
    
  })(); }
  
  protected getJsfnArgs() {
    // Always specifically grab `serviceMap` off `this.garden` to avoid accidentally serializing a
    // much larger Garden representation when we only need this one property
    const { flowerId, garden: { serviceMap } } = this;
    return { garden: { serviceMap }, flowerId };
  }
  
  public toJsfn() {
    return {
      hoist: `${import.meta.filename}::{${this.constructor.name}}` as const,
      form: this.constructor as typeof Pollen<Def>,
      args: [ this.getJsfnArgs() ]
    } satisfies JsfnInstSer<typeof Pollen<Def>>;
  }
  
  public fly(inp: unknown): unknown { throw Error('script missing'); }
  
};
