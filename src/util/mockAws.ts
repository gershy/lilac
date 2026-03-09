import proc from '@gershy/util-nodejs-proc';
import { rootFact } from '@gershy/disk';
import http from '@gershy/util-http';

const LOCALSTACK_IMAGE = 'localstack/localstack:latest';
const LOCALSTACK_PORT = 4566;

export type MockAwsArgs = {
  port: number,
  image: `localstack/localstack${':' | '@'}${string}` // E.g. 'localstack/localstack:latest'
};
export default async (args: MockAwsArgs) => {
  
  // Ensure docker is running
  await (async () => {
    
    const output = await proc('docker ps', { cwd: rootFact });
    if (!output[has]('TODO')) throw Error('docker unavailable');
    
  })();
  
  // Deploy localstack to docker
  const { containerName } = await (async () => {
    
    const containerName = `mockAws${Date.now()}`;
    await proc(`docker run --rm -d --name ${containerName} -p ${args.port}:${args.port} ${args.image}`, { cwd: rootFact });
    
    const readyEndpoint = {
      $req: null as any,
      $res: null as any as { code: number, body: { services?: any[] } },
      netProc: { proto: 'http' as const, addr: 'localhost', port: args.port },
      path: [ 'health', 'ready' ],
      method: 'get' as const
    }
    const res = await http(readyEndpoint, { query: {}, body: {} });
    console.log('localstack http health', { res });
    
    return { containerName };
    
  })();
  
  return {
    
    netProc: { proto: 'http', addr: 'localhost', port: args.port },
    end: async () => {
      await proc(`docker rm -f ${containerName}`, { cwd: rootFact })
    }
    
  };

};