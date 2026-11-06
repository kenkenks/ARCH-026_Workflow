# SimpleDB: local SQLite persistence

Requires Node 24 with `node:sqlite` (verified on v24.16.0). No external package.
`node:sqlite` is release candidate in this Node version. Its synchronous I/O can
block the event loop; the Promise Repository API does not make SQLite I/O async.

## Composition

After `npm run build`, use the following CommonJS composition:

```js
const {SimpleDB} = require('./src/adapters/simpledb/database.cjs');
const {STORAGE_SCHEMA, SimpleDBWorkflowDefinitionRepository} =
  require('./src/adapters/workflow-definition/simpledb.cjs');
// Provision once, explicitly, in an existing dedicated directory:
SimpleDB.initialize(dbPath, STORAGE_SCHEMA);
// Subsequent startup: open only. Missing DB or wrong version is an error.
const db = SimpleDB.open(dbPath, STORAGE_SCHEMA, {timeout: 100});
const repository = new SimpleDBWorkflowDefinitionRepository(db);
try {
  // Existing loadWorkflow(repository, id, version, registry, historyStore).
} finally { db.close(); }
```

For Local JSON, inject `LocalWorkflowDefinitionRepository` instead. Core, schema,
registry and DefinitionRepository do not change. Composition owns the connection;
the repository must not close a potentially shared database.

## Responsibilities and storage

`simpledb/database.cjs` handles connection, bound SQL, transactions, errors and
close; it imports no Workflow code. SQL/table definitions belong to the adapter.
Its transaction callback must be synchronous; nested/async transactions are not
supported. Database/schema configuration is trusted composition input, not user SQL.

Physical schema v1 uses application_id `0x41524348` and user_version `1`.
These are independent of logical `prototype-workflow/1` and definitionVersion.
Unknown physical versions are rejected. No automatic Migration is implemented.

`workflow_definitions` stores UTF-8 BLOB ID/Version as a NOT NULL composite primary
key, schema_version TEXT and definition_json TEXT, in a STRICT table. BLOB keys
preserve case, Unicode and embedded NUL without normalization or delimiter joins.
The existing validator checks logical input/output, and reads compare column,
payload and requested identities. Published definitions have add/get only, no
update/delete/upsert. A new content version requires a new definitionVersion.
Direct administrative SQL/file access is outside repository immutability control.

## Consistency and failures

Initialization exclusively creates a new file, then transactionally creates tables
and metadata. Existing files are never overwritten. Normal open checks metadata
and never initializes tables. A concurrent open before provisioning finishes may
fail; publish readiness only after initialize returns successfully.

Each Add is INSERT inside BEGIN IMMEDIATE/COMMIT; duplicate composite primary keys
are rejected by SQLite across processes. No pre-read uniqueness check is used.
The synchronous connection completes an operation before another JS call can use
it. A failed rollback poisons the connection: only close is allowed afterward.

Uses rollback journal and synchronous=FULL at initialization; local storage only.
Do not change journal mode externally. SQLite manages interprocess locks (no custom
lock files). Default busy timeout is 100ms; a lock timeout before writing is
UNAVAILABLE. No application write retry is implemented.

SQLite primary/unique constraint violations map to ALREADY_EXISTS in the generic
layer, then DEFINITION_ALREADY_EXISTS in the repository. Corruption maps to
DATA_CORRUPT; physical version mismatch to STORAGE_SCHEMA_MISMATCH. Other definite
I/O failures map to UNAVAILABLE. Commit errors conservatively map to OUTCOME_UNKNOWN
even if rollback later succeeds. Read-back is state reconciliation, not proof that
one particular operation succeeded. Rollback/close cleanup failures retain the
original classification and fixed-label diagnostics. Public errors contain no OS
message, database path, SQL or raw stack from SQLite.

Normal close and process restart persistence are tested. SQLite crash recovery is
not a tested guarantee against power loss, broken storage or network filesystems.
SQLite's build/runtime capacity limits still apply; logical Schema does not gain
a new ID/record size restriction here. No database export, migration, Instance,
Ticket, history, Firebase or GAS implementation is added.

## Verification

`npm run test:simpledb` builds and runs shared JSON/SQLite Repository scenarios,
separate-process read/race, reconnect, lock, corruption and fault tests. Included
in `npm test`. Test databases live only in unique temporary directories, closed
before removal. Existing database files are never selected for cleanup.
