import { assertEqual } from '../build/utils.test.ts';
import './main.ts';
import { Context, Garden, Lilac, Registry, TfEntity, TfResource } from './main.ts';
import { rootEnt } from '@gershy/disk';
import path from 'node:path';
import Logger from './util/logger.ts';


// Type testing
(async () => {
  
  type Enforce<Provided, Expected extends Provided> = { provided: Provided, expected: Expected };
  
  type Tests = {
    1: Enforce<{ x: 'y' }, { x: 'y' }>,
  };
  
})();

(async () => {
  
  const cases = [
    
    {
      name: 'basic terraform gen',
      fn: async () => {
        
        const tf = new TfResource('awsWafv2WebAcl', 'happyWaf', {
          
          name: `aaa-coolFirewall`,
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
        
        const r = await tf.getResult();
        console.log(r);
        assertEqual(r, String[baseline](`
          | resource "aws_wafv2_web_acl" "happy_waf" {
          |   name = "aaa-coolFirewall"
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
        
      }
    },
    {
      name: 'garden growth',
      fn: async () => {
        
        class MyLilac extends Lilac {
          
          public async * getTfEntities(ctx: Context) {
            
            const x = new TfResource('testType0', 'testHandle', {
              abc: 123,
              def: 456
            });
            yield x;
            
            yield new TfResource('testType1', 'testHandle', {
              testProp0: 111,
              testProp1: 'aaa',
              testProp2: {
                testProp3: 'x',
                testProp4: 'y'
              },
              $testProp5$0: {
                testProp6: 'yolo',
                testProp7: 'haha'
              },
              $testProp5$1: {
                testProp8: x.tfRefp('abc'),
                testProp9: x.tfRefp('def')
              }
            });
            
          }
          
        };
        class MyLilacTest extends MyLilac {};

        const registry = new Registry({
          MyLilac: { real: MyLilac, test: MyLilacTest }
        });
        
        const gardenFp = rootEnt.kid(path.join(import.meta.dirname, '..', 'config'));
        const garden = new Garden({
          
          name: 'hi',
          
          logger: new Logger('gardenTest'),
          fp: gardenFp,
          aws: {
            accountId: 'lol',
            accessKey: { id: 'lol', '!secret': 'lol' },
            region: 'us-east-1'
          },
          registry,
          
          maturity: 'm0',
          debug: false,
          pfx: 'aaa',
          
          define: function*(ctx, { MyLilac }) {
            
            yield new MyLilac();
            
          }
          
        });
        
      }
    }
    
  ];
  for (const { name, fn } of cases) {
    
    try {
      
      await fn();
      
    } catch (err: any) {
      
      console.log(`FAILED: "${name}"`, err[limn]());
      process.exit(1);
      
    }
    
  }
  
  console.log(`Passed ${cases.length} test${cases.length === 1 ? '' : 's'}`);
  
})();