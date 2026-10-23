# Host retry: verified diagnosis and remaining deployment

Host: ai.kdone.ddns.net. Existing admin session used for read-only audit inspection and one SELECT retry. The service restart API was invoked once; no business records or UI answers were replaced.

## Observed evidence

- Audit a497b785-aeb0-412b-8029-37839c0f8739: detail/header/customer SQL rejected with JOIN_SCOPE_DENIED for dbo.m_customer. After get_join_path, repeated schema discovery exhausted context before a successful read.
- Audit a620d941-1bd6-4890-814b-702d75659951: repeated discovery, missing SQL and requested fields, CONTEXT_BUDGET_EXCEEDED.
- Frontend already contained reasoning-resume-v2; a frontend cache refresh alone cannot resolve the backend failures.
- Restart API returned 202. Subsequent real retry audit 19d99141-25bb-41be-b021-8ca267631f43 returned SUCCESS, but inspection of SQL showed only CustomerCode filtering, no PeriodID=20, and mixed periods 18/19/20. This is NOT an accepted fix.

## Generic correction prepared locally

Semantic review now binds explicitly requested equality constraints to authorized physical columns, with exact evidence from the original question. The request and final evidence checks require these predicates in the mandatory WHERE conjunction, including related tables; a broader TOP preview, wrong table alias, changed value or OR bypass cannot satisfy them. No hard-coded customer, table or period branch was added. Unicode SQL string literals are supported by the existing scope validator.

Local real-provider rerun of the exact question returned SUCCESS and four rows, all PeriodID=20. SQL used detail->header->customer and both CustomerCode and PeriodID predicates. Includes old/new indices, multiplier, quantity, price, before-tax/VAT/after-tax amounts. Private evidence: output/ipms-electricity-audit-20261023/host-detail-local-repro-{live,audits}.private.json.

Checks: 1,095 tests; 1,081 passed, zero failed, 14 skipped. New regression cases cover missing/changed qualifiers, related-table provenance, OR bypass, hidden columns, ungrounded values and final completion rejection of successful but broader SQL.

## Deployment state

User confirms host deployment uses git pull followed by restart. Web admin can restart but cannot git pull or install backend files. These new predicate checks are local workspace changes and have NOT been installed on the host. Repository publication and host deployment remain necessary before claiming the host bug fixed.
