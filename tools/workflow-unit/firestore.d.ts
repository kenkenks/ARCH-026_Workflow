import type {Firestore, DocumentReference, Timestamp} from '@google-cloud/firestore';
import type {IWaitingHistoryStore,RunSnapshot,PrototypeDefinition,ProductShelf,reconstructWorkflow} from './index';
import type {LifecycleOptions,LifecycleRow,LeaseOwner,WaitingClaim} from './waiting';
import type {WaitingOperation} from './index';
export {Timestamp,FieldValue} from '@google-cloud/firestore';
export interface EmulatorEnvironment {FIRESTORE_EMULATOR_HOST:string;projectId:string;namespace:string}
export interface EmulatorConnection {db:Firestore;root:DocumentReference;close():Promise<void>}
export class PersistenceError extends Error {code:string}
/** @deprecated Retained for the 0.1 experimental entry's compatibility. */
export function fail(code:string):never;
export function validateEnvironment(environment:EmulatorEnvironment):EmulatorEnvironment;
export function connectEmulator(environment:EmulatorEnvironment):Promise<EmulatorConnection>;
export function leaseValid(expires:Timestamp,readTime:Timestamp):boolean;
export function hash(value:unknown):string;
export interface Observation {state:'APPLIED'|'NOT_APPLIED'|'UNKNOWN';scope:'MUTATION'|'RESUME_CLAIM';reason?:string;receipt?:Record<string,unknown>}
export class FirestoreWaitingStore implements IWaitingHistoryStore {
 constructor(connection:EmulatorConnection,options:LifecycleOptions);
 readonly products:ProductShelf;readonly poisoned:boolean;readonly lastMutationId:string|undefined;
 read():Promise<LifecycleRow|undefined>;
 load(runId:string):Promise<RunSnapshot|undefined>;
 save(snapshot:RunSnapshot):Promise<void>;
 claimStart(operationId?:string):Promise<LifecycleRow>;
 claimWaiting(saved:RunSnapshot,operation:WaitingOperation):Promise<WaitingClaim>;
 claimLimit(saved:RunSnapshot,operationId?:string):Promise<LifecycleRow>;
 heartbeat():Promise<LeaseOwner>;
 getInput():unknown;
 observeMutation(id:string):Promise<Observation>;
 observeOperation(operation:WaitingOperation,options?:{sealAbsent?:boolean}):Promise<Observation>;
}
/** Retained legacy v1 API. Does not implement the WAITING lifecycle Port. */
export class FirestoreExperimentStore {
 constructor(connection:EmulatorConnection,runId:string,options?:{leaseMs?:number});
 add(definition:PrototypeDefinition):Promise<void>;get(id:string,version:string):Promise<PrototypeDefinition|null>;
 claim(ownerId:string,options?:{administrativeTakeover?:boolean}):Promise<{ownerId:string;token:string;fence:number}>;
 load(runId:string):Promise<RunSnapshot|undefined>;inspect():Promise<Record<string,unknown>>;
 commit(changes:Record<string,unknown>,options?:Record<string,unknown>):Promise<{digest:string;revision:number}>;
 heartbeat():Promise<unknown>;release():Promise<unknown>;observeMutation(id:string):Promise<unknown>;
}
export function createExecution(store:FirestoreExperimentStore,definition:PrototypeDefinition,forms:ReadonlyMap<string,unknown>,checks?:ReadonlyMap<string,unknown>,options?:{resume?:boolean;observe?:(event:unknown)=>void|Promise<void>}):Promise<{
 products:ProductShelf;graph:ReturnType<typeof reconstructWorkflow>;bindings:unknown[];artifacts:unknown[];run(max?:number):Promise<RunSnapshot>
}>;
