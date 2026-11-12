import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, callModel } from './measure.mjs';
import { backendIndex } from './routing.mjs';

const state = JSON.parse(await readFile(resolve('.lab', 'state.json'), 'utf8'));
if (!process.env.LAB_APIM_KEY) throw new Error('The APIM runtime credential is required.');
const sessions = new Map();
for (let index = 0; sessions.size < 3; index++) {
  const session = `ses_cache_probe_${index}`;
  sessions.set(`b${backendIndex(session, state.deployment) + 1}`, session);
}
const records = [];
for (let trial = 1; trial <= 3; trial++) {
  const body = fixture(`cache-scope-${randomUUID()}`, 'identical-body', 0, state.deployment);
  for (const backend of ['b1', 'b2', 'b3', 'b1']) {
    const result = await callModel({
      url: `${state.apim.endpoint}/sticky/openai/v1/chat/completions`,
      key: process.env.LAB_APIM_KEY, keyHeader: 'Ocp-Apim-Subscription-Key',
      body, session: sessions.get(backend),
    });
    records.push({ trial, intendedBackend: backend, ...result });
    await writeFile(resolve('.lab', 'cache-scope.json'), JSON.stringify(records, null, 2));
    if (!result.complete || result.backend !== backend || Number(result.attempts) !== 1) {
      throw new Error('The controlled cache probe did not reach its intended backend on its first attempt.');
    }
    console.log(JSON.stringify({ trial, backend, promptTokens: result.promptTokens, cachedTokens: result.cachedTokens }));
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
