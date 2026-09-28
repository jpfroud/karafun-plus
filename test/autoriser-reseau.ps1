$ErrorActionPreference = 'Stop'
$reportFile = 'D:\dev\karafun-helper\journal\pare-feu-admin.log'
try {
    $ruleName = 'KarafunHelper-Node-Private-3000'
    $existingRule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if (-not $existingRule) {
        New-NetFirewallRule -Name $ruleName -DisplayName 'File karaoke (node)' -Direction Inbound -Program 'D:\dev\karafun-helper\node\node.exe' -Action Allow -Profile Private -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet | Out-Null
    }
    Get-NetFirewallRule -Name $ruleName | Select-Object Name,Enabled,Direction,Action,Profile | Format-List | Out-String | Set-Content -LiteralPath $reportFile
    Get-NetFirewallRule -Name $ruleName | Get-NetFirewallApplicationFilter | Select-Object Program | Format-List | Out-String | Add-Content -LiteralPath $reportFile
    Get-NetFirewallRule -Name $ruleName | Get-NetFirewallPortFilter | Select-Object Protocol,LocalPort | Format-List | Out-String | Add-Content -LiteralPath $reportFile
    Get-NetFirewallRule -Name $ruleName | Get-NetFirewallAddressFilter | Select-Object RemoteAddress | Format-List | Out-String | Add-Content -LiteralPath $reportFile
    Add-Content -LiteralPath $reportFile -Value 'PASS - Regle privee disponible.'
} catch {
    Set-Content -LiteralPath $reportFile -Value ('FAIL - ' + $_.Exception.Message)
    exit 1
}
