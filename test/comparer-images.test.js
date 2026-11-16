'use strict';
// Règles de test/comparer-images.js (.github/RELEASE.md, « Avant de publier ») : ses
// fonctions sur le Dockerfile du dépôt, ses arrêts avant Docker, son verdict avec de
// faux git et docker (hors Windows), et son historique sur un vrai dépôt git (C9 avec un
// faux docker, hors Windows ; C10 sans Docker, partout).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lignesFrom, references, empreintesChangees, dockerfileAncien, versionsAttendues, problemesVersions, problemesRejeu, differences, Arret } =
  require('./comparer-images');

const root = path.join(__dirname, '..');
const actuel = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
const EMPREINTE = /sha256:[0-9a-f]{64}/;
const empreinte = chiffre => `sha256:${String(chiffre).repeat(64)}`;
// Le Dockerfile avec une empreinte propre à chaque ligne FROM choisie (depart, depart + 1…).
const changer = (texte, choisir, depart = 1) => {
  let n = depart - 1;
  return texte.split('\n').map(ligne => /^FROM /.test(ligne) && choisir(ligne) ? ligne.replace(EMPREINTE, empreinte(++n)) : ligne).join('\n');
};
const node = ligne => / node:/.test(ligne);
// Le même Dockerfile avec une autre étiquette de Node (une montée, ou son retour).
const nodeDecale = (texte, ecart) => texte.replace(/ node:(\d+)-/g, (_, version) => ` node:${Number(version) + ecart}-`);
const temurinLigne = actuel.split('\n').find(ligne => /^FROM eclipse-temurin:/.test(ligne));
const avant = changees => changees.map(c => [c.image.split(':')[0], c.avant]);

test('C1 seules les empreintes changées comptent, ligne FROM par ligne FROM', () => {
  const from = lignesFrom(actuel);
  assert.ok(from.some(f => f.image === 'node') && from.some(f => f.image === 'maven') && from.some(f => f.image === 'eclipse-temurin'),
    'Node, Maven et Temurin dans le Dockerfile');
  assert.ok(from.every(f => !/^sha256:(\d)\1{63}$/.test(f.empreinte)), 'empreintes de test distinctes des vraies');
  assert.deepEqual(empreintesChangees(references([actuel], actuel), actuel), [], 'même Dockerfile : rien à comparer');
  assert.deepEqual(avant(empreintesChangees(references([changer(actuel, node)], actuel), actuel)), [['node', empreinte(1)], ['node', empreinte(2)]]);
  assert.equal(empreintesChangees(references([changer(actuel, () => true)], actuel), actuel).length, from.length, 'Maven compris');
  assert.equal(empreintesChangees(references([actuel.replace(/\n/g, '\r\n')], actuel), actuel).length, 0, 'fins de ligne Windows');
  // Docker lit aussi « from » ou un FROM décalé : une telle ligne arrête tout, sinon son
  // empreinte sortirait de la comparaison sans rien dire.
  for (const autre of [temurinLigne.replace(/^FROM/, 'from'), ` ${temurinLigne}`]) {
    assert.throws(() => lignesFrom(actuel.replace(temurinLigne, autre)), Arret, autre);
  }
});

