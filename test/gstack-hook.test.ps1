$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -LiteralPath (Join-Path $root '.codex\hooks.json') -Raw | ConvertFrom-Json
$hookCommand = $config.hooks.UserPromptSubmit[0].hooks[0].commandWindows
if (-not $hookCommand) { throw 'La commande Windows du hook Codex est absente.' }

function Invoke-Hook([string]$payload, [string]$directory) {
    Push-Location $directory
    try {
        $stdout = $payload | & cmd.exe /d /s /c $hookCommand
        return @{
            ExitCode = $LASTEXITCODE
            Stdout = $stdout -join [Environment]::NewLine
        }
    } finally { Pop-Location }
}

foreach ($directory in @($root, (Join-Path $root 'test'))) {
    $valid = Invoke-Hook '{"hook_event_name":"UserPromptSubmit","prompt":"test"}' $directory
    if ($valid.ExitCode -ne 0) { throw "Le hook a bloque un prompt dans $directory." }
    $reply = $valid.Stdout | ConvertFrom-Json
    if ($reply.hookSpecificOutput.hookEventName -ne 'UserPromptSubmit' -or
        $reply.hookSpecificOutput.additionalContext -notmatch 'gstack') {
        throw "Le rappel gstack est absent dans $directory."
    }
    # Routing table: every route and the no-silent-skip rule.
    foreach ($route in @('-> gstack-investigate', '-> gstack-spec', '-> gstack-qa', '-> gstack-review', 'no gstack command fits', 'never skip this choice silently')) {
        if (-not $reply.hookSpecificOutput.additionalContext.Contains($route)) { throw "Table de routage incomplete dans ${directory} : $route" }
    }
}
$startCommand = $config.hooks.SessionStart[0].hooks[0].commandWindows
if ($startCommand -ne $hookCommand) { throw 'Le hook de demarrage Codex doit lancer le meme script.' }
$start = Invoke-Hook '{"hook_event_name":"SessionStart","source":"startup"}' $root
if ($start.ExitCode -ne 0) { throw 'Le hook de demarrage a bloque Codex.' }
$started = $start.Stdout | ConvertFrom-Json
if ($started.hookSpecificOutput.hookEventName -ne 'SessionStart' -or
    $started.hookSpecificOutput.additionalContext -notmatch '^GSTACK_(OK|MISSING)') {
    throw 'La verification gstack au demarrage est absente.'
}
$unrelated = Invoke-Hook '{"hook_event_name":"Stop"}' $root
if ($unrelated.ExitCode -ne 0 -or $unrelated.Stdout) { throw 'Le hook doit ignorer les autres evenements.' }
$broken = Invoke-Hook '{' $root
if ($broken.ExitCode -ne 0 -or $broken.Stdout) { throw 'Un JSON invalide ne doit pas bloquer Codex.' }
Write-Host 'Hook gstack: startup check and prompt reminder, valid JSON, non-blocking, resolved from root and a subdirectory.'
