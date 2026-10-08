'use strict';
// Couverture de code de la suite hors ligne, sans dépendance : la mesure
// intégrée de Node (NODE_V8_COVERAGE) suit chaque processus lancé par
// test/run-offline.js, y compris les serveurs de démonstration. Les tests
// exécutent aussi server.js et les pages client.html et staff.html dans un
// bac à sable `vm` : ces mesures sont ramenées à leur fichier d'origine.
//
//   node test/coverage.js                 suite complète puis rapport
//   node test/coverage.js --min-lines 70  échoue sous 70 % de lignes couvertes
//   node test/coverage.js --report DIR    rapport seul, à partir de mesures existantes
//   node test/coverage.js --keep-raw      garde les mesures brutes (dossier temporaire affiché)
//
// Rapport dans coverage/ : summary.txt (tableau), lcov.info (éditeurs, CI) et
// uncovered.json (lignes jamais exécutées, pour écrire les tests manquants).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const out = path.join(root, 'coverage');
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const minLines = option('--min-lines') == null ? null : Number(option('--min-lines'));
if (minLines != null && !(minLines >= 0 && minLines <= 100)) throw new Error('--min-lines attend un pourcentage.');

// Fichiers mesurés : le code livré dans le kit du bar.
const SOURCES = ['battle-vote.js', 'catalog.js', 'evening-journal.js', 'evening-stats.js', 'fake-karafun.js', 'karafun-state.js', 'karafun.js',
  'kcs-transport.js', 'lyrics.js', 'night-state.js', 'scheduler.js', 'server.js', 'solo-invitations.js', 'private-event.js',
  'song-repeats.js', 'song-settings.js', 'spotify.js', 'start-evening.js', 'stop.js', 'table-access.js', 'solver/bridge.js',
  'public/client-i18n.js', 'public/client.html', 'public/staff.html', 'public/stats.html'];
// Scripts chargés dans un bac à sable par les tests (nom donné à `vm`) : le
// premier <script> en ligne d'une page, ou le fichier depuis son début.
const SANDBOXED = { 'server.js': 'server.js', 'client.html': 'public/client.html', 'staff.html': 'public/staff.html',
  'stats.html': 'public/stats.html', 'client-i18n.js': 'public/client-i18n.js' };

function inlineScript(text) {
  const match = /<script>([\s\S]*?)<\/script>/.exec(text);
  return match ? { start: match.index + '<script>'.length, end: match.index + '<script>'.length + match[1].length } : null;
}

// Lignes utiles d'un fichier : ni vides, ni seulement des commentaires ou des
// fermetures. Chaque ligne est représentée par son premier caractère utile.
function sourceLines(file, text) {
  const region = file.endsWith('.html') ? inlineScript(text) : { start: 0, end: text.length };
  const lines = [];
  let offset = 0, inComment = false;
  for (const [index, line] of text.split('\n').entries()) {
    const start = offset;
    offset += line.length + 1;
    if (!region || start < region.start || start >= region.end) continue;
    const trimmed = line.trim();
    if (inComment) { if (trimmed.includes('*/')) inComment = false; continue; }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) { inComment = true; continue; }
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const first = line.search(/[^\s})\];,]/);
    if (first < 0) continue;
    lines.push({ number: index + 1, at: start + first });
  }
  return { lines, region };
}

// Comptes d'exécution par caractère : les blocs les plus internes l'emportent.
function paint(functions, length, base) {
  const counts = new Int32Array(length).fill(-1);
  const ranges = functions.flatMap(fn => fn.ranges)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const range of ranges) {
    const from = Math.max(0, range.startOffset + base), to = Math.min(length, range.endOffset + base);
    if (to > from) counts.fill(range.count, from, to);
  }
  return counts;
}

