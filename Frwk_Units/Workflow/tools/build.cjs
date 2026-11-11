'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function inputs(){const result={};function read(name){const absolute=path.join(root,name);if(fs.statSync(absolute).isDirectory()){for(const n of fs.readdirSync(absolute).sort())read(name+'/'+n);}else result[name]=crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');}for(const p of ['src','tsconfig.json','package.json','tools/build.cjs'])read(p);return result;}
const before=inputs(),r=spawnSync(process.execPath,[require.resolve('typescript/bin/tsc'),'-p',path.join(root,'tsconfig.json')],{cwd:root,stdio:'inherit',windowsHide:true});
if(r.status!==0)process.exit(r.status||1);
if(JSON.stringify(before)!==JSON.stringify(inputs()))throw Error('BUILD_INPUT_CHANGED');
fs.writeFileSync(path.join(root,'dist/build-inputs.json'),JSON.stringify({compiler:require('typescript/package.json').version,files:before},null,2)+'\n');
