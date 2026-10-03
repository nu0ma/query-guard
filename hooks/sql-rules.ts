export type Severity = 'destructive' | 'slow'

export type Finding = {
  severity: Severity
  label: string
}

const DB_CLI =
  /(?:^|[\s;&|(`/"'])(?:psql|mysql|mariadb|sqlite3|duckdb|bq|spanner-cli|spanner-readonly-cli|clickhouse-client)(?=\s|$)|\bgcloud\s+spanner\s+databases\s+execute-sql\b/

// Only a whitespace-delimited `--` starts a comment, so shell flags like --sql=... survive
const LINE_COMMENT = /(^|\s)--(?=\s|$)[^\n]*/gm
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g

// Mask only '...' right after an operator or keyword, so shell-quoted SQL is not mistaken for a literal
const SQL_LITERAL = /([=<>(,]|\b(?:I?LIKE|IN|VALUES|THEN|ELSE|AND|OR))(\s*)'(?:[^']|'')*'/gi

const STATEMENT_SEPARATOR = /;|&&|\|\||\||\s-[ce]\s/

const HAS_WHERE = /\bWHERE\b/i
const HAS_LIMIT = /\b(?:LIMIT|TOP|FETCH\s+FIRST)\b/i

type Rule = {
  severity: Severity
  match: (statement: string, raw: string) => string | undefined
}

const afterMatch = (statement: string, pattern: RegExp): string | undefined => {
  const m = pattern.exec(statement)
  return m === null ? undefined : statement.slice(m.index + m[0].length)
}

const RULES: readonly Rule[] = [
  {
    severity: 'destructive',
    match: s => {
      const rest = afterMatch(s, /\bDELETE\s+(?:\w+\s+)?FROM\b/i)
      if (rest === undefined) return undefined
      return HAS_WHERE.test(rest) ? 'DELETE' : 'DELETE without WHERE'
    },
  },
  {
    severity: 'destructive',
    match: s => {
      const rest = afterMatch(s, /\bUPDATE\s+[\w."`[\]]+(?:\s+(?:AS\s+)?\w+)?\s+SET\b/i)
      return rest !== undefined && !HAS_WHERE.test(rest) ? 'UPDATE without WHERE' : undefined
    },
  },
  {
    severity: 'destructive',
    match: s => {
      const target = /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|COLUMN)\b/i.exec(s)?.[1]
      if (target !== undefined) return `DROP ${target.toUpperCase()}`
      return /\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(s) ? 'ALTER TABLE ... DROP' : undefined
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
      if (rest === undefined || HAS_WHERE.test(rest) || HAS_LIMIT.test(rest)) return undefined
      return 'possible full scan (no WHERE / LIMIT)'
    },
  },
  {
    severity: 'slow',
    match: s => {
      if (/\bCROSS\s+JOIN\b/i.test(s)) return 'cartesian product (CROSS JOIN)'
      const rest = afterMatch(s, /\bFROM\s+[\w.`"]+(?:\s+(?:AS\s+)?(?!WHERE\b|JOIN\b|ON\b)\w+)?\s*,\s*[\w.`"]+/i)
      return rest !== undefined && !HAS_WHERE.test(rest) ? 'cartesian product (comma join without WHERE)' : undefined
    },
  },
  {
    severity: 'slow',
    // Reads literal contents, so it checks the statement before masking
    match: (_, raw) => (/\bI?LIKE\s+'%/i.test(raw) ? 'LIKE with leading wildcard' : undefined),
  },
  {
    severity: 'slow',
    match: s => {
      const rest = afterMatch(s, /\bORDER\s+BY\b/i)
      return rest !== undefined && !HAS_LIMIT.test(rest) ? 'ORDER BY without LIMIT' : undefined
    },
  },
]

export const isDbCommand = (command: string): boolean => DB_CLI.test(command)

export const analyze = (command: string): Finding[] => {
  if (!isDbCommand(command)) return []

  const uncommented = command.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, '$1')
  const findings: Finding[] = []
  const seen = new Set<string>()

  for (const raw of uncommented.split(STATEMENT_SEPARATOR)) {
    const statement = raw.replace(SQL_LITERAL, "$1$2''")
    for (const rule of RULES) {
      const label = rule.match(statement, raw)
      if (label === undefined || seen.has(label)) continue
      seen.add(label)
      findings.push({ severity: rule.severity, label })
    }
  }

  return findings
}

export const describe = (findings: readonly Finding[]): string => {
  const pick = (severity: Severity) =>
    findings.filter(f => f.severity === severity).map(f => f.label)
  const parts = [
    ['destructive', pick('destructive')],
    ['possibly slow', pick('slow')],
  ] as const
  return `query-guard: ${parts
    .filter(([, labels]) => labels.length > 0)
    .map(([name, labels]) => `${name}: ${labels.join(', ')}`)
    .join(' / ')}`
}
