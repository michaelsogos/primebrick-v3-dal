---
trigger: always_on
---

# Devin Rule: Data Model Conventions

## Trigger
- Applies to ALL code in this repository that defines, reads, or returns data models: entities, DALs, services, routers, DTOs, JSON API responses.

## Canonical doc
**`docs/ai/data-model-conventions.md` — read it before acting.** This file is a
pointer; the normative text lives in the canonical doc.

## Enforcement
- AI agent MUST use `snake_case` for all new TS interfaces, types, entity fields, JSON response fields, and FE types.
- AI agent MUST NOT create DTO classes/interfaces that rename fields between DB and TS models.
- AI agent MUST NOT add lowercasing/uppercasing/trimming on the read path — only at the write/upsert path.
- AI agent MUST NOT add fallback string-literal defaults (`|| "..."`, `?? ""`) for configuration data.
- AI agent MUST spread raw DB results (`...settings`) instead of field-by-field rebuilding, unless a field needs a real type conversion.
- When reviewing existing code, flag any camelCase field names in entity-shaped JSON responses as violations.
