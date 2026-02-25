import { rootFact } from '@gershy/disk';
import proc, { ProcOpts } from './proc.ts';
type DiskEnt = typeof rootFact

export default (fp: DiskEnt, cmd: string, opts?: ProcOpts) => {
  
  const numTailingTfLogLines = 20;
  
  const writeLog = async (result: string | Obj<Json> | Json[]) => {
    const [ yr, mo, dy, hr, mn, sc, ms ] = new Date().toISOString().match(/([0-9]{4})[-]([0-9]{2})[-]([0-9]{2})[T]([0-9]{2})[:]([0-9]{2})[:]([0-9]{2})[.]([0-9]+)[Z]/)!.slice(1);
    const term = `${cmd.split(' ')[1]}-${yr}${mo}${dy}-${hr}${mn}${sc}`;
    const logDb = fp.kid([ '.terraform.log', `${term}.txt` ]);
    await logDb.setData(result);
    return logDb;
  };
  
  return proc(cmd, {
    timeoutMs: 0,
    ...opts,
    cwd: fp,
    env: { TF_DATA_DIR: '' }
  }).then(
    async result => {
      const logDb = await writeLog(result.output);
      return { logDb, output: result.output.split('\n').slice(-numTailingTfLogLines).join('\n') };
    },
    async err => {
      const logDb = await writeLog(err.output ?? err[limn]());
      throw Error(`terraform failed (${err.message})`)[mod]({
        logDb,
        ...(err.output ? { output: err.output.split('\n').slice(-numTailingTfLogLines).join('\n') } : { cause: err })
      });
    }
  );
  
};