import { Logger }              from '../../../boot/util/logger';
import niceRegex               from '../../../boot/util/niceRegex';
import resolve1pImport         from '../../../boot/util/resolve1pImport';
import hash                    from '../../util/hash';
import slashEscape             from '../../../boot/util/slashEscape';
import { TfEntity, TfFile, TfResource }  from '../provider/awsTf';
import { Lilac, LilacContext } from '../lilac';
import { Role }                from './role';
import JsZip                   from 'jszip';
import { aws, tf }                  from '../util';
import { HttpReq, HttpRes }    from '../../../boot/util/http';
import webpack                 from '../../util/webpack';
import { Vpc } from './vpc';
import capitalize from '../../../boot/util/capitalize';
import { Service } from '../registry/registry';

export type AwsLambdaContext = {
  callbackWaitsForEmptyEventLoop: boolean,
  clientContext: null,
  invokedFunctionArn: string,
  awsRequestId: string,
  getRemainingTimeInMillis: () => number
};
export type Check = (v: any) => v is any;
export type CombinedChecks<Checks extends Check[]> = Checks extends ((v: any) => v is infer T)[] ? Combine<T> : never;
export type LambdaShape = {
  
  // Determines the input/output schemas for aws and the consumer
  
  awsRawReq: unknown, // 1. aws raw request incoming
  req:       unknown, // 2. aws request parsed into succinct request
  res:       unknown, // 3. logic produces succinct response
  awsRawRes: unknown  // 4. succint response converted to aws response
  
};
export type BeginContext<Data extends Jsfn> = {
  debug:   boolean,
  logger:  Logger,
  require: any,
  data:    JsfnDecoded<Data>
};
export type EventContext<Supplies, S extends LambdaShape, Checks extends Check[]> = {
  awsRawCtx: AwsLambdaContext,
  awsRawReq: S['awsRawReq'],
  
  require:   (fp: string) => any,
  debug:     boolean,
  logger:    Logger,
  supplies:  Supplies,
  args:      S['req'] & CombinedChecks<Checks>
};

export type ExecutionWrapperContext<Supplies, Checks extends Check[], S extends LambdaShape> = {
  require: any,
  debug: boolean,
  lambdaLogger: Logger,
  supplies: Supplies,
  checks: Check[],
  event: (req: EventContext<Supplies, S, Checks>) => MaybePromise<S['res']>
};

export class Lambda<S extends LambdaShape, Data extends Jsfn, Supplies, Checks extends Check[], Res extends S['res']> extends Lilac {
  
  // TODO: Custom cloudwatch log groups with reasonable retention!! (Delete old groups!)
  
  // Note every Lambda has a 1-to-1 correspondance with a Role! This means the Role is handled
  // entirely here in the Lambda code - it isn't exposed as a separate dependancy Resource! Instead
  // the Role is simply initialized by the the Lambda, and then has `getTerraform` called on it,
  // which is embedded into the Lambda's `getTerraform` result!
  
  static typescriptHoister = (v: null | string, p: string) => v ? `import ${v} from '${p}';` : `import '${p}';`;
  static javascriptHoister = (v: null | string, p: string) => {
    if (!v) return `require('${p}');`;
    
    // Referencing the default import requires the "default" property to be dereferenced; this is
    // detected by checking if the 1st character of `v` is a letter, whereas non-default imports
    // use object notation (beginning with "{")
    return /^[a-zA-Z]/.test(v)
      ? `const ${v} = require('${p}')['default'];`
      : `const ${v} = require('${p}');`
  };
  
  static awsNodeRuntime = 'nodejs22.x'; // TODO: higher versions may require the terraform provider to be updated??
  
  protected name: string;
  protected data: Promise<Data>;
  protected vpc: null | Vpc;
  public code: {
    checks: Checks,
    // Consider renaming "begin" + "event" to "launch" + "invoke"
    begin: (ctx: BeginContext<Data>) => Supplies,
    event: (ctx: EventContext<Supplies, S, Checks>) => MaybePromise<Res> 
  };
  protected role: Role;
  public envVars: any;
  private memoryMb: number;
  
