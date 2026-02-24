import { IncomingMessage, Server, ServerResponse } from 'node:http';
import { LilacContext } from '../lilac';

import { repoRootFp } from '../../util/db';
import { HttpGateway as RealHttpGateway } from '../resource/httpGateway';
import { Domain as RealDomain } from '../resource/domain';
import { DocDb as RealDocDb } from '../resource/docDb';
import { HttpShape, LambdaQueue as RealLambdaQueue, Lambda as RealLambda, LambdaHttp as RealLambdaHttp } from '../resource/lambda';
import { Email as RealEmail } from '../resource/email';
import { Storage as RealStorage } from '../resource/storage';
import { LambdaDocDbKeeper } from '../comm/lambdaDocDb/keep.test';
import { LambdaStorageKeeper } from '../comm/lambdaStorage/keep.test';
import { LambdaEmailKeeper } from '../comm/lambdaEmail/base.test';
import { ApiGatewayManager } from '../comm/apiGatewayManager.test';
import resolve1pImport from '../../../boot/util/resolve1pImport';
import capitalize from '../../../boot/util/capitalize';
import { Config } from '../../project/config';
import { HtmlContainer as Hc, HtmlSingleton as Hs } from '../../../boot/util/html';
import { WebSocket } from 'ws';
import getUid from '../../../boot/util/getUid';
import snakeCase from '../../../boot/util/snakeCase';
import httpServer from '../../util/httpServer';
import { Queue as RealQueue } from '../resource/queue';
import { LambdaQueueKeeper } from '../comm/lambdaQueue/keep.test';
import { Vpc as RealVpc } from '../resource/vpc';
import { DocDbItem, DocDbKey } from '../comm/lambdaDocDb/base';
import { Role as RealRole } from '../resource/role';

const uriDecode = (v: string) => decodeURIComponent(v.replaceAll('+', ' ')).replaceAll('\r\n', '\n');

// This takes the place of the "mock" http event apigw uses to represent sokt events
type SoktHttpEvent = {
  wsEventType: string,
  context: { soktId: string },
  http: {
    pathAndQuery: string,
    headersDistinct: Obj<string[]>,
    body: any
  }
};
type SoktHttpResult = {
  code: number,
  headers: any,
  body: any
};

class Domain extends RealDomain {
  
  constructor(addr: any, port: any) { super(addr, port); }
  
};
class HttpGateway extends RealHttpGateway {
  
  // `getSokt` relies on the existence of a WebSocket server; it resolves to a function which maps
  // an id to its corresponding connected socket
  private soktHandlerKey: string;
  private getSoktFn: PromiseLater<(id: string) => Promise<null | WebSocket>>;
  
  constructor(args: any & { domain: Domain }) {
    super(args);
    
    this.soktHandlerKey = `testHttpGatewaySoktHandler@${Math.random().toString(36).slice(2)}`;
    this.getSoktFn = Promise.later<(id: string) => Promise<null | WebSocket>>();
    
    (process as any).registrySet(this.soktHandlerKey, async (id: string) => {
      const getSoktFn = await this.getSoktFn;
      return getSoktFn(id);
    });
    
  }
  
  // TODO: Rename `addManager` to `addAccessor`, and `ApiGatewayManager` to `ApiGatewayKeeper`??
  // Then rename "accessor" -> "keeper" everywhere???
  addManager(ctx: LilacContext, lambda: RealLambda<any, any, any, any, any>) {
    
    super.addManager(ctx, lambda);
    
    // Note that ordinarily CommForms must use json arguments (to be sent over-the-wire), but for
    // tests we can simply pass full values (although this breaks if testing is made to resemble
    // lambda contexts more closely!) 
    return {
      hoist: '<repo>/src/node/lilac/comm/apiGatewayManager.test::ApiGatewayManager',
      form: ApiGatewayManager,
      args: [{ soktHandlerKey: this.soktHandlerKey }]
    } as JsfnInst<typeof ApiGatewayManager> as any;
    
  }
  