test('C2 une ligne montée se compare depuis l’état de main où elle a pris son étiquette actuelle', () => {
  // Montée de Node : comparée depuis la montée ; les autres lignes depuis la révision.
  const montee = changer(actuel, node);
  const refs = references([nodeDecale(montee, -4), montee], actuel);
  assert.deepEqual(refs.map(r => r.montee), lignesFrom(actuel).map(f => (f.image === 'node' ? 1 : 0)));
  assert.deepEqual(avant(empreintesChangees(refs, actuel)), [['node', empreinte(1)], ['node', empreinte(2)]]);
  assert.deepEqual(empreintesChangees(references([nodeDecale(actuel, -4), actuel], actuel), actuel), [], 'montée sans autre empreinte');
  // Une empreinte de Node fusionnée seule avant une montée de Java reste comparée depuis la révision.
  const javaAvant = texte => texte.replace(temurinLigne, temurinLigne.replace(/:(\d+)-jdk/, (_, version) => `:${Number(version) - 4}-jdk`));
  const suite = references([javaAvant(changer(actuel, node, 3)), javaAvant(actuel), actuel], actuel);
  assert.deepEqual(suite.map(r => r.montee), lignesFrom(actuel).map(f => (f.image === 'eclipse-temurin' ? 2 : 0)));
  assert.deepEqual(avant(empreintesChangees(suite, actuel)), [['node', empreinte(3)], ['node', empreinte(4)]]);
  // Une montée annulée ensuite (retour à l'étiquette de la révision) : comparée depuis la révision.
  const retour = references([changer(actuel, node, 5), actuel, nodeDecale(changer(actuel, node, 7), 2), actuel], actuel);
  assert.deepEqual(avant(empreintesChangees(retour, actuel)), [['node', empreinte(5)], ['node', empreinte(6)]]);
  // Une autre plateforme n'est pas une montée.
  const plateforme = actuel.replace(temurinLigne, temurinLigne.replace(/^FROM /, 'FROM --platform=linux/amd64 '));
  assert.deepEqual(avant(empreintesChangees(references([changer(actuel, ligne => /^FROM eclipse-temurin:/.test(ligne), 7), actuel, plateforme], plateforme), plateforme)),
    [['eclipse-temurin', empreinte(7)]], 'autre plateforme');
  // Les lignes se suivent par leur place : des étapes changées en chemin (renommée, déplacée,
  // ajoutée ou retirée) ou un Dockerfile illisible arrêtent tout, montée comprise, plutôt que
  // de laisser hors de la comparaison une empreinte changée avant.
  const [, jre, deps] = actuel.split('\n').filter(ligne => /^FROM /.test(ligne));
  const deplace = actuel.replace(jre, '§').replace(deps, jre).replace('§', deps);
  const renomme = actuel.replace(temurinLigne, temurinLigne.replace(/ AS \S+$/, ' AS autre'));
  const sansTemurin = actuel.split('\n').filter(ligne => ligne !== temurinLigne).join('\n');
  const illisible = texte => texte.replace(temurinLigne, temurinLigne.replace(/@sha256:[0-9a-f]{64}/, ''));
  const m = changer(actuel, node, 5);
  for (const [cas, versions, apres] of [
    ['étapes déplacées après une empreinte fusionnée seule', [changer(actuel, () => true), actuel, deplace], deplace],
    ['étape renommée', [changer(actuel, () => true), renomme], renomme],
    ['une étape de moins depuis la révision', [actuel], sansTemurin],
    ['une étape retirée puis remise, en chemin', [changer(actuel, node), sansTemurin, actuel], actuel],
    ['un Dockerfile illisible en chemin', [changer(actuel, node), illisible(actuel), actuel], actuel],
    ['une étape de moins en chemin, après une montée', [nodeDecale(m, -4), m, m.replace(`${temurinLigne}\n`, ''), actuel], actuel],
    ['un Dockerfile illisible en chemin, après une montée', [nodeDecale(m, -4), m, illisible(m), actuel], actuel],
    ['révision sans empreinte', [illisible(actuel)], actuel],
    ['étiquette changée sans commit', [actuel], nodeDecale(actuel, 2)],
    ['étapes changées sans commit', [actuel], deplace],
  ]) assert.throws(() => references(versions, apres), Arret, cas);
  // L'arrêt nomme le commit où les étapes ont changé.
  assert.throws(() => references([actuel, actuel, renomme], renomme, ['v0.0.0', 'aaaaaaa', 'bbbbbbb']), /Étapes du Dockerfile changées en bbbbbbb/);
});

test('C3 l’ancienne image : le Dockerfile actuel avec les empreintes de référence, chacune sur sa ligne', () => {
  // Une empreinte propre à chaque ligne, Maven laissé tel quel.
  const ancien = changer(actuel, ligne => !/ maven:/.test(ligne)).replace('# Images de base', '# Commentaire de la révision');
  const construit = dockerfileAncien(references([ancien], actuel), actuel);
  assert.deepEqual(lignesFrom(construit).map(f => f.empreinte), lignesFrom(ancien).map(f => f.empreinte), 'chaque empreinte sur sa ligne');
  assert.equal(lignesFrom(construit).find(f => f.image === 'maven').empreinte, lignesFrom(actuel).find(f => f.image === 'maven').empreinte);
  const sans = texte => texte.replace(new RegExp(EMPREINTE.source, 'g'), '');
  assert.equal(sans(construit), sans(actuel), 'tout le reste vient du Dockerfile actuel');
});

