import type { CheckResult, StepDefinition, WorkflowDefinition, WorkflowEvent, WorkflowInstance } from '../core/types.js';
export interface DefinitionRepository {
  get(id: string, version: string): Promise<WorkflowDefinition | null>;
}
export interface InstanceRepository {
  get(id: string): Promise<WorkflowInstance | null>;
  /** Must use optimistic concurrency or transaction in concrete adapter. */
  save(instance: WorkflowInstance, expectedRevision: string): Promise<string>;
}
export interface JobExecutor {
  /** Human tasks may return WAITING rather than execute immediately. */
  execute(step: StepDefinition, instance: WorkflowInstance): Promise<'COMPLETED' | 'WAITING'>;
}
export interface CheckExecutor {
  evaluate(step: StepDefinition, instance: WorkflowInstance): Promise<CheckResult>;
}
export interface EventPublisher { publish(event: WorkflowEvent): Promise<void>; }
export interface EventDeduplication { claim(eventId: string): Promise<boolean>; }
export interface RouteGuard {
  authorize(guardId: string, event: WorkflowEvent, instance: WorkflowInstance): Promise<boolean>;
}
