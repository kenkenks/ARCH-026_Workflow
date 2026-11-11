import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadRegistry,resolveSafe} from './registry.mjs';
import {scan,loadEvidence} from './scanner.mjs';
import {verify} from './verifier.mjs';
import {summarize} from './status.mjs';
import {report} from './reporter.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
try{
 const command=process.argv[2];if(process.argv.length!==3||!['scan','status','verify','report'].includes(command))throw Error('Usage: scan|status|verify|report');
 let registry=loadRegistry(root),evidence=loadEvidence(root);
 if(command==='verify'){({registry,evidence}=verify(root,registry,evidence));for(const [id,r]of Object.entries(evidence.groups)){console.log(id+': '+r.outcome+'\n'+r.log);if(r.outcome!=='PASS')process.exitCode=1;}}
 const result=scan(root,registry,evidence);
 if(command==='report'){const dir=resolveSafe(root,'Migration/reports');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(resolveSafe(root,'Migration/reports/status.md'),report(result));console.log('Migration/reports/status.md');}
 else console.log(JSON.stringify(command==='scan'?result:summarize(result),null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