test('C4 un rejeu ne prouve rien sans tous ses plans Timefold, faits par le jar de l’image, comme V37', () => {
  const timefold = { asked: 37, ok: 37, failed: 0, ceiling: 0, moves: 20000 };
  const bon = { timefold, jar: '/app/solver/karafun-solver.jar' };
  assert.deepEqual(problemesRejeu(bon), []);
  for (const [cas, rejeu] of [['sans Timefold', {}], ['aucune demande', { ...bon, timefold: { ...timefold, asked: 0, ok: 0 } }],
    ['un plan manquant', { ...bon, timefold: { ...timefold, ok: 36 } }], ['un échec', { ...bon, timefold: { ...timefold, failed: 1 } }],
    ['plafond de temps', { ...bon, timefold: { ...timefold, ceiling: 1 } }], ['autre effort', { ...bon, timefold: { ...timefold, moves: 0 } }],
    ['autre jar', { ...bon, jar: '/tmp/karafun-solver.jar' }], ['jar absent', { timefold }]]) {
    assert.ok(problemesRejeu(rejeu).length, cas);
  }
  // Les conditions de verifier_rejeu de test/verifier-image.sh, dans les deux sens : un contrôle
  // ajouté d'un seul côté échoue ici. V37 lui passe le jar attendu, l'outil le connaît.
  const verifier = /verifier_rejeu\(\) \{([\s\S]*?)\n\}/.exec(fs.readFileSync(path.join(root, 'test', 'verifier-image.sh'), 'utf8'));
  assert.ok(verifier, 'verifier_rejeu absent de test/verifier-image.sh');
  const v37 = [...verifier[1].matchAll(/if \((.+?)\) faute/g)].map(m => m[1].replace('process.argv[2] && r.jar !== process.argv[2]', 'rejeu.jar !== JAR'));
  const controles = [...problemesRejeu.toString().matchAll(/if \((.+?)\) (?:return|problemes\.push)/g)].map(m => m[1]);
  assert.deepEqual(controles.sort(), v37.sort());
});

test('C5 les décisions se comparent comme V38 : tout sauf le jar et les avertissements', () => {
  const a = { decisions: [1, 2], waits: { moyenne: 24.5 }, jar: '/app/solver/karafun-solver.jar', warnings: ['avertissement'] };
  assert.deepEqual(differences(a, { ...a, jar: '/autre.jar', warnings: [] }), []);
  assert.deepEqual(differences(a, { decisions: [1, 2], waits: { moyenne: 24.5 } }), [], 'jar et avertissements absents');
  assert.deepEqual(differences(a, { ...a, decisions: [2, 1] }), ['decisions']);
  assert.deepEqual(differences(a, { ...a, nouveau: 1 }), ['nouveau'], 'champ en plus');
  // Les champs écartés sont ceux du filtre de V38 dans test/verifier-image.sh : un champ écarté
  // d'un seul côté échoue ici.
  const v38 = /controle V38[\s\S]*?\.filter\(k => (.+?)\)\.sort\(\)/.exec(fs.readFileSync(path.join(root, 'test', 'verifier-image.sh'), 'utf8'));
  assert.ok(v38, 'filtre de V38 absent de test/verifier-image.sh');
  assert.deepEqual([...differences.toString().matchAll(/champ !== '(\w+)'/g)].map(m => m[1]).sort(), [...v38[1].matchAll(/k !== "(\w+)"/g)].map(m => m[1]).sort());
});