  private runHttpServer(ctx: LilacContext, hosting: Config['testing']['hosting']['internal'], reqFn: (req: IncomingMessage, res: ServerResponse) => any) {
    return httpServer({ hosting, fn: reqFn });
  }
  private runSoktServer(ctx: LilacContext, httpServer: Server<any, any>, reqFn: (evt: SoktHttpEvent) => Promise<SoktHttpResult>) {
    
    // End this server by ending the `httpServer` arg
    const server = new WebSocket.Server({ server: httpServer });
    const sokts = new Map<string, { sokt: WebSocket, end: () => void }>();
    
    server.on('connection', async (sokt, req) => {
      
      const soktId = getUid()[upper](); // Uppercase imitates apigw
      
      // 2-hr timeout imitates apigw timeouts
      const timeout = setTimeout(() => end(), 1000 * 60 * 60 * 2);
      
      const end = (msg: string = 'goodbye') => {
        clearTimeout(timeout);
        sokts[rem](soktId);
        sokt.close(1000, msg);
      };
      sokts[add](soktId, { sokt, end });
      
      const connectRes = await reqFn({
        wsEventType: '$connect',
        context: { soktId },
        http: {
          pathAndQuery: req.url,
          headersDistinct: req.headers[map](v => isForm(v, String) ? [ v ] : v),
          body: null
        }
      });
      if (connectRes.code !== 200) return end('invalid request');
      
      sokt.on('message', async (msg: any) => {
        
        try { msg = JSON.parse(msg.toString('utf8')); } catch(err) {}
        
        // Note the computed wsEventType really has to do with the "route selection expression"
        // defined for the sokt apigw; example tf:
        //  | resource "aws_apigatewayv2_api" "ex" {
        //  |   name                     = "example websocket api"
        //  |   protocol_type            = "WEBSOCKET"
        //  |   route_selection_expression = "$request.body.action" # The "action" property of the json body (json is the *only* protocol natively handled by apigw)
        //  | }
        const msgRes = await reqFn({
          
          wsEventType: '$default',
          
          context: { soktId },
          
          // $default events don't have access to headers
          http: {
            pathAndQuery: '/',
            headersDistinct: {},
            body: JSON.stringify(msg)
          }
          
        });
        
        if (msgRes.body) sokt.send(JSON.stringify(msgRes.body));
        
      });
      
      sokt.on('close', async () => {
        
        await reqFn({
          
          wsEventType: '$default',
          
          context: { soktId },
          
          // $default events don't have access to headers
          http: {
            pathAndQuery: '/',
            headersDistinct: {},
            body: null
          },
          
        }).catch(err => {
          // Tolerate errors - don't prevent removal from `sokts`
          ctx.logger.log({ $$: 'glitch', msg: 'error in sokt close logic', err });
        });
        
        end();
        
      });
      
      const body = (() => {
        try         { return JSON.parse(connectRes.body); }
        catch (err) {}
        return connectRes.body;
      })();
      
      if (body) sokt.send(body);
      
    });
    
    return { getSokt: (id: string) => sokts.get(id) ?? null };
    
  }
  async runLocal(ctx: LilacContext, hosting: Config['testing']['hosting'] = { internal: { proto: 'http', addr: 'localhost', port: 3000 } }) {
    
    const { proto: extProto, addr: extAddr, port: extPort } = hosting.external ?? hosting.internal;
    const extNetProc = (extProto === 'http' && extPort === 80 || extProto === 'https' && extPort === 443)
      ? `${extProto}://${extAddr}`
      : `${extProto}://${extAddr}:${extPort}`;
    
    Object.assign(process.env, {
      [snakeCase('httpUrl')]: extNetProc,
      [snakeCase('soktUrl')]: extNetProc.replace(/^http:[/][/]/, 'ws://').replace(/^https:[/][/]/, 'wss://'),
    });
    
    type HttpTxn = { req: IncomingMessage, res: ServerResponse };
    const kill = (args: HttpTxn & { code: number, body: Json, headers?: Obj<string> }) => {
      
      const { res, code, body, headers={} } = args;
      
      const isJson = !isForm(body, String);
      const type = isJson ? 'application/json' : 'text/plain';
      const errs: any[] = [];
      try { res.writeHead(code, { ...headers, ...(isJson && { 'content-type': type }) }); } catch(err: any) { err.suppress(); errs.push(err); }
      try { res.end(body && isJson ? JSON.stringify(body) : body);                        } catch(err: any) { err.suppress(); errs.push(err); }
      
      if (errs[count]() === 0) {
        ctx.logger.log({ $$: 'http.reject', res: { code, headers, msg: body } });
      } else {
        ctx.logger.log({
          $$: 'http.glitch',
          msg: 'errors killing response',
          res: { code, headers, msg: body },
          errs: errs[map](err => {
            // Short output for premature stream closes (these simply mean the response socket
            // ended while the resource was streaming - so the response is already sent, anyways!)
            if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return `stream closed (${err.message})`;
            return err;
          })
        });
      }
      
    };
    
    const localHttpLambdas = this.httpRoutes[toObj](({ path, method, lambda }) => [ `${path} -> ${method}`, lambda ] as const);
    const localSoktLambdas = this.soktRoutes[toObj](({ key,          lambda }) => [ key[lower](),           lambda ] as const);
    
    const getPathAndQuery = (url: string) => {
      
      if (!url) return [ '/', {} ] as const;
      
      const [ p, q = '' ] = url[cut]('?', 1);
      if (!q) return [ p, {} ] as const;
      
      const args: Obj<string[]> = {};
      
      const add = (k: string, v: string) => args[has](k) ? args[k].push(v) : ((args as any)[k] = [ v ]);
      for (const pc of q.split('&')) add(...pc[cut]('=', 1)[map](v => decodeURIComponent(v)) as [ string, string ]);
      return [ p, args ]  as const;
      
    };
    
    // Run http server...
    const { prm: serverRunningPrm, server: httpServer } = this.runHttpServer(ctx, hosting.internal, async (req, res) => {
      
      const method = req.method![lower]();
      const [ path, query ] = getPathAndQuery(req.url!);
      const resPath = `${path} -> ${method}`;
      
      const bodyPrm = new Promise<Buffer | Json>((rsv, rjc) => {
        
        const chunks: any[] = [];
        req.on('data', c => chunks.push(c));
        req.on('error', rjc);
        req.on('end', () => {
          
          let body: Buffer | Json = Buffer.concat(chunks);
          
          if (req.headers['content-type'] === 'application/x-www-form-urlencoded') try {
            
            body = body.toString().split('&')[toObj](entry => {
              return entry[cut]('=').map(uriDecode) as [ string, string ];
            });
            
          } catch (err) {}
          
          else try {
            
            body = JSON.parse(body as any);
            
          } catch(err) {}
          
          rsv(body);
          
        })
        
      });
      
      if (resPath === '/test/volume -> get') {
        
        const json = JSON.stringify((process as any).testVolume, null, 2);
        
        const sizing = 'width: 100%; height: 100%;';
        const html = new Hc('html', { style: sizing }, [
          new Hc('head', [
            new Hc('title', [ 'VOLUME' ])
          ]),
          new Hc('body', { style: `${sizing} margin: 0; padding: 0; overflow: hidden;` }, [
            new Hc('form', { style: `${sizing} overflow: hidden;`, action: '/test/volume', method: 'post' }, [
              new Hc('textarea', { indent: 'no', title: 'volume', placeholder: 'volume', name: 'volume', style: `width: 100%; height: calc(100% - 30px); margin: 0; padding: 0; box-sizing: border-box; border-radius: 10px; border: 1em solid #0004; resize: none;` }, [ json ]),
              new Hc('button', { type: 'submit', style: 'box-sizing: border-box; height: 20px;' }, [ 'Update' ])
            ]),
            // new Hc('pre', [ json.replaceAll('\n', '<br/>') ])
          ])
        ]);
        const htmlStr = html.renderTop({});
        
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(htmlStr).toString(10) });
        res.end(htmlStr);
        return;
        
      } else if (resPath === '/test/volume -> post') {
        
        // const json = JSON.stringify({ msg: 'Success!' });
        
        const body = await bodyPrm;
        const newVolume = (() => {
          try { return JSON.parse((body as any).volume ?? 'null'); }
          catch (err) { return null; }
        })();
        const success = isForm(newVolume, Object);
        if (success) (process as any).testVolume = newVolume;
        
        const html = new Hc('html', [
          new Hc('head', { stye: 'margin:0; padding:0;' }, [
            new Hc('title', [ success ? 'VOLUME UPDATED' : 'FAILED VOLUME UPDATE' ])
          ]),
          new Hc('body', { style: 'margin:0; padding:0;' }, [
            new Hc('p', [ success ? 'Success!' : 'Update failed :(' ]),
            new Hc('a', { href: '/test/volume' }, [ 'back' ])
          ])
        ]);
        const htmlStr = html.renderTop({});
        
        res.writeHead(success ? 200 : 400, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(htmlStr).toString(10) });
        res.end(htmlStr);
        return;
      
      } else if (resPath === '/test/cookie -> get') {
        
        const cookieObj = (req.headers.cookie ?? '').split(';')[map](v => v.trim() || skip)[toObj](v => {
          const [ k, vv ] = v[cut]('=', 1)[map](v => v.trim());
          return [ k, vv ];
        });
        
        const clearKey = Object.keys(cookieObj)[0] ?? null;
        
        const resBody = JSON.stringify({ clearKey, ...(clearKey && { val: cookieObj[clearKey] }) });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(resBody).toString(10),
          ...(clearKey && {
            'set-cookie': {
              [clearKey]: 'deleted',
              [capitalize('expires') ]: (new Date(0)).toUTCString(),
              [capitalize('path')    ]: '/',
              [capitalize('secure')  ]: null,
              [capitalize('httpOnly')]: null,
              [capitalize('sameSite')]: capitalize('strict'),
            }[toArr]((v, k) => v ? `${k}=${v}` : k).join('; ')
          })
        });
        res.end(resBody);
        return;
        
      } else if (resPath === '/test/ngrok-cookie -> get') {
        
        const resBod = JSON.stringify({ msg: 'no external url available' });
        res.writeHead(400, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(resBod).toString(10)
        });
        res.end(resBod);
        if ((() => 1)()) return;
        
        const internal = hosting.internal;
        const external = hosting.external;
        if (!external) {
          const resBody = JSON.stringify({ msg: 'no external url available' });
          res.writeHead(400, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(resBody).toString(10)
          });
          res.end(resBody);
          return;
        }
        
        console.log('Redirect to', `${internal.proto}://${internal.addr}:${internal.port}`);
        
        const resBody = String.baseline(`
          | <!doctype html>
          | <html lang="en">
          |   <head><title>Ngrok Cookie</title></head>
          |   <body>
          |     <a href="${internal.proto}://${internal.addr}:${internal.port}">Main page</a>
          |   </body>
          | </html>
        `);
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-length': Buffer.byteLength(resBody).toString(10),
          'location': `${internal.proto}://${internal.addr}:${internal.port}`,
          'set-cookie': {
            // If we refreshed token1, include it in the response cookie
            'abuse_interstitial': external.addr,
            [capitalize('expires') ]: (new Date(Date.now() + 1000 * 60 * 60 * 24 * 20)).toUTCString(), // Expire 5sec early
            [capitalize('path')    ]: '/',
            [capitalize('secure')  ]: null,
            [capitalize('httpOnly')]: null,
            [capitalize('sameSite')]: capitalize('strict'),
          }[toArr]((v, k) => v ? `${k}=${v}` : k).join('; ')
        });
        res.end(resBody);
        return;
        
      } else if (resPath === '/.well-known/appspecific/com.chrome.devtools.json -> get') {
        
        const resBody = JSON.stringify({
          workspace: {
            root: repoRootFp.join('/')
          }
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(resBody).toString(10)
        });
        res.end(resBody);
        return;
        
      }
      
      const lbdLookup = `${path} -> ${method}`;
      const localLambda = localHttpLambdas[at](lbdLookup, null);
      if (!localLambda) return kill({
        req, res, code: 404,
        body: { rejectPath: resPath, acceptPaths: localHttpLambdas[toArr]((v, k) => k).sort() }
      });
      
      const localFn = (localLambda as LambdaHttp).localFn;
      const lambdaRes = await localFn({
        path,
        httpMethod: method[upper](),
        headers: req.headersDistinct[map](v => v?.[0] ?? skip),
        multiValueHeaders: req.headersDistinct,
        queryStringParameters: query[map](v => v?.[0] ?? skip),
        multiValueQueryStringParameters: query,
        requestContext: {
          apiId: `dev:${this.name}`,
          resourceId: `${method[upper]()} ${req.url || '/'}` as any,
          identity: { sourceIp: '127.0.0.1' }
        },
        isBase64Encoded: false,
        body: await bodyPrm
      });
      
      if (lambdaRes.statusCode == null) {
        
        // TODO: Some kinda bug happening here relating to http requests as dev is spinning up??
        console.log('LAMBDA LOCAL FN RETURNED NULL STATUS CODE', {
          fn: localFn.toString(),
          res: lambdaRes
        });
        const resBody = JSON.stringify({ msg: 'try again soon??' });
        res.writeHead(500, { 'content-length': Buffer.byteLength(resBody).toString(10) });
        res.end(resBody);
        
      }
      
      const { statusCode, headers, isBase64Encoded, body=JSON.stringify({ msg: 'not loaded yet', path }) } = lambdaRes;
      const resBody = isBase64Encoded ? Buffer.from(body, 'base64') : body;
      const replyHeaders = { ...headers, 'content-length': Buffer.byteLength(resBody).toString(10) };
      
      res.writeHead(statusCode, replyHeaders);
      res.end(resBody);
      
    });
    
    // Run sokt server too...
    const { getSokt } = this.runSoktServer(ctx, httpServer, async soktHttp => {
      
      const { wsEventType, http: req, context } = soktHttp;
      
      const localLambda = localSoktLambdas[at](wsEventType[lower](), localSoktLambdas['$default']);
      
      // No lambda, not even a default - simply return with no feedback
      if (!localLambda) return { code: 200, headers: {}, body: null };
      
      const [ path, query ] = getPathAndQuery(req.pathAndQuery);
      const { statusCode, headers, isBase64Encoded, body } = await (localLambda as LambdaHttp).localFn({
        path: path,
        httpMethod: 'post',
        headers: req.headersDistinct[map](v => v[0]),
        multiValueHeaders: req.headersDistinct,
        queryStringParameters: query[map](v => v[0]),
        multiValueQueryStringParameters: query,
        requestContext: {
          connectionId: context.soktId,
          identity: { sourceIp: '127.0.0.1' }
        },
        isBase64Encoded: false,
        body: req.body
      });
      
      const resBody = isBase64Encoded ? Buffer.from(body, 'base64') : body;
      let resHeaders = { ...headers, 'content-length': Buffer.byteLength(resBody).toString(10) };
      
      return {
        code: statusCode,
        headers: resHeaders,
        body: resBody
      };
      
    });
    
    const getSoktFn = (id: string) => Promise.resolve(getSokt(id)?.sokt ?? null);
    this.getSoktFn.resolve(getSoktFn);
    
    await serverRunningPrm;
    ctx.logger.log({ msg: String.baseline(`
      | MAIN APP           - ${extNetProc}
      | SEE ACTIVE CONTEXT - ${extNetProc}/test/volume
      | RESET COOKIES      - ${extNetProc}/test/cookie
    `)});
    
  }
  
};

