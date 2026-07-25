---
trigger: always_on
---

# Devin Rule: Data Model Conventions

## Trigger
- Applies to ALL code in this repository that defines, reads, or returns data models: entities, DALs, services, routers, DTOs, JSON API responses.

## Golden Rules

### 1. Snake_case everywhere — maximum portability
- DB columns, TS interfaces/types, JSON request bodies, JSON response bodies, FE types — ALL use `snake_case`.
- A field named `oidc_issuer_url` in the DB must be `oidc_issuer_url` in the TS interface, `oidc_issuer_url` in the JSON response, and `oidc_issuer_url` in the FE type.
- NEVER rename `oidc_issuer_url` → `oidcIssuerUrl` (camelCase) between layers. The name is identical from DB to FE.
- **Exception:** External API adapters (e.g. Casdoor™ REST API expects `clientId` as a query param). The camelCase is dictated by the external API, not by our convention. The translation happens ONLY at the adapter boundary, never in our internal data flow.

### 2. No DTO transformation between DB models and TS models
- If the DB returns `{ oidc_issuer_url, casdoor_endpoint, auth_mode }`, the TS interface is `{ oidc_issuer_url, casdoor_endpoint, auth_mode }` — NOT a rebuilt object with renamed fields.
- Do NOT create intermediate DTO classes/interfaces that rename fields between the DB row and the internal TS model. The DB row IS the TS model.
- Prefer spreading the raw result (`return { ...settings, <overrides> }`) over field-by-field rebuilding (`return { fieldA: row.field_a, fieldB: row.field_b, ... }`).

### 3. No transformation unless it's a real TYPE conversion
- ALLOWED: `string` (DB) → `boolean` (TS) via `=== "true"`. This is a type conversion, not data-quality enforcement.
- ALLOWED: `string` (DB) → `enum` (TS) via validation + normalization (e.g. uppercase for enum comparison). This is type safety, not data-quality enforcement.
- FORBIDDEN: Lowercasing, uppercasing, trimming, or any data-quality normalization on the READ path. Data quality is enforced at the WRITE path (FE form validation + BE API upsert validation). The read path returns exactly what the DB has.
- FORBIDDEN: Fallback defaults on the read path (e.g. `|| "http://localhost:8000"`, `?? ""`). A value either exists in the DB or it doesn't — `undefined` if missing, `null` if the row exists but value is NULL, `string` if present. Mandatory-field checks throw before the return, they don't fake a default.

### 4. JSON API responses: snake_case for entity-shaped responses
- If a JSON response represents an entity or an array of entities, the field names MUST be `snake_case` — matching the DB column names and the TS entity interface.
- Example: `res.json({ available, email, existing_uuid })` — correct. `res.json({ available, email, existingUuid })` — WRONG.
- Do NOT create a DTO layer in the router that renames entity fields to camelCase before `res.json()`. If the entity is already snake_case, pass it through directly.
- If the response is a computed shape (not an entity), field names are still snake_case for consistency.

### 5. No fake defaults for configuration data
- AUTH CONFIG, IDP config, gateway config — these are NOT "nice to have". Either the value is in the DB or the system is misconfigured.
- NEVER mix real config data with fake fallback defaults (`|| "ACME"`, `|| "x-gateway-secret"`). A fake config that looks valid but points to the wrong IDP is worse than a clear error.
- Mandatory fields: validate in a check block before the return, throw if missing. Optional fields: stay `undefined` if missing.

## Enforcement
- AI agent MUST use `snake_case` for all new TS interfaces, types, entity fields, JSON response fields, and FE types.
- AI agent MUST NOT create DTO classes/interfaces that rename fields between DB and TS models.
- AI agent MUST NOT add lowercasing/uppercasing/trimming on the read path — only at the write/upsert path.
- AI agent MUST NOT add fallback string-literal defaults (`|| "..."`, `?? ""`) for configuration data.
- AI agent MUST spread raw DB results (`...settings`) instead of field-by-field rebuilding, unless a field needs a real type conversion.
- When reviewing existing code, flag any camelCase field names in entity-shaped JSON responses as violations.
