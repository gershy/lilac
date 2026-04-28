import '@gershy/clearing';
import fs, { glob } from 'node:fs/promises';
import path from 'node:path';
import tsc from 'typescript';
import esbuild from 'esbuild';

(async () => {
  
  const rootFp = path.join(import.meta.dirname, '..');
  const mode = process.argv.at(-1);
  
  const ops = {
    
    cmp: async () => { // "compile"
      
      const cmpFp = path.join(rootFp, 'cmp');
      await fs.rm(cmpFp, { recursive: true, force: true });
      await fs.mkdir(cmpFp);
      const { compilerOptions = {} } = JSON.parse(await fs.readFile(path.join(rootFp, 'tsconfig.json')));
      
      // Use `tsc` to generate .d.ts files for all source .ts (excluding .d.ts) source files
      // Generates only a "cjs" directory (which will be copied exactly to "esm")
      await (async () => {
        
        // This function is marked `async` - although tsc is completely sync :(
        
        const outputDir = path.join(cmpFp, 'cjs'); // We copy to cjs, then copy the full subtree to esm
        const target = 'esm';
        const jsonArgs = {
          
          include: [ 'src/**/main.ts', 'src/**/*.main.ts' ],
          compilerOptions: {
            
            ...compilerOptions,
            module:              { cjs: 'CommonJS', esm: 'ESNext' }[target],
            moduleResolution:    'NodeNext',
            declaration:         true,
            emitDeclarationOnly: true,
            declarationDir:      outputDir,
            strict:              true,
            
          }
          
        };
        const programArgs = tsc.parseJsonConfigFileContent(jsonArgs, tsc.sys, rootFp)
        const program = tsc.createProgram({
          rootNames: programArgs.fileNames,
          options:   programArgs.options
        });
        
        const result = program.emit();
        if (result.emitSkipped) throw new Error('tsc declaration failed')[cl.mod]({
          diagnostics: [ ...tsc.getPreEmitDiagnostics(program), ...result.diagnostics ]
            .map(({ file, start, messageText }) => ({
              
              msg: tsc.flattenDiagnosticMessageText(messageText, '\n'),
              ...(file && start && (() => {
                
                const { line, character } = file.getLineAndCharacterOfPosition(start);
                return { fileName, line: line + 1, char: character + 1 };
                
              })())
              
            }))
        });
        
      })();
      
      // Copy all .d.ts files in src to cmp (tsc always excludes .d.ts files)
      await (async () => {
        
        const declarationFiles = await glob('**/*.d.ts', { cwd: path.join(rootFp, 'src') });
        for await (const decFd of declarationFiles) {
          
          const srcFp = path.join(rootFp, 'src', decFd);
          const cmpFp = path.join(rootFp, 'cmp', 'cjs', decFd);
          
          await fs.mkdir(path.dirname(cmpFp), { recursive: true });
          await fs.cp(srcFp, cmpFp);
          
        }
        
      })();
      
      // Now cmp/cjs is fully populated by types, which are used by both cjs and esm
      await fs.cp(
        path.join(rootFp, 'cmp', 'cjs'),
        path.join(rootFp, 'cmp', 'esm'),
        { recursive: true }
      );
      
      // Transpile typescript to cjs / esm
      await Promise.all([ 'cjs', 'esm' ].map(async target => {
        
        const replaceKey = k => `__esbuild_replace_target_${k.replace(/[^a-zA-Z0-9_$]/g, '_')}`;
        const replacements = {
          'import.meta': '({ url: new URL(__filename).href, dirname: __dirname, filename: __filename })'
        };
        
        const result = await esbuild.build({
          entryPoints: [ 'src/**/main.ts', 'src/**/*.main.ts' ],
          outbase:     path.join(rootFp, 'src'),
          outdir:      path.join(rootFp, 'cmp', target),
          define:      replacements[cl.map]((v, k) => replaceKey(k)),
          logLevel:    'silent',
          bundle:      false,
          minify:      false,
          sourcemap:   false,
          platform:    'node',
          format:      target,
          metafile:    true
        }).catch(cause => err[cl.fire]({ msg: cause.message, ...cause[cl.slice]([ 'errors', 'warnings' ])[cl.map](arr => arr.map(v => v[cl.slice]([ 'text', 'location' ]))) }));
        
        const replace = replacements[cl.mapk]((v, k) => {
          return [ replaceKey(k), v ];
        });
        const replaceReg = new RegExp(replace[cl.toArr]((v, k) => k).join('|').replaceAll('$', '\\$'), 'g');
        await Promise.all(result.metafile.outputs[cl.toArr](async (v, cmpFp) => {
          
          const fp = path.join(rootFp, cmpFp);
          const content = await fs.readFile(fp, 'utf8');
          const replaced = content.replace(replaceReg, term => replace[term]);
          await fs.writeFile(fp, replaced);
          
        }));
        
        await fs.writeFile(
          path.join(cmpFp, target, 'package.json'),
          JSON.stringify({ type: { cjs: 'commonjs', esm: 'module' }[target] })
        );
        
      }));
      
    }
    
  };
  
  if (!{}.hasOwnProperty.call(ops, mode)) {
    
    console.log('Unsupported option', process.argv);
    process.exit(1);
    
  } else {
    
    await ops[mode]();
    
  }
  
})().catch(err => {
  console.log('fatal', err);
  process.exit(1);
});
