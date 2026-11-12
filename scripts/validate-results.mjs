import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateComparisons(comparisons) {
  assert.equal(comparisons.length, 6, 'Expected one current comparison per gateway and scenario.');
  for (const gateway of ['apim', 'aigateway']) {
    const cases = comparisons.filter(record => record.gateway === gateway);
    for (const scenario of ['single', 'balanced', 'sticky']) {
      const matches = cases.filter(record => record.scenario === scenario);
      assert.equal(matches.length, 1, `${gateway}/${scenario}: missing or duplicate comparison.`);
      const record = matches[0];
      assert.equal(record.requests, 360, `${gateway}/${scenario}: incomplete workload.`);
      assert.equal(record.completed, 360, `${gateway}/${scenario}: incomplete model responses.`);
      assert.equal(record.sessions, 60, `${gateway}/${scenario}: incomplete session population.`);
      assert.equal(record.usageCoverage, 1, `${gateway}/${scenario}: incomplete token usage.`);
      assert.equal(record.resourceLogCoverage, 1, `${gateway}/${scenario}: incomplete backend evidence.`);
      assert.equal(record.byTurn?.['1']?.cacheRatio, 0, `${gateway}/${scenario}: first-turn prefixes were not cold.`);
    }
    const single = cases.find(record => record.scenario === 'single');
    assert.equal(Object.keys(single.requestDistribution).length, 1, `${gateway}: reference used multiple backends.`);
    const balanced = cases.find(record => record.scenario === 'balanced');
    assert.ok(['b1', 'b2', 'b3'].every(backend => balanced.requestDistribution[backend] > 0),
      `${gateway}: standard pool did not use all backends.`);
    const sticky = cases.find(record => record.scenario === 'sticky');
    assert.equal(sticky.affinityEnabled, true, `${gateway}: session affinity was not enabled.`);
    assert.equal(sticky.sessionsSwitchingBackend, 0, `${gateway}: healthy sessions changed backend.`);
    for (const backend of ['b1', 'b2', 'b3']) {
      const share = (sticky.initialSessionDistribution[backend] ?? 0) / sticky.sessions;
      assert.ok(share >= 0.2 && share <= 0.45, `${gateway}/${backend}: session share ${share} is outside 20-45%.`);
    }
    assert.ok(Number.isFinite(single.warmCacheRatio) && single.warmCacheRatio > 0,
      `${gateway}: single-backend cache reference is unavailable.`);
    assert.ok(Number.isFinite(sticky.warmCacheRatio) && Math.abs(sticky.warmCacheRatio - single.warmCacheRatio) <= 0.05,
      `${gateway}: warm cache reuse differs from its reference by more than five percentage points.`);
  }
  return { comparisons: comparisons.length, requests: 2160, passed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const comparisons = JSON.parse(await readFile(resolve('results', 'comparisons.json'), 'utf8'));
  console.log(JSON.stringify(validateComparisons(comparisons), null, 2));
}
