# Adapter boundary

No Firebase / Cloud Run / DAO implementation yet. Codex must inspect the actual repository and reuse its dispatch and DTO/DAO boundaries. Do not invent parallel business APIs.

Required adapters: definition repository, instance repository (CAS/transaction), job/check executor, route guard, event publisher, event deduplication. Refund execution must use a business-owned idempotency key and verified evidence; never retry money movement blindly.
