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

// Matched against a segment with its quotes and backslashes removed, so `\psql`, `ps''ql`,
// `X=psql` and `psql<<EOF` all name the CLI the shell runs
const DB_CLI = new RegExp(
  `(?:^|[^\\w.-])(?:${DB_CLIS.join('|')})(?![\\w-])` +
    '|\\bgcloud\\b[\\s\\S]*?\\bspanner\\s+databases\\s+execute-sql\\b' +
    '|\\bclickhouse\\s+client\\b',
)

const SHELL_QUOTING = /['"\\]/g

// Groups: the line holding the operator, the delimiter's quote, the delimiter, the body
const HEREDOC = /^([^\n]*?<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\2[^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/gm

// A heredoc body is only data when its delimiter is quoted (no expansion) and nothing but
// cat or tee reads it: a shell, ssh or a pipe would run it
const DATA_SINK_LINE = /^\s*(?:cat|tee)\b[^|;&`()]*$/

// Segments that start with these only print or search text, unless they run a substitution
const INERT_SEGMENT = /^\s*(?:echo|printf|grep)\b/
const SUBSTITUTION = /\$\(|`|<\(|>\(/

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

const isInert = (segment: string): boolean => INERT_SEGMENT.test(segment) && !SUBSTITUTION.test(segment)

export const isDbCommand = (command: string): boolean =>
  command
    .replace(HEREDOC, (block: string, line: string, quote: string) =>
      quote !== '' && DATA_SINK_LINE.test(line) ? line : block,
    )
    .split(SHELL_SEGMENT)
    .some(segment => !isInert(segment) && DB_CLI.test(segment.replace(SHELL_QUOTING, '')))

// Splits a command into words the way a POSIX shell does, quotes removed, so SQL passed
// as one argument is read without the shell quotes around it and its neighbours
const shellWords = (text: string): string[] => {
  const words: string[] = []
  let word = ''
  let inWord = false
  const flush = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''
    if (c === "'" || (c === '$' && text[i + 1] === "'")) {
      // '...' is literal; $'...' takes backslash escapes
      const ansi = c === '$'
      let j = i + (ansi ? 2 : 1)
      while (j < text.length && text[j] !== "'") {
        if (ansi && text[j] === '\\') j++
        word += text[j] ?? ''
        j++
      }
      i = j
      inWord = true
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && '$`"\\\n'.includes(text[j + 1] ?? 'x')) j++
        word += text[j] ?? ''
        j++
      }
      i = j
      inWord = true
    } else if (c === '\\') {
      word += text[i + 1] ?? ''
      i++
      inWord = true
    } else if (/\s/.test(c) || ';&|<>()'.includes(c)) {
      flush()
    } else {
      word += c
      inWord = true
    }
  }
  flush()
  return words
}

// Every reading of the command a rule runs on: the raw text, each shell word, and each
// heredoc body. Findings are unioned, so no single reading can hide a statement.
const readings = (command: string): string[] => {
  const bodies: string[] = []
  const withoutBodies = command.replace(HEREDOC, (_block: string, line: string, _q: string, _d: string, body: string) => {
    bodies.push(body)
    return line
  })
  return [command, ...shellWords(withoutBodies), ...bodies]
}

export const analyze = (command: string): Finding[] => {
  if (!isDbCommand(command)) return []

  const labels = RULES.map(() => new Set<string>())
  for (const reading of readings(command)) {
    for (const statement of reading.split(STATEMENT_SEPARATOR)) {
      RULES.forEach((rule, i) => {
        const label = rule.match(statement)
        if (label !== undefined) labels[i]?.add(label)
      })
    }
  }

  return RULES.flatMap((rule, i) => {
    const found = labels[i] ?? new Set<string>()
    // A reading without the WHERE outranks one that saw it
    if (found.has('DELETE without WHERE')) found.delete('DELETE')
    return [...found].map(label => ({ severity: rule.severity, label }))
  })
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
