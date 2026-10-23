# Prépare un dossier autonome pour le PC Windows 64 bits du bar.
# Ne copie volontairement ni data/ (accès privés), ni journal/, ni test/.
$ErrorActionPreference = 'Stop'
$racine = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$destination = Join-Path $racine 'KIT-BAR-KARAFUN.zip'
$temporaire = Join-Path $racine 'KIT-BAR-KARAFUN.zip.tmp'
& (Join-Path $racine 'CREER-LANCEUR.ps1')
$jarConstruit = Join-Path $racine 'solver\target\karafun-solver.jar'
$jarPortable = Join-Path $racine 'solver\karafun-solver.jar'
$javaPortable = Join-Path $racine 'solver-runtime\bin\java.exe'
$tiers = Join-Path $racine 'solver\target\generated-sources\license\THIRD-PARTY.txt'
$licencesXml = Join-Path $racine 'solver\target\generated-resources\licenses.xml'
$textesLicences = Join-Path $racine 'solver\target\generated-resources\licenses'
foreach ($source in @($jarConstruit, $tiers, $licencesXml, $textesLicences)) {
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Solveur ou notices absents : $source. Construis le projet Maven et ses notices avant le kit."
  }
}
Copy-Item -LiteralPath $jarConstruit -Destination $jarPortable -Force
if (-not (Test-Path -LiteralPath $javaPortable -PathType Leaf)) {
  $jlink = Get-Command jlink.exe -ErrorAction SilentlyContinue
  if (-not $jlink) { throw 'Java 21 (jlink) manque pour construire le runtime embarqué.' }
  & $jlink.Source --add-modules 'java.se,jdk.unsupported' --strip-debug `
    --no-header-files --no-man-pages --output (Join-Path $racine 'solver-runtime')
  if ($LASTEXITCODE -ne 0) { throw 'Construction du runtime Java embarqué impossible.' }
}
# Version affichée dans la page du bar : celle de la publication (tag), sinon
# celle de package.json, avec le commit construit.
$paquet = Get-Content -LiteralPath (Join-Path $racine 'package.json') -Raw | ConvertFrom-Json
$versionKit = if ($env:KIT_VERSION) { $env:KIT_VERSION } else { "v$($paquet.version)" }
$commitKit = $env:GITHUB_SHA
if (-not $commitKit -and (Get-Command git -ErrorAction SilentlyContinue)) {
  try { $commitKit = (& git -C $racine rev-parse HEAD 2>$null | Select-Object -First 1) } catch { $commitKit = '' }
}
$infoKit = [ordered]@{ version = $versionKit; commit = "$commitKit"; builtAt = (Get-Date).ToUniversalTime().ToString('o') }
# WriteAllText écrit l'UTF-8 sans BOM, lisible directement par JSON.parse.
[System.IO.File]::WriteAllText((Join-Path $racine 'build-info.json'), ($infoKit | ConvertTo-Json))
# Fichiers de l'application : manifeste unique livrable.json, lu aussi par
# scripts/preparer-livrable.js pour l'image Docker. Liste « commun » (image et
# kit) puis « windows » (kit seulement) ; un dossier est copié en entier,
# fichiers cachés compris. Les produits de la construction n'y sont pas.
$produits = @('KaraFun Plus.exe', 'build-info.json', 'solver\karafun-solver.jar')
$manifeste = Get-Content -LiteralPath (Join-Path $racine 'livrable.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($liste in @('commun', 'windows')) {
  $propriete = $null
  if ($null -ne $manifeste) { $propriete = $manifeste.PSObject.Properties[$liste] }
  if ($null -eq $propriete -or $propriete.Value -isnot [array]) {
    throw 'livrable.json : listes « commun » et « windows » attendues.'
  }
}
$fichiers = [System.Collections.Generic.List[string]]::new()
foreach ($nom in $produits) { $fichiers.Add($nom) }
foreach ($nom in @($manifeste.commun) + @($manifeste.windows)) {
  $chemin = Join-Path $racine ($nom.Replace('/', '\'))
  if (Test-Path -LiteralPath $chemin -PathType Leaf) {
    $fichiers.Add($nom.Replace('/', '\'))
  } elseif (Test-Path -LiteralPath $chemin -PathType Container) {
    # Même nom d'entrée dans le ZIP que l'ancienne copie du dossier entier.
    Get-ChildItem -LiteralPath $chemin -File -Recurse -Force |
      ForEach-Object { $fichiers.Add($_.FullName.Substring($racine.Length + 1)) }
  } else {
    throw "Fichier indispensable absent : $nom"
  }
}
foreach ($nom in $fichiers) {
  if (-not (Test-Path -LiteralPath (Join-Path $racine $nom) -PathType Leaf)) {
    throw "Fichier indispensable absent : $nom"
  }
}
foreach ($nom in @('node\node.exe', 'node\LICENSE', 'node_modules\qrcode', 'node_modules\socket.io',
    'node_modules\socket.io-client', 'public\client.html', 'public\client-i18n.js', 'public\staff.html', 'public\stats.html',
    'solver-runtime\bin\java.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $racine $nom))) {
    throw "Dépendance indispensable absente : $nom"
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$entrees = [System.Collections.Generic.List[string]]::new()
foreach ($nom in $fichiers) { $entrees.Add((Join-Path $racine $nom)) }
foreach ($dossier in @('node', 'node_modules', 'solver-runtime')) {
  Get-ChildItem -LiteralPath (Join-Path $racine $dossier) -File -Recurse -Force |
    ForEach-Object { $entrees.Add($_.FullName) }
}
$nomsNotices = @{}
$nomsNotices[$tiers] = 'LICENCES-JAVA/THIRD-PARTY.txt'
$nomsNotices[$licencesXml] = 'LICENCES-JAVA/licenses.xml'
foreach ($source in @($tiers, $licencesXml)) { $entrees.Add($source) }
$textes = @(Get-ChildItem -LiteralPath $textesLicences -File)
if ($textes.Count -eq 0) { throw "Aucun texte de licence Java n’a été généré." }
foreach ($source in $textes) {
  $entrees.Add($source.FullName)
  $nomsNotices[$source.FullName] = "LICENCES-JAVA/textes/$($source.Name)"
}
if (Test-Path -LiteralPath $temporaire) { Remove-Item -LiteralPath $temporaire -Force }
$flux = [System.IO.File]::Open($temporaire, [System.IO.FileMode]::CreateNew)
try {
  $archive = [System.IO.Compression.ZipArchive]::new(
    $flux, [System.IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($source in $entrees) {
      $relatif = if ($nomsNotices.ContainsKey($source)) { $nomsNotices[$source] }
        else { $source.Substring($racine.Length + 1).Replace('\', '/') }
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $source, "karaoke-bar/$relatif",
        [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose() }
} finally { $flux.Dispose() }
Move-Item -LiteralPath $temporaire -Destination $destination -Force
Write-Host "Kit autonome créé : $destination ($($entrees.Count) fichiers)"