test('C6 les versions de Node et de Java de chaque image suivent les étiquettes du Dockerfile', () => {
  const attendues = versionsAttendues(actuel);
  const n = Number(attendues.node), j = Number(attendues.java);
  assert.ok(n > 0 && j > 0, JSON.stringify(attendues));
  const bonnes = { node: `v${n}.13.0`, java: `openjdk ${j}.0.5 2026-10-20 LTS ; OpenJDK Runtime Environment Temurin-${j}.0.5+8 (build ${j}.0.5+8-LTS)` };
  assert.deepEqual(problemesVersions(bonnes, attendues), []);
  assert.deepEqual(problemesVersions({ ...bonnes, java: `openjdk ${j} 2026-09-16 LTS` }, attendues), [], 'Java d’une première version');
  for (const [cas, versions] of [['autre Node', { ...bonnes, node: `v${n + 2}.0.0` }], ['Node voisin', { ...bonnes, node: `v${n}0.1.0` }],
    ['autre Java', { ...bonnes, java: `openjdk ${j + 1}.0.1 2027-01-20` }], ['Java muet', { ...bonnes, java: '' }]]) {
    assert.equal(problemesVersions(versions, attendues).length, 1, cas);
  }
});

const git = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root }).status === 0;
const outil = (args, options = {}) => spawnSync(process.execPath, [path.join(__dirname, 'comparer-images.js'), ...args], { cwd: root, encoding: 'utf8', ...options });

test('C7 sans révision lisible, l’outil s’arrête avant Docker, code 2', { skip: git ? false : 'git ou dépôt absent' }, () => {
  for (const [args, motif] of [[[], /Usage/], [[''], /Usage/], [['--essai'], /Usage/], [['revision-absente-du-depot', '--essai'], /Révision introuvable/]]) {
    const r = outil(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, motif, JSON.stringify(args));
  }
  // HEAD et le même Dockerfile, en essai : rien à comparer, sans Docker.
  if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'Dockerfile'], { cwd: root }).status === 0) {
    const r = outil(['HEAD', '--essai']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rien à comparer/);
  }
});

const bash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;

