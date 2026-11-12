import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionHeader, backendIndex, summarize } from '../scripts/routing.mjs';
import { parseEvent } from '../scripts/measure.mjs';
import { callModel } from '../scripts/measure.mjs';
import { createServer } from 'node:http';
import { validateComparisons } from '../scripts/validate-results.mjs';

test('session identifiers must agree and preserve opaque case-sensitive values', () => {
  assert.equal(sessionHeader(new Headers()), null);
  assert.equal(sessionHeader(new Headers({ 'X-OpenCode-Session': 'ses_AbC', 'x-session-id': 'ses_AbC' })).value, 'ses_AbC');
  assert.throws(() => sessionHeader(new Headers({ 'x-opencode-session': 'ses_A', 'x-session-id': 'ses_B' })), /Conflicting/);
  assert.throws(() => sessionHeader(new Headers({ 'x-session-id': 'a'.repeat(257) })), /Invalid/);
});

test('routing is stable across turns and sufficiently distributes independent keys', () => {
  const counts = [0, 0, 0];
  for (let index = 0; index < 6000; index++) counts[backendIndex(`ses_${index}`, 'lab-chat')]++;
  assert.ok(counts.every(count => count > 1800 && count < 2200), String(counts));
  assert.equal(backendIndex('ses_fixed', 'lab-chat'), backendIndex('ses_fixed', 'lab-chat'));
  assert.notDeepEqual(
    Array.from({ length: 20 }, (_, index) => backendIndex(`ses_${index}`, 'title')),
    Array.from({ length: 20 }, (_, index) => backendIndex(`ses_${index}`, 'lab-chat')),
  );
});

test('cache aggregation is token-weighted and unknown usage or routing is exposed', () => {
  const summary = summarize([
    { complete: true, session: 'a', model: 'm', backend: 'b1', turn: 0, promptTokens: 100, cachedTokens: 100 },
    { complete: true, session: 'a', model: 'm', backend: 'b2', turn: 1, promptTokens: 900, cachedTokens: 0 },
    { complete: true, session: 'b', model: 'm', backend: 'unknown', turn: 1, promptTokens: null, cachedTokens: null },
    { complete: false, session: 'c', model: 'm' },
  ]);
  assert.equal(summary.cacheRatio, 0.1);
  assert.equal(summary.usageCoverage, 2 / 3);
  assert.equal(summary.backendCoverage, 2 / 3);
  assert.equal(summary.sessionsSwitchingBackend, 1);
  assert.equal(summary.failed, 1);
});

test('comparison acceptance requires configured affinity and independently verified routing', () => {
  const comparisons = ['apim', 'aigateway'].flatMap(gateway => ['single', 'balanced', 'sticky'].map(scenario => ({
    gateway, scenario, requests: 360, completed: 360, sessions: 60, usageCoverage: 1, resourceLogCoverage: 1,
    affinityEnabled: scenario === 'sticky', sessionsSwitchingBackend: scenario === 'balanced' ? 60 : 0,
    requestDistribution: scenario === 'single' ? { b1: 360 } : { b1: 120, b2: 120, b3: 120 },
    initialSessionDistribution: { b1: 20, b2: 20, b3: 20 }, warmCacheRatio: 0.91,
    byTurn: { 1: { cacheRatio: 0 } },
  })));
  assert.equal(validateComparisons(comparisons).passed, true);
  const unconfigured = structuredClone(comparisons);
  unconfigured[5].affinityEnabled = false;
  assert.throws(() => validateComparisons(unconfigured), /affinity was not enabled/);
  const unverified = structuredClone(comparisons);
  unverified[5].resourceLogCoverage = 0.99;
  assert.throws(() => validateComparisons(unverified), /incomplete backend evidence/);
  const unstable = structuredClone(comparisons);
  unstable[5].sessionsSwitchingBackend = 1;
  assert.throws(() => validateComparisons(unstable), /healthy sessions changed backend/);
});

test('SSE usage, generated content, terminal completion, and errors stay distinct', () => {
  assert.equal(parseEvent('[DONE]').done, true);
  assert.equal(parseEvent('{"choices":[{"delta":{"role":"assistant"}}]}').content, false);
  assert.equal(parseEvent('{"choices":[{"delta":{"content":"ACK"}}]}').content, true);
  assert.equal(parseEvent('{"choices":[{"delta":{},"finish_reason":"stop"}]}').finished, true);
  assert.equal(parseEvent('{"usage":{"prompt_tokens":2048},"choices":[]}').usage.prompt_tokens, 2048);
  assert.equal(parseEvent('{"error":{"code":"server_error"}}').error.code, 'server_error');
});

test('network-fragmented CRLF SSE retains usage and requires terminal completion', async () => {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const data = [
      'data: {"choices":[{"delta":{"content":"ACK"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":2048,"prompt_tokens_details":{"cached_tokens":1920}}}',
      'data: [DONE]',
    ].join('\r\n\r\n') + '\r\n\r\n';
    for (const byte of Buffer.from(data)) {
      response.write(Buffer.from([byte]));
      await new Promise(resolve => setImmediate(resolve));
    }
    response.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await callModel({
      url: `http://127.0.0.1:${server.address().port}`, body: { stream: true },
    });
    assert.equal(result.complete, true);
    assert.equal(result.promptTokens, 2048);
    assert.equal(result.cachedTokens, 1920);
    assert.ok(result.ttftMs >= 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('SSE completion does not wait for the server to close the transport', async () => {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write([
      'data: {"choices":[{"delta":{"content":"ACK"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":2048,"prompt_tokens_details":{"cached_tokens":1920}}}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await callModel({
      url: `http://127.0.0.1:${server.address().port}`, body: { stream: true }, timeoutMs: 500,
    });
    assert.equal(result.complete, true);
    assert.equal(result.cachedTokens, 1920);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
