# Local SQL semantic eval fixture

Copy this directory outside the repository and point `KNOWLEDGEHUB_DATA_DIR` to that copy. Add an isolated local-model provider and a SQL source for the dedicated `KnowledgeHubLocalEval` database through the application. Do not put credentials in this fixture or commit them.

Reset only that dedicated database:

```powershell
sqlcmd -S <server> -d KnowledgeHubLocalEval -E -b -i tests/fixtures/sql_server_seed/reset_local_eval.sql
```

Validate the corpus without services:

```powershell
npm run eval:local:semantic
```

Run the live eval after setting the isolated data directory and IDs:

```powershell
$env:KNOWLEDGEHUB_DATA_DIR = 'D:\eval-data\knowledgehub'
$env:LOCAL_SQL_EVAL_PROVIDER_ID = '<provider-id>'
$env:LOCAL_SQL_EVAL_DB_SOURCE_ID = '<db-source-id>'
npm run eval:local:semantic:live -- --repetitions 3 --output artifacts/local-sql-eval.json
```
