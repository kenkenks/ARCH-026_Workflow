# ARCH-026 implementation skeleton (design scaffold, NOT executable workflow)

Source of truth: `docs/architecture/ARCH-026_Workflow_Event_Architecture_統合版.md` (included). Mermaid diagrams and definition tables remain in that document.

## Boundaries

- `src/core`: workflow-neutral definitions, instance types, validation and engine interfaces.
- `src/ports`: infrastructure/business boundary contracts.
- `src/adapters`: placeholder only; inspect existing repository before implementation.
- `src/definitions`: illustrative exam workflow from ARCH-026, not production-approved.
- `tests`: acceptance test plan; tests not implemented.

## Non-negotiable rules

1. Engine does not interpret exam/refund business meaning.
2. Workflow definition and runtime instance/history are separate; instance pins definition version.
3. CHECK type and evaluation result are separate.
4. Provisional rerun does not automatically cancel an application or date.
5. Only applicant withdrawal ends the application; full refund applies to paid fee regardless of reason.
6. Withdrawal halt and refund-complete gating are **proposed**, not approved rules.
7. External refund is never retried blindly; require business-owned idempotency and proof.
8. Event delivery is not authorization; guard checks business conditions.

## Deliberately unresolved

- Exact return type of JOB and CHECK; suspension semantics; downstream invalidation rules.
- Cancellation eligibility (including after exam results) and unpaid-fee handling.
- State machine for branch/interrupt, revision/CAS and transactional event outbox.
- Stop of already running jobs, refund method, payment evidence, notification channels.

This is a structure to hand to Codex for review, not code to deploy. No `npm` scripts are provided intentionally.

## v0.2 Ticket prototype

- `src/prototype/ticket.ts`: CTicketManager, Ticket, ITicketRepository, in-memory repository.
- `tests/ticket.test.ts`: seven ticket tests.
- `gui/`: ticket list/create/submit/edit/start/cancel, connected to the existing demo workflow.
- Ticket data is ephemeral; this is **not** a production-ready approval or ticket system.
