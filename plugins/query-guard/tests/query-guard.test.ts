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
