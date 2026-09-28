$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# Adds context to Codex. An error must never block a command.
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $event = $raw | ConvertFrom-Json
    if ($event.hook_event_name -ne 'UserPromptSubmit') { exit 0 }

    $skillsRoot = Join-Path $env:USERPROFILE '.codex\skills'
    $gstackReady = Test-Path -LiteralPath (Join-Path $skillsRoot 'gstack-review\SKILL.md')
    if ($gstackReady) {
        $message = 'This project requires gstack for code changes: gstack-investigate for bugs, gstack-spec or gstack-plan-eng-review for features, gstack-qa for browser testing, and gstack-review before delivery. Run the tests and record results in RAPPORT-TEST.md. Explicit user instructions take precedence.'
    } else {
        $message = 'gstack is required by AGENTS.md but missing from Codex skills. Install it from https://github.com/garrytan/gstack with setup --host codex --prefix, or report it unavailable and perform equivalent checks. Explicit user instructions take precedence.'
    }
    $result = @{
        hookSpecificOutput = @{
            hookEventName = 'UserPromptSubmit'
            additionalContext = $message
        }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 4 -Compress))
} catch {
    exit 0
}