function collect(dir) {
  const files = new Map(SOURCES.map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return [file, { text, ...sourceLines(file, text), hits: new Map() }];
  }));
  const byUrl = new Map(SOURCES.map(file => [pathToFileURL(path.join(root, file)).href, file]));
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    for (const script of data.result || []) {
      const file = byUrl.get(script.url) || SANDBOXED[script.url];
      const entry = file && files.get(file);
      if (!entry) continue;
      // Une page lancée en bac à sable commence à son premier <script>.
      const base = file.endsWith('.html') ? entry.region?.start : 0;
      if (base == null) continue;
      const counts = paint(script.functions, entry.text.length, base);
      for (const line of entry.lines) {
        const count = counts[line.at];
        if (count < 0) continue;
        entry.hits.set(line.number, (entry.hits.get(line.number) || 0) + count);
      }
    }
  }
  return files;
}

function report(files) {
  fs.mkdirSync(out, { recursive: true });
  const rows = [], lcov = [], uncovered = {};
  let total = 0, covered = 0;
  for (const [file, entry] of files) {
    const lines = entry.lines.map(line => [line.number, entry.hits.get(line.number) || 0]);
    const hit = lines.filter(([, count]) => count > 0).length;
    total += lines.length; covered += hit;
    rows.push([file, lines.length, hit]);
    lcov.push(`SF:${file}`, ...lines.map(([number, count]) => `DA:${number},${count}`),
      `LF:${lines.length}`, `LH:${hit}`, 'end_of_record');
    // Lignes jamais exécutées, regroupées en plages.
    const ranges = [];
    for (const [number, count] of lines) {
      if (count > 0) continue;
      const last = ranges.at(-1);
      if (last && entry.lines.findIndex(line => line.number === number) ===
        entry.lines.findIndex(line => line.number === last[1]) + 1) last[1] = number;
      else ranges.push([number, number]);
    }
    uncovered[file] = ranges.map(([a, b]) => a === b ? String(a) : `${a}-${b}`);
  }
  const pct = (hit, all) => all ? (100 * hit / all).toFixed(1) : '100.0';
  const width = Math.max(...rows.map(([file]) => file.length), 'Total'.length);
  const table = [`${'Fichier'.padEnd(width)}  Lignes  Couvertes      %`,
    ...rows.sort((a, b) => a[2] / (a[1] || 1) - b[2] / (b[1] || 1))
      .map(([file, all, hit]) => `${file.padEnd(width)}  ${String(all).padStart(6)}  ${String(hit).padStart(9)}  ${pct(hit, all).padStart(5)}`),
    `${'Total'.padEnd(width)}  ${String(total).padStart(6)}  ${String(covered).padStart(9)}  ${pct(covered, total).padStart(5)}`];
  fs.writeFileSync(path.join(out, 'summary.txt'), table.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'lcov.info'), lcov.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'uncovered.json'), JSON.stringify(uncovered, null, 1) + '\n');
  console.log(table.join('\n'));
  return Number(pct(covered, total));
}

async function main() {
  let dir = option('--report');
  let testsFailed = false;
  const ownDir = !dir;
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-couverture-'));
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(__dirname, 'run-offline.js')], {
        cwd: root, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: dir } });
      child.on('exit', resolve);
    });
    testsFailed = code !== 0;
  }
  let percent;
  try { percent = report(collect(dir)); }
  finally {
    // Les serveurs de test écrivent une mesure par seconde : centaines de fichiers.
    // Un fichier encore verrouillé (Windows) ne doit pas faire échouer le rapport.
    if (ownDir && !argv.includes('--keep-raw')) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
      catch (error) { console.warn(`Mesures brutes non supprimées (${error.code || error.message}) : ${dir}`); }
    } else if (ownDir) console.log(`Mesures brutes gardées dans ${dir}`);
  }
  console.log(`Couverture des lignes : ${percent} %. Détail dans coverage/summary.txt et coverage/uncovered.json.`);
  if (testsFailed) { console.error('Des tests ont échoué.'); process.exitCode = 1; }
  if (minLines != null && percent < minLines) {
    console.error(`Couverture ${percent} % sous le seuil de ${minLines} %.`);
    process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