  constructor(args: {
    name: string,
    vpc?: null | Vpc,
    memoryMb?: number,  // must be an integer in [128, 10240]
    data: (lbd: Lambda<any, any, any, any, any>) => Data,
    
    // TODO: Checks should be able to:
    // 1. Perform sanitization
    // 2. Be referenced from supplies (e.g. consider the case where many different lambdas want to
    //    work with sanitized email addresses - the check should be able to sanitize the email
    //    address, and the check should be writable in such a way that it can simply be dropped
    //    into the Checks of each lambda which operates with emails) - e.g.:
    //    ```
    //    type Email = `${string}@${string}.${string}`;
    //    const lbd = new LambdaHttp({
    //      name: 'whatever',
    //      data: { sanitizeEmail },
    //      checks: ctx => [
    //        (q: any): q is { query: { account: { ['!email']: Email } } } => q[merge]({
    //          query: { account: { '!email': ctx.supplies.sanitizeEmail(q.query.account['!email']) } }
    //        })
    //      ]
    //    });
    //    ```
    //    Ok admittedly this is a little awkward since Checks originally simply returned true/false
    //    and they now need to be able to return a sanitized value...
    checks: Checks,
    begin: SovereignFn<(ctx: BeginContext<Data>) => Supplies>,
    event: SovereignFn<(ctx: EventContext<Supplies, S, Checks>) => MaybePromise<Res>>
  }) {
    if (!/^[a-zA-Z0-9]+$/.test(args.name)) throw Error('invalid name')[mod]({ args });
    
    super();
    this.name = args.name;
    
    this.vpc = args.vpc ?? null;
    
    const memoryMb = args.memoryMb ?? 2048;
    if (memoryMb < 128 || memoryMb > 10240 || Math.floor(memoryMb) != memoryMb) throw Error('memory mb invalid')[mod]({ memoryMb });
    this.memoryMb = memoryMb;
    
    // Delayed execution allows multiple lambdas defined linearly/synchronously to reference each
    // other and not hit errors for unresolved values
    // TODO: delaying the call to `args.data` by a single tick means referenced lambdas must be
    // defined within a single tick; this reduces the implementor's flexibility
    this.data = Promise.resolve().then(() => args.data(this));
    this.code = args[slice]([ 'checks', 'begin', 'event' ]);
    this.role = new Role({
      name: args.name,
      assumePolicies: [
        { effect: 'Allow', action: 'sts:AssumeRole', principal: { service: 'lambda.amazonaws.com' } }
      ],
      enactPolicies: [
        {
          // Grant logging permissions
          effect: 'Allow',
          action: [ 'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents' ],
          // arn:partition:service:region:accountId:resource
          resource: [ `arn:aws:logs:*:*:*` ]
        },
      ]
    });
    this.envVars = {};
    
  }
  
  public * getDependencies(ctx: LilacContext) {
    yield* super.getDependencies(ctx);
    yield* this.role.getDependencies(ctx);
    if (this.vpc) yield* this.vpc.getDependencies(ctx);
  }
  
  public getName() { return this.name; }
  public getRole() { return this.role; }
  
  protected getExecutionWrapper(): (ctx: ExecutionWrapperContext<Supplies, Checks, S>, awsRawReq: S['awsRawReq'], awsRawCtx: AwsLambdaContext) => Promise<S['awsRawRes']> {
    throw Error('not implemented');
  }
  
