import { describe, expect, test } from 'claude-code/testing'
import { CANCEL, RUN } from '../hooks/register.ts'
import { analyze } from '../hooks/sql-rules.ts'

const labels = (command: string) => analyze(command).map(f => f.label)

describe('analyze', () => {
  const cases = [
    { name: 'DELETE without WHERE', command: 'psql -c "DELETE FROM users"', want: ['DELETE without WHERE'] },
    { name: 'DELETE with WHERE', command: `psql -c "DELETE FROM users WHERE id = 1"`, want: ['DELETE'] },
    { name: 'UPDATE without WHERE', command: `mysql -e "UPDATE t SET a = 1"`, want: ['UPDATE without WHERE'] },
    { name: 'UPDATE with WHERE', command: `mysql -e "UPDATE t SET a = 1 WHERE id = 2"`, want: [] },
    { name: 'DROP TABLE', command: `sqlite3 db.sqlite "DROP TABLE t"`, want: ['DROP TABLE'] },
    { name: 'TRUNCATE', command: `psql -c 'TRUNCATE events'`, want: ['TRUNCATE'] },
    { name: 'full scan', command: `bq query --use_legacy_sql=false "SELECT * FROM big"`, want: ['possible full scan (no WHERE / LIMIT)'] },
    { name: 'filtered select', command: `psql -c "SELECT id FROM t WHERE id = 1 LIMIT 1"`, want: [] },
    { name: 'cross join', command: `psql -c "SELECT * FROM a CROSS JOIN b WHERE a.x = 1"`, want: ['cartesian product (CROSS JOIN)'] },
    { name: 'comma join', command: `psql -c "SELECT * FROM a, b LIMIT 10"`, want: ['cartesian product (comma join without WHERE)'] },
    { name: 'leading wildcard', command: `psql -c "SELECT id FROM t WHERE name LIKE '%foo' LIMIT 5"`, want: ['LIKE with leading wildcard'] },
    { name: 'ORDER BY without LIMIT', command: `psql -c "SELECT id FROM t WHERE a = 1 ORDER BY id"`, want: ['ORDER BY without LIMIT'] },
    { name: 'keyword inside a literal still asks', command: `psql -c "SELECT id FROM t WHERE note = 'DROP TABLE x' LIMIT 1"`, want: ['DROP TABLE'] },
    { name: 'keyword inside a comment still asks', command: `psql -c "SELECT 1 -- DELETE FROM users"`, want: ['DELETE without WHERE', 'possible full scan (no WHERE / LIMIT)'] },
    { name: 'MySQL executable comment', command: `mysql -e "/*!50000 DROP TABLE t */"`, want: ['DROP TABLE'] },
    { name: 'spanner gcloud', command: `gcloud spanner databases execute-sql db --sql="DELETE FROM t WHERE k = 1"`, want: ['DELETE'] },
    { name: 'not a DB CLI', command: `echo "DELETE FROM users"`, want: [] },
    { name: 'DB CLI named by echo', command: `echo "run psql -c 'DELETE FROM users'"`, want: [] },
    { name: 'DB CLI named by grep', command: `grep -rn "psql -c 'DELETE FROM users'" docs`, want: [] },
    { name: 'DB CLI named in a heredoc body', command: "cat > notes.md <<'EOF'\n- `psql -c 'DELETE FROM users'` is risky\nEOF", want: [] },
    { name: 'quoted heredoc written to a variable path', command: "cat > $S/notes.md <<'EOF'\nUse `psql -f file.sql`; DROP TABLE is caught\nEOF", want: [] },
    { name: 'heredoc read by a DB CLI', command: "psql <<'EOF'\nDELETE FROM users;\nEOF", want: ['DELETE without WHERE'] },
    { name: 'SQL piped into a DB CLI', command: `echo "DELETE FROM users" | psql`, want: ['DELETE without WHERE'] },
    { name: 'env assignment before the CLI', command: `PGPASSWORD=x psql -c "DROP TABLE t"`, want: ['DROP TABLE'] },
    { name: 'CLI inside docker exec', command: `docker exec -i db psql -c "TRUNCATE t"`, want: ['TRUNCATE'] },
    { name: 'CLI inside bash -c', command: `bash -c "mysql -e 'DROP DATABASE app'"`, want: ['DROP DATABASE'] },
    { name: 'DELETE without FROM (Spanner)', command: `spanner-cli -e "DELETE Singers WHERE TRUE"`, want: ['DELETE'] },
    { name: 'ON DELETE CASCADE is not a DELETE', command: `psql -c "CREATE TABLE c (id INT REFERENCES p ON DELETE CASCADE)"`, want: [] },
    { name: 'ON DUPLICATE KEY UPDATE is not an UPDATE', command: `mysql -e "INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1"`, want: [] },
    { name: 'WHERE only in a subquery', command: `psql -c "UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)"`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE behind --', command: `psql -c "UPDATE t SET a = 1 --WHERE id = 1"`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE behind #', command: `mysql -e "UPDATE t SET a = 1 # WHERE id = 1"`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE inside a dollar-quoted string', command: `psql -c 'UPDATE t SET a = $$ WHERE $$'`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE as a quoted identifier', command: `psql -c 'UPDATE t SET "where" = 1'`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE inside a backslash-escaped string', command: String.raw`mysql -e "UPDATE t SET a = 'x\' WHERE id = 1'"`, want: ['UPDATE without WHERE'] },
    { name: 'multi-table UPDATE', command: `mysql -e "UPDATE a JOIN b ON a.id = b.id SET a.x = 1"`, want: ['UPDATE without WHERE'] },
    { name: 'command substitution inside echo', command: `echo $(psql -c "DROP TABLE t")`, want: ['DROP TABLE'] },
    { name: 'backticks inside echo', command: "echo `mysql -e 'TRUNCATE t'`", want: ['TRUNCATE'] },
    { name: 'process substitution inside grep', command: `grep x <(psql -c "DELETE FROM t")`, want: ['DELETE without WHERE'] },
    { name: 'rg can run a preprocessor', command: `rg --pre psql "DROP TABLE t"`, want: ['DROP TABLE'] },
    { name: 'heredoc run by a shell', command: "bash <<'EOF'\npsql -c \"DROP TABLE t\"\nEOF", want: ['DROP TABLE'] },
    { name: 'heredoc run by ssh', command: "ssh db-host <<'EOF'\nmysql -e 'TRUNCATE t'\nEOF", want: ['TRUNCATE'] },
    { name: 'heredoc piped into a shell', command: "cat <<'EOF' | bash\npsql -c \"DROP TABLE t\"\nEOF", want: ['DROP TABLE'] },
    { name: 'unquoted heredoc expands substitutions', command: "cat > out.txt <<EOF\n$(psql -c \"DROP TABLE t\")\nEOF", want: ['DROP TABLE'] },
    { name: 'backslash before the CLI', command: String.raw`\psql -c "DROP TABLE t"`, want: ['DROP TABLE'] },
    { name: 'quotes inside the CLI name', command: `ps''ql -c "DROP TABLE t"`, want: ['DROP TABLE'] },
    { name: 'CLI held in a variable', command: `X=psql; $X -c "DROP TABLE t"`, want: ['DROP TABLE'] },
    { name: 'heredoc operator right after the CLI', command: "psql<<'EOF'\nTRUNCATE t;\nEOF", want: ['TRUNCATE'] },
    { name: 'WHERE in a later shell argument', command: `psql -c "UPDATE t SET a = 1" -v x="WHERE"`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE in a later --command', command: `psql --command="UPDATE t SET a = 1" --command="SELECT 1 WHERE true"`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE from a parameter expansion', command: `psql -c "UPDATE t SET a = 1 \${UNSET+WHERE}"`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE from a variable', command: `psql -c "UPDATE t SET a = 1 $FILTER"`, want: ['UPDATE without WHERE'] },
    { name: 'WHERE inside a command substitution', command: `psql -c "UPDATE t SET a = 1 $(true WHERE)"`, want: ['UPDATE without WHERE'] },
    { name: 'keyword glued by a parameter expansion', command: `psql -c "\${X:-DROP} TABLE t"`, want: ['DROP TABLE'] },
    { name: 'heredoc script run by a shell later', command: "cat > s.sh <<'EOF'\npsql -c \"DROP TABLE t\"\nEOF\nbash s.sh", want: ['DROP TABLE'] },
    { name: 'heredoc script made executable and run', command: "cat > s.sh <<'EOF'\npsql -c \"DROP TABLE t\"\nEOF\nchmod +x s.sh && ./s.sh", want: ['DROP TABLE'] },
    { name: 'heredoc script run by its path', command: "tee /tmp/s.sh <<'EOF'\nmysql -e 'TRUNCATE t'\nEOF\n/tmp/s.sh", want: ['TRUNCATE'] },
    { name: 'heredoc script sourced', command: "cat > s.sh <<'EOF'\npsql -c \"DROP TABLE t\"\nEOF\n. s.sh", want: ['DROP TABLE'] },
    { name: 'heredoc note then a release', command: "cat > $S/notes.md <<'EOF'\nUse `psql -f file.sql`; DROP TABLE is caught\nEOF\ngh release create v1 --notes-file $S/notes.md", want: [] },
  ]
  for (const c of cases) {
    test(c.name, async () => {
      expect(labels(c.command)).toEqual(c.want)
    })
  }
})

describe('tool.call', () => {
  const RISKY = 'psql -c "DELETE FROM users"'
  const REASON = 'query-guard: destructive: DELETE without WHERE'

  const cases = [
    { name: 'runs risky SQL once the user approves', command: RISKY, answer: RUN, wantAsked: 1, wantRan: true },
    { name: 'denies risky SQL when the user cancels', command: RISKY, answer: CANCEL, wantAsked: 1, wantRan: false },
    { name: 'denies risky SQL when the user types something else', command: RISKY, answer: 'maybe', wantAsked: 1, wantRan: false },
    { name: 'denies risky SQL when the dialog is dismissed', command: RISKY, answer: undefined, wantAsked: 1, wantRan: false },
    { name: 'runs safe SQL without asking', command: 'psql -c "SELECT id FROM t WHERE id = 1 LIMIT 1"', answer: RUN, wantAsked: 0, wantRan: true },
  ]
  for (const c of cases) {
    test(c.name, async ($, on) => {
      const asked: string[] = []
      const ran: string[] = []
      on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
        const question = e.questions[0]?.question ?? ''
        asked.push(question)
        if (c.answer === undefined) return { deny: 'dismissed' }
        return { result: { questions: e.questions, answers: { [question]: c.answer } } }
      })
      on('tool.call', { tool: 'Bash' }, (_$, e) => {
        ran.push(e.command)
        return { result: { stdout: '', stderr: '', interrupted: false } }
      })

      const got = await $.tool.call({ tool: 'Bash', command: c.command })

      expect(asked.length).toBe(c.wantAsked)
      expect(ran.length > 0).toBe(c.wantRan)
      if (!c.wantRan) expect(got).toEqual({ deny: `${REASON}. The user did not approve running it.` })
    })
  }

  test('toasts the reason before asking', async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', (_$, e, next) => {
      toasts.push(e.text)
      return next(e)
    })
    on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))

    await $.tool.call({ tool: 'Bash', command: RISKY })

    expect(toasts).toEqual([REASON])
  })
})
