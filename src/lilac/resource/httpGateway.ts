import snakeCase from '../../../boot/util/snakeCase';
import kebabCase from '../../../boot/util/kebabCase';
import capitalize from '../../../boot/util/capitalize';
import { TfEntity, TfFile, TfResource } from '../provider/awsTf';
import { HttpLambda } from '../comm/httpLambda';
import { Lilac, LilacContext } from '../lilac';
import { aws, tf } from '../util';
import { Domain } from './domain';
import { Check, CombinedChecks, Lambda, HttpShape, LambdaHttp } from './lambda';
import { SoktLambda } from '../comm/soktLambda';
import { ApiGatewayManager } from '../comm/apiGatewayManager';
import JsZip from 'jszip';
import hash from '../../util/hash';
import awsRegions from '../../util/awsRegions';

export type HttpGatewayArgs = {
  name: string,
  description: string,
  protocol: 'http' | 'https',
  domain: Domain,
  throttling: { requestsPerIpPerMin: number }
};
export type HttpGatewayHandlerOpts = {
  acceptHeaders: string[]
};
export class HttpGateway extends Lilac {
  
  // Note this logical http gateway also handles websockets
  
  protected name: HttpGatewayArgs['name'];
  protected description: HttpGatewayArgs['description'];
  protected proto: 'http' | 'https';
  protected domain: Domain;
  protected throttling: HttpGatewayArgs['throttling'];
  protected httpRoutes: Array<{ method: string, path: `/${string}`, lambda: LambdaHttp<any, any, any, any>, args?: HttpGatewayHandlerOpts }>;
  protected soktRoutes: Array<{ key: string, lambda: LambdaHttp<any, any, any, any> }>;
  protected managers: Array<{ lambda: Lambda<any, any, any, any, any> }>;
  constructor(args: HttpGatewayArgs) {
    super();
    this.name = args.name;
    this.description = args.description;
    this.proto = args.protocol;
    this.domain = args.domain;
    this.throttling = args.throttling;
    this.httpRoutes = [];
    this.soktRoutes = [];
    this.managers = [];
  }
  
  public * getDependencies(ctx: LilacContext) {
    yield* super.getDependencies(ctx);
    yield* this.domain.getDependencies(ctx);
    for (const { lambda } of this.httpRoutes) yield* lambda.getDependencies(ctx);
    for (const { lambda } of this.soktRoutes) yield* lambda.getDependencies(ctx);
    for (const { lambda } of this.managers) yield* lambda.getDependencies(ctx);
  }
  
  addHttpHandler<Checks extends Check[], Res extends HttpShape['res']>(
    route: `/${string} -> ${'get' | 'put' | 'post' | 'patch' | 'delete' | 'head'}`,
    lambda: LambdaHttp<any, any, Checks, Res>
  ): JsfnInst<typeof HttpLambda<HttpShape['req'] & CombinedChecks<Checks>, Res>>
  
  addHttpHandler<Checks extends Check[], Res extends HttpShape['res']>(
    route: `/${string} -> ${'get' | 'put' | 'post' | 'patch' | 'delete' | 'head'}`,
    opts: HttpGatewayHandlerOpts,
    lambda: LambdaHttp<any, any, Checks, Res>
  ): JsfnInst<typeof HttpLambda<HttpShape['req'] & CombinedChecks<Checks>, Res>>
  
  addHttpHandler(...args: any[]) {
    
    const route = args.find(a => isForm(a, String)) as `/${string} -> ${'get' | 'put' | 'post' | 'patch' | 'delete' | 'head'}`;
    const opts = (args.find(a => isForm(a, Object)) as HttpGatewayHandlerOpts) ?? { acceptHeaders: [] };
    const lambda = args.find(a => hasForm(a, LambdaHttp)) as LambdaHttp<any, any, any, any>;
    
    const [ path, method ] = route[cut](' -> ', 1)[map](v => v.trim()) as [ `/${string}`, string ];
    this.httpRoutes.push({ path, method, lambda, args: opts });
    
    return {
      hoist: '<repo>/src/node/lilac/comm/httpLambda::HttpLambda',
      form: HttpLambda,
      args: [{
        netProc: { proto: this.proto, addr: this.domain.getNameFull(), port: this.domain.getPort() },
        path: path.split('/').slice(1).filter(Boolean),
        method
      }]
    } as JsfnInst<typeof HttpLambda<any, any>>;
    
  }
  
