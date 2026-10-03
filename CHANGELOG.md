# Changelog

## 0.2.3

- Fixed a shell expansion fooling the guard: a `WHERE` that may expand to nothing (`${UNSET+WHERE}`, `$VAR`) no longer counts as the statement's own, and a keyword glued to shell syntax (`${X:-DROP} TABLE t`) is caught by a reading with shell punctuation blanked
- Fixed a script written by a quoted heredoc and run later in the same command (`bash s.sh`, `chmod +x s.sh && ./s.sh`, `/tmp/s.sh`, `. s.sh`) going unchecked: a heredoc body now counts as text only when nothing in the command could run the file it writes

## 0.2.2

- Fixed DB CLIs slipping past the guard inside `echo`, `printf` or `grep` through a command or process substitution (`$(...)`, backticks, `<(...)`), and in a heredoc body run by a shell, `ssh` or a pipe, or expanded because its delimiter is unquoted; a heredoc body now counts as text only when its delimiter is quoted and `cat` or `tee` alone reads it
- Fixed a CLI name written so the shell still runs it going unnoticed: `\psql`, `ps''ql`, `X=psql; $X`, `psql<<EOF`
- Fixed a `WHERE` in a later shell argument (`-v x="WHERE"`, a second `--command`) counting as the statement's own: each shell word, quotes removed, is now checked too, and the strictest reading wins
- Removed `rg` from the commands that only search text, since `rg --pre` runs a program
- Added a note to the README that query-guard is a safety net, not a security boundary, and that a read-only database user is what makes writes impossible

## 0.2.1

- Fixed risky SQL slipping past the guard: a `WHERE` hidden in a comment (`--WHERE`, `# WHERE`), a dollar-quoted or backslash-escaped string, a quoted identifier or a subquery no longer counts as the statement's own; keywords in comments and strings, MySQL's executable `/*! ... */` comments included, now ask instead of being ignored; `DELETE` without `FROM` (Spanner, BigQuery) and multi-table `UPDATE ... JOIN ... SET` are caught; `DROP` of any object asks
- Fixed a command that only names a DB CLI asking for no reason: one in a heredoc body (a release note being written), or in an `echo`, `printf`, `grep` or `rg` command
- Added `pgcli`, `mycli`, `litecli`, `clickhouse client`, `cockroach`, `usql`, `sqlcmd`, `snowsql` and `trino` to the DB CLIs inspected
- Changed `ON DELETE CASCADE`, `ON UPDATE`, `FOR UPDATE` and `ON DUPLICATE KEY UPDATE` to no longer count as a `DELETE` or an `UPDATE`
- Added CI that validates and tests the plugin on every push and pull request, and weekly against the latest Claude Code

## 0.2.0

- Changed the confirmation from a `tool.check` `ask` to a question asked through `$.ui.ask` in a `tool.call` hook, so it appears in every permission mode, auto mode and `bypassPermissions` included; only `Run it` runs the command, and a dismissed dialog or a headless run denies it

## 0.1.0

- Added a `tool.check` hook that inspects SQL passed to DB CLIs (`psql`, `mysql`, `mariadb`, `sqlite3`, `duckdb`, `bq`, `spanner-cli`, `spanner-readonly-cli`, `clickhouse-client`, `gcloud spanner databases execute-sql`) and turns the permission decision into `ask` with a toast when it looks risky
- Added destructive rules: `DELETE`, `UPDATE` without `WHERE`, `DROP`, `ALTER TABLE ... DROP`, `TRUNCATE`
- Added slow-query rules: `SELECT` without `WHERE` or `LIMIT`, `CROSS JOIN`, comma joins without `WHERE`, `LIKE '%...'`, `ORDER BY` without `LIMIT`
