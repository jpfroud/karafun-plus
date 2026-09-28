# Compile un lanceur Windows sans console visible, à partir du code auditable du dépôt.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core') {
  & "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
  if ($LASTEXITCODE -ne 0) { throw 'Compilation du lanceur impossible.' }
  return
}
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$source = Join-Path $root 'launcher\KaraFunPlus.cs'
$target = Join-Path $root 'KaraFun Plus.exe'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Code du lanceur absent : $source"
}
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
Add-Type -Path $source -OutputAssembly $target -OutputType WindowsApplication `
  -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll')
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
  throw 'Compilation du lanceur impossible.'
}
Write-Host "Lanceur Windows cree : $target"
