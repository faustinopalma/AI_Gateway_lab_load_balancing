import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { callModel, fixture } from './measure.mjs';
import { backendIndex } from './routing.mjs';

const gateway = process.argv[2];
const cold = process.argv[3] === 'cold';
const providerName = cold ? process.env.LAB_FAULT_PROVIDER : 'b1';
if (cold && (gateway !== 'aigateway' || !/^b1-cold-[a-f0-9]{8}$/.test(providerName ?? ''))) throw new Error('Invalid isolated test provider.');
const tests = cold ? ['unavailable'] : ['429', '503', 'unavailable'];
if (!['apim', 'aigateway'].includes(gateway)) throw new Error('Choose apim or aigateway.');
const state = JSON.parse(await readFile(resolve('.lab', 'state.json'), 'utf8'));
const armToken = process.env.LAB_ARM_TOKEN;
if (!armToken) throw new Error('An in-memory ARM token is required.');
const prefix = `/subscriptions/${state.subscription}/resourceGroups/${state.resourceGroup}/`.toLowerCase();
async function arm(method, id, version, properties) {
  if (!id.toLowerCase().startsWith(prefix)) throw new Error('ARM mutation escaped the dedicated lab group.');
  const response = await fetch(`https://management.azure.com${id}?api-version=${version}`, {
    method, headers: { authorization: `Bearer ${armToken}`, 'content-type': 'application/json' },
    ...(properties ? { body: JSON.stringify({ properties }) } : {}),
    signal: AbortSignal.timeout(120000),
  });
  const text = (await response.text()).replace(/^\uFEFF/, '');
  if (!response.ok) throw new Error(`Scoped ARM ${method} failed (${response.status}): ${text.slice(0, 1000)}`);
  return method === 'GET' && text ? JSON.parse(text) : null;
}
const id = gateway === 'apim' ? `${state.apim.id}/backends/b1` :
  `${state.aiGateway.id}/workspaces/default/modelProviders/${providerName}`;
