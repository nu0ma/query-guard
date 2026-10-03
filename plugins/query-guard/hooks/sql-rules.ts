export type Severity = 'destructive' | 'slow'

export type Finding = {
  severity: Severity
  label: string
}

const DB_CLIS = [
  'psql',
  'pgcli',
  'mysql',
  'mariadb',
  'mycli',
  'sqlite3',
  'litecli',
  'duckdb',
  'bq',
  'spanner-cli',
  'spanner-readonly-cli',
  'clickhouse-client',
  'cockroach',
  'usql',
  'sqlcmd',
  'snowsql',
  'trino',
]

const DB_CLI = new RegExp(
  `(?:^|[\\s;&|(\`/"'])(?:${DB_CLIS.join('|')})(?=[\\s;&|)"'\`]|$)` +
    '|\\bgcloud\\b[\\s\\S]*?\\bspanner\\s+databases\\s+execute-sql\\b' +
    '|\\bclickhouse\\s+client\\b',
)

// A heredoc body is data unless a DB CLI reads it, so it never makes a command a DB command
const HEREDOC = /(<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g

// Segments that start with these only print or search text
const INERT_SEGMENT = /^\s*(?:echo|printf|grep|rg)\b/

const SHELL_SEGMENT = /;|&&|\|\||\||\n/

const STATEMENT_SEPARATOR = /;|&&|\|\||\||\s-[ce]\s/

// Everything that can hide a WHERE or a LIMIT from the database: comments in any dialect
// (`--`, `#`, `/* */`), strings ('...', "...", `...`, $tag$...$tag$) with backslash
// escapes, and unterminated ones to the end. Masking too much only asks more often.
const OPAQUE =
  /\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*|#[^\n]*|\$(\w*)\$[\s\S]*?(?:\$\1\$|$)|'(?:[^'\\]|\\[\s\S])*(?:'|$)|"(?:[^"\\]|\\[\s\S])*(?:"|$)|`[^`]*(?:`|$)/g

const PARENTHESIZED = /\([^()]*\)/g

const HAS_WHERE = /\bWHERE\b/i
const HAS_LIMIT = /\b(?:LIMIT|TOP|FETCH\s+FIRST)\b/i

// Strips what follows a keyword down to the clauses that apply to it, so a WHERE in a
// comment, a string or a subquery does not count as the statement's own
const ownClauses = (rest: string): string => {
  let text = rest.replace(OPAQUE, ' ')
  for (let prev = ''; prev !== text; ) {
    prev = text
    text = text.replace(PARENTHESIZED, ' ')
  }
  return text
}

// The text after the first match whose prefix group is empty, as in DELETE but not ON DELETE
const afterStatement = (statement: string, pattern: RegExp): string | undefined => {
  for (const m of statement.matchAll(pattern)) {
    if (m[1] === undefined) return statement.slice(m.index + m[0].length)
  }
  return undefined
}

const afterMatch = (statement: string, pattern: RegExp): string | undefined => {
  const m = pattern.exec(statement)
  return m === null ? undefined : statement.slice(m.index + m[0].length)
}

type Rule = {
  severity: Severity
  match: (statement: string) => string | undefined
}

// Keywords are searched in the raw statement, comments and strings included: a database
// can run what looks like a comment (MySQL's /*! ... */) or end a string earlier than a
// regex would, so hiding a keyword from the guard must not be possible
const RULES: readonly Rule[] = [
  {
    severity: 'destructive',
    // FROM is optional in Spanner and BigQuery
    match: s => {
      const rest = afterStatement(s, /\b(ON\s+)?DELETE\b/gi)
      if (rest === undefined) return undefined
      return HAS_WHERE.test(ownClauses(rest)) ? 'DELETE' : 'DELETE without WHERE'
    },
  },
  {
    severity: 'destructive',
    // Covers multi-table forms (UPDATE a JOIN b ... SET) but not ON UPDATE or FOR UPDATE
    match: s => {
      const rest = afterStatement(s, /\b(ON\s+|FOR\s+(?:NO\s+KEY\s+)?)?UPDATE\b/gi)
      if (rest === undefined) return undefined
      const clauses = ownClauses(rest)
      return /\bSET\b/i.test(clauses) && !HAS_WHERE.test(clauses) ? 'UPDATE without WHERE' : undefined
    },
  },
  {
    severity: 'destructive',
    match: s => {
      if (/\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(s)) return 'ALTER TABLE ... DROP'
      const target = /\bDROP\s+(MATERIALIZED\s+VIEW|\w+)/i.exec(s)?.[1]
      return target === undefined ? undefined : `DROP ${target.toUpperCase().replace(/\s+/g, ' ')}`
    },
  },
  {
    severity: 'destructive',
    match: s => (/\bTRUNCATE\b/i.test(s) ? 'TRUNCATE' : undefined),
  },
  {
    severity: 'slow',
    match: s => {
      const rest = afterMatch(s, /\bSELECT\b[\s\S]*?\bFROM\b/i)
      if (rest === undefined) return undefined
      const clauses = ownClauses(rest)
      return HAS_WHERE.test(clauses) || HAS_LIMIT.test(clauses) ? undefined : 'possible full scan (no WHERE / LIMIT)'
    },
  },
  {
    severity: 'slow',
    match: s => {
      if (/\bCROSS\s+JOIN\b/i.test(s)) return 'cartesian product (CROSS JOIN)'
      const rest = afterMatch(s, /\bFROM\s+[\w.`"]+(?:\s+(?:AS\s+)?(?!WHERE\b|JOIN\b|ON\b)\w+)?\s*,\s*[\w.`"]+/i)
      return rest !== undefined && !HAS_WHERE.test(ownClauses(rest))
        ? 'cartesian product (comma join without WHERE)'
        : undefined
    },
  },
  {
    severity: 'slow',
    match: s => (/\bI?LIKE\s+[EN]?'%/i.test(s) ? 'LIKE with leading wildcard' : undefined),
  },
  {
    severity: 'slow',
    match: s => {
      const rest = afterMatch(s, /\bORDER\s+BY\b/i)
      return rest !== undefined && !HAS_LIMIT.test(ownClauses(rest)) ? 'ORDER BY without LIMIT' : undefined
    },
  },
]

export const isDbCommand = (command: string): boolean =>
  command
    .replace(HEREDOC, '$1')
    .split(SHELL_SEGMENT)
    .some(segment => !INERT_SEGMENT.test(segment) && DB_CLI.test(segment))

export const analyze = (command: string): Finding[] => {
  if (!isDbCommand(command)) return []

  const findings: Finding[] = []
  const seen = new Set<string>()

  for (const statement of command.split(STATEMENT_SEPARATOR)) {
    for (const rule of RULES) {
      const label = rule.match(statement)
      if (label === undefined || seen.has(label)) continue
      seen.add(label)
      findings.push({ severity: rule.severity, label })
    }
  }

  return findings
}

export const describe = (findings: readonly Finding[]): string => {
  const pick = (severity: Severity) => findings.filter(f => f.severity === severity).map(f => f.label)
  const parts = [
    ['destructive', pick('destructive')],
    ['possibly slow', pick('slow')],
  ] as const
  return `query-guard: ${parts
    .filter(([, labels]) => labels.length > 0)
    .map(([name, labels]) => `${name}: ${labels.join(', ')}`)
    .join(' / ')}`
}
