import {createMemoryProductShelf} from './CJobForm';
import type {ProductReader,ProductShelf,ArtifactReadPort} from './CJobForm';
import {ARTIFACT_SNAPSHOT_FORMAT_VERSION,ARTIFACT_SNAPSHOT_CODEC_VERSION,encodeArtifactValue,decodeArtifactValue,validateArtifactSnapshot,snapshotBoxDeclarations} from './ArtifactSnapshot';
import type {ArtifactSnapshot} from './ArtifactSnapshot';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function name(value:unknown):asserts value is string{if(typeof value!=='string'||!value.trim())fail('INVALID_ARTIFACT_BOX');}
/** One Memory artifact region per execution. It never retains a Workflow or business Repository. */
export class ArtifactManager {
  private readonly shelves=new Map<string,ProductShelf>();
  private readonly readers=new Map<string,ProductReader>();
  private runId:string|null=null;
  private readonly port:ArtifactReadPort;
  private readonly keys=new Map<string,Set<string>>();
  private readonly externalDefault:boolean;
  private ownedShelf(box:string):ProductShelf{
    const memory=createMemoryProductShelf(),keys=new Set<string>();this.keys.set(box,keys);
    return {has:k=>memory.has(k),get:k=>memory.get(k),put:(k,v)=>{const result=memory.put(k,v);keys.add(k);return result;}};
  }
  constructor(boxes:readonly string[]=[],defaultShelf?:ProductShelf){
    this.externalDefault=defaultShelf!==undefined;
    if(defaultShelf===undefined)defaultShelf=this.ownedShelf('default');
    if(!Array.isArray(boxes)||!defaultShelf||!['has','get','put'].every(k=>typeof defaultShelf[k as keyof ProductShelf]==='function'))fail('INVALID_ARTIFACT_BOX');
    this.shelves.set('default',defaultShelf);
    for(const box of boxes){name(box);if(this.shelves.has(box))fail('DUPLICATE_ARTIFACT_BOX');this.shelves.set(box,this.ownedShelf(box));}
    for(const [box,shelf]of this.shelves)this.readers.set(box,Object.freeze({has:(key:string)=>shelf.has(key),get:(key:string)=>shelf.get(key)}));
    this.port=Object.freeze({hasBox:(box:string)=>this.hasBox(box),box:(box='default')=>this.reader(box)});
  }
  hasBox(box:string):boolean{return this.shelves.has(box);}
  reader(box='default'):ProductReader{name(box);const value=this.readers.get(box);if(!value)fail('UNKNOWN_ARTIFACT_BOX');return value;}
  shelf(box='default'):ProductShelf{name(box);const value=this.shelves.get(box);if(!value)fail('UNKNOWN_ARTIFACT_BOX');return value;}
  readPort():ArtifactReadPort{return this.port;}
  createSnapshot():ArtifactSnapshot{
    if(this.externalDefault)fail('ARTIFACT_SNAPSHOT_EXTERNAL_SHELF');
    return validateArtifactSnapshot({formatVersion:ARTIFACT_SNAPSHOT_FORMAT_VERSION,codecVersion:ARTIFACT_SNAPSHOT_CODEC_VERSION,
      boxes:[...this.shelves].map(([box,shelf])=>({name:box,entries:[...this.keys.get(box)!].map(key=>({key,encodedValue:encodeArtifactValue(shelf.get(key))}))}))});
  }
  /** Fresh, unbound manager only. Does not authorize Workflow resume or change an existing manager. */
  static fromSnapshot(input:unknown,declaredBoxes?:readonly string[]):ArtifactManager{
    const snapshot=validateArtifactSnapshot(input),boxes=snapshot.boxes.map(b=>b.name).filter(n=>n!=='default');
    if(declaredBoxes!==undefined){
      const declarations=snapshotBoxDeclarations(declaredBoxes);
      if(new Set(declarations).size!==declarations.length||declarations.includes('default')||declarations.length!==boxes.length||boxes.some(n=>!declarations.includes(n)))fail('ARTIFACT_SNAPSHOT_BOX_MISMATCH');
    }
    const manager=new ArtifactManager(boxes);
    for(const box of snapshot.boxes)for(const entry of box.entries)manager.shelf(box.name).put(entry.key,decodeArtifactValue(entry.encodedValue));
    return manager;
  }
  /** @internal Called only at an execution boundary. A retained manager is not a persistence format. */
  bindRun(id:string):void{name(id);if(this.runId!==null&&this.runId!==id)fail('ARTIFACT_RUN_MISMATCH');this.runId=id;}
  /** @internal Refuse reconstruction with a fresh/serialized replacement after progress was saved. */
  assertResume(id:string):void{if(this.runId!==id)fail('ARTIFACT_RESTORE_UNSUPPORTED');}
}