test('C8 le verdict après Docker : 0 mêmes décisions, 1 écart gardé, 2 rien de prouvé', { skip: bash ? false : 'bash absent (faux git et docker en scripts)' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparer-faux-'));
  try {
    const ecrire = (nom, texte, mode = 0o755) => fs.writeFileSync(path.join(dir, nom), texte, { mode });
    // L'outil tourne depuis une copie (dir/depot) avec le Dockerfile du dépôt : un faux
    // docker peut y changer le Dockerfile en cours de route sans toucher au dépôt.
    const depot = path.join(dir, 'depot');
    fs.mkdirSync(path.join(depot, 'test'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'comparer-images.js'), path.join(depot, 'test', 'comparer-images.js'));
    fs.writeFileSync(path.join(depot, 'Dockerfile'), actuel);
    // Faux git : révisions et Dockerfile servis depuis $FAUX (un fichier par commit). Il
    // refuse tout autre appel que ceux de l'outil, historique de main compris.
    ecrire('git', ['#!/usr/bin/env bash', 'case "$1" in',
      // Copie de travail changée en cours de route, une fois l'historique lu ($FAUX/bouge) :
      // $FAUX_BOUGE dit quoi (head : HEAD ; statut : un fichier non suivi ; dockerfile : le
      // Dockerfile, que change alors la construction).
      '  rev-parse) case "$*" in "rev-parse HEAD") if [ "$FAUX_BOUGE" = head ] && [ -e "$FAUX/bouge" ]; then echo autre; else echo "${FAUX_HEAD:-tete}"; fi;;',
      '    "rev-parse --verify --quiet v0.0.0^{commit}") echo reference;; *) exit 2;; esac ;;',
      '  merge-base) [ "$*" = "merge-base --is-ancestor reference HEAD" ] || exit 2; exit "${FAUX_ANCETRE:-0}" ;;',
      '  ls-remote) [ "$*" = "ls-remote --exit-code origin refs/heads/main" ] || exit 2; printf "%s\\trefs/heads/main\\n" "${FAUX_MAIN:-tete}" ;;',
      '  status) [ "$*" = "status --porcelain --untracked-files=all" ] || exit 2',
      '    if [ "$FAUX_BOUGE" = statut ] && [ -e "$FAUX/bouge" ]; then echo "?? solver/src/main/java/Nouveau.java"; else printf "%s" "$FAUX_STATUS"; fi ;;',
      '  log) [ "$*" = "log --first-parent --reverse --format=%H reference..HEAD -- Dockerfile" ] || exit 2; printf "%s" "$FAUX_LOG"',
      '    [ -z "$FAUX_BOUGE" ] || touch "$FAUX/bouge" ;;',
      '  show) cat "$FAUX/${2%%:*}" ;;', '  *) exit 2 ;;', 'esac'].join('\n') + '\n');
    // Faux docker : build garde l'éventuel Dockerfile reçu et donne un identifiant par
    // image ; run rend les versions de l'image, ou écrit à l'endroit demandé le rejeu de
    // l'image lancée, seulement sans réseau. Rien d'autre (aucune étiquette). Avec
    // FAUX_BOUGE=dockerfile, la construction change le Dockerfile de la copie de travail.
    ecrire('docker', ['#!/usr/bin/env bash',
      'image() { for a; do case "$a" in id-*) echo "${a#id-}"; return;; esac; done; }',
      'case "$1" in',
      '  build) [ "${FAUX_BUILD:-0}" = 0 ] || exit 1',
      '    [ "$FAUX_BOUGE" != dockerfile ] || echo "# changé pendant la comparaison" >> Dockerfile',
      '    nom=nouvelle; [ "$2" = -f ] && { nom=ancienne; cat > "$FAUX/construit"; }',
      '    for a; do [ "$prec" = --iidfile ] && [ -z "$FAUX_SANS_IID" ] && echo "id-${FAUX_MEME_ID:-$nom}" > "$a"; prec=$a; done ;;',
      '  run) nom=$(image "$@"); case "$*" in',
      '      *"node --version") v=FAUX_NODE_$nom; echo "${!v:-$FAUX_NODE_nouvelle}" ;;',
      '      *"java --version") printf "%s\\n" "$FAUX_JAVA" ;;',
      '      *) case "$*" in *" --network none "*) ;; *) exit 3 ;; esac',
      '         for a; do case "$a" in *:/sortie) s=${a%:/sortie};; /sortie/*.json) f=${a#/sortie/};; esac; done',
      '         v=FAUX_REJEU_$nom; printf "%s" "${!v}" > "$s/$f" ;;',
      '    esac ;;', '  *) exit 2 ;;', 'esac'].join('\n') + '\n');
    ecrire('reference', changer(actuel, node), 0o644);
    const rejeu = decisions => JSON.stringify({ timefold: { asked: 1, ok: 1, failed: 0, ceiling: 0, moves: 20000 }, jar: '/app/solver/karafun-solver.jar', decisions });
    // Versions des images d'après les étiquettes du Dockerfile, quelle que soit la LTS en service.
    const { node: n, java: j } = versionsAttendues(actuel);
    const lancer = (env = {}, args = ['v0.0.0']) => spawnSync(process.execPath, [path.join(depot, 'test', 'comparer-images.js'), ...args], { cwd: depot, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAUX: dir,
        FAUX_STATUS: '', FAUX_LOG: '', FAUX_REJEU_ancienne: rejeu([1]), FAUX_REJEU_nouvelle: rejeu([1]), FAUX_NODE_ancienne: `v${n}.12.0`, FAUX_NODE_nouvelle: `v${n}.13.0`,
        FAUX_JAVA: `openjdk ${j}.0.5 2026-10-20 LTS\nOpenJDK Runtime Environment Temurin-${j}.0.5+8 (build ${j}.0.5+8-LTS)`, ...env } });
    const memes = lancer();
    assert.equal(memes.status, 0, memes.stderr);
    assert.match(memes.stdout, /Commit comparé : tete \(main du serveur\)/);
    assert.match(memes.stdout, /Mêmes décisions/);
    assert.match(memes.stdout, new RegExp(`Node a changé \\(v${n}\\.12\\.0 puis v${n}\\.13\\.0\\).*id-nouvelle node test/probe-kcs\\.js`), 'essai visant l’image comparée');
    assert.deepEqual(lignesFrom(fs.readFileSync(path.join(dir, 'construit'), 'utf8')).map(f => f.empreinte),
      lignesFrom(changer(actuel, node)).map(f => f.empreinte), 'ancienne image construite avec les empreintes de la révision');
    const memeNode = lancer({ FAUX_NODE_ancienne: `v${n}.13.0` });
    assert.doesNotMatch(memeNode.stdout, /Node a changé/, 'même version de Node : pas d’essai à refaire');
    assert.match(memeNode.stdout, new RegExp(`même version v${n}\\.13\\.0 : essai de la télécommande facultatif`));
    const identiques = lancer({ FAUX_MEME_ID: 'meme' });
    assert.equal(identiques.status, 0, identiques.stderr);
    assert.match(identiques.stdout, /Même image pour cette architecture/);
    assert.doesNotMatch(identiques.stdout, /Mêmes décisions/, 'rien à rejouer');
    const ecart = lancer({ FAUX_REJEU_nouvelle: rejeu([2]) });
    assert.equal(ecart.status, 1, ecart.stderr);
    const gardes = /Rejeux gardés : (\S+) et (\S+)\.$/m.exec(ecart.stdout);
    assert.ok(gardes && fs.existsSync(gardes[1]) && fs.existsSync(gardes[2]), ecart.stdout);
    const garde = path.dirname(path.dirname(gardes[1]));
    assert.match(path.basename(garde), /^comparer-images-/);
    fs.rmSync(garde, { recursive: true, force: true });
    // Rien n'est prouvé (code 2) ; un rejeu déjà fait reste, avec son chemin, pour en voir la raison.
    for (const [cas, env, motif, garde] of [['rejeu sans Timefold', { FAUX_REJEU_nouvelle: '{}' }, /rejeu sans Timefold/, true],
      ['sortie illisible', { FAUX_REJEU_ancienne: 'pas du JSON' }, /sortie JSON illisible/, true],
      ['autre jar', { FAUX_REJEU_ancienne: JSON.stringify({ ...JSON.parse(rejeu([1])), jar: '/tmp/autre.jar' }) }, /jar = \/tmp\/autre\.jar/, true],
      ['construction ratée', { FAUX_BUILD: '1' }, /Construction de l'image ancienne/, false],
      ['autre Node majeur', { FAUX_NODE_nouvelle: `v${Number(n) + 2}.0.0` }, new RegExp(`Node v${Number(n) + 2}\\.0\\.0, attendu ${n}`), true],
      ['révision hors de l’historique', { FAUX_ANCETRE: '1' }, /n'est pas dans l'historique de HEAD/, false],
      ['hors de main', { FAUX_MAIN: 'autre' }, /n'est pas le main du serveur/, false],
      ['copie de travail modifiée', { FAUX_STATUS: ' M server.js\n' }, /Copie de travail modifiée/, false],
      ['fichier non suivi', { FAUX_STATUS: '?? solver/src/main/java/Nouveau.java\n' }, /Copie de travail modifiée.*Nouveau\.java/, false],
      ['HEAD changé pendant la comparaison', { FAUX_BOUGE: 'head' }, /HEAD a changé pendant la comparaison/, true],
      ['fichier non suivi ajouté pendant la comparaison', { FAUX_BOUGE: 'statut' }, /La copie de travail a changé pendant la comparaison/, true],
      ['Dockerfile changé pendant la comparaison', { FAUX_BOUGE: 'dockerfile' }, /Le Dockerfile a changé pendant la comparaison/, true],
      ['HEAD changé, même image', { FAUX_MEME_ID: 'meme', FAUX_BOUGE: 'head' }, /HEAD a changé pendant la comparaison/, false]]) {
      const r = lancer(env);
      fs.rmSync(path.join(dir, 'bouge'), { force: true });
      fs.writeFileSync(path.join(depot, 'Dockerfile'), actuel);
      assert.equal(r.status, 2, `${cas} : ${r.stdout} ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`ÉCHEC : .*${motif.source}`), cas);
      const gardes = /Rejeux faits gardés dans (\S+) /.exec(r.stderr);
      assert.equal(Boolean(gardes), garde, `${cas} : ${r.stderr}`);
      if (gardes) {
        assert.ok(fs.existsSync(gardes[1]) && fs.readdirSync(gardes[1]).some(nom => nom.endsWith('.json')), `${cas} : rejeux annoncés mais retirés`);
        fs.rmSync(path.dirname(gardes[1]), { recursive: true, force: true });
      }
    }
    const imprevue = lancer({ FAUX_SANS_IID: '1' });
    assert.equal(imprevue.status, 2, 'erreur imprévue : jamais le code 1 des décisions différentes');
    assert.match(imprevue.stderr, /ENOENT/);
    const essai = lancer({ FAUX_MAIN: 'autre', FAUX_STATUS: ' M server.js\n' }, ['v0.0.0', '--essai']);
    assert.equal(essai.status, 0, '--essai lève les deux gardes');
    assert.match(essai.stdout, /essai : le verdict ne vaut pas pour une publication/);
    // Rien à comparer, sans Docker : la copie de travail est revue aussi avant le verdict.
    ecrire('reference', actuel, 0o644);
    const rien = lancer({ FAUX_BOUGE: 'head' });
    fs.rmSync(path.join(dir, 'bouge'), { force: true });
    assert.equal(rien.status, 2, rien.stdout);
    assert.match(rien.stderr, /ÉCHEC : HEAD a changé pendant la comparaison/);
    assert.doesNotMatch(rien.stdout, /rien à comparer/);
    // Une ligne montée depuis la révision : comparée depuis le commit de sa montée, avec le rappel
    // de l'essai en fin de sortie et sa commande sur l'image comparée.
    ecrire('montee', changer(actuel, node, 5), 0o644);
    ecrire('reference', nodeDecale(changer(actuel, node, 5), -4), 0o644);
    const montee = lancer({ FAUX_LOG: 'montee\n', FAUX_NODE_ancienne: `v${n}.13.0` });
    assert.equal(montee.status, 0, montee.stderr);
    assert.match(montee.stdout, /montée en montee/);
    assert.match(montee.stdout, new RegExp('À faire avant de publier :\\n- Node est monté depuis v0\\.0\\.0 : sa PR doit avoir fait l\'essai de la télécommande KaraFun.*'
      + ' dans PowerShell : docker run --rm --init --pull never -v "[^"]+:/app/test:ro" id-nouvelle node test/probe-kcs\\.js <code>\\n$'));
    assert.deepEqual(lignesFrom(fs.readFileSync(path.join(dir, 'construit'), 'utf8')).filter(f => f.image === 'node').map(f => f.empreinte),
      [empreinte(5), empreinte(6)], 'Node comparé depuis la montée');
    // Monté, puis changé de version par une empreinte : les deux rappels, une seule commande.
    const monteeChangee = lancer({ FAUX_LOG: 'montee\n' });
    assert.equal(monteeChangee.status, 0, monteeChangee.stderr);
    assert.match(monteeChangee.stdout, new RegExp('À faire avant de publier :\\n- Node est monté depuis v0\\.0\\.0 : sa PR doit avoir fait l\'essai de la télécommande KaraFun '
      + `et la comparaison --json \\(AGENTS\\.md\\)\\.\\n- Node a changé \\(v${n}\\.12\\.0 puis v${n}\\.13\\.0\\) : .* id-nouvelle node test/probe-kcs\\.js <code>\\n$`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// C9 et C10 créent leur propre dépôt : il leur faut le programme git, pas celui-ci.
const gitPresent = spawnSync('git', ['--version']).status === 0;

// Dépôt git jetable dans dir/depot, l'outil copié dans son test/. git y ignore la
// configuration de la machine (fichier global vide, configuration système écartée) et le
// dépôt d'un hook git en cours (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE le détourneraient),
// comme test/gstack-gate.test.js ; l'outil lancé hérite du même environnement. Rend git, de
// quoi écrire le Dockerfile, et l'outil lancé en essai contre v0.0.0.
function depotGit(dir, env = {}) {
  const depot = path.join(dir, 'depot');
  fs.mkdirSync(path.join(depot, 'test'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'comparer-images.js'), path.join(depot, 'test', 'comparer-images.js'));
  const config = path.join(dir, 'gitconfig');
  fs.writeFileSync(config, '');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'essai', GIT_AUTHOR_EMAIL: 'essai@example.invalid',
    GIT_COMMITTER_NAME: 'essai', GIT_COMMITTER_EMAIL: 'essai@example.invalid', ...env };
  for (const nom of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[nom];
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: depot, encoding: 'utf8', env: gitEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')} : ${r.stderr}`);
  };
  g('init', '-q');
  return {
    g,
    ecrire: texte => fs.writeFileSync(path.join(depot, 'Dockerfile'), texte),
    comparer: () => spawnSync(process.execPath, [path.join(depot, 'test', 'comparer-images.js'), 'v0.0.0', '--essai'], { cwd: depot, encoding: 'utf8', env: gitEnv }),
  };
}

test('C9 sur un vrai dépôt git : montée seule, essai rappelé ; puis une empreinte après la montée, comparée depuis la montée', { skip: bash && gitPresent ? false : 'bash ou git absent' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparer-git-'));
  try {
    // Faux docker qui échoue : l'outil s'arrête à la construction, après avoir dit quoi comparer.
    fs.writeFileSync(path.join(dir, 'docker'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const { g, ecrire, comparer } = depotGit(dir, { PATH: `${dir}${path.delimiter}${process.env.PATH}` });
    ecrire(nodeDecale(changer(actuel, node, 5), -4)); g('add', 'Dockerfile'); g('commit', '-qm', 'version publiée'); g('tag', 'v0.0.0');
    ecrire(changer(actuel, node, 5)); g('commit', '-qam', 'montée de Node');
    // Montée seule : rien à comparer, sans Docker, mais l'essai de la télécommande en fin de
    // sortie, avec une commande qui construit l'image de la copie de travail.
    const seule = comparer();
    assert.equal(seule.status, 0, seule.stderr);
    assert.match(seule.stdout, /rien à comparer/);
    assert.match(seule.stdout, /À faire avant de publier :\n- Node est monté depuis v0\.0\.0 : .* dans PowerShell : docker run --rm --init --pull never -v "[^"]+:\/app\/test:ro" \$\(docker build -q "[^"]+"\) node test\/probe-kcs\.js <code>\n$/);
    ecrire(actuel); g('commit', '-qam', 'nouvelle empreinte de Node');
    const r = comparer();
    assert.doesNotMatch(r.stdout, /rien à comparer/, r.stdout);
    assert.match(r.stdout, /node:\S+ : montée en [0-9a-f]{7}, comparée depuis\./);
    assert.match(r.stdout, new RegExp(`node:\\S+ : ${empreinte(5).slice(7, 19)} devenue `));
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /ÉCHEC : Construction de l'image ancienne/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('C10 montée de Java seule, Maven compris : rien à comparer, le bilan de la montée rappelé en fin de sortie (git seul, sans bash ni Docker)', { skip: gitPresent ? false : 'git absent' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comparer-java-'));
  try {
    const { g, ecrire, comparer } = depotGit(dir);
    // Version publiée sur un Java plus ancien, dans les étiquettes de Maven et de Temurin.
    ecrire(actuel.replace(/eclipse-temurin([:-])(\d+)/g, (_, signe, version) => `eclipse-temurin${signe}${Number(version) - 4}`));
    g('add', 'Dockerfile'); g('commit', '-qm', 'version publiée'); g('tag', 'v0.0.0');
    ecrire(actuel); g('commit', '-qam', 'montée de Java');
    const r = comparer();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /maven:\S+ : montée en [0-9a-f]{7}, comparée depuis\.\neclipse-temurin:\S+ : montée en [0-9a-f]{7}, comparée depuis\./);
    assert.match(r.stdout, /rien à comparer/);
    assert.match(r.stdout, /À faire avant de publier :\n- Montée depuis v0\.0\.0 de maven:\S+ et eclipse-temurin:\S+ : sa PR doit avoir fait le bilan d'une vraie soirée et la comparaison --json \(AGENTS\.md\)\.\n$/);
    assert.doesNotMatch(r.stdout, /Node est monté|Node a changé/, 'Node n’est pas monté');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
