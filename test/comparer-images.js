'use strict';
// Avant une publication (.github/RELEASE.md, « Avant de publier ») : l'image de main et
// la même construite avec les empreintes des images de base de la dernière version
// publiée. Même code des deux côtés : seules les images de base diffèrent, Maven
// compris. Une ligne FROM dont l'image ou l'étiquette a changé depuis (une montée) se
// compare depuis le commit de main où elle a pris son étiquette actuelle : la montée
// elle-même s'essaie dans sa PR (AGENTS.md). Les lignes FROM se suivent par leur place :
// les étapes du Dockerfile (noms et ordre) doivent rester les mêmes depuis la révision, et
// chaque ligne que Docker lit comme un FROM doit avoir la forme épinglée ci-dessous.
// L'outil contrôle les versions de Node et de Java de chaque image, rejoue la soirée de
// référence dans chacune (Timefold, sans réseau, contrôles de V37 de test/verifier-image.sh)
// et compare leurs décisions comme V38 : c'est la comparaison --json de AGENTS.md entre
// l'ancien et le nouvel outil. Ce qui reste à faire à la main (essai de la télécommande,
// essais d'une montée) est redit en fin de sortie, sous « À faire avant de publier ».
//   node test/comparer-images.js <dernier tag> [--essai]
// Sans --essai, la copie de travail doit être le main du serveur (git ls-remote), sans
// modification ni fichier non suivi : le verdict vaut alors pour ce commit-là. --essai le
// lève pour un essai. Au verdict, HEAD, le Dockerfile et, sans --essai, l'absence de
// modification sont revus : la construction et le rejeu ont relu la copie de travail.
// Codes de sortie : 0 mêmes décisions, ou rien à comparer ; 1 décisions différentes (les
// deux rejeux sont gardés) ; 2 rien n'est prouvé (usage, révision introuvable ou hors de
// l'historique, copie de travail qui n'est pas main ou qui a changé pendant la comparaison,
// étapes du Dockerfile changées, ligne FROM hors de la forme épinglée ou Dockerfile
// illisible depuis la révision, construction ou rejeu en échec, version inattendue,
// Timefold qui n'a pas rendu tous ses plans, erreur imprévue ; un rejeu déjà fait est
// gardé). Il faut git et Docker ; les deux images restent, sans étiquette, sous les
// identifiants affichés.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const SOIREE = 'test/fixtures/soiree-2026-10-15-anonyme.json';
const NOMS = ['ancienne', 'nouvelle'];
// FROM [--platform=…] image:étiquette@sha256:… [AS étape] : la forme épinglée du Dockerfile.
const FROM = /^FROM( --platform=\S+)? (\S+?):(\S+?)@(sha256:[0-9a-f]{64})( AS \S+)?$/;
// Toute ligne que Docker lit comme un FROM : casse indifférente, retrait permis.
const LIGNE_FROM = /^\s*FROM\s/i;
const EMPREINTE = /sha256:[0-9a-f]{64}/;
// Le jar de l'image, celui que V37 exige du rejeu.
const JAR = '/app/solver/karafun-solver.jar';
// Modifications et fichiers non suivis de la copie de travail, tous, quel que soit le réglage
// status.showUntrackedFiles : un fichier non suivi de solver/src/ entre aussi dans les images.
const ETAT = ['status', '--porcelain', '--untracked-files=all'];
const MINUTE = 60 * 1000;

// Arrêt prévu, sans pile : rien n'est prouvé (code 2).
class Arret extends Error {}

