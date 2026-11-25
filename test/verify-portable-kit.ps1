# Vérifie le ZIP sur ce Windows sans utiliser Node installé globalement.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$zipPath = Join-Path $root 'KIT-BAR-KARAFUN.zip'
$extractPath = [System.IO.Path]::GetFullPath((Join-Path $root "journal\kit-check-$PID"))
if (-not $extractPath.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase)) { throw 'Extraction hors du projet refusée.' }
if (Test-Path -LiteralPath $extractPath) { throw 'Dossier de test déjà présent.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Net.Http
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $names = @($archive.Entries | ForEach-Object FullName)
  if ($names | Where-Object { $_ -match '^karaoke-bar/(data|journal|test)/' }) {
    throw 'Le kit contient des données ou tests privés du projet.'
  }
  # Entrées strictes : chaque fichier du ZIP vient de livrable.json (développé
  # comme dans PREPARER-KIT-BAR.ps1) ou des produits de la construction, et
  # chaque fichier du manifeste est dans le ZIP.
  $manifeste = Get-Content -LiteralPath (Join-Path $root 'livrable.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($liste in @('commun', 'windows')) {
    $propriete = $null
    if ($null -ne $manifeste) { $propriete = $manifeste.PSObject.Properties[$liste] }
    if ($null -eq $propriete -or $propriete.Value -isnot [array]) {
      throw 'livrable.json : listes « commun » et « windows » attendues.'
    }
  }
  $livres = [System.Collections.Generic.List[string]]::new()
  foreach ($nom in @($manifeste.commun) + @($manifeste.windows)) {
    $chemin = Join-Path $root ($nom.Replace('/', '\'))
    if (Test-Path -LiteralPath $chemin -PathType Container) {
      Get-ChildItem -LiteralPath $chemin -File -Recurse -Force |
        ForEach-Object { $livres.Add($_.FullName.Substring($root.Length + 1).Replace('\', '/')) }
    } else { $livres.Add($nom) }
  }
  $admis = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($nom in $livres) { [void]$admis.Add("karaoke-bar/$nom") }
  foreach ($produit in @('karaoke-bar/KaraFun Plus.exe', 'karaoke-bar/build-info.json',
      'karaoke-bar/solver/karafun-solver.jar')) { [void]$admis.Add($produit) }
  foreach ($name in $names) {
    if (-not $admis.Contains($name) -and
        $name -cnotmatch '^karaoke-bar/(node|node_modules|solver-runtime|LICENCES-JAVA)/') {
      throw "Entrée du kit hors de livrable.json : $name"
    }
  }
  $presentes = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($name in $names) { [void]$presentes.Add($name) }
  foreach ($nom in $livres) {
    if (-not $presentes.Contains("karaoke-bar/$nom")) { throw "Fichier absent du kit : karaoke-bar/$nom" }
  }
  foreach ($required in @('karaoke-bar/node/node.exe', 'karaoke-bar/node/LICENSE', 'karaoke-bar/server.js',
      'karaoke-bar/build-info.json',
      'karaoke-bar/public/client.html', 'karaoke-bar/public/client-i18n.js', 'karaoke-bar/DEMARRER.bat',
      'karaoke-bar/KaraFun Plus.exe', 'karaoke-bar/solver/bridge.js', 'karaoke-bar/lib/scheduler/rotation.js',
      'karaoke-bar/lyrics.js', 'karaoke-bar/spotify.js', 'karaoke-bar/stage-progress.js', 'karaoke-bar/private-event.js',
      'karaoke-bar/evening-journal.js', 'karaoke-bar/evening-stats.js', 'karaoke-bar/public/stats.html',
      'karaoke-bar/solver/karafun-solver.jar',
      'karaoke-bar/solver-runtime/bin/java.exe',
      'karaoke-bar/LICENCES-JAVA/THIRD-PARTY.txt',
      'karaoke-bar/LICENCES-JAVA/licenses.xml')) {
    if ($required -notin $names) { throw "Fichier absent du kit : $required" }
  }
  if (-not ($names | Where-Object { $_ -like 'karaoke-bar/LICENCES-JAVA/textes/*' })) {
    throw 'Les textes des licences Java sont absents du kit.'
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
  $java = Join-Path $app 'solver-runtime\bin\java.exe'
  $javaOutput = & $java --version
  $javaExit = $LASTEXITCODE
  $javaVersion = @($javaOutput)[0]
  if ($javaExit -ne 0 -or $javaVersion -notmatch '^(openjdk|java) 25') {
    throw "Java 25 intégré ne démarre pas : $javaVersion"
  }
  & $node (Join-Path $PSScriptRoot 'portable-solver-smoke.js') $java `
    (Join-Path $app 'solver\karafun-solver.jar')
  if ($LASTEXITCODE -ne 0) { throw 'Le solveur Java embarqué ne calcule pas la file.' }
  # Commandes PowerShell du §18 de DEPLOIEMENT-SERVEUR.md (réparation des
  # soirées), tapées telles quelles dans le kit extrait, avant la démo, sur le
  # dossier d'essai de test/dossier-reparation.js : le même journal et le même
  # index d'essai que documentation.test.js. Le guide est lu en UTF-8 ; ce
  # script, sans BOM, ne compare que de l'ASCII. Un identifiant vide n'est pas
  # essayé avec node.exe : PowerShell 5.1 ne lui passe pas un argument vide.
  # Il l'est avec les gardes du retrait d'un morceau et de tar.exe.
  $ids = (& $node (Join-Path $PSScriptRoot 'dossier-reparation.js') $app) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $ids.morceau) { throw 'Dossier d''essai de la section 18 non prepare (test/dossier-reparation.js).' }
  $dans18 = $false
  $lignes18 = @(foreach ($ligne in (Get-Content -LiteralPath (Join-Path $root 'DEPLOIEMENT-SERVEUR.md') -Encoding UTF8)) {
    if ($ligne.StartsWith('## 18. ')) { $dans18 = $true } elseif ($ligne.StartsWith('## 19. ')) { $dans18 = $false }
    if ($dans18) { $ligne.Trim() }
  })
  $commandes = @{}
  foreach ($ligne in $lignes18) {
    if (-not $ligne.StartsWith('node\node.exe -')) { continue }
    if ($ligne.StartsWith('node\node.exe -p ')) { $commandes['controle'] = $ligne }
    elseif ($ligne.Contains('readdirSync')) { $commandes['liste'] = $ligne }
    elseif ($ligne.Contains('copyFileSync')) { $commandes['recopie'] = $ligne }
    elseif ($ligne.Contains("]='ok'")) { $commandes['ok'] = $ligne }
    elseif ($ligne.Contains('delete x.checked')) { $commandes['retrait'] = $ligne }
  }
  # Retrait d'un morceau et archive d'« Envoyer une soirée au développeur » :
  # chacun dans le if de la garde de son identifiant, sur sa propre ligne.
  $retirer = @($lignes18 | Where-Object { $_.StartsWith('if ($morceau -cmatch ') -and $_.Contains('{ Remove-Item -Recurse "data\soirees\$morceau" }') })
  $archiver = @($lignes18 | Where-Object { $_.StartsWith('if ($id -cmatch ') -and $_.Contains('{ tar.exe -czf "$HOME\soiree-$id.tar.gz" ') })
  $envoi = @($lignes18 | Where-Object { $_.StartsWith('Select-String -Path journal\serveur-') -and $_.Contains('Set-Content') })
  foreach ($nom in @('controle', 'liste', 'recopie', 'ok', 'retrait')) {
    if (-not $commandes.ContainsKey($nom)) { throw "DEPLOIEMENT-SERVEUR.md, section 18 : commande PowerShell $nom introuvable." }
  }
  if ($retirer.Count -ne 1 -or $archiver.Count -ne 1 -or $envoi.Count -ne 1) {
    throw 'DEPLOIEMENT-SERVEUR.md, section 18 : Remove-Item, tar.exe ou Select-String introuvable.'
  }
  # Une ligne du guide, avec $id ; erreurs de node.exe à la console, sans
  # arrêter ce script. Son code gardé, $LASTEXITCODE est remis à 0 : l'étape
  # « shell: powershell » d'Actions sort avec lui, et le second retrait, le
  # dernier programme lancé, sort en code 1 comme attendu.
  function Invoke-Ligne18([string]$ligne, [string]$valeur) {
    $ErrorActionPreference = 'Continue'
    $id = $valeur
    $sortie = @(Invoke-Expression $ligne | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    $global:LASTEXITCODE = 0
    return [pscustomobject]@{ Code = $code; Sortie = ($sortie -join ' ') }
  }
  function Get-Empreinte([string]$dossier) {
    (Get-ChildItem -LiteralPath $dossier -File -Recurse -Force | Sort-Object FullName |
      ForEach-Object { $_.FullName + ' ' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }) -join "`n"
  }
  $hash = { param($chemin) (Get-FileHash -LiteralPath $chemin -Algorithm SHA256).Hash }
  $data = Join-Path $app 'data'
  $indexFichier = Join-Path $data 'soirees\.bornage.json'
  $index = { Get-Content -LiteralPath $indexFichier -Raw -Encoding UTF8 | ConvertFrom-Json }
  $lieu = Get-Location
  Set-Location -LiteralPath $app
  try {
    $avant = Get-Empreinte $data
    foreach ($nom in @($commandes.Keys)) {
      $r = Invoke-Ligne18 $commandes[$nom] '../x'
      if ($r.Code -ne 1 -or (Get-Empreinte $data) -ne $avant) { throw "Section 18, $nom avec ../x : code $($r.Code) ou dossier d'essai change." }
    }
    $r = Invoke-Ligne18 $commandes['controle'] $ids.decoupee
    if ($r.Code -ne 0 -or $r.Sortie -notmatch '^\d+$') { throw "Section 18, controle de la copie : code $($r.Code), $($r.Sortie)" }
    $r = Invoke-Ligne18 $commandes['controle'] $ids.sansFin
    if ($r.Code -ne 0 -or $r.Sortie -ne 'undefined') { throw "Section 18, copie sans endedAt : code $($r.Code), $($r.Sortie)" }
    $r = Invoke-Ligne18 $commandes['liste'] $ids.decoupee
    if ($r.Code -ne 0 -or $r.Sortie -ne $ids.morceau) { throw "Section 18, liste des morceaux : code $($r.Code), $($r.Sortie)" }
    # Gardes du retrait et de tar.exe : « .. » et un nom vide sont refusés par
    # throw, avec le message des commandes node, avant Remove-Item ou tar.exe :
    # dossier d'essai inchangé. Un nom vide s'essaie ici, aucun programme ne le
    # recevant. Puis le morceau nommé est retiré.
    foreach ($valeur in @('..', '')) {
      $morceau = $valeur
      $id = $valeur
      foreach ($ligne in @($retirer[0], $archiver[0])) {
        $refus = ''
        try { Invoke-Expression $ligne } catch { $refus = $_.Exception.Message }
        if ($refus -notlike 'Identifiant de soir*e invalide : * Rien ne change.' -or (Get-Empreinte $data) -ne $avant) {
          throw "Section 18, garde avec '$valeur' : refus attendu, rien ne change. $refus"
        }
      }
    }
    $morceau = $ids.morceau
    Invoke-Expression $retirer[0]
    if (Test-Path -LiteralPath (Join-Path $data "soirees\$($ids.morceau)")) { throw 'Section 18 : morceau non retire par Remove-Item.' }
    $r = Invoke-Ligne18 $commandes['recopie'] $ids.decoupee
    if ($r.Code -ne 0) { throw "Section 18, recopie de l'original : code $($r.Code)" }
    foreach ($fichier in @('journal.jsonl', 'meta.json', 'summary.json')) {
      if ((& $hash (Join-Path $data "soirees\$($ids.decoupee)\$fichier")) -ne
          (& $hash (Join-Path $data "soirees-originales\$($ids.decoupee)\1\$fichier"))) { throw "Section 18 : $fichier non recopie." }
    }
    # L'index garde sa règle : sans elle, il se lirait comme vide, et la
    # réparation recouperait la soirée remise à l'original.
    $regle = (& $index).rule
    if ([string]::IsNullOrEmpty($regle)) { throw 'Section 18 : index d''essai sans regle.' }
    $r = Invoke-Ligne18 $commandes['ok'] $ids.decoupee
    $lu = & $index
    $checked = $lu.checked
    if ($r.Code -ne 0 -or $lu.rule -cne $regle -or $checked.($ids.decoupee) -ne 'ok' -or $checked.($ids.autre) -ne 'ok') {
      throw "Section 18, entree ok : code $($r.Code), regle $($lu.rule)"
    }
    $r = Invoke-Ligne18 $commandes['retrait'] $ids.enEchec
    $lu = & $index
    $checked = $lu.checked
    if ($r.Code -ne 0 -or $lu.rule -cne $regle -or $null -ne $checked.PSObject.Properties[$ids.enEchec] -or
        $checked.($ids.autre) -ne 'ok') {
      throw "Section 18, retrait de l'entree failed : code $($r.Code), regle $($lu.rule)"
    }
    $empreinteIndex = & $hash $indexFichier
    $r = Invoke-Ligne18 $commandes['retrait'] $ids.enEchec
    if ($r.Code -ne 1 -or (& $hash $indexFichier) -ne $empreinteIndex) { throw "Section 18, second retrait : code $($r.Code) ou index change." }
    $cible = Join-Path $app 'envoi.txt'
    Invoke-Expression $envoi[0].Replace('$HOME\envoi.txt', "'$cible'")
    $obtenu = (Get-Content -LiteralPath $cible -Encoding UTF8) -join "`n"
    $attendu = (Get-Content -LiteralPath (Join-Path $app 'attendu-envoi.txt') -Encoding UTF8) -join "`n"
    if ($obtenu -ne $attendu) { throw "Section 18 : envoi.txt differe des lignes attendues :`n$obtenu" }
  } finally { Set-Location -LiteralPath $lieu }
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
  Write-Host "Kit vérifié : $($names.Count) entrées, Node intégré $version, Java 25, commandes de la section 18, bar 302, port clients 403."
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
