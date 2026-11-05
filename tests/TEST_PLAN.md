# ARCH-026 Core acceptance tests (not implemented)

- Definition: duplicate Step IDs, missing targets, missing START/END, unreachable paths rejected.
- Normal: S001 -> S013 with JOB, FINAL, PROVISIONAL, WAIT behaviors.
- WAIT: remains pending without event; E002 triggers check reevaluation, not blind refund reexecution.
- PROVISIONAL: S003 rerun while at S007; retain application and date, record append-only execution; assess dependent checks.
- FINAL: ordinary rerun rejected; correction path remains undefined.
- E001: only authorized applicant, eligible instance, once; pending withdrawal stops normal progression (proposed, requires approval).
- Refund: full amount for paid exam fee; no double payment on retries/concurrent requests; refund completion requires evidence.
- Race: duplicate event, concurrent advance/withdrawal, crash between external side effect and state save.
- Definition version: existing instance remains pinned to its original definition.
- Human task: WAITING until external completion event; no fake immediate completion.