// Lignes FROM d'un Dockerfile. Une ligne FROM hors de la forme épinglée (« from », FROM
// décalé, sans empreinte…) arrête tout : son empreinte sortirait sinon de la comparaison
// sans rien dire.
function lignesFrom(texte) {
  return texte.replace(/\r\n/g, '\n').split('\n').filter(ligne => LIGNE_FROM.test(ligne)).map(ligne => {
    const m = FROM.exec(ligne);
    if (!m) throw new Arret(`Ligne FROM hors de la forme épinglée « FROM [--platform=…] image:étiquette@sha256:… [AS étape] » : ${ligne}`);
    // Nom d'étape en minuscules : Docker n'y distingue pas la casse.
    return { ligne, plateforme: m[1] || '', image: m[2], etiquette: m[3], empreinte: m[4], etape: (m[5] || '').slice(4).toLowerCase() };
  });
}

// Une autre plateforme n'est pas une montée : seules l'image et l'étiquette comptent.
const memeEtiquette = (a, b) => Boolean(a && b) && a.image === b.image && a.etiquette === b.etiquette;

// Étapes d'un Dockerfile, dans l'ordre : par elles, une ligne FROM garde sa place.
const nomsEtapes = lignes => lignes.map(ligne => ligne.etape || 'sans nom').join(', ');

// Empreinte de référence de chaque ligne FROM du Dockerfile actuel. versions : le
// Dockerfile de la révision, puis ceux de main qui l'ont changé, du plus ancien au plus
// récent (git log --first-parent) ; noms : la révision et ces commits, pour les messages.
// Chaque état doit être lisible et garder les étapes d'aujourd'hui, dans le même ordre :
// sinon une ligne suivie par sa place changerait d'étape, et une empreinte changée avant
// sortirait de la comparaison. Même image et même étiquette que dans la révision :
// l'empreinte de la révision. Sinon (montée) : celle du plus ancien état de main depuis
// lequel la ligne garde son image et son étiquette actuelles (montee : son rang).
function references(versions, actuel, noms = versions.map((_, k) => (k ? `l'état ${k}` : 'la révision'))) {
  const etats = versions.map((texte, k) => {
    try { return lignesFrom(texte); } catch (err) { throw new Arret(`Dockerfile de ${noms[k]} illisible : ${err.message}`); }
  });
  const apres = lignesFrom(actuel);
  [...etats, apres].forEach((lignes, k, suite) => {
    if (k && nomsEtapes(lignes) !== nomsEtapes(suite[k - 1])) {
      throw new Arret(`Étapes du Dockerfile changées ${k < etats.length ? `en ${noms[k]}` : 'sans commit'} (${nomsEtapes(suite[k - 1])}, puis `
        + `${nomsEtapes(lignes)}) : les lignes FROM ne se suivent plus jusqu'à ${noms[0]} (.github/RELEASE.md, « Son verdict »).`);
    }
  });
  return apres.map((ligne, i) => {
    if (memeEtiquette(etats[0][i], ligne)) return { ...etats[0][i], montee: 0 };
    let k = etats.length;
    while (k > 1 && memeEtiquette(etats[k - 1][i], ligne)) k--;
    if (k === etats.length) throw new Arret(`Ligne FROM changée sans commit : ${ligne.ligne}`);
    return { ...etats[k][i], montee: k };
  });
}

// Empreintes changées entre les références et le Dockerfile actuel, ligne FROM par ligne FROM.
function empreintesChangees(refs, actuel) {
  return lignesFrom(actuel).flatMap((ligne, i) => refs[i].empreinte === ligne.empreinte ? []
    : [{ image: `${ligne.image}:${ligne.etiquette}`, avant: refs[i].empreinte, apres: ligne.empreinte, montee: refs[i].montee }]);
}

// Le Dockerfile actuel avec les empreintes de référence : même code, anciennes images de base.
function dockerfileAncien(refs, actuel) {
  let i = 0;
  return actuel.replace(/\r\n/g, '\n').split('\n')
    .map(ligne => LIGNE_FROM.test(ligne) ? ligne.replace(EMPREINTE, refs[i++].empreinte) : ligne).join('\n');
}

