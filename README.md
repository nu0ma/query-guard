# query-guard

A Claude Code mod that catches risky SQL before Claude runs it through a DB CLI.

When a Bash command invokes `psql`, `mysql`, `mariadb`, `sqlite3`, `duckdb`, `bq`, `spanner-cli`, `spanner-readonly-cli`, `clickhouse-client` or `gcloud spanner databases execute-sql`, query-guard inspects the SQL in the command. On a match it shows a toast and turns the permission decision into `ask`, so a confirmation dialog appears even when an allow rule would have let the call through. A `deny` from the engine is kept as is.

## Rules

| Severity | Detected |
| --- | --- |
| destructive | `DELETE` (flagged louder without `WHERE`), `UPDATE` without `WHERE`, `DROP TABLE/DATABASE/SCHEMA/INDEX/VIEW/COLUMN`, `ALTER TABLE ... DROP`, `TRUNCATE` |
| possibly slow | `SELECT ... FROM` without `WHERE` or `LIMIT`, `CROSS JOIN`, comma join without `WHERE`, `LIKE '%...'`, `ORDER BY` without `LIMIT` |

Detection is regex-based static analysis with no dependencies; it never connects to a database.

## Limitations

- SQL read from files (`-f file.sql`, `< file.sql`) is not inspected.
- Regex matching can miss or over-report, e.g. a `WHERE` that only appears in a subquery.
- `ask` goes to the current permission mode's decider, so in `bypassPermissions` or auto mode the dialog may not appear (the toast still does).

## Usage

```sh
claude --plugin-dir /path/to/query-guard
```

## Development

```sh
claude plugin validate .
claude plugin test .
```
