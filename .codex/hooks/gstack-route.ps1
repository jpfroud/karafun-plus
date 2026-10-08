$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# Codex hook: at session start, checks that gstack is installed; on each
# prompt, recalls the project workflow. The hook itself installs nothing (its
# timeout is too short): when gstack is missing it tells Codex to run the
# project installer, which the user approved. An error must never block Codex.
# Keep this file ASCII (Windows PowerShell 5.1).
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $event = $raw | ConvertFrom-Json
    $name = [string]$event.hook_event_name
    if ($name -ne 'UserPromptSubmit' -and $name -ne 'SessionStart') { exit 0 }

    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $homeDir '.codex' }
    $skillsRoot = Join-Path $codexHome 'skills'
    # Codex needs its gstack-* skills, even when GSTACK_ROOT names the source.
    $gstackReady = Test-Path -LiteralPath (Join-Path $skillsRoot 'gstack-review/SKILL.md')
    # Routing table (same as the Claude Code hook): short, it is added to every prompt.
    $rules = 'This project requires gstack. Before acting, pick the gstack skill that fits this prompt, state it in one line and run it: reported bug or "why does X happen" -> gstack-investigate; feature to pin down -> gstack-spec (plan to challenge -> gstack-plan-eng-review); exercising the app -> gstack-qa (gstack-qa-only to report only); change written, before commit, push or PR -> gstack-review; security -> gstack-cso; code health -> gstack-health; docs after a change -> gstack-document-release. If none fits (a pure question), say "no gstack command fits: <reason>"; never skip this choice silently. Run node test/run-offline.js and record results in RAPPORT-TEST.md. Explicit user instructions take precedence.'
    if ($gstackReady) {
        $message = if ($name -eq 'SessionStart') { "GSTACK_OK: gstack skills found in $skillsRoot. $rules" } else { $rules }
    } else {
        $message = 'GSTACK_MISSING: gstack is required by AGENTS.md but missing from Codex skills. The user has approved installing it automatically: before any code change, run bash .claude/hooks/install-gstack.sh codex from the repository root (Git Bash on Windows; needs git and bun), then tell the user to restart Codex so the gstack-* skills load. If it fails, tell the user the reason it prints. Meanwhile perform equivalent checks and never claim a skill was run. ' + $rules
    }
    $result = @{
        hookSpecificOutput = @{
            hookEventName = $name
            additionalContext = $message
        }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 4 -Compress))
} catch {
    exit 0
}
