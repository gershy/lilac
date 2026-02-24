import { isCls } from '@gershy/clearing';

const capitalize = (v: string | string[]): string => {
  
  // capitalize('hello')                       -> "Hello"
  // capitalize('heLLo')                       -> "HeLLo"
  // capitalize([ 'my', 'name', 'is', 'bOb' ]) -> "myNameIsBOb"
  
  if (isCls(v, String)) return v[0][upper]() + v.slice(1);
  return [ v[0], ...v.slice(1)[map](v => v[0][upper]() + v.slice(1)) ].join('');
  
};

export default capitalize;