  addSoktHandler<Checks extends Check[], Res extends HttpShape['res']>(
    key: '$connect' | '$disconnect' | '$default' | string,
    lambda: LambdaHttp<any, any, Checks, Res>
  ) {
    
    this.soktRoutes.push({ key, lambda });
    return {
      hoist: '<repo>/src/node/lilac/comm/soktLambda::SoktLambda',
      form: SoktLambda,
      args: [{ netProc: { proto: this.proto === 'http' ? 'ws' : 'wss', addr: this.domain.getNameFull(), port: this.domain.getPort() }, key }]
    } as JsfnInst<typeof SoktLambda>;
    
  }
  
  addManager(ctx: LilacContext, lambda: Lambda<any, any, any, any, any>) {
    
    this.managers[add]({ lambda });
    return {
      hoist: '<repo>/src/node/lilac/comm/apiGatewayManager::ApiGatewayManager',
      form: ApiGatewayManager,
      args: [ {} ]
    } as JsfnInst<typeof ApiGatewayManager>;
    
  }
  
  async getTfEntities0(ctx: LilacContext) {
    
    // TODO: Prevent direct access to api gateway via public invoke url:
    // Add resource policies to API Gateway to only allow requests from CloudFront.
    const entities = new Set<TfEntity>();
    const addEntity = <TE extends TfEntity>(ent: TE): TE => { entities.add(ent); return ent; };
    
    // Note the processes of defining http and sokt resources are very similar! Lotsa repetition...
    
    const httpApi = addEntity(new TfResource('awsApigatewayv2Api', this.name, { // Consider: `${this.name}Http`
      name:         `${ctx.pfx}-${this.name}`,
      protocolType: 'http'[upper](),
      description:  `${this.description} - http api`
    }));
    const httpStage = addEntity(new TfResource('awsApigatewayv2Stage', this.name, {
      apiId:      httpApi.tfRefp('id'),
      name:       `${ctx.pfx}-${this.name}-http`,
      autoDeploy: true,
      description: `maturity: ${ctx.maturity}; protocol: http`,
      
      // Note the stage can define *global* throttling - not sure if we ever want this??
      // defaultRouteSettings: {
      //   throttlingBurstLimit: 100, // Max parallel requests per burst (need more info - how are "bursts" detected/gated??)
      //   throttlingRateLimit:  50,  // Requests per sec
      // },
      stageVariables: {
        // Note the full `stageVariables` payload must be <= 2kb
        // TODO: Lambdas should obtain the http/sokt urls from these stage variables!!
        // TODO: Should add opinions about what *must* exist in `stageVariables`, and
        // enforce/expose it through typing both here and in `HttpLambda`!!
        //debug: ctx.debug.toString() // Note - different stages should be able to have different values here!!!
      }
      
    }));
    
    const soktApi = addEntity(new TfResource('awsApigatewayv2Api', `${this.name}Sokt`, {
      name:         `${ctx.pfx}-${this.name}-sokt`,
      protocolType: 'websocket'[upper](),
      description:  `${this.description} - sokt api`
    }));
    const soktStage = addEntity(new TfResource('awsApigatewayv2Stage', `${this.name}Sokt`, {
      apiId:       soktApi.tfRefp('id'),
      name:        `${ctx.pfx}-${this.name}-sokt`,
      autoDeploy:  true,
      description: `maturity: ${ctx.maturity}; protocol: sokt`
    }));
    
    // Every lambda in the http gateway gets environment vars pointing to http/sokt entrypoints
    for (const lambda of new Set([ ...this.httpRoutes, ...this.soktRoutes, ...this.managers ][map](route => route.lambda)))
      Object.assign(lambda.envVars, {
        httpUrl: `${tf.embed(httpStage.tfRef('invokeUrl'))}`,
        soktUrl: `${tf.embed(soktStage.tfRef('invokeUrl'))}`,
      });
    
    const lambdaTfEntities = await Promise.all([
      ...this.httpRoutes[map](async ({ path, method, lambda }) => {
        
        // The lambda resolves to several TfEntities
        const lbdEnts = await lambda.getTfEntities(ctx); // TODO: Any zip failure here crashes the whole thing (should let all lambdas acc/rjc, which will include their cleanup)
        for (const ent of lbdEnts) addEntity(ent);
        
        // Find the specific lambda function TfEntity
        const lbd = lbdEnts.find(ent => ent.getType() === 'awsLambdaFunction')!;
        
        const integration = addEntity(new TfResource('awsApigatewayv2Integration', this.name + capitalize(lbd.getHandle()), {
          apiId: httpApi.tfRefp('id'),
          integrationType: snakeCase('awsProxy')[upper](),
          integrationUri: lbd.tfRefp('invokeArn')
        }));
        
        const route = addEntity(new TfResource('awsApigatewayv2Route', this.name + capitalize(lbd.getHandle()), {
          apiId:    httpApi.tfRefp('id'),
          routeKey: `${method[upper]()} ${path}`,
          target:   `integrations/${tf.embed(integration.tfRef('id'))}`
        }));
        
        const permission = addEntity(new TfResource('awsLambdaPermission', this.name + capitalize(lbd.getHandle()), {
          statementId:  `${ctx.pfx}-${this.name}-${kebabCase(lbd.getHandle())}`,
          action:       'lambda:InvokeFunction',
          functionName: lbd.tfRefp('functionName'),
          principal:    'apigateway.amazonaws.com',
          sourceArn:    `${tf.embed(httpApi.tfRef('executionArn'))}/*/*`
        }));
        
      }),
      ...this.soktRoutes[map](async ({ key, lambda }) => {
        
        const lbdEnts = await lambda.getTfEntities(ctx);
        for (const ent of lbdEnts) addEntity(ent);
        const lbd = lbdEnts.find(ent => ent.getType() === 'awsLambdaFunction')!;
        
        const integration = addEntity(new TfResource('awsApigatewayv2Integration', this.name + 'Sokt' + capitalize(lbd.getHandle()), {
          apiId: soktApi.tfRefp('id'),
          integrationType: snakeCase('awsProxy')[upper](),
          integrationUri: lbd.tfRefp('invokeArn')
        }));
        
        const route = addEntity(new TfResource('awsApigatewayv2Route', this.name + 'Sokt' + capitalize(lbd.getHandle()), {
          apiId:    soktApi.tfRefp('id'),
          routeKey: key,
          target:   `integrations/${tf.embed(integration.tfRef('id'))}`
        }));
        
        const permission = addEntity(new TfResource('awsLambdaPermission', this.name + 'Sokt' + capitalize(lbd.getHandle()), {
          statementId:  `${ctx.pfx}-${this.name}-${kebabCase(lbd.getHandle())}`,
          action:       'lambda:InvokeFunction',
          functionName: lbd.tfRefp('functionName'),
          principal:    'apigateway.amazonaws.com',
          sourceArn:    `${tf.embed(soktApi.tfRef('executionArn'))}/*/*`
        }));
        
      }),
      ...this.managers[map](async ({ lambda }) => {
        
        const lbdEnts = await lambda.getTfEntities(ctx);
        for (const ent of lbdEnts) addEntity(ent);
        
        const lbdRoleEnts = await lambda.getRole().getTfEntities(ctx);
        const tfIamRole = lbdRoleEnts.find(ent => ent.getType() === 'awsIamRole')!;
        
        const lambdaPolicyName = capitalize([ 'lambdaApiGwManage', lambda.getName(), this.name ]);
        const lambdaPolicy = addEntity(new TfResource('awsIamPolicy', lambdaPolicyName, {
          name: `${ctx.pfx}-${lambdaPolicyName}`,
          policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
            effect: capitalize('allow'),
            action: [ 'execute-api:ManageConnections' ],
            resource: [
              // The iam permissions for management need to be on this arn:
              // `${tf.embed(soktApi.tfRef('arn'))}/${tf.embed(soktStage.tfRef('name'))}/POST/@connections/*`,
              `${tf.embed(soktApi.tfRef('execution_arn'))}/${tf.embed(soktStage.tfRef('id'))}/POST/@connections/*`,
            ]
          }]}))
        }));
        
