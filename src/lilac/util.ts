import { isCls } from '@gershy/clearing';
import capitalize from '../util/capitalize.ts';

export const aws = {
  capitalKeys: (v: any) => {
    if (isCls(v, Array)) return v[map](v => aws.capitalKeys(v));
    if (isCls(v, Object)) return v[mapk]((val, key) => [ capitalize(key), aws.capitalKeys(val) ]);
    return v;
  }
};
export const tf = {
  embed: (v: string) => '${' + v + '}',
  json: (v: Json) => [
    '| <<EOF',
    JSON.stringify(v, null, 2)[indent](2),
    'EOF'
  ].join('\n'),
  provider: (defaultAwsRegion: string, targetAwsRegion: string): { $provider: string } => {
    return defaultAwsRegion !== targetAwsRegion
      ? { $provider: `aws.${targetAwsRegion.split('-').join('_')}` }
      : {} as any;
  }
};
