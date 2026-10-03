import type { Register } from 'claude-code'
import { analyze, describe } from './sql-rules.ts'

export const register: Register = on => {
  // Always ask before risky SQL, even when an allow rule would let the call through
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny') return verdict

    const { command } = e.input as { command?: unknown }
    if (typeof command !== 'string') return verdict

    const findings = analyze(command)
    if (findings.length === 0) return verdict

    const reason = describe(findings)
    $.ui.toast(reason, { timeoutMs: 8000 })
    return { decision: 'ask', reason }
  })
}
