import type {IWaitingHistoryStore, RunSnapshot, WaitingOperation, ProductShelf} from './index';
export interface LifecycleOptions {runId:string;definitionId:string;definitionVersion:string;definitionDigest:string;ownerId?:string;leaseMs?:number}
export interface LeaseOwner {state:'ACTIVE'|'RELEASED';ownerId:string;token:string;fence:number;expiresAt:number}
export interface LifecycleRow {
 schemaVersion:1;runId:string;definitionId:string;definitionVersion:string;definitionDigest:string;revision:number;
 snapshot:RunSnapshot|null;owner:LeaseOwner;updatedAt:string;input:unknown;activeOperationId:string;
 operations:Array<{operationId:string;kind:'START'|'RESUME_WAITING'|'RESUME_LIMIT';status:'RUNNING'|'FINISHED';request?:WaitingOperation;snapshot?:RunSnapshot;revision?:number}>;
 events:Array<{sequence:number;kind:string;at:string;generation?:number;operationId?:string}>;
 products:Array<{key:string;value:unknown}>;
}
export interface WaitingClaim {replayed:boolean;snapshot:RunSnapshot}
/** Volatile process-local storage. No shared backend or test hooks are public. */
export class MemoryWaitingStore implements IWaitingHistoryStore {
 constructor(options:LifecycleOptions);
 readonly products:ProductShelf;readonly poisoned:boolean;
 read():LifecycleRow|undefined;
 load(runId:string):RunSnapshot|undefined;
 save(snapshot:RunSnapshot):void;
 claimStart(operationId?:string):LifecycleRow;
 claimWaiting(saved:RunSnapshot,operation:WaitingOperation):Promise<WaitingClaim>;
 claimLimit(saved:RunSnapshot,operationId?:string):LifecycleRow;
 heartbeat():LeaseOwner;
 getInput():unknown;
}
