import '@gershy/clearing';
import slashEscape from '../../util/slashEscape.ts';
import Petal from '../petal.ts';
import ph from '@gershy/util-phrasing';

const { getClsName, isCls } = cl;

const hasHead: typeof cl.hasHead = cl.hasHead;
const map:     typeof cl.map     = cl.map;
const hasTail: typeof cl.hasTail = cl.hasTail;
const indent:  typeof cl.indent  = cl.indent;
const mod:     typeof cl.mod     = cl.mod;
const toArr:   typeof cl.toArr   = cl.toArr;
const has:     typeof cl.has     = cl.has;

export namespace PetalTerraform {
  
  export class Base extends Petal {
    
    // Defines petals using terraform; subclasses generally map to terraform's different block types
    
    static terraformEncode = (val: Json): string => {
      
      if (val === null)        return 'null';
      if (isCls(val, String))  return val[hasHead]('| ') ? val.slice('| '.length) : `"${slashEscape(val, '"\n')}"`;
      if (isCls(val, Number))  return `${val.toString(10)}`;
      if (isCls(val, Boolean)) return val ? 'true' : 'false';
      
      if (isCls(val, Array)) {
        const vals = val[map](v => this.terraformEncode(v));
        if (vals.some(v => isCls(v, String) && v[hasHead]('| '))) process.exit(0);
        if (vals.length === 0) return '[]';
        if (vals.length === 1) return `[ ${vals[0]} ]`;
        return `[\n${vals.join(',\n')[indent]('  ')}\n]`;
      }
      
      if (isCls(val, Object)) {
        
        // Strings use "| " to avoid any quoting (enabling complex/arbitrary tf)
        // Objects use "$" as a key-prefix to define "nested blocks" instead of "inline maps"
        
        const keys = Object.keys(val);
        if (keys.length === 1 && keys[0][hasTail]('()')) {
          const vals = (val[keys[0]] as any[])[map](v => this.terraformEncode(v));
          return `${keys[0].slice(0, -'()'.length)}(${vals.join(', ')})`;
        }
        
        const entryItems = val[toArr]((v, k) => {
          
          // "special" indicates whether the first char was "$" - it causes objects to be assigned as
          // *nested blocks*
          const [ special, pcs ] = (() => {
            
            const ks = k[hasHead]('$');
            const kk = ks ? k.slice(1) : k;
            return [ ks, kk.split('.') ];
            
          })();
          
          const dedup = pcs.length > 1 && /^[0-9]+$/.test(pcs.at(-1)!);
          if (dedup) pcs.pop(); // Remove last item
          
          // Multi-component keys must pertain to objects
          if (pcs.length > 1 && !isCls(v, Object))
            throw Error('tf key of this form must correspond to object value')[mod]({ k, v });
          
          // Resolve to raw string?
          if (special && isCls(v, String))
            return [ ph('camel->snake', pcs[0]), ' = ', this.terraformEncode(v[hasHead]('| ') ? v : `| ${v}`) ];
          
          // Resolve to nested block?
          if (special && isCls(v, Object))
            return [ [ ph('camel->snake', pcs[0]), ...pcs.slice(1)[map](pc => ph('camel->snake', pc)) ].join(' '), ' ', this.terraformEncode(v) ];
          
          // Resolve anything else to typical property - use the key exactly as provided (to support,
          // e.g., aws format for keys in policies, any other specific format, etc.)
          return [ ph('camel->snake', pcs[0]), ' = ', this.terraformEncode(v) ];
          
        });
        
        const len = entryItems.length;
        if (len === 0) return '{}';
        
        const entries = entryItems[map](([ key, joiner, value ]) => [ key, joiner, value ].join(''));
        
        // Note single-line terraform definitions are illegal for non-linear values
        // Determine whether the the value is linear based on its terminating character (janky)
        if (len === 1 && !entries[0]![has]('\n') && !'}]'[has](entries[0].at(-1)!)) return `{ ${entries[0]} }`;
        return `{\n` + entries.join('\n')[indent]('  ') + '\n}';
        
      }
      
      throw Error('unexpected val')[mod]({ form: getClsName(val), val });
      
    };
    
    constructor() { super(); }
    
    getType(): string { throw Error('not implemented'); }
    getHandle(): string { throw Error('not implemented'); }
    getProps(): { [key: string]: Json } { throw Error('not implemented'); }
    
    refStr(props: string | string[] = []): string {
      
      if (!isCls(props, Array)) props = [ props ];
      
      const base = `${ph('camel->snake', this.getType())}.${ph('camel->snake', this.getHandle())}`;
      return props.length
        ? `${base}.${props[map](v => ph('camel->snake', v)).join('.')}`
        : base;
      
    }
    ref(props: string | string[] = []): `| ${string}` {
      
      // "plain ref" - uses "| " to avoid being  quoted within terraform
      
      return `| ${this.refStr(props)}`;
      
    }
    async getResultHeader(): Promise<string> { throw Error('not implemented'); }
    async getResult(): Promise<string | { tf: string, files?: Obj<string | Buffer> }> {
      
      // Get header and props
      const [ header, props ] = await Promise.all([
        this.getResultHeader(),
        Base.terraformEncode(this.getProps())
      ]);
      
      return `${header} ${props}`;
      
    }
    
  };
  export class Terraform extends Base {
    
    private props: { [key: string]: Json };
    constructor(props: { [key: string]: Json }) {
      super();
      this.props = props;
    }
    getProps() { return this.props; }
    async getResultHeader() {
      return `terraform`;
    }
    
  };
  export class Resource extends Base {
    
    private type: string;
    private handle: string;
    private props: { [key: string]: Json };
    constructor(type: string, handle: string, props: { [key: string]: Json }) {
      super();
      this.type = type;
      this.handle = handle;
      this.props = props;
    }
    getType() { return this.type; }
    getHandle() { return this.handle; }
    getProps() { return this.props; }
    async getResultHeader() {
      return `resource "${ph('camel->snake', this.type)}" "${ph('camel->snake', this.handle)}"`;
    }
    
  };
  export class Provider extends Base {
    
    private name: string;
    private props: { [key: string]: Json };
    constructor(name: string, props: { [key: string]: Json }) {
      super();
      this.name = name;
      this.props = props;
    }
    getProps() { return this.props; }
    async getResultHeader() {
      return `provider "${ph('camel->snake', this.name)}"`;
    }
    
  };
  export class Data extends Base {
    
    private type: string;
    private handle: string;
    private props: { [key: string]: Json };
    constructor(type: string, handle: string, props: { [key: string]: Json }) {
      super();
      this.type = type;
      this.handle = handle;
      this.props = props;
    }
    getType() { return this.type; }
    getHandle() { return this.handle; }
    getProps() { return this.props; }
    
    async getResultHeader() {
      return `data "${ph('camel->snake', this.type)}" "${ph('camel->snake', this.handle)}"`;
    }
    refStr(props: string | string[] = []) {
      return `data.${super.refStr(props)}`;
    }
    
  };
  export class File extends Base {

    private fp: string;
    private content: string | Buffer;
    constructor(fp: string, content: string | Buffer) {
      super();
      this.fp = fp;
      this.content = content;
    }
    
    getType() { return '_file'; }
    async getResult() {
      return { tf: '', files: { [this.fp]: this.content } };
    }
    refStr(props?: string | string[]) {
      return this.fp; // `this.fp` should be quoted but not transformed to a tf handle
    }
    
  };
  
};