  public async getSourceCode(logger: Logger, ctx: LilacContext, args: { relFp: `<repo>/${string}`, lang?: 'ts' | 'js' }) {
    
    // Note `args.relFp` indicates where in the repo we are simulating the path of the lambda
    // source code; necessary for resolving references to other modules!
    
    // Converts this lambda's code (from multiple sources - begin, events, checks...) to a String
    // representing the entire aggregated lambda function definition, including resolved imports
    // already embedded inline - can be used as sourcecode for webpack!
    
    // Note the only use of typescript in the resulting lambda code at the moment is related to
    // imports (we get huge value leveraging typescript for imports because webpack's tree shaking
    // plus typescript `import` results in very minimal bundles!)
    // Compiling for js vs ts is very simple; the logic to generate an import is the only thing
    // that varies depending on the language!
    
    const { relFp, lang = 'ts' } = args;
    const langHoist = {
      ts: Lambda.typescriptHoister,
      js: Lambda.javascriptHoister
    }[lang];
    
    // Captures lines like:
    // const util = ctx.require('<repo>/src/boot/util');
    // const util = ctx.require('<repo>/src/boot/util') as typeof import('../src/boot/util');
    // const { util1, util2 } = ctx.require('<repo>/src/boot/util') as typeof import('../src/boot/util');
    // const { util1, util2 } = t.require('<repo>/src/boot/util') as typeof import('../src/boot/util');
    // TODO: To future person reading this... why no support for double-quotes??
    const importReg = niceRegex(String.baseline(`
      | ^[ ]*                                                                          (?:         )?
      |      const[ ]       [=][ ]*                    [.]require[(]['#]        ['#][)]   [ ]+as[ ]  
      |              ([^=]+)       [a-zA-Z][a-zA-Z0-9]*                 ([^'#]+)                     
    `).replaceAll('#', '`'));
    
    const resolveImport = (importPath: string) => {
      // Check if this is a first-party import (as opposed to 3rd-party, in node_modules)
      return importPath[hasHead]('<repo>/')
        ? resolve1pImport(relFp, importPath as `<repo>/${string}`)
        : importPath;
    };
    const getCodeAndHoists = (fn: Fn) => {
      
      const lines: string[] = [];
      const hoists: string[] = [];
      
      for (const ln of fn.toString().split('\n')) {
        
        const imp = ln.match(importReg);
        if (imp) {
          const [ _full, varDef, importPath ] = imp;
          hoists.push( langHoist(varDef.trim(), resolveImport(importPath)) );
        } else {
          lines.push(ln);
        }
        
      }
      
      // Note that Function.prototype.toString() produces a multiline result where the first line
      // never has any indent, and all further lines are often quite deeply indented (depending on
      // nesting in the source code) - we try to reindent these lines properly.
      const leastIndent = Math.min(...lines.slice(1)[map](ln => ln.match(/^[ ]*/)![0].length));
      const code = lines.length > 1
        ? [ lines[0], ...lines.slice(1)[map](ln => ln.slice(leastIndent)) ].join('\n')
        : lines[0];
      
      return { hoists, code };
      
    };
    
    const commFnHoists: { hoists: string[], code: string }[] = []; // We use `jsfn.encode` middleware to additionally parse any `ctx.require` calls appearing in live functions
    const encodedData = jsfn.encode(await this.data, { encodeFn: fn => {
      
      // How does minifying the dev/compile/debug-time javascript play with webpack and typescript?
      // 1. Lambda is defined with live references to functions/non-traditionally-serializable data
      // 2. Lambda produces its "source code"; one-stop shop for script to run in aws lambda
      //    a. Lambda uses jsfn.encode to handle live function refs
      //    b. The encoded jsfn (from `this.data`) is dropped *directly*, without wrapping in
      //       quotes, into the lambda script - no decode call is necessary, as the encoded jsfn
      //       is a string representing valid typescript (not json)!
      //    c. Lambda's jsfn may need live references to other modules - the jsfn encoding process
      //       extracts such hoists, and they are inserted into the head of the lambda's script
      //    d. Lambda's typescript logic may also reference modules using `ctx.require` - this is
      //       beyond native jsfn, and implemented by passing THIS `encodeFn` middleware, which
      //       parses all functions encountered during jsfn encoding
      //    e. Note that jsfn live-function-references, and hoists, can all be uglified/compressed
      //       as it is all literal typescript, and the hoists resolve to `import` statements!
      // 3. Lambda also has its actual domain-specific pieces of logic (`this.code.begin/event`);
      //    these are sovereign so they're simply stringified and concatenated into the aws script
      //    (note - *all* function-stringification-pre-webpack-minification is handled with
      //    `getCodeAndHoists`, so hoists (`ctx.require`) are captured separately, parsed out of
      //    the function-string-representation, and re-written as actual typescript imports, to be
      //    consolidated by webpack)
      // 4. An overall "script" results
      // 5. This script is literally written into the repo temporarily, webpacked, and the actual
      //    webpacked payload is captured (the script written to the repo is .ts - these are
      //    preserved in config/iac/*/proj/*.ts, whereas resulting webpacked scripts are js; these
      //    are also preserved in config/iac/*/proj/*.js!)
      
      // Minifying dev/compile/debug source code means:
      // 1. Any live function references passed as lambda data will be minified functions
      // 2. The actual lambda-specific logic pieces, handled by `getCodeAndHoists`, will be
      //    minified - this means it could be harder to parse for `ctx.require`... see
      //    `importReg` earlier in this file!
      
      const commCodeAndHoists = getCodeAndHoists(fn);
      commFnHoists.push(commCodeAndHoists);
      return commCodeAndHoists.code;
      
    }});
    
    // Validate the vpc won't block access to any hoists!
    if (this.vpc) {
      
      const { hoists } = encodedData;
      
      // Consider: This is a "blacklist" approach - should really do a "whitelist" approach i.e.
      // every vpc boolean has a "permitsHoist" function, and every hoist needs to be permitted by
      // at least 1 vpc boolean
      const vpcConfig = this.vpc.getConfig();
      const vpcInterferences = {
        storage: { bool: vpcConfig.storage, check: () => hoists.filter(h => /::LambdaStorage/.test(h)) },
        docDb:   { bool: vpcConfig.docDb,   check: () => hoists.filter(h => /::LambdaDocDb/  .test(h)) },
        email:   { bool: vpcConfig.email,   check: () => hoists.filter(h => /::LambdaEmail/  .test(h)) },
        queue:   { bool: vpcConfig.queue,   check: () => hoists.filter(h => /::LambdaQueue/  .test(h)) },
        w3:      { bool: vpcConfig.w3,      check: () => [ /* Impossible to verify for now... */ ]     },
      } satisfies { [K in Service]: any };
      
      for (const { bool, check } of vpcInterferences[toArr](v => v)) {
        
        if (bool) continue;
        
        const blockedHoists = check();
        if (blockedHoists.length) throw Error('vpc hoist interference')[mod]({ lambda: this.name, hoistsBlockedByVpc: blockedHoists });
        
      }
      
    }
    
    const beginCodeAndHoists = getCodeAndHoists(this.code.begin);
    const eventCodeAndHoists = getCodeAndHoists(this.code.event);
    const commFormHoists = encodedData.hoists[map](hoist => {
      const [ importPath, clsName ] = hoist.split('::');
      return langHoist(`{ ${clsName} }`, resolveImport(importPath));
    });
    const executionWrapperCodeAndHoists = getCodeAndHoists(this.getExecutionWrapper());
    
    const hoists = new Set([
      
      // These hoists are needed to implement base lambda logic
      langHoist(null,         resolve1pImport(relFp, '<repo>/src/boot/clearing')),
      langHoist('{ Logger }', resolve1pImport(relFp, '<repo>/src/boot/util/logger')),
      
      // Include imports discovered dynamically
      ...beginCodeAndHoists.hoists,
      ...eventCodeAndHoists.hoists,
      ...commFnHoists[map](cfh => cfh.hoists).flat(1),
      ...commFormHoists,
      ...executionWrapperCodeAndHoists.hoists,
      
    ]);
    
    return [
      // Import all hoists...
      ...hoists,
      
      // Sooooo *all* hoisted references are provided to *every* jsfn eval - will crash if multiple
      // hoists use the same reference name but from different imports. And there's no hoist
      // merging: `import { a, b } from 'z'; import { a, c } from 'z';` will fail due to `a` being
      // redefined. Need more structure around the import, something like:
      //    | 
      //    | type Import = never
      ///   |   | { type: 'trivial' }                                         // require('thingy');                     import 'thingy';
      ///   |   | { type: 'default' }                                         // const thing = require('thingy');       import z from 'thingy';
      //    |   | { type: 'select', props: { name: string, alias?: string } } // const { a, b: c } = require('thingy'); import { a, b as c } from 'thingy';
      //    |
      // and full logic to actually handle merging hoists. Also, hoisting should probably be native
      // jsfn functionality.
      
      // Data
      `const data = ${encodedData.str};`,
      
      // Init execution-context-wide logger...
      `const debug = ${ctx.debug ? 'true' : 'false'};`,
      `const lambdaLogger = new Logger('lambda');`,
      `lambdaLogger.log({ $$: 'launch', name: '${slashEscape(this.name, `'`)}' });`,
      
      // Logic functions
      `const begin = ${beginCodeAndHoists.code};`,
      `const checks = [${this.code.checks[map](c => c.toString()).join(', ')}];`,
      `const event = ${eventCodeAndHoists.code};`,
      
      // Init supplies...
      `const supplies = lambdaLogger.scope('supplies', {}, logger => begin({ debug, require, logger, data }));`,
      
      // Note there is no "require" property - all code included here using "ctx.require"-type
      // functionality will have already been compiled to use hoists (`import`) instead!
      `const ctx = {  `,
      `  debug,       `,
      `  lambdaLogger,`,
      `  supplies,    `,
      `  checks,      `,
      `  event        `,
      `};             `,
      `const logic = (${executionWrapperCodeAndHoists.code}).bind(null, ctx);`,
      
      // Finally, export based on language
      {
        ts: 'export const handler = '   + `logic;`,
        js: 'module.exports.handler = ' + `logic;`
      }[lang]
      
    ][map](ln => ln.trimEnd() ?? skip).join('\n');
    
  }
  protected async getPackedCode(logger: Logger, ctx: LilacContext) {
    
    const uniqueTerm = `lambda.${this.name}` as const;
    const relFp = `<repo>/src/webpack.${uniqueTerm}` as const;
    const sourceCode = await this.getSourceCode(logger, ctx, { relFp });
    
    const packedCode = await webpack({
      ctx: { ...ctx, logger },
      relFp,
      // memFp: '<repo>/config/mem', // Note it's impossible to reliably hash the sourcecode, due to its imports - we'd need to unravel them, which is why we need webpack in the 1st place!
      
      // Note `sourceCode` is *all* code the lambda executes, *except* the literal content of the
      // modules it imports. This hash differentiates *any* logical changes to the lambda including
      // checks, comms, begin, event. It's missing:
      // - Changes to 3rd parties, hoisted/imported by the lambda (add package.json to hash?)
      // - Changes in the lambda's relative dependencies (tricker - could read the literal file and
      //   include that in the hash? But that also misses 2nd-order dependencies...
      hash: uniqueTerm, // hash([ ctx.debug.toString(), this.name, sourceCode ], String.base32).slice(0, 10),
      sourceCode
    });
    
    // Consider a lambda-defining file which does some early logic involving capitalization; at
    // the top of this file will be the line `import capitalize from './utils/capitalize'`. If
    // the lambda script also performs capitalization, the implementation may accidentally
    // reference the `capitalize` function from the top-level of the file, but this will not be
    // included in the webpack bundle (only the lambda function body is considered during the
    // bundling process). Webpack will simply see a reference to "capitalize", but will have no
    // awareness of where it's defined. Webpack does something like consider this value an import
    // from a source external to the entire bundle; it will replace "capitalize" with a value
    // looking like "capitalize_1.default". This indicates a serious problem in the lambda's code;
    // fortunately the resulting value is unique enough that we can simply perform a regex check
    // for it in order to alert during the build process. This process is brittle!!
    const externalDepMatch = packedCode.toString('utf8').match(/([a-zA-Z0-9]+)_[0-9]+[.]default/);
    if (externalDepMatch)
      logger.log({ $$: 'notice', msg: 'dependency possibly broken', lambda: this.name, dependency: externalDepMatch[1].split('_')[0] });
    
    return { sourceCode, packedCode };
    
  }
  private async getZippedCode(logger: Logger, ctx: LilacContext, resolvedName: string) {
    
    const { sourceCode, packedCode } = await this.getPackedCode(logger, ctx);
    if (!packedCode) throw Error('packing code failed')[mod]({ packedCode });
    
    const jsZip = new JsZip();
    jsZip.file(`${resolvedName}/code.js`, packedCode as Uint8Array, { date: new Date(0) });
    const zip = await ctx.throttlers.zipFile.do(() => jsZip.generateAsync({ type: 'nodebuffer', compression: 'deflate'[upper]() }));
    
    // Note within the lambda's context there are 3 different options for the hash:
    // 1. Original typescript source code
    // 2. Compiled javascript code (webpacked, includes dependencies and sourceMapping)
    // 3. Overall zip file containing javascript code somewhere within it
    // The correct choice is the 3rd - for #1, changes to dependency code won't register as
    // changes (lambda will not be updated). For #2, changes to zip structure won't register,
    // e.g. adding a new file will not be captured. The only correct choice is #3!
    // Consider that `JsZip` produces buffers representing zipped files with nondeterministic
    // contents(!) causing hashes to change as code remains the same - using option #2 for now;
    // at present this is safe as the zip file contains nothing other than the single js file!
    
    return { sourceCode, packedCode, zip, hash: hash(packedCode) };
    
  }
  
  async getTfEntities0(ctx: LilacContext) {
    
    const resolvedName = `${ctx.pfx}-${this.name}`;
    
    const { zip, sourceCode, packedCode, hash } = await ctx.throttlers.webpack.do(() => {
      
      return ctx.logger.scope('lambda.zip', { name: this.name }, async logger => {
        const { zip, sourceCode, packedCode, hash } = await this.getZippedCode(logger, ctx, resolvedName);
        logger.log({ $$: 'result', lambda: this.name, size: `${(zip.length / 1000).toFixed(2)}kb` });
        return { zip, sourceCode, packedCode, hash };
      });
      
    });
    
    const zipFile = new TfFile(`literal/lambda/${this.name}.js.zip`, zip);
    const sourceCodeFile = new TfFile(`literal/lambda/${this.name}.ts`, sourceCode); // Consider removing; it's only for debug purposes
    const packedCodeFile = new TfFile(`literal/lambda/${this.name}.js`, packedCode); // Consider removing; it's only for debug purposes
    
    const roleTfEnts = await this.role.getTfEntities(ctx);
    const roleTfEnt = roleTfEnts.find(v => v.getType() === 'awsIamRole')!;
    const lambda = new TfResource('awsLambdaFunction', this.name, {
      
      functionName: resolvedName,
      runtime:      Lambda.awsNodeRuntime,
      role:         roleTfEnt.tfRefp('arn'),
      handler:      `${resolvedName}/code.handler`,
      filename:     zipFile.tfRef(), // Should be a string in terraform
      timeout:      20,              // In seconds
      memorySize:   this.memoryMb,
      
      ...(this.vpc && await (async () => {
        
        const vpcEnts = await this.vpc!.getTfEntities(ctx);
        const subnets = vpcEnts.filter(v => v.getType() === 'awsSubnet');
        const securityGroup = vpcEnts.find(v => v.getType() === 'awsSecurityGroup')!;
        
        return {
          $vpcConfig: {
            subnetIds: subnets.map(sn => sn.tfRefp('id')),
            securityGroupIds: [ securityGroup.tfRefp('id') ]
          }
        };
        
      })()),
      
      sourceCodeHash: hash,
      
      $loggingConfig: {
        logFormat: 'json'[upper]()
      },
      
      $environment: {
        variables: this.envVars ?? {}
      }
      
    });
    
    // Need to extend lambda iam permissions for vpc setup
    const policyTfEnts = (() => {
      
      const policyTfEnts: TfEntity[] = []
      
      if (this.vpc) {
        
        const policy = new TfResource('awsIamPolicy', `${this.name}VpcPolicy`, {
          name: `${ctx.pfx}-${this.name}Vpc`,
          policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
            effect: capitalize('allow'),
            action: [
              'ec2:CreateNetworkInterface',
              'ec2:DescribeNetworkInterfaces',
              'ec2:DeleteNetworkInterface'
            ],
            resource: '*'
          }]}))
        });
        
        const attachment = new TfResource('awsIamRolePolicyAttachment', `${this.name}VpcPolicy`, {
          role:      roleTfEnt.tfRefp('name'),
          policyArn: policy.tfRefp('arn')
        });
        
        policyTfEnts.push(policy, attachment);
        
      }
      
      return policyTfEnts;
      
    })();
    
    // Note there is no infrastructural link between a lamda and its log group - we can customize a
    // lambda's log group by simply defining a log group with the correct name the lambda will try
    // to log to!
    const logGroup = new TfResource('awsCloudwatchLogGroup', this.name, {
      name:            `/aws/lambda/${tf.embed(lambda.tfRef('functionName'))}`,
      retentionInDays: 14
    });
    
    // Consider removing `codeFile` in production? (Only needed for debugging?)
    // Consider removing `...roleTfEnts` - already covered by `this.getDependencies` I think!
    return [ zipFile, sourceCodeFile, packedCodeFile, lambda, logGroup, ...roleTfEnts, ...policyTfEnts ];
    
  }
  
};

export type HttpShape = {
  awsRawReq: {
    path: string,
    httpMethod: string,
    
    // Consider: no headers currently; they're all filtered out by cloudfront!
    headers: Obj,
    multiValueHeaders: Obj,
    
    queryStringParameters: any,
    multiValueQueryStringParameters: Obj<string[]>,
    requestContext: {
      
      // The properties always show up:
      identity: { sourceIp: `${number}.${number}.${number}.${number}` }, // Consider: typing is probably wrong for ipv6
      stage: string,
      domainName: string,
      
      // These show up for http connections:
      resourceId?: `${'GET' | 'POST' | 'PUT'} /${string}`,
      
      // These show up for socket connections:
      routeKey?:     '$connect' | '$disconnect' | string,
      eventType?:    'CONNECT' | 'DISCONNECT' | string, // Consider: I've only actually seen CONNECT so far...
      connectedAt?:  number,
      connectionId?: string,
      
      stageVariables: Obj<string>
      
    },
    body: any, // Consider testing how this value looks? And is it coupled with "isBase64Encoded"??
    isBase64Encoded: boolean,
  },
  req: HttpReq,
  res: Omit<HttpRes, 'body'> & ({ body: Json, base64?: false } | { body: string, base64: true }),
  awsRawRes: {
    statusCode: number,
    headers: { [K: string]: string | string[] },
    isBase64Encoded?: boolean
    body: Json,
  }
};
export class LambdaHttp<Data extends Jsfn, Supplies, Checks extends Check[], Res extends HttpShape['res']> extends Lambda<HttpShape, Data, Supplies, Checks, Res> {
  
  getExecutionWrapper() {
    
    return async (ctx: ExecutionWrapperContext<Supplies, Checks, HttpShape>, awsRawReq: HttpShape['awsRawReq'], awsRawCtx: AwsLambdaContext) => {
      
      const ms = Date.now();
      const logger = ctx.lambdaLogger.kid('invoke');
      const { require, debug, checks, supplies, event } = ctx;
      
      const { code, headers = {}, body, base64 = false } = await (async (): Promise<HttpShape['res']> => {
        
        const headers: Obj<string[]> = (awsRawReq.multiValueHeaders ?? {})[mapk]((v, k) => [ k[lower](), v ]);
        
        const reqBody = (() => {
          if (!awsRawReq.body) return null;
          try { return JSON.parse(awsRawReq.body); } catch(err) {}
          return awsRawReq.body;
        })();
        
        const args = {
          path: awsRawReq.path?.split('/').filter(v => !!v.trim()) ?? '/',          // If `awsRawReq.path` doesn't exist, this is a websocket event
          method: (awsRawReq.httpMethod?.[lower]() ?? 'sokt') as HttpReq['method'], // If `awsRawReq.httpMethod` doesn't exist, this is a websocket event
          headers,
          
          // Note we do not accept multi-value query strings; we ignore any duplicated name beyond
          // the first. To provide an array in a query use e.g. `val.0=a&val.1=b&val.2=c`
          query: ((awsRawReq.multiValueQueryStringParameters ?? {}) as Obj<string[]>)
            [map  ](v => v[0])
            [built](),
          
          cookies: (headers.cookie ?? [])
            [map](cookies => cookies.split(/[;][ ]*/))
            .flat(1)
            [toObj](c => c[cut]('=', 1)[map](v => v.trim()) as [ string, string ])
            [built](),
          
          body: reqBody
        };
        const dbgArgs = args[slash]([ 'headers' ]);
        
        try {
          
          logger.log({ $$: 'launch', debug, args: dbgArgs });
          
          for (const check of checks)
            if (!check(args))
              throw Error('check failed')[mod]({ http: { body: { args: dbgArgs, check: `false === (${check.toString().replace(/[\s]+/, ' ')})(args)` } } });
          
          const res = await event({ debug, require, awsRawCtx, awsRawReq, logger, supplies, args: args as (typeof args & CombinedChecks<Checks>) });
          logger.log({ $$: 'accept', ms: Date.now() - ms, res });
          return res;
          
        } catch(err: any) {
          
          if (err.http) {
            
            // The error representation appears in two places:
            // 1. In logs
            // 2. In the http response, if in "debug" mode
            // In both cases, it's accompanied with the full http response value - since the full
            // http response value is a superset of the error's "http" property, we don't have to
            // include the "http" value in either case!
            const { http = {}, ...errLimn } = err[limn]();
            const res = { code: 400, body: { code: 'reject', trace: logger.getTraceId('invoke') } }
              [merge](http as {})
              [merge](debug ? { body: { err: errLimn } } : {});
            
            // In debug mode, don't log res.body.err - it's already available in the log as "err"
            logger.log({ $$: 'reject', ms: Date.now() - ms, err: errLimn, res: debug ? {}[merge](res)[merge]({ body: { err: skip } }) : res });
            return res;
            
          } else {
            
            const res = { code: 500, body: { code: 'glitch', trace: logger.getTraceId('invoke') } }
              [merge](debug ? { body: { err: err[limn]() } } : {});
            logger.log({ $$: 'glitch', ms: Date.now() - ms, err, res });
            return res;
            
          }
          
        }
        
      })();
      
      const isStringBody = isForm(body, String);
      const hdrs = { contentType: isStringBody ? 'text/plain' : 'application/json', ...headers };
      return {
        statusCode: code,
        headers: hdrs[mapk]((v, k) => [ k.replace(/([A-Z])/g, '-$1')[lower](), v ]), // Kebab-case!
        body: isStringBody ? body : JSON.stringify(body), // TODO: Allow response body to be `skip` (to provide websockets with a way to send *no* response as opposed to `null` response)
        isBase64Encoded: base64
      };
      
    };
    
  }
  
};

export type QueueShape<E extends Json> = {
  awsRawReq: {    // How does lambda natively receive the event?
    Records: {
      body: string // Stringified json
    }[]
  },
  req: E,         // What's our optimal interface for the event?
  res: void,      // Handler just needs to finish successfully
  awsRawRes: void // How does lambda natively respond to the event?
};
export class LambdaQueue<Data extends Jsfn, Supplies, Checks extends Check[], Res extends QueueShape<Json>['res']> extends Lambda<QueueShape<Json>, Data, Supplies, Checks, Res> {
  
  getExecutionWrapper() {
    
    return async (ctx: ExecutionWrapperContext<Supplies, Checks, QueueShape<Json>>, awsRawReq: QueueShape<Json>['awsRawReq'], awsRawCtx: AwsLambdaContext): Promise<void> => {
      
      const ms = Date.now();
      const logger = ctx.lambdaLogger.kid('invoke');
      const { require, debug, checks, supplies, event } = ctx;
      
      const errs = await (async () => {
        
        const errs: { obj: any, err: any }[] = [];
        
        logger.log({ $$: 'launch', debug, objectNum: awsRawReq.Records.length });
        
        // TODO: Parallelize??
        for (const [ n, argsEncoded ] of awsRawReq.Records.entries()) {
          
          const objLogger = logger.kid(n.toString(10));
          objLogger.log({ $$: 'launch' });
          
          let args: any = argsEncoded;
          
          try {
            
            args = JSON.parse(args.body);
            
            for (const check of checks)
              if (!check(args))
                throw Error('check failed')[mod]({ http: { body: { args, check: `false === (${check.toString().replace(/[\s]+/, ' ')})(args)` } } });
            
            await event({ debug, require, awsRawCtx, awsRawReq, logger, supplies, args });
            objLogger.log({ $$: 'accept', ms: Date.now() - ms });
            
          } catch(err: any) {
            
            objLogger.log({ $$: 'glitch', ms: Date.now() - ms, args, err });
            errs.push({ obj: args, err });
            
          }
          
        }
        
        return errs;
        
      })();
      
      if (errs.length) throw Error('some objects failed')[mod]({ numFailed: errs.length });
      
    };
    
  }
  
};