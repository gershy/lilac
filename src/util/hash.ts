import { createHash } from 'node:crypto';
import { isCls } from '@gershy/clearing';

export default (str: string | Buffer | Iterable<string | Buffer>, targetBase = String[base62]) => {
  
  // Consider moving this under the "node" directory - relies on "node:crypto'
  
  if (isCls(str, String) || isCls(str, Buffer)) str = [ str ];
  
  const hash = createHash('sha256');
  for (const val of str) hash.update(val as any);
  
  return hash
    .digest('base64url')
    [toNum](String[base64Url])
    [toStr](targetBase);
  
};