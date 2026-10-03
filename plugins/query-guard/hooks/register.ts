import type { Register } from 'claude-code'
import { analyze, describe } from './sql-rules.ts'

export const RUN = 'Run it'
export const CANCEL = 'Cancel'

export const register: Register = on => {
  // Ask the person directly rather than through tool.check, so no permission
  // mode (auto, acceptEdits, bypassPermissions) can settle it without them
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const findings = analyze(e.command)
    if (findings.length === 0) return next(e)

    const reason = describe(findings)
    $.ui.toast(reason, { timeoutMs: 8000 })

    // Cancel comes first so a dialog that resolves on its own lands on it
    const answer = await $.ui
      .ask(`${reason}. Run this command anyway?`, { header: 'query-guard', options: [CANCEL, RUN] })
      .catch(() => undefined)

    return answer === RUN ? next(e) : { deny: `${reason}. The user did not approve running it.` }
  })
}
