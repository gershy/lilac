export const embed = (v: string) => '${' + v + '}';
export const json = (v: Json) => [
  '| <<EOF',
  JSON.stringify(v, null, 2)[indent](2),
  'EOF'
].join('\n');
