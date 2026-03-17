import { assertEqual, cmpAny, testRunner } from '../build/utils.test.ts';
import { Context, Garden, Flower, Registry, PetalTerraform } from './main.ts';
import { Fact, rootFact } from '@gershy/disk';
import Logger from '@gershy/logger';
import hash from '@gershy/util-hash';
import http from '@gershy/util-http';
import phrasing from '@gershy/util-phrasing';
import JsZip from 'jszip';
import { APIGatewayClient, GetRestApisCommand } from '@aws-sdk/client-api-gateway';
import { Soil } from './soil/soil.ts';

// Type testing
(async () => {
  
  type Enforce<Provided, Expected extends Provided> = { provided: Provided, expected: Expected };
  
  type Tests = {
    1: Enforce<{ x: 'y' }, { x: 'y' }>,
  };
  
})();

const isolated = async (fn: (fact: Fact) => Promise<void>) => {
  
  let fact: null | Fact = null;
  try {
    
    fact = await rootFact.kid([ import.meta.dirname, '.isolatedTest' ], { newTx: true });
    await fn(fact);
    
  } finally {
    
    await fact?.rem();
    fact?.tx.end();
    
  }
  
};
const getSubtree = async (ent: Fact, enc: 'bin' | 'str' | 'json') => {
  
  // Consider - `terraform init` might be quite slow... should it be in these tests??
  const [ data, kids ] = await Promise.all([
    
    ent.getData(enc as any),
    await ent.getKids()
      .then(kids => Promise[allObj](kids[map](kid => getSubtree(kid, enc))))
    
  ]);
  
  return { data, kids };
  
};