// Versions attendues d'après les étiquettes : node:<n>-… et eclipse-temurin:<n>-….
function versionsAttendues(actuel) {
  const etiquettes = lignesFrom(actuel);
  const majeure = (image, motif) => {
    const trouvees = [...new Set(etiquettes.filter(f => f.image === image).map(f => (motif.exec(f.etiquette) || [])[1]))];
    if (trouvees.length !== 1 || !trouvees[0]) throw new Arret(`Version majeure de ${image} illisible dans le Dockerfile.`);
    return trouvees[0];
  };
  return { node: majeure('node', /^(\d+)-/), java: majeure('eclipse-temurin', /^(\d+)-/) };
}

// Écarts entre les versions lues dans une image et celles des étiquettes.
function problemesVersions(versions, attendues) {
  const problemes = [];
  if (!versions.node.startsWith(`v${attendues.node}.`)) problemes.push(`Node ${versions.node}, attendu ${attendues.node}.x`);
  if (!new RegExp(`^(openjdk|java) ${attendues.java}([. ]|$)`).test(versions.java)) problemes.push(`Java « ${versions.java} », attendu ${attendues.java}`);
  return problemes;
}

// Contrôles de V37 (verifier_rejeu de test/verifier-image.sh) : Timefold a rendu chaque plan,
// avec le jar de l'image.
function problemesRejeu(rejeu) {
  const t = rejeu && rejeu.timefold;
  if (!t) return ['rejeu sans Timefold'];
  const problemes = [];
  if (!(t.asked > 0)) problemes.push(`timefold.asked = ${t.asked}, attendu au moins 1`);
  if (t.ok !== t.asked) problemes.push(`timefold.ok = ${t.ok} pour ${t.asked} demandes`);
  if (t.failed !== 0) problemes.push(`timefold.failed = ${t.failed}`);
  if (t.ceiling !== 0) problemes.push(`timefold.ceiling = ${t.ceiling} (plafond de temps atteint)`);
  if (t.moves !== 20000) problemes.push(`timefold.moves = ${t.moves}, attendu 20000`);
  if (rejeu.jar !== JAR) problemes.push(`jar = ${rejeu.jar}, attendu ${JAR}`);
  return problemes;
}

// Champs qui diffèrent, comme V38 : tout sauf le jar et les avertissements.
function differences(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(champ => champ !== 'jar' && champ !== 'warnings').sort()
    .filter(champ => JSON.stringify(a[champ]) !== JSON.stringify(b[champ]));
}

// Essai de la télécommande KaraFun dans une image (.github/RELEASE.md), à lancer dans
// PowerShell, de n'importe quel dossier ; sans image comparée, la commande construit celle
// de la copie de travail.
const essaiKaraFun = image => `docker run --rm --init --pull never -v "${path.join(root, 'test')}:/app/test:ro" `
  + `${image || `$(docker build -q "${root}")`} node test/probe-kcs.js <code>`;

// Ce qui reste à faire à la main avant de publier, redit en dernier (la sortie de docker
// build ferait défiler un rappel donné plus tôt) : les essais qu'une montée a dû faire dans
// sa PR (SECURITY.md, « Comment monter »), et l'essai de la télécommande pour un autre Node.
// Une montée de Node est toujours rappelée, même si une empreinte a changé sa version
// depuis : la commande de l'essai n'est alors donnée qu'une fois, avec l'autre Node.
function aFaire({ tag, montees, image = null, node = null }) {
  const lignes = [];
  if (montees.some(r => r.image === 'node')) {
    lignes.push(`Node est monté depuis ${tag} : sa PR doit avoir fait l'essai de la télécommande KaraFun et la comparaison --json (AGENTS.md)`
      + (node ? '.' : ` ; sinon, faire l'essai, dans PowerShell : ${essaiKaraFun(image)}`));
  }
  if (node) lignes.push(`Node a changé (${node}) : essai de la télécommande KaraFun, dans PowerShell : ${essaiKaraFun(image)}`);
  const autres = [...new Set(montees.filter(r => r.image !== 'node').map(r => `${r.image}:${r.etiquette}`))];
  if (autres.length) {
    lignes.push(`Montée depuis ${tag} de ${autres.join(' et ')} : sa PR doit avoir fait le bilan d'une vraie soirée et la comparaison --json (AGENTS.md).`);
  }
  if (lignes.length) console.log(['À faire avant de publier :', ...lignes.map(ligne => `- ${ligne}`)].join('\n'));
}

