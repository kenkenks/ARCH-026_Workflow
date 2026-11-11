'use strict';
// Development-only static inspection. No Unit imports this tool at runtime.
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const {createRequire,builtinModules}=require('node:module');
const roots=['Core','Workflow','TimeTrip','DB/Builder','Member'];
const slash=s=>s.split(path.sep).join('/');
function cycles(graph){
  const done=new Set(),stack=[],found=[];
  function visit(n){if(stack.includes(n)){found.push([...stack.slice(stack.indexOf(n)),n]);return;}if(done.has(n))return;stack.push(n);for(const next of graph[n]||[])visit(next);stack.pop();done.add(n);}
  for(const n of Object.keys(graph))visit(n);return found;
}
function references(file){
  const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true),result=[],dynamic=[];
  function visit(n){
    if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))result.push(n.moduleSpecifier.text);
    if(ts.isCallExpression(n)&&((ts.isIdentifier(n.expression)&&n.expression.text==='require')||n.expression.kind===ts.SyntaxKind.ImportKeyword)){
      const arg=n.arguments[0];if(arg&&ts.isStringLiteralLike(arg))result.push(arg.text);else dynamic.push(n.getStart(source));
    }
    ts.forEachChild(n,visit);
  }visit(source);return {result,dynamic};
}
function inspect(root){
  root=path.resolve(root);const errors=[],warnings=[],units=roots.map(dir=>{const base=path.join(root,'Frwk_Units',dir),pkg=JSON.parse(fs.readFileSync(path.join(base,'package.json')));return {dir,base,pkg,files:[]};});
  const owner=file=>units.find(u=>file.startsWith(u.base+path.sep));
  const graph=Object.fromEntries(units.map(u=>[u.pkg.name,[]])),fileGraph={};
  function walk(dir,out){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p,out);else if(/\.(?:ts|js|mjs|cjs)$/.test(p))out.push(p);}}
  for(const u of units){
    walk(path.join(u.base,'src'),u.files);
    for(const name of Object.keys({...u.pkg.dependencies,...u.pkg.peerDependencies}))if(units.some(x=>x.pkg.name===name))graph[u.pkg.name].push(name);
    for(const [entry,value]of Object.entries(u.pkg.exports||{})){
      const target=typeof value==='string'?value:value.require||value.default;
      if(target&&!target.includes('*')&&!fs.existsSync(path.join(u.base,target)))errors.push('MISSING_EXPORT '+u.pkg.name+entry);
    }
    if(!u.pkg.exports)warnings.push('NO_EXPORTS '+u.pkg.name);
    for(const file of u.files){
      const key=slash(path.relative(root,file));fileGraph[key]=[];const refs=references(file);
      for(const n of refs.dynamic)warnings.push('DYNAMIC_IMPORT '+key+':'+n);
      for(const spec of refs.result){
        if(spec.startsWith('node:')||builtinModules.includes(spec))continue;
        if(spec.startsWith('.')){
          const base=path.resolve(path.dirname(file),spec),target=[base,base+'.ts',base+'.js',base+'.mjs',path.join(base,'index.ts')].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
          if(!target){errors.push('MISSING_MODULE '+key+' '+spec);continue;}
          const other=owner(target);if(other&&other!==u){errors.push('PRIVATE_CROSS_UNIT '+key+' '+spec);if(!graph[u.pkg.name].includes(other.pkg.name))graph[u.pkg.name].push(other.pkg.name);}
          fileGraph[key].push(slash(path.relative(root,target)));
        }else{
          const provider=units.find(x=>spec===x.pkg.name||spec.startsWith(x.pkg.name+'/'));
          const name=provider?.pkg.name||(spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0]);
          if(name!==u.pkg.name&&!Object.hasOwn({...u.pkg.dependencies,...u.pkg.peerDependencies},name))errors.push('UNDECLARED_DEPENDENCY '+key+' '+spec);
          if(provider&&provider!==u&&!graph[u.pkg.name].includes(name))graph[u.pkg.name].push(name);
          try{createRequire(path.join(u.base,'package.json')).resolve(spec);}catch{errors.push('UNRESOLVED_PUBLIC_IMPORT '+key+' '+spec);}
        }
      }
    }
  }
  const unitCycles=cycles(graph),fileCycles=cycles(fileGraph);
  for(const c of unitCycles)errors.push('UNIT_CYCLE '+c.join(' -> '));for(const c of fileCycles)errors.push('FILE_CYCLE '+c.join(' -> '));
  return {units:units.map(u=>({name:u.pkg.name,root:slash(path.relative(root,u.base)),exports:u.pkg.exports||null,dependencies:graph[u.pkg.name]})),graph,unitCycles,fileCycles,errors,warnings};
}
module.exports={inspect,cycles};
if(require.main===module){const result=inspect(path.resolve(__dirname,'../..'));console.log(JSON.stringify(result,null,2));if(result.errors.length)process.exitCode=1;}
