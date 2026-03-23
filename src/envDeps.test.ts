import { rootFact } from '@gershy/disk';
import proc from '@gershy/nodejs-proc';

await Promise.all(
  
  {
    docker:    'docker --version',
    terraform: 'terraform --version',
    aws:       'aws --version',
  }[cl.toArr]((cmd, name) => {
    return proc(cmd, { cwd: rootFact, env: process.env })
      .catch(err => err[cl.fire]({ msg: `${name} dependency failed`, cmd }));
  })
  
);