const version = gateway === 'apim' ? '2024-05-01' : '2025-09-01-preview';
const original = await arm('GET', id, version);
if (gateway === 'aigateway' && original.properties.foundry?.authentication?.kind !== 'ManagedIdentity') {
  throw new Error('Expected the original Foundry provider to use managed identity.');
}
const run = `fault-${gateway}-${randomUUID().slice(0, 8)}`;
const folder = resolve('.lab', 'faults', run);
await mkdir(folder, { recursive: true });
await writeFile(resolve(folder, 'original-backend.json'), JSON.stringify(original, null, 2));
const records = [];
const sourceProbes = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = gateway === 'apim' ? `${state.apim.endpoint}/sticky/openai/v1/chat/completions` : state.aiGateway.chatUrl;
const key = gateway === 'apim' ? process.env.LAB_APIM_KEY : process.env.LAB_AIGATEWAY_KEY;
const keyHeader = gateway === 'apim' ? 'Ocp-Apim-Subscription-Key' : 'Authorization';
if (!key) throw new Error('Runtime credential is missing.');
const model = gateway === 'apim' ? state.deployment : `${state.model}-${cold ? providerName : 'failover'}`;
if (gateway === 'aigateway') {
  const readiness = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    const result = await callModel({ url, key, keyHeader,
      body: { model, messages: [{ role: 'user', content: 'Reply ACK.' }], max_completion_tokens: 512, reasoning_effort: 'minimal', stream: false } });
    readiness.push({ status: result.status, complete: result.complete, utc: new Date().toISOString() });
    await writeFile(resolve(folder, 'alias-readiness.json'), JSON.stringify(readiness, null, 2));
    if (result.complete) break;
    if (result.status !== 404 || attempt === 14) throw new Error('Native failover alias did not become ready.');
    console.log('Waiting for the new native alias to be published.');
    await pause(2000);
  }
}
const sessions = [];
for (let index = 0; sessions.length < 6; index++) {
  const session = `ses_fault_${index}`;
  const home = backendIndex(session, model);
  if (sessions.filter(item => item.home === home).length < 2) sessions.push({ session, home });
}
async function request(test, phase, session, turn) {
  let result;
  try {
    result = await callModel({ url, key, keyHeader, body: fixture(`${run}-${test}`, session, turn, model), session });
  } catch (error) {
    result = { complete: false, status: null, backend: 'unknown', error: error.message };
    console.error(`${gateway} ${test} ${phase}: ${error.message}`);
  }
  const record = { gateway, run, test, phase, session, model, turn, ...result };
  records.push(record);
  console.log(`${gateway} ${test} ${phase}: ${record.status} ${record.backend} attempts=${record.attempts ?? '?'} ${record.attemptLog ?? ''}`);
  await writeFile(resolve(folder, 'requests.json'), JSON.stringify(records, null, 2));
  return record;
}
let restored = false;
try {
  for (const test of tests) {
    await Promise.all(sessions.map(item => request(test, 'before', item.session, 0)));
    const properties = structuredClone(original.properties);
    if (gateway === 'apim') properties.url = test === 'unavailable'
      ? 'https://unavailable-llm-lab.invalid/openai/v1'
      : `${state.apim.endpoint}/fault${test}/openai/v1`;
    else {
      if (test !== 'unavailable') {
        const faultPolicy = `<policies><inbound><return-response><set-status code="${test}" reason="Synthetic lab fault"/><set-header name="Retry-After" exists-action="override"><value>1</value></set-header><set-body>{"error":{"code":"synthetic_lab_${test}"}}</set-body></return-response></inbound><backend/><outbound/><on-error/></policies>`;
        await arm('PUT', `${state.apim.id}/apis/fault-native/policies/policy`, '2024-05-01', { format: 'rawxml', value: faultPolicy });
        for (let attempt = 0; attempt < 15; attempt++) {
          const control = await fetch(`${state.apim.endpoint}/openai/v1/chat/completions`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
            signal: AbortSignal.timeout(10000),
          });
          sourceProbes.push({ test, status: control.status, utc: new Date().toISOString() });
          await writeFile(resolve(folder, 'source-probes.json'), JSON.stringify(sourceProbes, null, 2));
          await control.text();
          if (control.status === Number(test)) break;
          if (attempt === 14) throw new Error('The native fault source is not returning the requested status.');
          await pause(1000);
        }
      }
      properties.foundry.endpoint = test === 'unavailable'
        ? 'https://unavailable-llm-lab.invalid/' : `${state.apim.endpoint}/`;
    }
    restored = false;
    await arm('PUT', id, version, properties);
    await pause(5000);
    if (gateway === 'apim') {
      const affected = sessions.find(item => item.home === 0);
      let verified = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const probe = await request(test, 'propagation-check', affected.session, 1);
        const observed = test === 'unavailable'
          ? probe.attemptPath?.startsWith('b1;b2;') && Number(probe.attempts) >= 2 && probe.complete
          : probe.attemptLog?.includes(`b1:${test};`);
        if (observed) { verified = true; break; }
        await pause(2000);
      }
      if (!verified) throw new Error(`The ${test} fault was not proven at the APIM data plane.`);
    }
    for (const turn of [1, 2]) {
      await Promise.all(sessions.map(item => request(test, 'during', item.session, turn)));
    }
    await arm('PUT', id, version, original.properties);
    restored = true;
    await pause(12000);
    await Promise.all(sessions.map(item => request(test, 'after', item.session, 3)));
  }
} finally {
  if (!restored) {
    await arm('PUT', id, version, original.properties);
    restored = true;
  }
  const actual = await arm('GET', id, version);
  const endpoint = gateway === 'apim' ? actual.properties.url : actual.properties.foundry.endpoint;
  const expectedEndpoint = gateway === 'apim' ? original.properties.url : original.properties.foundry.endpoint;
  restored = endpoint === expectedEndpoint;
  await writeFile(resolve(folder, 'restoration.json'), JSON.stringify({ restored, utc: new Date().toISOString() }, null, 2));
  if (!restored) throw new Error('Backend endpoint restoration could not be verified.');
}
const summary = {
  gateway, run, cold, source: 'Synthetic pre-response HTTP faults and a reserved .invalid hostname on lab backend b1',
  restored,
  tests: Object.fromEntries(tests.map(test => {
    const rows = records.filter(record => record.test === test && record.phase === 'during');
    return [test, { requests: rows.length, completed: rows.filter(record => record.complete).length,
      failed: rows.filter(record => !record.complete).length,
      retried: gateway === 'apim' ? rows.filter(record => Number(record.attempts) > 1).length : null,
      bufferedRecovery: gateway === 'apim' ? rows.filter(record => record.recoveryBuffered).length : null }];
  })),
};
await writeFile(resolve(folder, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (records.some(record => !record.complete)) process.exitCode = 1;
