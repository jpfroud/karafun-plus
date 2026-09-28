# Vérifie le ZIP sur ce Windows sans utiliser Node installé globalement.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$zipPath = Join-Path $root 'KIT-BAR-KARAFUN.zip'
$extractPath = [System.IO.Path]::GetFullPath((Join-Path $root "journal\kit-check-$PID"))
if (-not $extractPath.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase)) { throw 'Extraction hors du projet refusée.' }
if (Test-Path -LiteralPath $extractPath) { throw 'Dossier de test déjà présent.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $names = @($archive.Entries | ForEach-Object FullName)
  if ($names | Where-Object { $_ -match '^karaoke-bar/(data|journal|test)/' }) {
    throw 'Le kit contient des données ou tests privés du projet.'
  }
  foreach ($required in @('karaoke-bar/node/node.exe', 'karaoke-bar/server.js',
      'karaoke-bar/public/client.html', 'karaoke-bar/DEMARRER.bat')) {
    if ($required -notin $names) { throw "Fichier absent du kit : $required" }
  }
} finally { $archive.Dispose() }

$process = $null
$client = $null
$handler = $null
try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath
  $app = Join-Path $extractPath 'karaoke-bar'
  $node = Join-Path $app 'node\node.exe'
  $version = & $node --version
  if ($LASTEXITCODE -ne 0 -or -not $version) { throw 'Node intégré ne démarre pas.' }
  $process = Start-Process -FilePath $node -ArgumentList @('server.js', '--demo',
    '--port', '3290', '--public-port', '3291', '--song-seconds', '30', '--no-open') `
    -WorkingDirectory $app -WindowStyle Hidden -PassThru
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $ready = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if ($process.HasExited) { throw "Démo du kit quittée : $($process.ExitCode)" }
    try {
      $response = $client.GetAsync('http://127.0.0.1:3290/').GetAwaiter().GetResult()
      if ([int]$response.StatusCode -eq 302) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 100 }
  }
  if (-not $ready) { throw 'Le bar du kit ne répond pas sur le port 3290.' }
  $public = $client.GetAsync('http://127.0.0.1:3291/').GetAwaiter().GetResult()
  if ([int]$public.StatusCode -ne 403) { throw 'Le port clients du kit expose le bar.' }
  Write-Host "Kit vérifié : $($names.Count) entrées, Node intégré $version, bar 302, port clients 403."
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
  if ($client) { $client.Dispose() }
  if ($handler) { $handler.Dispose() }
  if (Test-Path -LiteralPath $extractPath) {
    $checked = [System.IO.Path]::GetFullPath($extractPath)
    if (-not $checked.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) { throw 'Nettoyage hors du projet refusé.' }
    # Windows peut garder node.exe verrouillé brièvement après l'arrêt du test.
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      try {
        Remove-Item -LiteralPath $checked -Recurse -Force -ErrorAction Stop
        break
      } catch {
        if ($attempt -eq 19) { throw }
        Start-Sleep -Milliseconds 150
      }
    }
  }
}
