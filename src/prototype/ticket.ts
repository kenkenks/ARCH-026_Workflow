/** ARCH-026 Ticket: business case metadata, independent of workflow engine. */
export type TicketStatus = 'DRAFT'|'OPEN'|'IN_PROGRESS'|'COMPLETED'|'CANCELLED';
export interface Ticket {
  ticketId: string; title: string; description: string; createdBy: string;
  createdAt: string; updatedAt: string; ownerId: string; dueAt: string|null;
  status: TicketStatus; workflowId: string|null; workflowVersion: string|null;
  executionId: string|null; parentTicketId: string|null;
}
export interface TicketInput { title: string; description?: string; createdBy: string; ownerId: string; dueAt?: string|null; parentTicketId?: string|null; }
export interface ITicketRepository { get(id:string):Ticket|undefined; list():Ticket[]; save(ticket:Ticket):void; }
export class CMemoryTicketRepository implements ITicketRepository {
  private readonly items=new Map<string,Ticket>();
  get(id:string):Ticket|undefined { const t=this.items.get(id);return t?{...t}:undefined; }
  list():Ticket[]{return [...this.items.values()].map(t=>({...t}));}
  save(ticket:Ticket):void{this.items.set(ticket.ticketId,{...ticket});}
}
export class TicketValidationError extends Error {
  readonly code='INVALID_ARGUMENT'; readonly status=400;
  constructor(){super('Ticket input is invalid');this.name='TicketValidationError';}
}
function inputObject(value:unknown):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new TicketValidationError();}
function requiredText(value:unknown):asserts value is string{if(typeof value!=='string'||!value.trim())throw new TicketValidationError();}
function validDate(year:number,month:number,day:number):boolean{
 const leap=year%4===0&&(year%100!==0||year%400===0);
 return month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}
export class CTicketManager {
  private seq=0;
  constructor(private readonly repo:ITicketRepository,private readonly now:()=>string=()=>new Date().toISOString()){}
  create(input:TicketInput):Ticket {
    inputObject(input);requiredText(input.title);requiredText(input.createdBy);requiredText(input.ownerId);
    this.validateFields(input);
    if(input.parentTicketId!=null)requiredText(input.parentTicketId);
    if(input.parentTicketId && !this.repo.get(input.parentTicketId))throw new TicketValidationError();
    const at=this.now();let id:string;
    do {id=`WF-${at.slice(0,4)}-${String(++this.seq).padStart(6,'0')}`;}while(this.repo.get(id));
    const ticket:Ticket={ticketId:id,title:input.title.trim(),description:input.description??'',createdBy:input.createdBy.trim(),createdAt:at,updatedAt:at,ownerId:input.ownerId.trim(),dueAt:input.dueAt??null,status:'DRAFT',workflowId:null,workflowVersion:null,executionId:null,parentTicketId:input.parentTicketId??null};
    this.repo.save(ticket);return {...ticket};
  }
  get(id:string):Ticket|undefined{requiredText(id);return this.repo.get(id);}
  list():Ticket[]{return this.repo.list();}
  edit(id:string,patch:Partial<Pick<Ticket,'title'|'description'|'ownerId'|'dueAt'>>):Ticket{
    inputObject(patch);this.validateFields(patch);
    const t=this.required(id);if(t.status==='CANCELLED'||t.status==='COMPLETED')throw Error('Closed ticket cannot be edited');
    if(patch.title!==undefined)t.title=patch.title.trim();
    if(patch.ownerId!==undefined)t.ownerId=patch.ownerId.trim();
    if(patch.description!==undefined)t.description=patch.description;
    if(patch.dueAt!==undefined)t.dueAt=patch.dueAt;
    return this.persist(t);
  }
  submit(id:string):Ticket{const t=this.required(id);if(t.status!=='DRAFT')throw Error('Only draft can be submitted');t.status='OPEN';return this.persist(t);}
  attachWorkflow(id:string,workflowId:string,version:string,executionId:string):Ticket{
    const t=this.required(id);if(t.status!=='OPEN')throw Error('Ticket must be OPEN');
    requiredText(workflowId);requiredText(version);requiredText(executionId);
    if(this.repo.list().some(x=>x.ticketId!==id&&x.executionId===executionId))throw Error('Execution already linked');
    t.workflowId=workflowId;t.workflowVersion=version;t.executionId=executionId;t.status='IN_PROGRESS';return this.persist(t);
  }
  complete(id:string):Ticket{const t=this.required(id);if(t.status!=='IN_PROGRESS'&&t.status!=='OPEN')throw Error('Ticket is not active');t.status='COMPLETED';return this.persist(t);}
  cancel(id:string):Ticket{const t=this.required(id);if(t.status==='COMPLETED'||t.status==='CANCELLED')throw Error('Ticket already closed');t.status='CANCELLED';return this.persist(t);}
  private required(id:string):Ticket{requiredText(id);const t=this.repo.get(id);if(!t)throw Error(`Ticket not found: ${id}`);return {...t};}
  private persist(t:Ticket):Ticket{t.updatedAt=this.now();this.repo.save(t);return {...t};}
  private validateFields(value:{title?:unknown;description?:unknown;ownerId?:unknown;dueAt?:unknown}):void{
    if(value.title!==undefined)requiredText(value.title);
    if(value.ownerId!==undefined)requiredText(value.ownerId);
    if(value.description!==undefined&&typeof value.description!=='string')throw new TicketValidationError();
    this.validateDue(value.dueAt);
  }
  private validateDue(due:unknown):void{
    if(due===undefined||due===null)return;
    if(typeof due!=='string')throw new TicketValidationError();
    // Preserve local ISO date-times, Z and numeric offsets, with optional seconds.
    const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?$/.exec(due);
    if(!m||!validDate(+m[1],+m[2],+m[3])||+m[4]>24||+m[5]>59||+(m[6]??0)>59||
      (+m[4]===24&&(+m[5]!==0||+(m[6]??0)!==0||/[1-9]/.test(m[7]??'')))||
      (m[8]!==undefined&&(+m[9]>23||+m[10]>59))||Number.isNaN(Date.parse(due)))throw new TicketValidationError();
  }
}
