import { describe, expect, test } from 'claude-code/testing'
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
    { name: 'keyword inside literal', command: `psql -c "SELECT id FROM t WHERE note = 'DROP TABLE x' LIMIT 1"`, want: [] },
    { name: 'keyword inside comment', command: `psql -c "SELECT 1 -- DELETE FROM users"`, want: [] },
    { name: 'spanner gcloud', command: `gcloud spanner databases execute-sql db --sql="DELETE FROM t WHERE k = 1"`, want: ['DELETE'] },
    { name: 'not a DB CLI', command: `echo "DELETE FROM users"`, want: [] },
  ]
  for (const c of cases) {
    test(c.name, async () => {
      expect(labels(c.command)).toEqual(c.want)
    })
  }
})

describe('tool.check', () => {
  test('asks and toasts on risky SQL even when the engine allows it', async ($, on) => {
    const toasts: string[] = []
    on('tool.check', { tool: 'Bash' }, () => ({ decision: 'allow' }))
    on('ui.toast', (_$, e, next) => {
      toasts.push(e.text)
      return next(e)
    })

    const got = await $.tool.check({ tool: 'Bash', input: { command: 'psql -c "DELETE FROM users"' } })

    expect(got.decision).toBe('ask')
    expect(got.reason).toBe('query-guard: destructive: DELETE without WHERE')
    expect(toasts).toEqual(['query-guard: destructive: DELETE without WHERE'])
  })

  test('keeps the engine verdict for safe SQL', async ($, on) => {
    on('tool.check', { tool: 'Bash' }, () => ({ decision: 'allow' }))

    const got = await $.tool.check({ tool: 'Bash', input: { command: 'psql -c "SELECT id FROM t WHERE id = 1 LIMIT 1"' } })

    expect(got.decision).toBe('allow')
  })

  test('keeps a deny from beneath', async ($, on) => {
    on('tool.check', { tool: 'Bash' }, () => ({ decision: 'deny', reason: 'blocked' }))

    const got = await $.tool.check({ tool: 'Bash', input: { command: 'psql -c "DROP TABLE t"' } })

    expect(got).toEqual({ decision: 'deny', reason: 'blocked' })
  })
})
