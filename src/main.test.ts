import { assertEqual, cmpAny } from '../build/utils.test.ts';
import { Context, Garden, Flower, Registry, PetalTerraform } from './main.ts';
import { Fact, rootFact } from '@gershy/disk';
import Logger from './util/logger.ts';
import { getClsName } from '@gershy/clearing';
const { Resource } = PetalTerraform;

// Type testing
(async () => {
  
  type Enforce<Provided, Expected extends Provided> = { provided: Provided, expected: Expected };
  
  type Tests = {
    1: Enforce<{ x: 'y' }, { x: 'y' }>,
  };
  
})();

// Test cases
(async () => {
  
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
  
  const cases = [
    
    { name: 'basic terraform gen', fn: async () => {
      
      // TODO:
      // - This file should take optional argv aws creds
      // - Prevent automated isolated cleanup for this next part
      // - Actually fully apply terraform to aws account, plus `terraform destroy` for cleanup
      // - Can test various scenarios
      //   - Deleting populated dbs
      //   - Mapping dynamic-length lists (dns) to infrastructure (needs multiple `terraform apply` calls)
      // - Test various error scenarios; add specific text match conditions to `tryWithHealing`
      
      const tf = new Resource('awsWafv2WebAcl', 'happyWaf', {
        
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
      
    }},
    { name: 'garden growth', fn: () => isolated(async fact => {
      
      class MyLilac extends Flower {
        
        public async * getPetals(ctx: Context) {
          
          const x = new Resource('testType0', 'testHandle', {
            abc: 123,
            def: 456,
            cls: getClsName(this)
          });
          yield x;
          
          yield new Resource('testType1', 'testHandle', {
            testProp0: 111,
            testProp1: 'aaa',
            testProp2: {
              testProp3: 'x',
              testProp4: 'y'
            },
            '$testProp5.0': {
              testProp6: 'yolo',
              testProp7: 'haha'
            },
            '$testProp5.1': {
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
      
      const patioFact = fact.kid([ 'repo', 'patio' ]);
      const gardenFact = fact.kid([ 'repo', 'terraform' ]);
      const garden = new Garden({
        
        name: 'hi',
        fact: gardenFact,
        patioFact,
        
        logger: Logger.dummy,
        aws: {
          accountId: 'aws-acct-id',
          accessKey: { id: 'aws-key-id', '!secret': 'aws-key-secret' },
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
      await garden.grow('real');
      
      const gardenKids = await gardenFact.getKids();
      assertEqual(
        gardenKids,
        { boot: cmpAny, main: cmpAny }
      );
      
      // TODO: HEEERE test the patio creation - it won't have any data currently as `logicalApply`
      // isn't being used......... need something like a dummy terraform target
      // const expandFact = async (fact: Fact) => {
      //   
      //   const [ data, kids ] = await Promise.all([
      //     '<data?>',
      //     // fact.getData('str'),
      //     fact.getKids().then(kids => Promise[allObj](
      //       kids[map](kid => expandFact(kid))
      //     ))
      //   ]);
      //   
      //   return kids;
      //   
      // };
      // console.log(await expandFact(patioFact));
      
      const { boot: bootKids, main: mainKids } = await Promise[allObj](gardenKids[map](kid => kid.getKids()));
      assertEqual(
        { bootKids, mainKids },
        {
          bootKids: { '.terraform': cmpAny, '.terraform.lock.hcl': cmpAny, '.terraform.log': cmpAny, 'creds.ini': cmpAny, 'main.tf': cmpAny },
          mainKids: {                                                                                'creds.ini': cmpAny, 'main.tf': cmpAny }
        }
      );
      
      // Read the creds.ini and main.tf from both boot and main
      const tfData = await Promise[allObj]({ bootKids, mainKids }
        [map](kids => Promise[allObj](
          kids
            [slice]([ 'creds.ini', 'main.tf' ])
            [map](kid => kid.getData('str'))
        )
      ));
      assertEqual(
        tfData,
        { 
          bootKids: {
            'creds.ini': String[baseline](`
              | [default]
              | aws_region            = us-east-1
              | aws_access_key_id     = aws-key-id
              | aws_secret_access_key = aws-key-secret
            `),
            'main.tf': String[baseline](`
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
              |   bucket = "aaa-tf-state"
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
              |   name         = "aaa-tf-state"
              |   billing_mode = "PAY_PER_REQUEST"
              |   hash_key     = "LockID"
              |   attribute {
              |     name = "LockID"
              |     type = "S"
              |   }
              | }
            `)
          },
          mainKids: {
            'creds.ini': String[baseline](`
              | [default]
              | aws_region            = us-east-1
              | aws_access_key_id     = aws-key-id
              | aws_secret_access_key = aws-key-secret
            `),
            'main.tf': String[baseline](`
              | terraform {
              |   required_providers {
              |     aws = {
              |       source = "hashicorp/aws"
              |       version = "~> 5.0"
              |     }
              |   }
              |   backend s3 {
              |     region = "us-east-1"
              |     encrypt = true
              |     bucket = "aaa-tf-state"
              |     key = "tf"
              |     dynamodb_table = "aaa-tf-state"
              |     shared_credentials_files = [ "creds.ini" ]
              |     profile = "default"
              |   }
              | }
              | provider "aws" {
              |   shared_credentials_files = [ "creds.ini" ]
              |   profile = "default"
              |   region = "ca-central-1"
              |   alias = "ca_central_1"
              | }
              | provider "aws" {
              |   shared_credentials_files = [ "creds.ini" ]
              |   profile = "default"
              |   region = "us-east-1"
              | }
              | provider "aws" {
              |   shared_credentials_files = [ "creds.ini" ]
              |   profile = "default"
              |   region = "us-east-2"
              |   alias = "us_east_2"
              | }
              | provider "aws" {
              |   shared_credentials_files = [ "creds.ini" ]
              |   profile = "default"
              |   region = "us-west-1"
              |   alias = "us_west_1"
              | }
              | provider "aws" {
              |   shared_credentials_files = [ "creds.ini" ]
              |   profile = "default"
              |   region = "us-west-2"
              |   alias = "us_west_2"
              | }
              | resource "test_type0" "test_handle" {
              |   abc = 123
              |   def = 456
              |   cls = "MyLilac"
              | }
              | resource "test_type1" "test_handle" {
              |   test_prop0 = 111
              |   test_prop1 = "aaa"
              |   test_prop2 = {
              |     test_prop3 = "x"
              |     test_prop4 = "y"
              |   }
              |   test_prop5 {
              |     test_prop6 = "yolo"
              |     test_prop7 = "haha"
              |   }
              |   test_prop5 {
              |     test_prop8 = test_type0.test_handle.abc
              |     test_prop9 = test_type0.test_handle.def
              |   }
              | }
              | 
            `)
          }
        }
      );
      
    })}
    
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