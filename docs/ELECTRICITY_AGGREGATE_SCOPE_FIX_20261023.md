# Aggregate measure and temporal scope repair — 23/10/2026

## Observed failures

Audits `d490a222-7805-4972-9af6-4365db27afb8` and `8fdf69ec-92e3-4c35-b9d7-e47adb2a7f60` reproduce the screenshot in an existing conversation.

- The invoice question generated SUM(FinalTotalAmount), then SUM of before-tax/VAT/after-tax invoice amounts. The guard rejected both because the table's fallback metric was TotalQty. This was a stale query contract, not a database or JOIN failure.
- The 24-month anomaly question inherited an unrelated previous upcoming-30-day scope. The authoritative clock consequently allowed only today's date and a date 30 days later. Initial SQL omitted the range; repair SQL used DATEADD, which the literal-only temporal guard also rejected. No query executed successfully.

## Changes

- Semantic review returns the requested physical aggregate measures even when it supplies JOIN SQL. Measures bind only to exposed authorized numeric columns. These replace fallback metrics after planning; the SQL evaluator still requires every bound measure and its aggregation in the actual projection, with physical table provenance.
- A new explicit time scope in the current question prevents inheritance of the preceding question's time scope. Follow-ups without a new scope retain the existing inheritance behavior.
- An unanchored N-month request resolves to N calendar months including the current month, with start inclusive and end exclusive grounded by the backend clock. Both SQL bounds are required. Latest-available requests remain separate. The answer explicitly discloses the range and partial current month; it never silently substitutes older history.
- Failed inference due to absent data stays partial and explains the missing evidence. No fabricated anomaly threshold or zero-filled consumption.

## Live verification

Provider: existing default Gemini; source: existing default IPMS. Same conversation as the screenshot, not a fresh session.

- Invoice KA0021, 2024-02: SUCCESS. Before tax 6,159,911; VAT 492,793; after tax 6,652,704. Independently verified by a read-only aggregate with a customer subquery rather than the generated JOIN.
- 24-month anomaly: SQL executes over 2024-11-01 inclusive to 2026-11-01 exclusive. Zero matching records, independently confirmed by COUNT. The answer states insufficient data and does not conclude no anomalies. PARTIAL reflects the unfulfilled inference, not SQL failure.

Artifacts: `output/ipms-electricity-audit-20261023/electricity-mechanism-fixed-{live,audits}.private.json`, `electricity-mechanism-verified.json`. Runner and verification scripts in the same directory. Local changes only; no host deployment.

Regression coverage includes a harness with stale Qty default and a requested Amount aggregate, hidden/unavailable measures, physical-table provenance, explicit month scope, and both required calendar bounds.
