import {createMemoryProductShelf} from './CJobForm';
import type {ProductReader,ProductShelf,ArtifactReadPort} from './CJobForm';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function name(value:unknown):asserts value is string{if(typeof value!=='string'||!value.trim())fail('INVALID_ARTIFACT_BOX');}
/** One Memory artifact region per execution. It never retains a Workflow or business Repository. */
export class ArtifactManager {
  private readonly shelves=new Map<string,ProductShelf>();
  private readonly readers=new Map<string,ProductReader>();
  private runId:string|null=null;
  private readonly port:ArtifactReadPort;
  constructor(boxes:readonly string[]=[],defaultShelf:ProductShelf=createMemoryProductShelf()){
    if(!Array.isArray(boxes)||!defaultShelf||!['has','get','put'].every(k=>typeof defaultShelf[k as keyof ProductShelf]==='function'))fail('INVALID_ARTIFACT_BOX');
    this.shelves.set('default',defaultShelf);
    for(const box of boxes){name(box);if(this.shelves.has(box))fail('DUPLICATE_ARTIFACT_BOX');this.shelves.set(box,createMemoryProductShelf());}
    for(const [box,shelf]of this.shelves)this.readers.set(box,Object.freeze({has:(key:string)=>shelf.has(key),get:(key:string)=>shelf.get(key)}));
    this.port=Object.freeze({hasBox:(box:string)=>this.hasBox(box),box:(box='default')=>this.reader(box)});
  }
  hasBox(box:string):boolean{return this.shelves.has(box);}
  reader(box='default'):ProductReader{name(box);const value=this.readers.get(box);if(!value)fail('UNKNOWN_ARTIFACT_BOX');return value;}
  shelf(box='default'):ProductShelf{name(box);const value=this.shelves.get(box);if(!value)fail('UNKNOWN_ARTIFACT_BOX');return value;}
  readPort():ArtifactReadPort{return this.port;}
  /** @internal Called only at an execution boundary. A retained manager is not a persistence format. */
  bindRun(id:string):void{name(id);if(this.runId!==null&&this.runId!==id)fail('ARTIFACT_RUN_MISMATCH');this.runId=id;}
  /** @internal Refuse reconstruction with a fresh/serialized replacement after progress was saved. */
  assertResume(id:string):void{if(this.runId!==id)fail('ARTIFACT_RESTORE_UNSUPPORTED');}
}
