import capitalize from '../../../boot/util/capitalize';
import { TfData } from '../provider/awsTf';
import { Lilac, LilacContext } from '../lilac';

export class Domain extends Lilac {
  
  private addr: string;
  private port: number;
  private hostedZone: TfData;
  constructor(addr: string, port: number) {
    
    super();
    
    this.addr = addr;
    this.port = port;
    
    const baseDomain = this.getNameBase();
    const baseDomainHandle = `domain${baseDomain.split('.')[map](p => capitalize(p)).join('').replace(/[^a-zA-Z0-9]/g, '')}`;
    this.hostedZone = new TfData('awsRoute53Zone', baseDomainHandle, {
      name: baseDomain // Manually-created hosted zone ought to be for the base domain!!
    });
    
  }
  
  public getPort      () { return this.port; }
  public getNameFull  () { return this.addr; }
  public getNamePcs   () { return this.addr.split('.'); }
  public hasSubdomain () { return this.addr.split('.').length > 2; }
  public getNameBase  () { return this.addr.split('.').slice(-2).join('.'); }
  public getHostedZone() { return this.hostedZone; }
  
  protected async getTfEntities0(ctx: LilacContext) { return [ this.hostedZone ]; }
  
};