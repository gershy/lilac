import { rootFact } from '@gershy/disk';
import proc from '@gershy/util-nodejs-proc';

await Promise.all(
  
  {
    docker:    'docker --version',
    terraform: 'terraform --version',
    aws:       'aws --version',
  }[toArr]((cmd, name) => {
    return proc(cmd, { cwd: rootFact, env: process.env })
      .catch(err => err[fire]({ msg: `${name} dependency failed`, cmd }));
  })
  
);