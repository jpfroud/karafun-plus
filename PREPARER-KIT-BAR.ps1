# Prépare un dossier autonome pour le PC Windows 64 bits du bar.
# Ne copie volontairement ni data/ (accès privés), ni journal/, ni test/.
$ErrorActionPreference = 'Stop'
$racine = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$destination = Join-Path $racine 'KIT-BAR-KARAFUN.zip'
$temporaire = Join-Path $racine 'KIT-BAR-KARAFUN.zip.tmp'
$fichiers = @(
  'DEMARRER.bat', 'ARRETER.bat', 'DEMO.bat',
  'KIT-BAR-LISEZMOI.txt', 'GUIDE-BAR.md', 'LISEZMOI.txt',
  'package.json', 'package-lock.json',
  'battle-vote.js', 'catalog.js', 'fake-karafun.js', 'karafun-state.js',
  'karafun.js', 'kcs-transport.js', 'night-state.js', 'scheduler.js',
  'server.js', 'start-evening.js', 'stop.js', 'table-access.js'
)
foreach ($nom in $fichiers) {
  if (-not (Test-Path -LiteralPath (Join-Path $racine $nom) -PathType Leaf)) {
    throw "Fichier indispensable absent : $nom"
  }
}
foreach ($nom in @('node\node.exe', 'node_modules\qrcode', 'node_modules\socket.io',
    'node_modules\socket.io-client', 'public\client.html', 'public\staff.html')) {
  if (-not (Test-Path -LiteralPath (Join-Path $racine $nom))) {
    throw "Dépendance indispensable absente : $nom"
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$entrees = [System.Collections.Generic.List[string]]::new()
foreach ($nom in $fichiers) { $entrees.Add((Join-Path $racine $nom)) }
foreach ($dossier in @('node', 'node_modules', 'public')) {
  Get-ChildItem -LiteralPath (Join-Path $racine $dossier) -File -Recurse -Force |
    ForEach-Object { $entrees.Add($_.FullName) }
}
if (Test-Path -LiteralPath $temporaire) { Remove-Item -LiteralPath $temporaire -Force }
$flux = [System.IO.File]::Open($temporaire, [System.IO.FileMode]::CreateNew)
try {
  $archive = [System.IO.Compression.ZipArchive]::new(
    $flux, [System.IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($source in $entrees) {
      $relatif = $source.Substring($racine.Length + 1).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $source, "karaoke-bar/$relatif",
        [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose() }
} finally { $flux.Dispose() }
Move-Item -LiteralPath $temporaire -Destination $destination -Force
Write-Host "Kit autonome créé : $destination ($($entrees.Count) fichiers)"
