// TODO: @gershy/logger (or @gershy/watcher?)

import { getClsName, inCls, isCls } from '@gershy/clearing';

type LoggerData = null | boolean | number | string | { [limn]: (...args: any) => LoggerData } | LoggerData[] | { [k: string]: LoggerData };

type ScrubOpts = {
  isScrub: (k: string, v: any) => boolean,
  doScrub: (v: any) => Json,
  seen: Map<any, Json>
};
const scrubbed = (val: any, opts: Partial<ScrubOpts> = {}): Json => {
  const {
    isScrub = (k: string, _v: any) => k[0] === '!',
    doScrub = ((v: any) => `$scrub(${getClsName(v)})`),
    seen = new Map<any, Json>()
  } = opts ?? {}
  
  if (val === null)         return val;
  if (isCls(val, Boolean)) return val;
  if (isCls(val, Number))  return val;
  if (isCls(val, String))  return val;
  if (seen.has(val)) return seen.get(val) ?? null;
  
  if (isCls(val, Array)) {
    
    const result: any[] = [];
    seen.set(val, result);
    for (const item of val) result.push(scrubbed(item, { isScrub, doScrub, seen }));
    return result;
    
  } else if (isCls(val, Object)) {
    
    // Consider using hashes to display scrubbed values? (Makes them correlatable!)
    
    const result = {};
    seen.set(val, result);
    for (const [ k, v ] of val as any as [ string, (typeof val)[keyof typeof val] ][])
      result[k] = isScrub(k, v) ? doScrub(v) : scrubbed(v, { isScrub, doScrub, seen });
    return result;
    
  } else if (inCls(val[limn], Function)) {
    
    return scrubbed(val[limn](), { isScrub, doScrub, seen });
    
  } else {
    
    // Consider processing for other types (sets, maps?)
    return val;
    
  }
  
};

export default class Logger {
  
  public static dummy = {
    getTraceId() { return ''; },
    log() {},
    child() { return Logger.dummy; },
    scope(...args) { return args.at(-1)(Logger.dummy); }
  } as unknown as Logger;
  
  private format(v: any /* should not have cycles */, seen = new Map<any, Json>()): Json {
    
    // Formats any value into json (so that it can be logged)
    
    if (v == null)          return null;
    if (isCls(v, Boolean)) return v;
    if (isCls(v, Number))  return v;
    if (isCls(v, String))  return v.length > this.opts.maxStrLen ? v.slice(0, this.opts.maxStrLen - 1) + '\u2026' : v;
    
    if (seen.has(v)) return `<cyc> ${getClsName(v)}(...)`;
    
    if (inCls(v[limn], Function)) {
      const formatted: any = {};
      seen.set(v, formatted);
      Object.assign(formatted, this.format(v[limn](), seen));
      return formatted;
    }
    
    if (isCls(v, Array)) {
      const arr: any[] = [];
      seen.set(v, arr);
      for (const vv of v) arr.push(this.format(vv, seen));
      return arr;
    }
    
    if (isCls(v, Object)) {
      const obj: { [K: keyof any]: any } = {};
      seen.set(v, obj);
      for (const k in v) obj[k] = this.format(v[k], seen);
      return obj;
    }
    
    return `${getClsName(v)}(...)`;
    
  };
  
  private domain: string;
  private ctx: Obj<Json>;
  private write: (fullCtx: Obj<Json>) => void;
  private opts: { maxStrLen: number };
  constructor(domain: string, ctx: Obj<any> = {}, opts?: typeof this.opts, write?: typeof this.write) {
    this.domain = domain;
    this.ctx = {
      ...ctx,
      $:                                this.domain,
      [this.domain.split('.').at(-1)!]: Math.random().toString(36).slice(2, 12)[padTail](10, '0'),
    };
    this.opts = opts ?? { maxStrLen: 250 };
    
    // Note this default `this.write` function produces truncated values (sloppy outputting) in the
    // cli, but works perfectly for lambdas with json-style logging configured!
    
    this.write = write ?? ((val: Obj<Json>) => console.log(val));
  }
  
  public getDomain() { return this.domain; }
  
  public getTraceId(term: string) {
    
    const traceId = this.ctx[term];
    if (!traceId) throw Error('trace term invalid')[mod]({ term, ctx: this.ctx });
    return traceId as string;
    
  }
  
  public log(data: LoggerData) {
    
    // Use-cases:
    // 1. logger.log('a basic string')
    //    - The logged payload is converted to `{ msg: 'a basic string' }`
    // 2. logger.log({ msg: 'a basic string' })
    //    - Logged as-is; equivalent to #1
    // 3. logger.log({ $$: 'note', msg: 'a basic string' })
    //    - Same as #1 and #2, but logger domain has "note" appended to it
    // 4. logger.log({ $$: 'noteOnly' })
    //    - Logged payload will be `{}`; only info is the tag - useful for infinitesimal moments in
    //      the flamegraph!
    // 5. logger.log({ $$: 'context.noteOnly' })
    //    - Valid way to extend domain with more than 1 component at once!
    
    let dmn: null | string = null;
    if (data && isCls((data as any)?.$$, String)) ({ $$: dmn, ...data } = data as any);
    
    const domain = dmn ? [ this.domain, dmn ].join('.') : this.domain;
    
    if (!isCls(data, Object)) data = { msg: data };
    this.write({}
      [merge]({ $: this.ctx })
      [merge](scrubbed(this.format(data)) as Obj<Json>)
      [merge]({ $: { $: domain } }));
    
  }
  
  public kid(domain: string): Logger {
    const d = [ this.domain, domain ].filter(Boolean).join('.');
    const logger = new Logger(d, this.ctx, this.opts, this.write);
    return logger;
  }
  
  public scope<Fn extends (logger: Logger) => any>(domain: string, ctx: Obj<any>, fn: Fn): ReturnType<Fn> {
    
    const ms = Date.now();
    const logger = this.kid(domain);
    
    logger.log({ $$: 'launch', ...ctx });
    const accept = val => { logger.log({ $$:                 'accept', ms: Date.now() - ms      }); return val; };
    const glitch = err => { logger.log({ $$: err.log?.term?? 'glitch', ms: Date.now() - ms, err }); throw err;  }; // Always throws an error! Note allowing the consumer to override the logged term/domain offers a lot of flexibility!
    
    let v: any; try { v = fn(logger); } catch(err) { glitch(err); }
    
    return isCls(v, Promise)
      ? (v as Promise<unknown> & ReturnType<Fn>).then(accept, glitch)
      : accept(v);
      
  }
};
