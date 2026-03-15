import { NetProc } from '@gershy/util-http';
import net from 'node:net';

export default async (netProc: NetProc, timeoutMs = 5000) => {
  
  let timeout: any;
  const s = new net.Socket();
  
  return new Promise<void>((rsv, rjc) => {
    
    s.once('connect', () => rsv());
    s.once('error', err => rjc(err));
    
    timeout = setTimeout(() => rjc(Error('timeout')), timeoutMs);
    s.connect(netProc.port, netProc.addr);
    
  }).finally(() => {
    
    clearTimeout(timeout);
    try { s.destroy(); } catch {}
    
  });
  
};