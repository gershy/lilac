// TODO: @gershy/nodejs-proc

import { then } from '@gershy/clearing';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { rootFact } from '@gershy/disk';
type DiskEnt = typeof rootFact;

const stripAnsi = (str: string) => str.replace(/\u001B\[[0-9]+m/g, ''); // Removes ansi

type RunInShellResultStrs = { stdout: string, stderr: string, output: string, overview: string };
type RunInShellReturnValue = Promise<RunInShellResultStrs> & { proc: ChildProcessWithoutNullStreams, rawShellStr: string };

export type ProcOpts = {
  timeoutMs?: number,
  bufferOutput?: boolean,
  env?: Obj<string>,
  cwd?: DiskEnt,
  onInput?: (type: 'init' | 'out' | 'err', data: string) => void
};
export default (cmd: string, opts?: ProcOpts): RunInShellReturnValue => {

  // Note that `timeoutMs` counts since the most recent chunk
  const { timeoutMs=30 * 1000, bufferOutput=true, env={}, cwd=rootFact.kid([ '.proc' ]), onInput=null } = opts ?? {};
  const err = Error('');
  
  const [ shellName, ...shellArgs ] = cmd.split(/\s+/).filter(v => !!v);
  
  const state = {
    onInput,
    lastChunk: null as null | Buffer,
    timeout:   null as any
  };
  const proc = spawn(shellName, shellArgs, {
    windowsHide: true,
    shell: true,
    detached: false,
    env,
    cwd: path.join(...cwd.fp.cmps)
  });
  
  // Allow an initial amount of input
  state.onInput && then(
    state.onInput('init', ''),
    result => (result != null) && proc.stdin.write(result + '\n')
  );
  
  const stdoutChunks = [];
  const stderrChunks = [];
  const outputChunks = []; // The "entire" output; stdout interleaved with stderr
  const timeoutFn = () => {
    proc.kill();
    proc.emit('error', Error('timeout')[mod]({ timeoutMs, lastChunk: stripAnsi(state.lastChunk?.toString('utf8') ?? '') }))
  };
  const resetTimeout = timeoutMs
    ? () => { clearTimeout(state.timeout); state.timeout = setTimeout(timeoutFn, timeoutMs); }
    : () => { /* infinite timeout */ };
  resetTimeout();
  
  const handleChunk = (type: 'out' | 'err', chunks: Buffer[], data: Buffer) => {
    
    state.lastChunk = data;
    
    // Reset timeout
    resetTimeout();
    
    if (bufferOutput) chunks.push(data);
    
    if (state.onInput) (async () => {
      
      for (const rawLn of data.toString('utf8').split(/[\r]?[\n]/)) {
        
        // `state.onInput` may get set to `null` asynchronously
        if (!state.onInput) break;
        
        const ln = rawLn.trimEnd();
        if (!ln) continue; // Always ignore whitespace-only lines??
        
        try {
          const result = await state.onInput(type, ln);
          if (result != null) proc.stdin.write(result + '\n');
        } catch(err) {
          proc.kill();
          proc.emit('error', err);
        }
        
      }
      
    })();
    
  };
  
  const handleStdoutChunk = handleChunk.bind(null, 'out', stdoutChunks);
  const handleStderrChunk = handleChunk.bind(null, 'err', stderrChunks);
  const handleOutputChunk = handleChunk.bind(null, 'err', outputChunks);
  proc.stdout.on('data', handleStdoutChunk); // Pure stdout
  proc.stderr.on('data', handleStderrChunk); // Pure stderr
  
  // "output" consists of stdout interleaved with stderr in the same order chunks were received
  proc.stdout.on('data', handleOutputChunk);
  proc.stderr.on('data', handleOutputChunk);
  
  const rawShellStr = `${shellName} ${shellArgs.join(' ')}`;
  const closure = () => {
    
    clearTimeout(state.timeout);
    state.onInput = null;
    proc.stdout.removeListener('data', handleStdoutChunk);
    proc.stderr.removeListener('data', handleStderrChunk);
    
    const stdout = stripAnsi(Buffer.concat(stdoutChunks).toString('utf8'));
    const stderr = stripAnsi(Buffer.concat(stderrChunks).toString('utf8'));
    const output = stripAnsi(Buffer.concat(outputChunks).toString('utf8').trim());
    
    const overview = `> ${rawShellStr}\n${output[indent](`[${shellName}] `)}`
    return { stdout, stderr, output, overview };
    
  };
  
  const prm = new Promise<RunInShellResultStrs>((resolve, reject) => {
    
    proc.on('error', cause => {
      
      cause[suppress]();
      reject(err[mod]({ cause, msg: `Failed spawning "${shellName}"`, ...closure() }));
      
    });
    
    proc.on('close', exitCode => {
      
      if (exitCode === 0) resolve(closure());
      else                reject(err[mod]({ msg: `Proc "${rawShellStr}" failed (${exitCode})`, exitCode, ...closure() }));
      
    });
    
    proc.on('exit', (exitCode, signal) => {
      
      if (exitCode === 0) resolve(closure());
      else                reject(err[mod]({ msg: `Proc "${rawShellStr}" failed (${exitCode})`, exitCode, signal, ...closure() }));
      
    });
    
  });
  
  return Object.assign(prm, {
    proc,
    terminate: async () => {
      const signalSent = proc.kill();
      if (!signalSent) throw Error('process kill failed')[mod]({ pid: proc.pid ?? '<unknown>' });
      return prm;
    },
    rawShellStr
  });
  
};
