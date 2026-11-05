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
export class CTicketManager {
  private seq=0;
  constructor(private readonly repo:ITicketRepository,private readonly now:()=>string=()=>new Date().toISOString()){}
  create(input:TicketInput):Ticket {
    if(!input.title?.trim()||!input.createdBy?.trim()||!input.ownerId?.trim())throw Error('title, createdBy and ownerId are required');
    this.validateDue(input.dueAt);
    if(input.parentTicketId && !this.repo.get(input.parentTicketId))throw Error('Parent ticket not found');
    const at=this.now();let id:string;
    do {id=`WF-${at.slice(0,4)}-${String(++this.seq).padStart(6,'0')}`;}while(this.repo.get(id));
    const ticket:Ticket={ticketId:id,title:input.title.trim(),description:input.description??'',createdBy:input.createdBy.trim(),createdAt:at,updatedAt:at,ownerId:input.ownerId.trim(),dueAt:input.dueAt??null,status:'DRAFT',workflowId:null,workflowVersion:null,executionId:null,parentTicketId:input.parentTicketId??null};
    this.repo.save(ticket);return {...ticket};
  }
  get(id:string):Ticket|undefined{return this.repo.get(id);}
  list():Ticket[]{return this.repo.list();}
  edit(id:string,patch:Partial<Pick<Ticket,'title'|'description'|'ownerId'|'dueAt'>>):Ticket{
    const t=this.required(id);if(t.status==='CANCELLED'||t.status==='COMPLETED')throw Error('Closed ticket cannot be edited');
    if(patch.title!==undefined){if(!patch.title.trim())throw Error('title required');t.title=patch.title.trim();}
    if(patch.ownerId!==undefined){if(!patch.ownerId.trim())throw Error('ownerId required');t.ownerId=patch.ownerId.trim();}
    if(patch.description!==undefined)t.description=patch.description;
    if(patch.dueAt!==undefined){this.validateDue(patch.dueAt);t.dueAt=patch.dueAt;}
    return this.persist(t);
  }
  submit(id:string):Ticket{const t=this.required(id);if(t.status!=='DRAFT')throw Error('Only draft can be submitted');t.status='OPEN';return this.persist(t);}
  attachWorkflow(id:string,workflowId:string,version:string,executionId:string):Ticket{
    const t=this.required(id);if(t.status!=='OPEN')throw Error('Ticket must be OPEN');
    if(!workflowId||!version||!executionId)throw Error('Workflow identifiers required');
    if(this.repo.list().some(x=>x.ticketId!==id&&x.executionId===executionId))throw Error('Execution already linked');
    t.workflowId=workflowId;t.workflowVersion=version;t.executionId=executionId;t.status='IN_PROGRESS';return this.persist(t);
  }
  complete(id:string):Ticket{const t=this.required(id);if(t.status!=='IN_PROGRESS'&&t.status!=='OPEN')throw Error('Ticket is not active');t.status='COMPLETED';return this.persist(t);}
  cancel(id:string):Ticket{const t=this.required(id);if(t.status==='COMPLETED'||t.status==='CANCELLED')throw Error('Ticket already closed');t.status='CANCELLED';return this.persist(t);}
  private required(id:string):Ticket{const t=this.repo.get(id);if(!t)throw Error(`Ticket not found: ${id}`);return t;}
  private persist(t:Ticket):Ticket{t.updatedAt=this.now();this.repo.save(t);return {...t};}
  private validateDue(due:string|null|undefined):void{if(due!=null&&(!/^\d{4}-\d{2}-\d{2}T/.test(due)||Number.isNaN(Date.parse(due))))throw Error('dueAt must be ISO date-time');}
}
