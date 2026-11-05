/** ARCH-026: domain-neutral workflow contracts. No business logic here. */
export type StepType = 'JOB' | 'CHECK_FINAL' | 'CHECK_PROVISIONAL' | 'CHECK_WAIT' | 'END';
export type CheckResult = 'PASS' | 'WAIT' | 'REJECT' | 'ERROR';
export type RunStatus = 'ACTIVE' | 'WAITING' | 'BRANCH_PENDING' | 'COMPLETED' | 'FAILED';
export type StepStatus = 'NOT_STARTED' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED';
export interface StepDefinition {
  id: string;
  type: StepType;
  jobId?: string;
  nextStepId?: string;
  retryTargetStepId?: string;
}
export interface EventRoute {
  eventId: string;
  eventType: string;
  targetStepId: string;
  /** A route proposes a transition; authorization is delegated to business guard. */
  guardId: string;
  mode: 'BRANCH' | 'REEVALUATE';
}
export interface WorkflowDefinition {
  id: string;
  version: string;
  startStepId: string;
  steps: StepDefinition[];
  eventRoutes: EventRoute[];
}
export interface StepExecution {
  executionId: string;
  stepId: string;
  status: StepStatus;
  attempt: number;
  recordedAt: string;
  checkResult?: CheckResult;
}
export interface WorkflowInstance {
  id: string;
  definitionId: string;
  definitionVersion: string;
  currentStepId: string;
  status: RunStatus;
  stepExecutions: StepExecution[]; // append-only history; no overwrite
}
export interface WorkflowEvent {
  id: string;
  type: string;
  instanceId: string;
  occurredAt: string;
  payloadRef?: string; // business payload stays outside core
}