const getLambdaLogger = (ctx: LilacContext, lambda: RealLambda<any, any, any, any, any>) => ctx.logger.kid(`${(lambda as any).name}.lambda`);
const lambdaFnRealisticYaTracesNo = async (ctx: LilacContext, lbd: RealLambda<any, any, any, any, any>) => {
  
  // Preserves a lot of the string-style function building used in terraform, but the resulting
  // run lacks valid stack traces (as resulting lambda function bodies are eval'd strings)
  
  // Note a more ideal local simulation would run a separate process per lambda, each of which
  // would be running the *packed* (not *source*) code!! E.g. each process would have its own
  // copy of clearing, class prototypes, etc. (But how would the volume be shared between
  // processes? Uh oh...)
  
  const code = await lbd.getSourceCode(ctx.logger, ctx, { relFp: '<repo>/src/node/lilac/registry', lang: 'js', });
  
  const convertedCode = (() => {
    
    // Note `code` results in setting `module.exports.handler` to the handler; it also calls the
    // lambda wrapper with `const cfg = { debug: true };` - we want to replace the `logger`
    // supplied in `cfg`, and we also want to return the handler - not export it! Here we make
    // the conversion. Note this is a clunky approach, but it maintains a good amount of code
    // generation logic integrated into the dev process.
    
    const lines = code.split('\n');
    
    const cfg = lines[find](ln => /^const cfg = [{] debug: (true|false) [}];/.test(ln));
    lines[cfg.ind!] = `// ${lines[cfg.ind!]} // removed during conversion`;
    
    const exp = lines[find](ln => /^module[.]exports[.]handler = /.test(ln));
    lines[exp.ind!] = `${lines[exp.ind!].replace('module.exports.handler = ', 'return ')} // converted`;
    
    const log = lines[find](ln => /const lambdaLogger = /.test(ln));
    lines[log.ind!] = `const lambdaLogger = cfg.logger; // converted`;
    
    // This function can be called with any `cfg` value, which will replace `{ debug: true }`
    return [
      'cfg => {',
      lines.join('\n')[indent]('  '),
      '}'
    ].join('\n');
    
  })();
  
  try {
    
    await ctx.repoDb.kid([ 'cmp', 'node', 'lilac', 'registry', `${lbd.getName()}RealisticLambda.js` ]).setValue(`module.exports = ${convertedCode}`);
    return require(`./${lbd.getName()}RealisticLambda.js`)({ debug: true, logger: getLambdaLogger(ctx, lbd) });
    
  } catch (cause) {
    
    const reviewDb = ctx.repoDb.kid([ 'config', 'review', 'realisticLambdaLastFailed', `${lbd.getName()}.js` ]);
    await reviewDb.setValue(convertedCode).catch(() => ctx.logger.log({ $$: 'notice', msg: 'realistic lambda failure review failed' }));
    throw Error('realistic lambda failed')[mod]({
      cause,
      code: convertedCode.slice(0, 100),
      lambda: lbd.getName(),
      review: reviewDb.fp.toString()
    });
    
  }
  
};
const lambdaFnRealisticNoTracesYa = async (ctx: LilacContext, lbd: RealLambda<any, any, any, any, any>) => {
  
  // Skips some of the string-style function building used for terraform, but preserves
  // stacktraces for debugging!
  
  // TODO: Accessors should not be { hoist, form, args } but rather instances with a "serialize"
  // method (or e.g. `Symbol.for('clearing.jsfn')`), returning { hoist, form, args }!!!!
  const initializeJsfnInsts = (val: any) => {
    
    if (isForm(val, Object) && val[toArr]((v, k) => k).sort()[eq]([ 'args', 'form', 'hoist' ]) && hasForm(val.form, Function)) {
      const F = val.form as any;
      return new F(...val.args as any);
    }
    
    if (isForm(val, Array))  return val[map](v => initializeJsfnInsts(v));
    if (isForm(val, Object)) return val[map](v => initializeJsfnInsts(v));
    return val;
    
  };
  const data = initializeJsfnInsts(await (lbd as any).data);
  
  const requireFn = (fp: string) => {
    const required = fp[hasHead]('<repo>/')
      ? require(resolve1pImport('<repo>/src/node/lilac/registry', fp as UGH))
      : require(fp);
    
    return Object.keys(required).join(',') === 'default'
      // If the required module defines only a "default" vaulue, return that
      ? required.default
      : required;
  };
  const logger = getLambdaLogger(ctx, lbd);
  
  const debug = ctx.debug;
  return (lbd as any).getExecutionWrapper().bind(null, {
    debug,
    require: requireFn,
    lambdaLogger: logger,
    supplies: lbd.code.begin({ debug, require: requireFn, logger, data }),
    checks: lbd.code.checks,
    event: lbd.code.event
  });
};
const lamdaFn = lambdaFnRealisticYaTracesNo;

