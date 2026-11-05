import type { WorkflowDefinition, WorkflowEvent, WorkflowInstance } from './types.js';
import type { CheckExecutor, JobExecutor, RouteGuard } from '../ports/contracts.js';
/** Skeleton only: deliberately no transitions or side effects implemented. */
export class WorkflowEngine {
  constructor(
    private readonly jobs: JobExecutor,
    private readonly checks: CheckExecutor,
    private readonly guards: RouteGuard,
  ) {}
  async advance(_definition: WorkflowDefinition, _instance: WorkflowInstance): Promise<WorkflowInstance> {
    throw new Error('NOT_IMPLEMENTED: advance; define transition contract and atomic persistence');
  }
  async onEvent(_definition: WorkflowDefinition, _instance: WorkflowInstance, _event: WorkflowEvent): Promise<WorkflowInstance> {
    throw new Error('NOT_IMPLEMENTED: onEvent; guard, deduplication, and concurrency required');
  }
  async retryProvisional(_definition: WorkflowDefinition, _instance: WorkflowInstance, _stepId: string): Promise<WorkflowInstance> {
    throw new Error('NOT_IMPLEMENTED: retry; do not invalidate business records automatically');
  }
}
