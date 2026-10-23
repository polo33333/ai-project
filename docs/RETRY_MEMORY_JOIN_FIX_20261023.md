# Retry context and JOIN execution consistency

## Findings

The retry button sends a new HTTP request and uses a server-authorized answer index. The backend bounded the text history but still read the latest structured memory, pending failure and references. Retrying an older answer could therefore use later results. Failed answers absent from text history also had an unsafe fallback boundary.

JOIN resolution differed between executors: the built-in SQL tool resolves missing/narrow metadata through the permission-filtered verified catalog; the registry SQL tool validated its old plan immediately. This could reject an otherwise verified customer lookup on one execution path.

## Changes

- Retain up to eight pre-request memory checkpoints per conversation, keyed by question and bounded sanitized history. Retry reads an isolated checkpoint, not current pending state or later datasets.
- Older sessions without checkpoints use only the server-bounded transcript and fresh retrieval, with no stale structured references. Missing references may require clarification.
- Successful retry of the latest answer updates memory; older retries do not overwrite later memory. Failed retries do not replace live memory. A concurrent memory change prevents checkpoint commit.
- Failed answers missing from text history anchor retry context to the preceding stored answer.
- Identical repeated question/answer pairs select their corresponding occurrence, not the last matching answer in future history.
- Both stream and JSON routes use the retry memory view and authoritative stored question.
- Both SQL executors use the same catalog resolver, then the existing exact JOIN-key, source permission, visibility, mapped projection and fanout checks. No M_Customer exception or arbitrary JOIN permission was added.

## Verification

Tests cover pre-question restoration, failed/future reference exclusion, repeated identical turns, legacy fallback, older retry isolation, registry JOIN resolution and rejection of invented keys. Full suite: 1,091 tests, 1,077 passed, zero failed, 14 skipped.

Live runner `output/ipms-electricity-audit-20261023/run-retry-check-live.cjs` selects the existing saved UI invoice answer and calls the same JSON endpoint with its real retryMessageIndex. It does not replace UI history. Each attempt must succeed and contain a newly executed SQL call. Results are stored in `retry-check-live.private.json`.

An intermediate repeated live run exposed schema retrieval without a semanticModel skipping intent review. Review now also runs when an authorized typed intentCatalog is available. After that correction, two consecutive real retries succeeded, each executing SUM(FinalTotalAmount) with the verified CustomerID JOIN and CustomerCode filter, returning 6,652,704 VND. This confirms fresh execution, not a cached answer. No database business records were changed.

Local only; no host deployment.
