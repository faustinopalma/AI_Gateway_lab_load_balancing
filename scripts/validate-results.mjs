import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateComparisons(comparisons) {
  assert.equal(comparisons.length, 6, 'Expected one current comparison per gateway and scenario.');
  const issues = [];
  for (const gateway of ['apim', 'aigateway']) {
    const cases = comparisons.filter(record => record.gateway === gateway);
    for (const scenario of ['single', 'balanced', 'sticky']) {
      const matches = cases.filter(record => record.scenario === scenario);
      assert.equal(matches.length, 1, `${gateway}/${scenario}: missing or duplicate comparison.`);
      const record = matches[0];
      assert.equal(record.requests, 360, `${gateway}/${scenario}: incomplete workload.`);
      assert.ok(Number.isInteger(record.completed) && record.completed >= 0 && record.completed <= record.requests,
        `${gateway}/${scenario}: invalid response count.`);
      assert.equal(record.failed, record.requests - record.completed, `${gateway}/${scenario}: inconsistent error count.`);
      if (record.failed) issues.push(`${gateway}/${scenario}: ${record.failed} of ${record.requests} requests did not complete.`);
      assert.equal(record.sessions, 60, `${gateway}/${scenario}: incomplete session population.`);
      assert.equal(record.usageCoverage, 1, `${gateway}/${scenario}: incomplete token usage.`);
      assert.equal(record.completedResourceLogCoverage ?? record.resourceLogCoverage, 1,
        `${gateway}/${scenario}: incomplete backend evidence.`);
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
  return {
    comparisons: comparisons.length, requests: 2160,
    completed: comparisons.reduce((sum, record) => sum + record.completed, 0),
    failed: comparisons.reduce((sum, record) => sum + record.failed, 0),
    passed: issues.length === 0, issues,
  };
}

export function validateCacheIsolation(records) {
  const sequence = ['b1', 'b1', 'b2', 'b2', 'b3', 'b3', 'b1'];
  assert.equal(records.length, 21, 'Expected three seven-request cache-isolation trials.');
  for (const trial of [1, 2, 3]) {
    const rows = records.filter(record => record.trial === trial);
    assert.deepEqual(rows.map(record => record.intendedBackend), sequence, `Trial ${trial}: unexpected backend sequence.`);
    for (const record of rows) {
      assert.equal(record.complete, true, `Trial ${trial}: incomplete cache probe.`);
      assert.equal(record.backend, record.intendedBackend, `Trial ${trial}: unintended serving backend.`);
      assert.equal(record.resourceLogVerified, true, `Trial ${trial}: missing independent backend evidence.`);
      assert.ok(Number.isFinite(record.promptTokens) && record.promptTokens >= 1024, 'Cache probe prefix is too short.');
      assert.ok(Number.isFinite(record.cachedTokens) && record.cachedTokens >= 0, 'Cache probe usage is unavailable.');
    }
    for (const backend of ['b1', 'b2', 'b3']) {
      assert.equal(rows.find(record => record.backend === backend).cachedTokens, 0,
        `Trial ${trial}/${backend}: first use was not cold across subscription boundaries.`);
    }
  }
  for (const backend of ['b1', 'b2', 'b3']) {
    assert.ok(records.some(record => record.backend === backend && record.cachedTokens > 0),
      `${backend}: no local cache reuse was observed.`);
  }
  return { trials: 3, requests: records.length, passed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const comparisons = JSON.parse(await readFile(resolve('results', 'comparisons.json'), 'utf8'));
  const lifecycle = JSON.parse(await readFile(resolve('results', 'lifecycle.json'), 'utf8'));
  const result = validateComparisons(comparisons);
  if (lifecycle.backendSubscriptionCount === 3) {
    assert.equal(lifecycle.backendResourceKind, 'AIServices', 'Distributed backends must be Foundry resources.');
    const probes = JSON.parse(await readFile(resolve('results', 'cache-scope.json'), 'utf8'));
    result.cacheIsolation = validateCacheIsolation(probes);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