const lambdaRunLocal = async (ctx: LilacContext, lbd: RealLambda<any, any, any, any, any>) => {
  
  const lambdaFn = await lamdaFn(ctx, lbd);
  
  (lbd as any).localFn = (args: HttpShape['awsRawReq']) => lambdaFn(args, {
    callbackWaitsForEmptyEventLoop: false,
    clientContext: null,
    awsRequestId: Math.random().toString(36).slice(2),
    invokedFunctionArn: `dev:${(lbd as any).name}`,
    getRemainingTimeInMillis: () => 1000
  });
  
};

// TODO: Lack of diamond-shaped inheritance hurts here; need to repeat this extension for every
// RealLambdaHttp subclass...
class Vpc extends RealVpc {

  public localFn: any;
  constructor(args: any) { super(args); }

};

const unloadedLambdaFn = (lbd: RealLambda<any, any, any, any, any>) => () => ({
  statusCode: 503,
  headers: {},
  isBase64Encoded: false,
  body: JSON.stringify({ msg: 'dev mode is still booting...', lambda: lbd.getName() })
});
class LambdaHttp extends RealLambdaHttp<any, any, any, any> {
  
  public localFn: any;
  constructor(args: any) {
    super(args);
    this.localFn = unloadedLambdaFn(this);
  }
  
