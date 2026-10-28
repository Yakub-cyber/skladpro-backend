# Invitation security and limited RBAC

Migration 0033 must precede this backend. Upgrade preserves accounts, passwords,
memberships and invitation rows. Every legacy invitation requires reissue. Legacy
plaintext token values are cleared, not converted into accepted credentials. The
legacy token column is constrained to NULL. No global email verification is added.
Old backend writers cannot create plaintext invitations after this migration.

## HTTP

POST /v1/invitations: authenticated admin/manager, body {email,role,name?}.
Only admin may invite admin; cashier is not an invitation role. Returns
{ok,id,token} once. The token is 24 random bytes (32 base64url characters), stored
only as SHA-256. Expiry is seven days. Lists never include token or its hash.

POST /v1/invitations/accept: authenticated user, strict body {token}.
Empty legacy body is rejected. The invitation is locked FOR UPDATE; the user's
active database email must match. Email/JWT alone is never an invitation proof.
Membership insertion and acceptance marker commit together. Same-user replay
returns success but never recreates a removed/inactive membership or changes role.
Revoked, expired, malformed and legacy invitations cannot be newly accepted.

DELETE /v1/invitations/:id: tenant-scoped soft revoke, admin/manager. Accepted rows
cannot be revoked through this endpoint. Accepted/revoked history stays in lists.
The creator transfers a link manually through a trusted channel; no invitation
email is sent. Lost creation response requires a new invitation; the original
secret cannot be retrieved. Previously created links require reissue.

## Browser boundary

The first inline script in index.html removes invite from the hash before analytics
and application imports. A nonenumerable temporary handoff is consumed into module
memory, then deleted. No localStorage, sessionStorage, outbox or diagnostic storage.
Acceptance uses an authenticated POST body, over HTTPS except local loopback tests.
The secret is cleared on successful acceptance. Reload before acceptance loses it:
reopen the original trusted link. URL-sanitization failure does not hand the secret
to application code. Analytics and Sentry are disabled on invitation landing pages.
Webvisor, link tracking and click maps are disabled to avoid recording generated
invitation links on the administrator's page. Clipboard transfer is explicit.

## Server permissions

| Action | admin | manager | stock | courier | existing cashier |
|---|---|---|---|---|---|
| invite non-admin | yes | yes | no | no | no |
| invite admin / change roles | yes | no | no | no | no |
| customer payments/adjustments | yes | yes | no | no | no |
| sale/return | yes | yes | no | no | yes |
| commercial order/edit/cancel | yes | yes | no | no | no |
| warehouse documents/shipment v2 | yes | yes | yes | no | no |
| delivered | yes | yes | no | assigned order only | no |
| company settings | yes | yes | no | no | no |

Legacy shipment can receive money and therefore requires commercial permission;
stock uses only separately validated unpaid-credit shipment v2. Financial algorithms
are unchanged. Stock sync writes are restricted to products, warehouses, cells,
suppliers and invoices; no customer, employee, order or shift writes. Existing
cashier sync can write shifts only. Admin/manager retain the existing whitelist.
All ledger/balance fields remain server-owned and excluded from sync writes.
Unknown membership roles (including owner/warehouse aliases) fail closed. API-key
scope checks and platform super-admin checks remain separate. No cashier invitation
activation or new owner role. Membership authorization is read fresh from PostgreSQL
to observe demotion/revocation across workers; in-flight already authorized requests
are not retroactively revoked. Employee self-registration uses server membership role,
not the requested employee role, and cannot rebind another employee id. Courier
assignments resolve by user id, owned employee id or a unique active courier
membership name; ambiguous names are denied without rewriting the assignment. PIN verification does not grant a new API role.

## Deployment / limits

Use a coordinated backend cutover: pause invitation endpoints, apply 0033,
replace every backend instance, then enable invitation endpoints and release the
frontend. Do not overlap with old accept-by-email backend instances: those ignore
new lifecycle fields and must not serve requests during the migration window.
Old empty accept requests against the new backend fail closed;
old invitation writers fail the no-plaintext constraint. Do not roll back to the old
accept-by-email backend, even though the migration is additive. Do not auto-repair
historical membership or invite rows. Migration tested only on isolated PostgreSQL.
No production deployment or migration is performed. Complete cashier ownership
rules, all read-side data minimization and global email ownership remain separate.


## Files changed in this stage

Frontend (paths relative to skladpro):
- index.html
- src/features/auth/LoginPage.jsx
- src/features/auth/components/CloudLogin.jsx
- src/features/employees/components/InviteModal.jsx
- src/features/employees/components/TeamInvites.jsx
- src/shared/lib/cloud.js
- src/shared/lib/cloudSync.test.js
- src/shared/lib/invitationSecret.js
- src/shared/lib/invitationSecret.test.js
- src/shared/lib/monitoring.js
- src/shared/store/slices/cloudSlice.js
- src/shared/store/slices/invitationFlow.test.js

Backend (paths relative to skladpro-backend):
- sql/migrations/0033_invitation_security.sql
- src/app.ts
- src/lib/permissions.ts
- src/plugins/auth.ts
- src/services/invitations.ts
- src/services/deliveriesV2.ts
- src/routes/auth.ts
- src/routes/companies.ts
- src/routes/customers.ts
- src/routes/documents.ts
- src/routes/orders.ts
- src/routes/pin.ts
- src/routes/returns.ts
- src/routes/sales.ts
- src/routes/sync.ts
- test/companies.test.ts
- test/gdpr-invite.test.ts
- test/orders-returns.test.ts
- test/permissions.test.ts
- test/integration/invitation-security.test.ts
- test/integration/invitation-migrations.test.ts
- test/integration/returns-v2.test.ts
- test/integration/cancellations-v2.test.ts
- docs/invitation-security-rbac.md

The returns rollback test double now preserves Pool.connect's callback overload
because authorization reads memberships on each request. The previous cancellation
migration test counts migration files instead of assuming the chain ends at 0032.
Neither change alters the financial algorithms or posting SQL functions.

## Verification

Final isolated run: backend 692/692, including PostgreSQL integration tests;
frontend 762/762. Backend typecheck passed. Frontend lint: zero errors, 101 warnings.
Production Vite build passed from a fresh temporary source copy without .env files,
using already installed dependencies and public loopback API configuration. The
repository's prior forbidden AI environment variable is preserved and not bypassed
for builds from the original directory. git diff --check passed in both projects.
No real browser E2E was run for this stage; URL bootstrap is tested using the actual
inline script with a JavaScript VM and frontend lifecycle/HTTP boundary tests.
No production migrations, deployment, git add, commit or push were performed.
