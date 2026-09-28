'use strict';
// Mesure reproductible et volontairement hors de la suite rapide :
// node test/timefold-budget-benchmark.js [--deep|--production|--very-deep]
const { performance } = require('node:perf_hooks');
const { TimefoldBridge } = require('../solver/bridge');

function makeSongs(groupSizes, secondSongCount) {
  const performances = [];
  let people = 0;
  for (let table = 0; table < groupSizes.length; table++) {
    for (let place = 0; place < groupSizes[table]; place++) {
      const person = `P${people++}`;
      performances.push({ id: `${person}-0`, owner: person, ownerSongIndex: 0,
        singers: [person], groups: [`T${table}`], previousIndex: performances.length });
    }
  }
  for (let i = 0; i < secondSongCount; i++) {
    const person = `P${i}`;
    const table = groupSizes.findIndex((_, index) =>
      i < groupSizes.slice(0, index + 1).reduce((a, b) => a + b, 0));
    performances.push({ id: `${person}-1`, owner: person, ownerSongIndex: 1,
      singers: [person], groups: [`T${table}`], previousIndex: performances.length });
  }
  return performances;
}

async function main() {
  const veryDeep = process.argv.includes('--very-deep');
  const production = process.argv.includes('--production');
  const deep = veryDeep || production || process.argv.includes('--deep');
  const bridge = new TimefoldBridge({ timeoutMs: veryDeep ? 40000 : 20000, settleMs: 0 });
  const scenarios = [
    ['six tables usuelles, 18 titres', makeSongs([5, 4, 1, 2, 3, 1], 2)],
    ['six tables, 60 clients, 90 titres', makeSongs([10, 10, 10, 10, 10, 10], 30)],
  ];
  try {
    for (const [label, performances] of scenarios) {
      if (deep && performances.length < 60) continue;
      for (const [mode, tableRotation, weightedTables] of [
        ['libre', false, false], ['tables', true, false], ['tables pondérées', true, true],
      ]) {
        if (deep && mode === 'libre') continue;
        for (const budgetMs of veryDeep ? [15000, 30000] :
          production ? [3000, 8000, 15000] :
            deep ? [1500, 10000, 15000] : [200, 600, 1000, 1500]) {
          const start = performance.now();
          const response = await bridge.solve({ requestId: `${label}/${mode}/${budgetMs}`,
            budgetMs, performances, pastAppearance: {}, physicalCount: {},
            pinnedUntil: 0, roundPeople: [], roundGroups: [], lastGroups: [],
            tableServeCounts: {}, groupReadyCounts: Object.fromEntries(
              Array.from({ length: 6 }, (_, i) => [`T${i}`, new Set(performances
                .filter(p => p.groups.includes(`T${i}`)).map(p => p.owner)).size])),
            tableRotation, weightedTables });
          console.log(JSON.stringify({ scenario: label, mode, budgetMs,
            wallMs: Math.round(performance.now() - start),
            solveMs: response.elapsedMs, score: response.score,
            count: response.order.length }));
        }
      }
    }
  } finally { bridge.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
