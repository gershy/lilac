# Callers

Lilac results in deployed services, and aims to make communicating with these services as simple as possible. We conceptually model deployed services as functions - sent some input message, responding with some output. If a service pushes events, we can think of the initial handshake "function call" with it as returning an AsyncGenerator of endless events. For these "deployed functions" resulting from lilac, we strive to make it easy to obtain `Caller` instances for them. Consider an http server; an http server's endpoints are functions taking inputs that look like http request packets, and returning http response packets.

There are two distinct types of `Caller`s for a given lilac service:
1. Those that integrate flowers with each other - e.g. enable a lambda to query a db, or a cloud host instance to poll a queue, etc.
2. Those that integrate the dev environment with deployed flowers (e.g. so a dev can perform test queries against a doc db they've deployed)

Lilac adds some "magic" which allows for `Callers` to have a very simple interface.

Consider an example with an http gateway, with an endpoint that queries a database. The following is example code and omits some configuration, but fully demonstrates the `Caller` interface.

```ts
const garden = new Garden({ survey: (garden, seedBank, add) => {
  
  const { Http, Domain, LambdaHttp, DocDb } = seedBank;
  
  type DocDbVersion = {
    id: string,
    publishedUtcMs: number,
    newInThisVersion: string[],
    tag: string
  };
  const docDbConstants = new DocDb({ name: 'constants' });
  
  const http = add(new Http({
    name: 'coolHttpApi',
    domain: new Domain({ addr: 'my-cool-website.org' })
  }));
  
  // Defining an api results in its corresponding caller; this api itself has no callers as it can
  // fully determine the date internally
  const dateCaller = http.addHttpScript('/date -> get', new LambdaHttp({
    invokeFn: () => ({
      code: 200,
      body: { date: `I am the server and the time is ${new Date().toISOString()}` }
    })
  }));
  
  // This more complicated api queries the "currentVersion" document from `docDbConstants` - the
  // http script creation *results in* `versionCaller`; the lambda handler *depends on* on a
  // `Caller` to integrate with (be able to query / "function-call") the constants doc db. This
  // endpoint definition demonstrates caller type #1, i.e. flower<->flower integration
  const versionCaller = http.addHttpScript('/current-version -> get', new LambdaHttp({
    
    // Create and pass the caller doc db caller to the lamdba; note `docDbConstants` itself is the
    // source that provides `Caller`s for doc db function calls - 'query' (as opposed to 'write' or
    // 'admin') governs what permissions the lambda has in its integration. Note when `localData`
    // is a function its `lbd` parameter is itself; this can be passed to caller-creation-functions
    // allowing them to understand which lambda is gaining permissions on the flower.
    localData: lbd => ({ constantsCaller: docDbConstants.addCaller('query', lbd) }),
    launchFn: args => args.localData, // Overall, returns `{ constantsCaller: new DocDbCallerViewer(...) }`
    
    invokeFn: async args => {
      
      const { logger, launchData: { constantsCaller } } = args; // Note `args.launchData` is `launchFn`'s output
      
      // 1. Query version from doc db
      const version = await constantsCaller.query<DocDbVersion>(ops => ({
        logger,
        props: { id: 'currentVersion' } // Query for the constant with the "currentVersion" id
      }));
      
      // 2. Respond with version representation
      return { code: 200, body: {
        version: version[cl.slice]([ 'publishedUtcMs', 'newInThisVersion', 'tag' ])
      }};
      
    }
    
  }));
  
  // Callers can be returned from the garden's `survey` method. This is the secret to Caller type
  // #2, i.e. dev-environment<->flower integration. The value returned here is called the
  // "ornaments" - as in, a garden's ornaments.
  return {
    constantsCaller: docDbConstants.addCaller('admin') // Admin permission, no lambda - unrestricted access!
    dateCaller,
    versionCaller
  };
  
}});

// Now grow the garden...
const soil = new Soil.AwsCloud({ logger, garden, auth: { id: '...', '!secret': '...' }});
const grown = await garden.grow(soil);

// Now the garden is fully deployed and active. Any further code is only relevant at development
// time. Developers can interact/integrate with the grown `garden` via its ornaments.
const { ornaments } = grown;

// The dev can hit http endpoints
const dateRes = await ornaments.dateCaller.call({ /* No query params needed */ });
console.log(dateRes.body.date); // Prints: 'I am the server and the time is 2024-08-03T22:01:35.363Z'

// The dev can query the same ddb version constant...
const version = await constantsCaller.query<DocDbVersion>(ops => ({
  logger,
  props: { id: 'currentVersion' }
}));

// The dev can also update the version (`constantsCaller` is a `DocDbCallerAdmin`)
const version = await constantsCaller.query<DocDbVersion>(ops => ({
  logger,
  props: { id: 'currentVersion' }
}));
```

## The magic

The above seems very elegant, but the logic to implement it is subtle and non-self-documenting, and deserves its own writeup here.

### 1. Consumer definition

Imagine an integration between services #1 and #2; service #2 bundles typescript under a callback called `logic` and this callback interacts with service #1. (Let's call service #2 a "typescript-bundling-flower".)

```ts
const serviceOne = new SomeService1({ /* ... */ });
const serviceTwo = new SomeService2({
  
  callers: myself => ({
    serviceOne: serviceOne.getCaller(myself /* i.e. `serviceOne` */)
  }),
  
  logic: (callers) => {
    
    // This logic
    await callers.serviceOne.call(/* call serviceOne, i.e. we're integrated with it! */);
    
  }
  
});
```

### 2. Services track each other

In the above `serviceOne` has `getCaller(serviceTwo)` called on it - it can register that this `serviceTwo` is meant to call it, allowing it to generate any permission-related infra.

Also, `serviceTwo` is given a `serviceOne.getCaller(...)` instance, i.e. a `Caller` for it `serviceOne`; this is made available in its `logic` callback, which runs deployed somewhere in the cloud.

### 3. Runtime Caller instance is propagated to the cloud

But *how* is the *local* `serviceOne.getCaller(...)` instance propagated to the cloud (where it is then passed to `logic`)? The trick is (1) `Caller`s must be jsfn-compatible and therefore serializable; (2) the flower handles bundling the serialized jsfn containing the `Caller` alongside the `logic` callback (See `lilacLambda/src/main.ts::LambdaBase.prototype.getScript` for an example).

### 4. How do Callers network correctly?

Good question. `Caller`s are created before their corresponding infrastructure has been initialized/deployed, so they are unable to have immediate access to network addressing information. Instead, `Caller`s are given a `Garden` reference, and a fixed `serviceId` identifying a flower that is or will be deployed. Later, as the `Garden` is grown, it has a "service map" which is populated by any callable flowers - this service map associates `serviceId`s with their corresponding network addressing info. When a `Garden` has fully grown, all `serviceId`s will have a service map entry.

### 5. So how do dev<->flower Callers read the service map?

This one is easy. Local Flower instances must propagate their `garden` reference to all `Caller`s they create. The `Caller` can always check `garden.serviceMap`; post-`garden.grow()`, that service map will be fully populated!

Technical note:  service map network addressing info is defined in terraform outputs (where values like `aws_cloudfront_distribution.my_cool_cf_distro.domain_name` eventually resolve to actual values), retrieved by the `Garden` instance (by shelling out to `terraform output`), and compiling that data into the service map.

### 6. Ok but how do flower<->flower Callers read the service map?

This one is trickier. The magic is that all typescript-bundling-flowers bundle, along with `Caller` jsfn and arbitrary callback functions, a *full* service map representation.

1. After all Flowers are enumerated (and all service ids are known), but *before* infrastructure is deployed, the `Garden` calls `cultivate` on all Flowers and passes in the *full service map*. There's been no deployment yet, so this service map includes unresolved literal terraform values (like `aws_cloudfront_distribution.my_cool_cf_distro.domain_name`).
2. Typescript-bundling-flowers store the service map passed to their `cultivate` method, and embed it in their own infrastructure such that terraform references will be resolved (e.g. see `lilacLambda/src/main.ts::LambdaBase.prototype.cultivate` - `LambdaBase` stores the service map and inserts it into its terraform env vars; when lambdas deploy their `process.env` will contain an entry encoding the full service map).

#### Overall garden resolution flow

1. Consumer defines all Flowers
2. `Garden` enumerates the exhaustive list of Flowers; service ids, but not network addressing info, is known at this point
3. `Garden` formulates an exhaustive service map containing all service ids, with network addressing info represented as unresolved terraform refs
4. `Garden` passes this tf-unresolved-service-map to every Flower, via `cultivate`
5. `Garden` fully deploys all Flowers
  a. Typescript-bundling-flowers which inserted the unresolved-service-map into their own infra definition result in deployed infra with a tf-resolved service map. Conventionally, when the bundled script of a typescript-bundled-flower runs it should reference the service map appropriately (e.g. via env vars for lambdas), parse it, and store it on `process[Symbol.for('@gershy/lilac/serviceMap')]`. This global value is read by `Caller`s looking to resolve the service map when deployed within a typescript bundle.
  b. Locally, post-garden-grow, `terraform output` is used to resolve all network addressing


# Spitballing an ideal service map

```ts

// - Note any "resolved instantly" property can be removed; it's already in the service id.
// - Note any map which, as a result of removing "resolved instantly" properties winds up with zero
//   properties, *does not need to exist* - there is no data outside of the service id itself which
//   requires resolution!!

type Domain = `${string}.${string | Domain}`;
type DomainMap = {
  [K in `domain/${Domain}`]: {
    // TODO: no port right? Just assume 443?
    addr: Domain // Resolved instantly
  }
};

type AwsFargateClusterName = string;
type AwsFargateFamilyName = string;
type AwsFargateMap = {
  [K in `awsFargate/${AwsRegionTerm}/${AwsFargateClusterName}/${AwsFargateFamilyName}`]: {
    region: AwsRegionTerm,          // Resolved instantly
    cluster: AwsFargateClusterName, // Resolved instantly
    family: AwsFargateFamilyName    // Resolved instantly
  }
};

type AwsApiGatewayName = string;
type AwsApiGatewayMap = {
  [K in `awsApiGateway/${AwsRegionTerm}/${'http' | 'sokt'}/${AwsApiGatewayName}`]: {
    // TODO: no port right? Just assume 443?
    region: AwsRegionTerm,   // Resolved instantly
    proto:  'http' | 'sokt', // Resolved instantly
    addr:   Domain,          // Resolved post-tf-apply
    stage:  string           // Resolved post-tf-apply
  }
};

type AwsCloudfrontDistributionName = string;
type AwsCloudfrontDistributionMap = {
  [K in `awsCloudfrontDistribution/${'http' | 'sokt'}/${AwsCloudfrontDistributionName}`]: {
    proto: 'http' | 'sokt',  // Resolved instantly
    addr: Domain             // Resolved post-tf-apply
  }
};

type ServiceMap = {}
  & DomainMap
  & AwsFargateMap
  & AwsApiGatewayMap
  & AwsCloudfrontDistributionMap;

const serviceMap: ServiceMap = {
  
  // Trivial entries (i.e. the service id fully embeds the resolved networking; no terraform resolution required)
  'domain/my-cool-site.com': {
    addr: 'my-cool-site.com',
  },
  'fargate/ca-central-1/myCluster/myFamily': {
    region:  'ca-central-1'
    cluster: 'myCluster',
    family:  'myFamily'
  },
  
  // Http vs sokt api gws use completely different execute-api urls
  'apiGw/ca-central-1/http/${pfx}-myCoolApiGw': {
    region: 'ca-central-1',
    proto: 'http',
    addr: 'ab1ab1ab1.execute-api.ca-central-1.amazonaws.com',
    stage: 'some-stage'
  },
  'apiGw/ca-central-1/sokt/${pfx}-myCoolApiGw': {
    region: 'ca-central-1',
    proto: 'sokt',
    addr: 'cd2cd2cd2.execute-api.ca-central-1.amazonaws.com',
    stage: 'some-stage'
  },
  
  // Http vs sokt cf distros - http is pathless; sokt begins with "_sokt"
  'cfDistro/http/${pfx}-coolCdn': {
    proto: 'http', // tells us to hit `addr` directly
    addr: 'b8f3b33d270f397d3fe10b850f7f3836.cloudfront.net', //not 100% confirmed this is what a cloudfront url looks like
  },
  'cfDistro/sokt/${pfx}-coolCdn': {
    proto: 'sokt', // tells us to append `/_sokt` to `addr`
    addr: 'b8f3b33d270f397d3fe10b850f7f3836.cloudfront.net',
  },
  
}
```