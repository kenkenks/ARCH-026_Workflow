export const ARTIFACT_SNAPSHOT_FORMAT_VERSION = 'artifact-snapshot/1' as const;
export const ARTIFACT_SNAPSHOT_CODEC_VERSION = 'artifact-json/1' as const;
export type EncodedArtifactValue =
  | {type:'undefined'|'null'}
  | {type:'boolean';value:boolean}
  | {type:'string';value:string}
  | {type:'number';value:number|'-0'}
  | {type:'array';value:EncodedArtifactValue[]}
  | {type:'object';value:Array<{key:string;value:EncodedArtifactValue}>};
export interface ArtifactSnapshot {
  formatVersion:typeof ARTIFACT_SNAPSHOT_FORMAT_VERSION;
  codecVersion:typeof ARTIFACT_SNAPSHOT_CODEC_VERSION;
  boxes:Array<{name:string;entries:Array<{key:string;encodedValue:EncodedArtifactValue}>}>;
}
function fail():never{throw Object.assign(new Error('Invalid or unsupported artifact snapshot'),{code:'INVALID_ARTIFACT_SNAPSHOT'});}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
// Ordinary JSON data only. Reflection on arbitrary Proxies can still execute traps;
// Proxy inputs are unsupported and this is not a hostile-code sandbox.
class Guard {
  private readonly ancestors=new Set<object>();
  private count=0;
  enter(value:unknown,depth:number){if(depth>128||++this.count>100000)fail();if(value&&typeof value==='object'){if(this.ancestors.has(value))fail();this.ancestors.add(value);}}
  leave(value:unknown){if(value&&typeof value==='object')this.ancestors.delete(value);}
}
function record(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
  const result:Record<string,unknown>=Object.create(null),keys=Reflect.ownKeys(value);
  for(let i=0;i<keys.length;i++){const key=keys[i],d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d||!('value'in d)||!d.enumerable)fail();result[key]=d.value;}
  return result;
}
function exact(value:unknown,keys:string[]):Record<string,unknown>{const result=record(value);if(Object.keys(result).length!==keys.length)fail();for(let i=0;i<keys.length;i++)if(!Object.hasOwn(result,keys[i]))fail();return result;}
/** Detached own data values only; never read an input method, index getter or iterator. */
function array(value:unknown):unknown[]{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)fail();
  const length=Object.getOwnPropertyDescriptor(value,'length');
  if(!length||!('value'in length)||!Number.isSafeInteger(length.value)||length.value<0||length.value>100000||Reflect.ownKeys(value).length!==length.value+1)fail();
  const result:unknown[]=[];
  for(let i=0;i<length.value;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable)fail();result.push(d.value);}
  return result;
}
/** Internal boundary for the optional declaration list passed to the restore Factory. */
export function snapshotBoxDeclarations(value:unknown):string[]{const values=array(value),result:string[]=[];for(let i=0;i<values.length;i++){boxName(values[i]);result.push(values[i] as string);}return result;}
function text(value:unknown):asserts value is string{if(typeof value!=='string')fail();}
function boxName(value:unknown):asserts value is string{text(value);if(!value.trim())fail();try{encodeURIComponent(value);}catch{fail();}}
export function encodeArtifactValue(value:unknown):EncodedArtifactValue {
  const guard=new Guard();
  function visit(v:unknown,depth:number):EncodedArtifactValue{
    guard.enter(v,depth);
    try{
      if(v===undefined)return {type:'undefined'};
      if(v===null)return {type:'null'};
      if(typeof v==='boolean')return {type:'boolean',value:v};
      if(typeof v==='string')return {type:'string',value:v};
      if(typeof v==='number'){if(!Number.isFinite(v))fail();return {type:'number',value:Object.is(v,-0)?'-0':v};}
      if(Array.isArray(v)){const items=array(v),result:EncodedArtifactValue[]=[];for(let i=0;i<items.length;i++)result.push(visit(items[i],depth+1));return {type:'array',value:result};}
      const data=record(v),keys=Object.keys(data).sort(compare),result:Array<{key:string;value:EncodedArtifactValue}>=[];
      for(let i=0;i<keys.length;i++)result.push({key:keys[i],value:visit(data[keys[i]],depth+1)});
      return {type:'object',value:result};
    }finally{guard.leave(v);}
  }
  return visit(value,0);
}
export function decodeArtifactValue(value:unknown):unknown {
  const guard=new Guard();
  function visit(v:unknown,depth:number):unknown{
    guard.enter(v,depth);
    try{
      const data=record(v);
      if(data.type==='undefined'||data.type==='null'){exact(data,['type']);return data.type==='undefined'?undefined:null;}
      exact(data,['type','value']);
      switch(data.type){
        case 'boolean':if(typeof data.value!=='boolean')fail();return data.value;
        case 'string':text(data.value);return data.value;
        case 'number':if(data.value==='-0')return -0;if(typeof data.value!=='number'||!Number.isFinite(data.value)||Object.is(data.value,-0))fail();return data.value;
        case 'array':{const items=array(data.value),result:unknown[]=[];for(let i=0;i<items.length;i++)result.push(visit(items[i],depth+1));return result;}
        case 'object':{
          const items=array(data.value),result:Record<string,unknown>={},seen=new Set<string>();
          for(let i=0;i<items.length;i++){const entry=exact(items[i],['key','value']);text(entry.key);if(seen.has(entry.key))fail();seen.add(entry.key);
            // Define data properties, including __proto__/constructor/prototype, without setters.
            Object.defineProperty(result,entry.key,{value:visit(entry.value,depth+1),enumerable:true,writable:true,configurable:true});}
          return result;
        }
        default:return fail();
      }
    }finally{guard.leave(v);}
  }
  return visit(value,0);
}
/** Validates unknown input and returns a detached, canonical JSON-safe snapshot. */
export function validateArtifactSnapshot(input:unknown):ArtifactSnapshot {
  const data=exact(input,['formatVersion','codecVersion','boxes']);
  if(data.formatVersion!==ARTIFACT_SNAPSHOT_FORMAT_VERSION||data.codecVersion!==ARTIFACT_SNAPSHOT_CODEC_VERSION)fail();
  const items=array(data.boxes),names=new Set<string>(),boxes:ArtifactSnapshot['boxes']=[];let entries=0;
  for(let i=0;i<items.length;i++){
    const box=exact(items[i],['name','entries']);boxName(box.name);if(names.has(box.name))fail();names.add(box.name);
    const entryItems=array(box.entries),keys=new Set<string>(),values:ArtifactSnapshot['boxes'][number]['entries']=[];
    for(let j=0;j<entryItems.length;j++){
      if(++entries>100000)fail();const entry=exact(entryItems[j],['key','encodedValue']);text(entry.key);if(keys.has(entry.key))fail();keys.add(entry.key);
      values.push({key:entry.key,encodedValue:encodeArtifactValue(decodeArtifactValue(entry.encodedValue))});
    }
    boxes.push({name:box.name,entries:values.sort((a,b)=>compare(a.key,b.key))});
  }
  if(!names.has('default'))fail();
  return {formatVersion:ARTIFACT_SNAPSHOT_FORMAT_VERSION,codecVersion:ARTIFACT_SNAPSHOT_CODEC_VERSION,boxes:boxes.sort((a,b)=>compare(a.name,b.name))};
}
