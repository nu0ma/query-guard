# Changelog

## 0.1.0

- Added a `tool.check` hook that inspects SQL passed to DB CLIs (`psql`, `mysql`, `mariadb`, `sqlite3`, `duckdb`, `bq`, `spanner-cli`, `spanner-readonly-cli`, `clickhouse-client`, `gcloud spanner databases execute-sql`) and turns the permission decision into `ask` with a toast when it looks risky
- Added destructive rules: `DELETE`, `UPDATE` without `WHERE`, `DROP`, `ALTER TABLE ... DROP`, `TRUNCATE`
- Added slow-query rules: `SELECT` without `WHERE` or `LIMIT`, `CROSS JOIN`, comma joins without `WHERE`, `LIKE '%...'`, `ORDER BY` without `LIMIT`