  async runLocal(ctx: LilacContext) { lambdaRunLocal(ctx, this); }
  
};
class LambdaQueue extends RealLambdaQueue<any, any, any, any> {
  
  public localFn: any;
  constructor(args: any) {
    super(args);
    this.localFn = unloadedLambdaFn(this);
  }
  
  async runLocal(ctx: LilacContext) { lambdaRunLocal(ctx, this); }
  
};
class DocDb<A extends DocDbItem, B extends DocDbKey<A>> extends RealDocDb<A, B> {

  constructor(args: any) { super(args); }
  
  addAccessor(ctx: LilacContext, ...args: any[]) {
    
    // Call the super method but ignore the resulting instance
    const result = (super.addAccessor as any)(ctx, ...args);
    
    // Instead provide an overridden test instance
    const inst = {
      hoist: '<repo>/src/node/lilac/comm/lambdaDocDb/keep.test::LambdaDocDbKeeper',
      form: LambdaDocDbKeeper,
      args: [ this.getAccessorConfig(ctx) ]
    } as JsfnInst<typeof LambdaDocDbKeeper>;
    
    return inst as any;
    
  }
};
class Storage extends RealStorage {
  constructor(args: any) {
    super(args);
  }
  
  addAccessor(ctx: LilacContext, mode: any, baseKey: any, lambda: any) {
    const result = super.addAccessor(ctx, mode, baseKey, lambda);
    
    // Instead provide an overridden test instance
    const inst = {
      hoist: '<repo>/src/node/lilac/comm/lambdaStorage/keep.test::LambdaStorageKeeper',
      form: LambdaStorageKeeper,
      args: [ this.getAccessorConfig(ctx, baseKey) ]
    } as JsfnInst<typeof LambdaStorageKeeper>;
    
    return inst as any;
  }
};
class Queue extends RealQueue<any> {
  