testRunner([
  
  { name: 'basic terraform gen', fn: async () => {
    
    // TODO:
    // - This file should take optional argv aws creds
    // - Prevent automated isolated cleanup for this next part
    // - Actually fully apply terraform to aws account, plus `terraform destroy` for cleanup
    // - Can test various scenarios
    //   - Deleting populated dbs
    //   - Mapping dynamic-length lists (dns) to infrastructure (needs multiple `terraform apply` calls)
    // - Test various error scenarios; add specific text match conditions to `tryWithHealing`
    
    const res = new PetalTerraform.Resource('awsWafv2WebAcl', 'happyWaf', {
      
      name: `tezzzt-coolFirewall`,
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
            limit: 5000, // Value is requests per 5min
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
      
    });
    
    const tf = await res.getResult();
    assertEqual(tf, String[baseline](`
      | resource "aws_wafv2_web_acl" "happy_waf" {
      |   name = "tezzzt-coolFirewall"
      |   scope = "CLOUDFRONT"
      |   description = "firewall"
      |   default_action {
      |     allow {}
      |   }
      |   rule {
      |     name = "rateLimit"
      |     priority = 1
      |     action {
      |       block {}
      |     }
      |     statement {
      |       rate_based_statement {
      |         limit = 5000
      |         aggregate_key_type = "IP"
      |       }
      |     }
      |     visibility_config {
      |       metric_name = "rateLimitBlock"
      |       sampled_requests_enabled = false
      |       cloudwatch_metrics_enabled = false
      |     }
      |   }
      |   visibility_config {
      |     metric_name = "rateLimit"
      |     sampled_requests_enabled = false
      |     cloudwatch_metrics_enabled = false
      |   }
      | }
    `));
    
  }},
  { name: 'garden growth', fn: () => isolated(async fact => {
    
    // Deploy the simplest possible api to localStack, and test if querying it works
    
    const logger = new Logger('test', {}, {}, (...args) => {
      console.log(args);
    });
    
    logger.log({ $$: 'launch' });
    
    class TestInfra extends Flower {
      
      public static getAwsServices() { return [ 'lambda', 'apigateway', 'iam' ] as Soil.LocalStackAwsService[]; }
      
      public async getPetals(ctx: Context) {
        
        const code = String[baseline](`
          | module.exports.handler = async (e, ctx, cb) => {
          |   return {
          |     statusCode: 200,
          |     headers: { 'content-type': 'application/javascript' },
          |     body: JSON.stringify({ msg: 'test response' })
          |   };
          | };
        `);
        const jsZip = new JsZip();
        jsZip.file(`lambda/code.js`, code, { date: new Date(0) });
        const zip = await jsZip.generateAsync({ type: 'nodebuffer', compression: 'deflate'[upper]() });
        const lambdaBundle = new PetalTerraform.File('literal/testLambda.js.zip', zip);
        const lambdaRole = new PetalTerraform.Resource('awsIamRole', 'testLambdaRole', {
          name: `${ctx.pfx}-test-lambda-role`,
          assumeRolePolicy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' }
            }]
          })
        });
        const lambda = new PetalTerraform.Resource('awsLambdaFunction', 'testLambda', {
          functionName: `${ctx.pfx}-test-lambda`,
          role: lambdaRole.ref('arn'),
          runtime: 'nodejs22.x',
          handler: 'lambda/code.handler',
          filename: lambdaBundle.refStr(),
          sourceCodeHash: await hash(code)
        });
        
        const api = new PetalTerraform.Resource('awsApiGatewayRestApi', 'testApi', {
          name: `${ctx.pfx}-test-api`
        });
        const apiResource = new PetalTerraform.Resource('awsApiGatewayResource', 'testResource', {
          restApiId: api.ref('id'),
          parentId: api.ref('rootResourceId'),
          pathPart: 'test'
        });
        const apiMethod = new PetalTerraform.Resource('awsApiGatewayMethod', 'testMethod', {
          restApiId: api.ref('id'),
          resourceId: apiResource.ref('id'),
          httpMethod: 'GET',
          authorization: 'NONE'
        });
        const apiIntegration = new PetalTerraform.Resource('awsApiGatewayIntegration', 'testIntegration', {
          restApiId: api.ref('id'),
          resourceId: apiResource.ref('id'),
          httpMethod: apiMethod.ref('httpMethod'),
          integrationHttpMethod: 'POST',
          type: phrasing('awsProxy', 'camel', 'snake')[upper](),
          uri: lambda.ref('invokeArn')
        });
        const lambdaPermission = new PetalTerraform.Resource('awsLambdaPermission', 'testApiPermission', {
          statementId: 'AllowAPIGatewayInvoke',
          action: 'lambda:InvokeFunction',
          functionName: lambda.ref('functionName'),
          principal: 'apigateway.amazonaws.com',
          sourceArn: `\${${api.refStr('executionArn')}}/*/*`
        });
        const apiDeployment = new PetalTerraform.Resource('awsApiGatewayDeployment', 'testDeployment', {
          restApiId: api.ref('id'),
          dependsOn: [ apiIntegration.ref() ],
          $lifecycle: { createBeforeDestroy: true }
        });
        const apiStage = new PetalTerraform.Resource('awsApiGatewayStage', 'testStage', {
          restApiId: api.ref('id'),
          deploymentId: apiDeployment.ref('id'),
          stageName: 'test'
        });
        
        return [ lambdaBundle, lambdaRole, lambda, api, apiResource, apiMethod, apiIntegration, lambdaPermission, apiDeployment, apiStage ];
        
      }
      
    };
    class TestInfraFake extends TestInfra {};
    
    const registry = new Registry({
      MyLilac: { real: TestInfra, test: TestInfraFake }
    });
    
    const patioFact = fact.kid([ 'repo', 'patio' ]);
    const gardenFact = fact.kid([ 'repo', 'terraform' ]);
    const context: Context = {
      name: 'hi',
      fact: gardenFact,
      patioFact,
      logger: logger.kid('garden'),
      maturity: 'm0',
      debug: false,
      pfx: 'tezzzt',
    };
    
    const garden = new Garden({
      context,
      registry,
      define: (ctx, registry) => [ new registry.MyLilac() ]
    });
    
    const soil = new Soil.LocalStack({ aws: { region: 'ca-central-1' }, registry });
    const localStack = await soil.run({ logger });
    
    try {
      
      await garden.grow({ type: 'real', soil });
      
      const client = new APIGatewayClient({
        region: localStack.aws.region,
        endpoint: localStack.url
      });
      
      const { items: apis = [] } = await client.send(new GetRestApisCommand({}));
      
      console.log({ apis });
      
      const testApi = apis.find(item => item.name === 'tezzzt-test-api');
      if (!testApi?.id) throw Error('test api missing')[mod]({ apis });
      
      const testEndpoint = {
        $req: null as any,
        $res: null as any as { code: number, body: { msg: string } },
        netProc: { proto: 'http' as const, addr: 'localhost', port: 4566 },
        path: [ 'restapis', testApi.id, 'test', '_user_request_', 'test' ],
        method: 'get' as const
      };
      const res = await http(testEndpoint, {} as any);
      assertEqual(res, {
        reqArgs: cmpAny,
        code: 200,
        body: { msg: 'test response' }
      });
      
    } finally {
      
      logger.log({ $$: 'finish' });
      await soil.end();
      
    }
    
  })}
  
]);