        const lambdaPolicyAttachment = addEntity(new TfResource('awsIamRolePolicyAttachment', lambdaPolicyName, {
          role:      tfIamRole.tfRefp('name'),
          policyArn: lambdaPolicy.tfRefp('arn')
        }));
        
      })
    ]);
    
    const hostedZone = this.domain.getHostedZone();
    
    // Cloudfront distribution setup - these resources are always in us-east-1 (motivated by the
    // need to provide cloudfront with a certificate provisioned in us-east-1; it's easier to just
    // provision everything in us-east-1 instead of have cross-region dependencies)
    // Note us-east-1 cloudfront resources link back to resources in `ctx.region` via cloudfront's
    // origin domain name!
    const domainHandle = `domainUse1${this.domain.getNamePcs()[map](p => capitalize(p)).join('').replace(/[^a-zA-Z0-9]/g, '')}`;
    const cloudfrontDomainCert = addEntity(new TfResource('awsAcmCertificate', domainHandle, {
      
      ...tf.provider(ctx.aws.region, 'us-east-1'),
      domainName: this.domain.hasSubdomain()
        ? `${'*.'}${this.domain.getNameBase()}`
        : `${''  }${this.domain.getNameBase()}`, // Consider referencing domain name from hosted zone??
      validationMethod: 'dns'[upper]()
      
    }));
    const cloudfrontDomainDns = addEntity(new TfResource('awsRoute53Record', domainHandle, {
      
      ...tf.provider(ctx.aws.region, 'us-east-1'),
      
      // Need to create some dns records to facilitate the validation!
      forEach: `| { for opt in ${cloudfrontDomainCert.tfRef('domainValidationOptions')} : opt.${snakeCase('domainName')} => opt }`,
      zoneId:  hostedZone.tfRefp('zoneId'),
      name:    `| each.value.${snakeCase('resourceRecordName')}`,
      type:    `| each.value.${snakeCase('resourceRecordType')}`,
      records: `| [ each.value.${snakeCase('resourceRecordValue')} ]`,
      ttl:     60 * 5
      
    }));
    const cloudfrontDomainValidation = addEntity(new TfResource('awsAcmCertificateValidation', domainHandle, {
      
      ...tf.provider(ctx.aws.region, 'us-east-1'),
      
      certificateArn:        cloudfrontDomainCert.tfRefp('arn'),
      validationRecordFqdns: `| [ for rec in ${cloudfrontDomainDns.tfRef()} : rec.fqdn ]`
      
    }));
    
    // Redirect http->https; note that http->https redirection is coupled with caching config, as
    // both are facilitated by cloudfront
    const firewall = addEntity(new TfResource('awsWafv2WebAcl', this.name, {
      
      ...tf.provider(ctx.aws.region, 'us-east-1'),
      
      name: `${ctx.pfx}-${this.name}Firewall`,
      scope: 'cloudfront'[upper](),
      description: 'firewall',
      
      $defaultAction: {
        $allow: {}
      },
      $rule: {
        
        name: 'rateLimit',
        priority: 1,
        
        $action: { $block: {} },
        
        $statement: {
          $rateBasedStatement: {
            limit: this.throttling.requestsPerIpPerMin * 5, // Value is requests per 5min
            aggregateKeyType: 'ip'[upper]()
          }
        },
        
        $visibilityConfig: {
          metricName: 'rateLimitBlock',
          sampledRequestsEnabled: false,
          cloudwatchMetricsEnabled: false,
        },
        
      },
      
      $visibilityConfig: {
        metricName: 'rateLimit',
        sampledRequestsEnabled: false,
        cloudwatchMetricsEnabled: false,
      }
      
    }));
    
    // A single request policy for sokt, and an arbitrary number for http (as each http endpoint
    // can support different allowed-header configurations)
    const routeOrps = this.httpRoutes.filter(r => r.args?.acceptHeaders.length)[map]((route, n) => {
      const headers = route.args!.acceptHeaders;
      return {
        path: route.path,
        method: route.method,
        originRequestPolicy: addEntity(new TfResource('awsCloudfrontOriginRequestPolicy', `${this.name}Orp${n}`, /* "origin request policy" */ {
          name: `${ctx.pfx}-${this.name}Orp${n}`,
          $headersConfig: {
            headerBehavior: 'whitelist',
            
            // Cloudfront makes it illegal to specify certain headers (not sure about casing)
            $headers: { items: headers.filter(h => h !== 'Connection' && h !== 'Upgrade') },
            
            // This is a nice idea, but cloudfront has a limit of 10 headers, which is exceeded too
            // easily when the number of headers is tripled - UGH
            // The real solution here seems convoluted: use Lambda@Edge to normalize all headers
            // before they're processed by cloudfront
            // Note this was also contrived, motivated by paypal's full-upper header style...
            // $headers: { items: [
            // 
            //   // Cloudfront treats headers *case-sensitively* - for given input headers, include
            //   // 3x the headers - for fully lowercase, fully uppercase, and capitalized styles
            //   ...headers[map](v => kebabCase(v)),
            //   ...headers[map](v => kebabCase(v))[map](v => v[upper]()),
            //   ...headers[map](v => kebabCase(v))[map](v => v.split('-')[map](v => capitalize(v)).join('-'))
            //   
            // ]}
          },
          $cookiesConfig:      { cookieBehavior:      'all' },
          $queryStringsConfig: { queryStringBehavior: 'all' }
        }))
      };
    });
    
    const { name: soktEdgeLambdaName, soktEdgeLambda } = await (async () => {
      
      // TODO: A lot of this is copied from lambda.ts and role.ts - I just pulled the tf generation
      // straight out of them because I was antsy
      
      const name = `${this.name}SoktEdgeFn`;
      const resolvedName = `${ctx.pfx}-${name}`;
      
      const fnAssumePolicies = [
        { effect: 'Allow', action: 'sts:AssumeRole', principal: { service: [ 'lambda.amazonaws.com', 'edgelambda.amazonaws.com' ] } },
      ];
      const fnEnactPolicies = [
        {
          effect: 'Allow',
          action: [ 'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents' ],
          resource: [ `arn:aws:logs:*:*:*` ]
        },
      ];
      const role = addEntity(new TfResource('awsIamRole', name, {
        ...tf.provider(ctx.aws.region, 'us-east-1'),
        name: resolvedName,
        assumeRolePolicy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: fnAssumePolicies }))
      }));
      const policy = addEntity(new TfResource('awsIamPolicy', name, {
        ...tf.provider(ctx.aws.region, 'us-east-1'),
        name: resolvedName,
        policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: fnEnactPolicies }))
      }));
      const attach = addEntity(new TfResource('awsIamRolePolicyAttachment', name, {
        ...tf.provider(ctx.aws.region, 'us-east-1'),
        role:      role.tfRefp('name'),
        policyArn: policy.tfRefp('arn')
      }));
      
      // WATCH OUT!! Setting up lambda@edge is *very* finnicky - and tricky to debug!!!
      // Note the callback style seems *necessary*!!! It's also *possibly* necessary to mutate
      // `req` instead of just doing `cb({ ...req, uri: fixedUri })`.
      //    | type OriginRequest = {
      //    |   headers: { [K: string]: string[] },
      //    |   uri: string
      //    | };
      //    | type OriginRequestEvent = { Records: { cf: { request: OriginRequest } }[] };
      //    | const edgeFn = (e: OriginRequestEvent, ctx: any, cb: (err: any, val: OriginRequest) => void) => {
      //    |   const req = e.Records[0].cf.request;
      //    |   req.uri = req.uri.replace('/api/websocket', '');
      //    |   if (req.uri.length === 0) req.uri = '/';
      //    |   cb(null, req);
      //    | };
      //    | const packedCode2 = `exports.handler=${edgeFn.toString().replace(/\s+/g, ' ')}`;
      const packedCode = String.baseline(`
        | exports.handler = (e, ctx, cb) => {
        |   const req = e.Records[0].cf.request;
        |   req.uri = req.uri.replace('/api/websocket', '');
        |   if (req.uri.length === 0) req.uri = '/';
        |   cb(null, req);
        | };
      `);
      const jsZip = new JsZip();
      jsZip.file(`${resolvedName}/code.js`, packedCode, { date: new Date(0) });
      const zip = await ctx.throttlers.zipFile.do(() => jsZip.generateAsync({ type: 'nodebuffer', compression: 'deflate'[upper]() }));
      const zipFile = addEntity(new TfFile(`literal/lambda/${name}.js.zip`, zip));
      const jsFile  = addEntity(new TfFile(`literal/lambda/${name}.js`, packedCode));
      
      // Got to watch out for edge function log generation. Edge functions may log to a log group
      // of corresponding name, in *any region*!!! Realistically, this means for every lambda@edge,
      // there is a log group for every region. If we want to be able to set retention, we would
      // theoretically need to pre-emptively create a log group in every possible region that any
      // existing edge lambda could log to
      const soktEdgeLambda = addEntity(new TfResource('awsLambdaFunction', name, {
        // WATCH OUT - Provider and `publish` are unique to lambda@edge - they're not copied from
        // lambda.ts - and `timeout` is *maximum 5* for edge!
        ...tf.provider(ctx.aws.region, 'us-east-1'),
        publish: true,
        
        functionName:   resolvedName,
        runtime:        Lambda.awsNodeRuntime,
        role:           role.tfRefp('arn'),
        handler:        `${ctx.pfx}-${name}/code.handler`,
        filename:       zipFile.tfRef(),
        timeout:        5,
        sourceCodeHash: hash(packedCode), // Careful not to hash the zipped value, which is nondeterministic
        $loggingConfig: {
          logFormat: 'json'[upper]()
        },
        
        // Consider this produces warnings in terraform - but it does effectively prevent new
        // versions being created every time!
        $lifecycle: {
          ignoreChanges: [
            `| ${snakeCase('version')}`,
            `| ${snakeCase('qualifiedArn')}`,
            `| ${snakeCase('qualifiedInvokeArn')}`,
          ]
        }
      }));
      
      return { name, soktEdgeLambda };
    })();
    
    // Add a log group for lambda@edge... FOR EVERY REGION OWWWW
    // This will ensure lambda@edge logging retention settings in every region!
    // TODO: `awsRegions` are hardcoded here; realistically a user may have unlocked more
    // regions, or aws may have opened new locations, putting the user's real list of aws regions
    // out-of-date. The nasty result of this is that the user may wind up with infinite-retention
    // log groups in obscure regions! Yikes.
    for (const region of awsRegions)
      addEntity(new TfResource('awsCloudwatchLogGroup', `${soktEdgeLambdaName}Logs${capitalize(region.mini)}`, {
        
        // Here's how the log group is connected to its region
        ...tf.provider(ctx.aws.region, region.term),
        
        // Note the log group name will always include "us-east-1" as cloudfront resources (like
        // lambda@edge) are considered to be provisioned there, even though these resources are
        // replicated globally
        name: `/aws/lambda/us-east-1.${tf.embed(soktEdgeLambda.tfRef('functionName'))}`,
        
        retentionInDays: 14,
        
      }));
    
    const baseCacheConfigHttp = addEntity(new TfResource('awsCloudfrontCachePolicy', this.name, {
      
      ...tf.provider(ctx.aws.region, 'us-east-1'),
      name: `${ctx.pfx}-${this.name}CacheConfig`,
      
      // Consider setting up caching!! (Requires increasing these values, and sending caching
      // headers from lambdas)
      defaultTtl: 0,
      minTtl: 0,
      maxTtl: 3600,
      
      // Note these have no effect on what is forwarded to the origin if the
      // awsCloudfrontCachePolicy has a sibling awsCloudfrontOriginRequestPolicy item - if the
      // sibling is present, the orp fully determines what is sent to the origin! In our case,
      // `baseCacheConfigHttp` will be accompanied by `baseOriginRequestPolicyHttp`
      $parametersInCacheKeyAndForwardedToOrigin: {
        
        // Only the query string fragments the cache - headers are obviously undesirable due to
        // e.g. "user agent", and cookies are private to individual users - we probably don't want
        // them effecting a shared cache like cloudfront; maybe there's some potential to allow
        // users to cache their cookie-related private values in cf instead of in their browser...
        // to alleviate browser memory constraints? I dunno...
        $headersConfig:      { headerBehavior:      'none' },
        $cookiesConfig:      { cookieBehavior:      'none' },
        $queryStringsConfig: { queryStringBehavior: 'all' },
        
        enableAcceptEncodingGzip:   true,
        enableAcceptEncodingBrotli: true
        
      }
      
    }));
    const baseOriginRequestPolicyHttp = addEntity(new TfResource('awsCloudfrontOriginRequestPolicy', `${this.name}OrpBase`, {
      name:                `${ctx.pfx}-${this.name}OrpBase`,
      $headersConfig:      { headerBehavior:      'none' },
      $cookiesConfig:      { cookieBehavior:      'all' },
      $queryStringsConfig: { queryStringBehavior: 'all' }
    }));
    const cloudfront = addEntity(new TfResource('awsCloudfrontDistribution', this.name, {
      
      ...tf.provider(ctx.aws.region, 'us-east-1'),
      
      // Redirect settings
      aliases: [ this.domain.getNameFull() ],
      
      '$origin.0': {
        
        // The "origin" is the entity behind the cloudfront proxy - this one is the http api
        originId: 'httpApi',
        
        // Note cloudfront wants a url without any protocol or path!!
        domainName: `| regex("${/^https?:[/][/]([^/]+)([/].*)$/.toString().slice(1, -1)}", ${httpStage.tfRef('invokeUrl')})[0]`,
        originPath: `| regex("${/^https?:[/][/]([^/]+)([/].*)$/.toString().slice(1, -1)}", ${httpStage.tfRef('invokeUrl')})[1]`,
        
        $customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: 'https-only', // Only communicate with apigw over https (which is all apigw supports)
          originSslProtocols: [ `${'tls'[upper]()}v1.2` ]
        }
        
      },
      '$origin.1': {
        
        // Here's the sokt api for cloudfront...
        originId: 'soktApi',
        
        domainName: `| regex("${/^wss?:[/][/]([^/]+)([/].*)$/.toString().slice(1, -1)}", ${soktStage.tfRef('invokeUrl')})[0]`,
        originPath: `| regex("${/^wss?:[/][/]([^/]+)([/].*)$/.toString().slice(1, -1)}", ${soktStage.tfRef('invokeUrl')})[1]`,
        
        $customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: 'https-only', // Only communicate with apigw over https (which is all apigw supports)
          originSslProtocols: [ `${'tls'[upper]()}v1.2` ]
        }
        
      },
      
      // More settings...
      comment: 'cloudfront',
      priceClass: 'PriceClass_100', // cheapest - only pushes to cheap edge locations (e.g. us, ca)
      enabled: true,
      isIpv6Enabled: true,
      defaultRootObject: '',
      
      // Redirect "/api/websocket" requests to sokt origin
      '$orderedCacheBehavior.0': {
        pathPattern: '/api/websocket',
        targetOriginId: 'soktApi',
        allowedMethods: 'head,get'[upper]().split(','),
        cachedMethods: 'head,get'[upper]().split(','),
        
        cachePolicyId: addEntity(new TfResource('awsCloudfrontCachePolicy', `${this.name}Sokt`, {
          
          ...tf.provider(ctx.aws.region, 'us-east-1'),
          name: `${ctx.pfx}-${this.name}CacheConfigSokt`,
          
          // The max ttl of 0 disables caching entirely for ws
          defaultTtl: 0, minTtl: 0, maxTtl: 0,
          
          // Note these have no effect on what is forwarded to the origin due to presence of an
          // accompanying orp
          $parametersInCacheKeyAndForwardedToOrigin: {
            // Note that due to `maxTtl: 0`, *all* of these must be "none"
            $headersConfig:      { headerBehavior:      'none' },
            $cookiesConfig:      { cookieBehavior:      'none' },
            $queryStringsConfig: { queryStringBehavior: 'none' }
          }
          
        })).tfRefp('id'),
        
        originRequestPolicyId: addEntity(new TfResource('awsCloudfrontOriginRequestPolicy', `${this.name}OrpSokt`, {
          name: `${ctx.pfx}-${this.name}OrpSokt`,
          $headersConfig: {
            headerBehavior: 'whitelist',
            $headers: { items: [
              'Sec-WebSocket-Key',
              'Sec-WebSocket-Version',
              'Sec-WebSocket-Protocol',
              'Sec-WebSocket-Extensions',
            ]}
          },
          // Consider forwarding cookies and query strings?? (TODO: How to get Token1Body???)
          $cookiesConfig:      { cookieBehavior:      'all' },
          $queryStringsConfig: { queryStringBehavior: 'all' }
        })).tfRefp('id'),
        
        viewerProtocolPolicy:  'redirect-to-https',
        
        $lambdaFunctionAssociation: {
          eventType: 'origin-request',
          lambdaArn: soktEdgeLambda.tfRefp('qualifiedArn'),
          includeBody: false
        }
      },
      
      ...(routeOrps[toObj](({ path, method, originRequestPolicy }, n) => {
        
        return [ `$orderedCacheBehavior.${n + 1}`, {
          pathPattern:           path,
          allowedMethods:        {
            
            // Cloudfront supports fixed lists of allowed methods (cannot supply arbitrary lists of
            // methods) - but we know the exact method; given that method, use the minimal set of
            // methods supported by cloudfront
            
            // Note that 'head,get' is a more minimal option than anything here, but it's illegal
            // to specify a (cached method) that isn't in (allowed methods), and we want to specify
            // options in our cached methods.
            
            head:      'head,get,options',
            get:       'head,get,options',
            options:   'head,get,options',
          }[at](method, 'head,delete,post,get,options,put,patch')[upper]().split(','),
          
          // Here we specify caching for some methods, but whether this actually takes effect
          // depends on http headers returned by the specific endpoint! 
          cachedMethods:         'head,get,options'[upper]().split(','),
          targetOriginId:        'httpApi',
          cachePolicyId:         baseCacheConfigHttp.tfRefp('id'), // Base caching simply means "headers: no, cookies: no, query string: yes"
          originRequestPolicyId: originRequestPolicy.tfRefp('id'), // This cache-behaviour-specific orp mostly whitelists headers
          viewerProtocolPolicy:  'redirect-to-https'
        }];
        
      })),
      
      $defaultCacheBehavior: {
        
        targetOriginId: 'httpApi', // Reference an embedded origin by id
        viewerProtocolPolicy: 'redirect-to-https',
        
        allowedMethods: 'head,options,get,post,put,patch,delete'[upper]().split(','),
        cachedMethods:  'head,get,options'[upper]().split(','),
        
        // The base cache config and orp result in caching only based on path+queryString, and
        // forwarding cookies and queryString (not headers) to the origin
        cachePolicyId:         baseCacheConfigHttp.tfRefp('id'),
        originRequestPolicyId: baseOriginRequestPolicyHttp.tfRefp('id')
        
      },
      
      $restrictions: {
        $geoRestriction: {
          restrictionType: 'none'
        }
      },
      
      $viewerCertificate: {
        acmCertificateArn: cloudfrontDomainCert.tfRefp('arn'),
        sslSupportMethod: kebabCase('sniOnly'), // "server name indication"; the client always mentions the hostname they're connecting to; this says to use that mentioned hostname to determine the cert (multiple hostnames may exist under the same cloudfront/ip address)
        minimumProtocolVersion: 'TLSv1.2_2019'
      },
      
      webAclId: firewall.tfRefp('arn'), // Yes... "arn", not "id"
      
      dependsOn: [ cloudfrontDomainValidation.tfRefp() ]
      
    }));
    
    // Add a log group for cloudfront... FOR EVERY REGION... AGAIN... OOWOWWWWWW
    for (const region of awsRegions)
      addEntity(new TfResource('awsCloudwatchLogGroup', `${this.name}Logs${capitalize(region.mini)}`, {
        ...tf.provider(ctx.aws.region, region.term),
        name: `/aws/cloudfront/LambdaEdge/${tf.embed(cloudfront.tfRef('id'))}`,
        retentionInDays: 14
      }));
    
    // Connect our domain name as an entrypoint to cloudfront
    const cloudfrontDns = addEntity(new TfResource('awsRoute53Record', this.name, {
      
      // Define the given domain name as an alias for cloudfront's address!
      // Note this form of "a" record is unique to aws - it points a domain to another domain,
      // whereas typical "a" records point an ip address to a domain.
      
      ...tf.provider(ctx.aws.region, 'us-east-1'),
      zoneId: hostedZone.tfRefp('id'),
      name: this.domain.getNameFull(),
      type: 'a'[upper](),
      
      $alias: {
        name:                 cloudfront.tfRefp('domainName'),
        zoneId:               cloudfront.tfRefp('hostedZoneId'),
        evaluateTargetHealth: false
      }
      
    }));
    
    return [ ...entities ];
    
  }
};