  private handlerKey: string;
  
  constructor(args: any) {
    super(args);
    this.handlerKey = `testLilacQueueHandler@${Math.random().toString(36).slice(2)}`;
    (process as any).registrySet(this.handlerKey, async evt => (this.handler as any).localFn(evt));
  }
  
  addAccessor(ctx: LilacContext, mode: 'mark', lambda: any) {
    const result = super.addAccessor(ctx, mode, lambda); // Call, but ignore result (TODO: necessary to call??)
    
    // Instead provide an overridden test instance
    const inst = {
      hoist: '<repo>/src/node/lilac/comm/lambdaQueue/keep.test::LambdaQueueKeeper',
      form: LambdaQueueKeeper,
      args: [ { handlerKey: this.handlerKey }]
    } as JsfnInst<typeof LambdaQueueKeeper>;
    
    return inst as any;
  }
};
class Email extends RealEmail {
  constructor(args: any) {
    super({
      ...args,
      storage: new RealStorage({ name: `${args.name}TestReceiptStorage` })
    });
  }
  addAccessor(ctx: LilacContext, ...args: any[]) {
    
    (super.addAccessor as any)(ctx, ...args);
    
    const inst = {
      hoist: '<repo>/src/node/lilac/comm/lambdaEmail/base.test::LambdaEmailKeeper',
      form: LambdaEmailKeeper,
      args: [ { domain: this.domain.getNameBase() } ]
    } as JsfnInst<typeof LambdaEmailKeeper>;
    
    return inst as any;
    
  }
};
class Role extends RealRole {
  constructor(args: any) { super(args); }
};

export const registry = {
  Vpc,
  LambdaHttp,
  LambdaQueue,
  DocDb,
  Domain,
  HttpGateway,
  Storage,
  Queue,
  Email,
  Role
} satisfies typeof import('./registry').registry;