function lancer(commande, args, options = {}) {
  const r = spawnSync(commande, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * MINUTE, ...options });
  if (r.error) throw new Arret(`${commande} ${args[0]} impossible ou trop long (${r.error.code || r.error.message}).`);
  return r;
}

// Sortie standard d'une commande réussie ; sinon arrêt avec la fin de son erreur.
function exiger(r, quoi) {
  if (r.status === 0) return r.stdout || '';
  const fin = String(r.stderr || '').trim().split('\n').slice(-3).join(' / ');
  throw new Arret(`${quoi} : code ${r.status}${fin ? ` (${fin})` : ''}.`);
}

const git = (args, quoi) => exiger(lancer('git', args), quoi).trim();

function main(argv) {
  const essai = argv.includes('--essai');
  const args = argv.filter(arg => arg !== '--essai');
  if (args.length !== 1 || !args[0]) {
    console.error('Usage : node test/comparer-images.js <dernier tag publié> [--essai]');
    return 2;
  }
  const tag = args[0];
  const revision = git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], `Révision introuvable : ${tag} (git fetch --tags ?)`);
  const tete = git(['rev-parse', 'HEAD'], 'HEAD illisible');
  if (lancer('git', ['merge-base', '--is-ancestor', revision, 'HEAD']).status !== 0) {
    throw new Arret(`${tag} n'est pas dans l'historique de HEAD : donner le dernier tag publié depuis main.`);
  }
  if (!essai) {
    // Le verdict ne vaut que pour le commit publié : le main du serveur, sans modification ni
    // fichier non suivi (la construction et le rejeu lisent la copie de travail).
    const distant = git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], 'main du serveur illisible (réseau ?)').split(/\s/)[0];
    const etat = git(ETAT, 'état de la copie de travail illisible');
    if (etat) {
      const fichiers = etat.split('\n').slice(0, 3).map(ligne => ligne.trim()).join(' ; ');
      throw new Arret(`Copie de travail modifiée ou avec des fichiers non suivis (${fichiers}) : le verdict ne vaudrait pour aucun commit. `
        + 'Valider, retirer ou mettre de côté, ou --essai.');
    }
    if (tete !== distant) throw new Arret(`HEAD (${tete}) n'est pas le main du serveur (${distant}) : git switch main, git pull --tags, ou --essai.`);
  }
  const commits = git(['log', '--first-parent', '--reverse', '--format=%H', `${revision}..HEAD`, '--', 'Dockerfile'], 'Historique du Dockerfile illisible')
    .split('\n').filter(Boolean);
  const suite = [revision, ...commits];
  const actuel = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  // Avant tout verdict : la copie de travail est encore celle du départ. La construction et
  // le rejeu la relisent pendant des minutes : un git pull, un git switch ou une modification
  // entre-temps donneraient un verdict pour un autre code que celui du commit affiché.
  const inchangee = () => {
    const maintenant = git(['rev-parse', 'HEAD'], 'HEAD illisible');
    if (maintenant !== tete) throw new Arret(`HEAD a changé pendant la comparaison (${tete}, puis ${maintenant}) : relancer l'outil.`);
    if (!essai && git(ETAT, 'état de la copie de travail illisible')) {
      throw new Arret('La copie de travail a changé pendant la comparaison (modification ou fichier non suivi) : relancer l\'outil.');
    }
    if (fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8') !== actuel) throw new Arret('Le Dockerfile a changé pendant la comparaison : relancer l\'outil.');
  };
  const refs = references(suite.map(commit => exiger(lancer('git', ['show', `${commit}:Dockerfile`]), `Dockerfile de ${commit.slice(0, 7)} illisible`)),
    actuel, [tag, ...commits.map(commit => commit.slice(0, 7))]);
  const changees = empreintesChangees(refs, actuel);
  console.log(`Commit comparé : ${tete}${essai ? ' (essai : le verdict ne vaut pas pour une publication)' : ' (main du serveur)'} ; référence : ${tag}.`);
  const montees = refs.filter(r => r.montee);
  for (const ligne of new Set(montees.map(r => `${r.image}:${r.etiquette} : montée en ${suite[r.montee].slice(0, 7)}, comparée depuis.`))) console.log(ligne);
  if (!changees.length) {
    inchangee();
    console.log(`Aucune empreinte d'image de base changée depuis ${tag}${montees.length ? ' ni depuis les montées' : ''} : rien à comparer.`);
    aFaire({ tag, montees });
    return 0;
  }
  // Une image citée sur deux lignes FROM (étape de construction et image finale) ne s'affiche qu'une fois.
  for (const ligne of new Set(changees.map(c => `${c.image} : ${c.avant.slice(7, 19)} devenue ${c.apres.slice(7, 19)}`))) console.log(ligne);
  const ancien = dockerfileAncien(refs, actuel);
  if (ancien === actuel.replace(/\r\n/g, '\n')) throw new Arret('Dockerfile ancien identique à l\'actuel malgré des empreintes changées : défaut de l\'outil.');
  const attendues = versionsAttendues(actuel);
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'comparer-images-'));
  // Dossier en 0700 ; seul sortie/, monté dans le conteneur, s'ouvre à son utilisateur
  // node, comme dans test/verifier-image.sh.
  const sortie = path.join(dossier, 'sortie');
  let garder = false;
  try {
    fs.mkdirSync(sortie);
    fs.chmodSync(sortie, 0o777);
    // Les images servent par leur identifiant, sans étiquette : un autre essai ne s'y mêle pas.
    const ids = {};
    for (const nom of NOMS) {
      const iid = path.join(dossier, `${nom}.iid`);
      const vieille = nom === 'ancienne';
      exiger(lancer('docker', ['build', ...(vieille ? ['-f', '-'] : []), '--iidfile', iid, '.'],
        { input: vieille ? ancien : undefined, stdio: [vieille ? 'pipe' : 'ignore', 'inherit', 'inherit'], timeout: 60 * MINUTE }),
        `Construction de l'image ${nom}`);
      ids[nom] = fs.readFileSync(iid, 'utf8').trim();
    }
    console.log(`Images : ${ids.ancienne} (ancienne), ${ids.nouvelle} (nouvelle).`);
    if (ids.ancienne === ids.nouvelle) {
      // Seule l'autre architecture a changé : rien ne change ici, et les décisions non plus.
      inchangee();
      console.log('Même image pour cette architecture : les empreintes changées n\'y changent rien. Pour l\'autre architecture, rien ne '
        + 'compare l\'ancienne et la nouvelle image : la publication la vérifie seulement contre le Java et le Node du runner (V36 à V38).');
      aFaire({ tag, montees, image: ids.nouvelle });
      return 0;
    }
    const rejeux = {}, versions = {};
    for (const nom of NOMS) {
      const run = (quoi, extra, commande) => exiger(lancer('docker', ['run', '--rm', '--init', ...extra, ids[nom], ...commande]), `${quoi} dans l'image ${nom}`);
      versions[nom] = { node: run('node --version', [], ['node', '--version']).trim(),
        java: run('java --version', [], ['/app/solver-runtime/bin/java', '--version']).trim().split('\n').slice(0, 2).join(' ; ') };
      console.log(`${nom} : Node ${versions[nom].node} ; ${versions[nom].java}`);
      const ecarts = problemesVersions(versions[nom], attendues);
      if (ecarts.length) throw new Arret(`Image ${nom} : ${ecarts.join(' ; ')}.`);
      const texte = run('Rejeu', ['--network', 'none', '-v', `${path.join(root, 'test')}:/app/test:ro`,
        '-v', `${path.join(root, 'solver', 'src')}:/app/solver/src:ro`, '-v', `${sortie}:/sortie`],
      ['node', 'test/rejeu-soiree.js', SOIREE, '--libre', '--solveur', '--cles', '--court', '--json', `/sortie/${nom}.json`]);
      console.log(texte.trim().split('\n').slice(0, 2).map(ligne => `  ${ligne}`).join('\n'));
      let rejeu;
      try { rejeu = JSON.parse(fs.readFileSync(path.join(sortie, `${nom}.json`), 'utf8')); }
      catch (err) { throw new Arret(`Rejeu dans l'image ${nom} : sortie JSON illisible (${err.message}).`); }
      const problemes = problemesRejeu(rejeu);
      if (problemes.length) throw new Arret(`Rejeu dans l'image ${nom} non concluant : ${problemes.join(' ; ')}.`);
      if (rejeu.warnings && rejeu.warnings.length) console.log(`  avertissements : ${rejeu.warnings.join(' ; ')}`);
      rejeux[nom] = rejeu;
    }
    // Copie de travail changée en cours de route : rien n'est prouvé, les rejeux restent.
    inchangee();
    const ecarts = differences(rejeux.ancienne, rejeux.nouvelle);
    if (ecarts.length) {
      garder = true;
      console.log(`Décisions différentes (${ecarts.join(', ')}) : ne pas publier avant d'avoir compris l'écart.`);
      console.log(`Rejeux gardés : ${path.join(sortie, 'ancienne.json')} et ${path.join(sortie, 'nouvelle.json')}.`);
      return 1;
    }
    console.log(`Mêmes décisions dans les deux images (${rejeux.nouvelle.timefold.asked} plans Timefold chacune).`);
    // L'essai de la télécommande vise cette image-là, par son identifiant (.github/RELEASE.md).
    const node = versions.ancienne.node !== versions.nouvelle.node ? `${versions.ancienne.node} puis ${versions.nouvelle.node}` : null;
    if (!node && changees.some(c => c.image.startsWith('node:'))) {
      console.log(`Empreinte de Node changée, même version ${versions.nouvelle.node} : essai de la télécommande facultatif (${essaiKaraFun(ids.nouvelle)}).`);
    }
    aFaire({ tag, montees, image: ids.nouvelle, node });
    return 0;
  } catch (err) {
    // Rien n'est prouvé, mais un rejeu déjà fait reste, pour en voir la raison.
    const faits = NOMS.filter(nom => fs.existsSync(path.join(sortie, `${nom}.json`)));
    if (faits.length) {
      garder = true;
      console.error(`Rejeux faits gardés dans ${sortie} (${faits.map(nom => `${nom}.json`).join(', ')}).`);
    }
    throw err;
  } finally {
    // Un nettoyage raté ne change pas le verdict : il est seulement signalé.
    if (!garder) {
      try { fs.rmSync(dossier, { recursive: true, force: true, maxRetries: 3 }); }
      catch (err) { console.error(`Dossier temporaire non retiré (${err.code || err.message}) : ${dossier}`); }
    }
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // Toute autre erreur aussi : rien n'est prouvé, jamais le code 1 des décisions différentes.
    console.error(err instanceof Arret ? `ÉCHEC : ${err.message}` : err);
    process.exitCode = 2;
  }
}

module.exports = { lignesFrom, references, empreintesChangees, dockerfileAncien, versionsAttendues, problemesVersions, problemesRejeu, differences, Arret };
