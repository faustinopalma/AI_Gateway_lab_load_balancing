# LLM gateway lab: results

**Test date:** 12 November 2026  
**Client:** OpenCode 2.2.5  
**Scope:** three identical model backends, cookie-free sessions, and basic recovery.

## What we found

**APIM met the session-routing requirement.** Its policy distributed 60 sessions across the three backends in a 20 / 23 / 17 split. Every healthy first attempt reached the expected backend. Controlled 429, 503, and DNS failures were recovered without failed client requests.

**The tested standalone Azure AI Gateway configuration did not meet the requirement.** With the existing OpenCode session headers, all 60 sessions in the final repeat still changed backend. An isolated DNS failure returned HTTP 500 for all 12 affected requests.

**A cache-saving advantage from stickiness was not demonstrated.** Cached input stayed near 91% after the first turn even when requests changed backend. A separate controlled probe confirmed cached-token reuse across the three accounts for this Global Standard setup. The original assumption that every deployment change necessarily makes the cache cold was not reproduced.

## What was deployed

![Laboratory architecture](architecture.png)

The [editable SVG](architecture.svg) was prepared and rendered with Inkscape.

- One Azure API Management **Basic v2** unit.
- One dedicated standalone Azure AI Gateway **Standard preview** resource.
- Three separate Azure OpenAI accounts in **Sweden Central**.
- Identical deployments: **gpt-5-nano**, version **2025-08-07**, deployment name **gpt-5-nano**, **Global Standard**.
- A capped Log Analytics workspace and an Application Insights component for telemetry setup.

Global Standard uses service-managed inference placement. The resource region alone does not establish where each inference executed. Both gateways used managed identities with inference permission scoped to the three accounts; model API-key authentication was disabled.

All seven top-level resources were created in one new, ownership-tagged lab group. Existing subscription resources were left unchanged. The separately authorized provider registrations remain registered.

## How the test worked

Each comparative case ran **60 sessions of six turns**, at **36 requests/minute**. Prompts contained about **5,200-5,300 tokens** of synthetic instructions, a tool definition, and growing conversation history. Each session/run had an early unique prefix. Every first turn reported zero cached tokens.

Two complete rounds produced **4,320 completed requests and zero failures**. Six cases ran concurrently against the same three accounts. The first round used twelve concurrent session workers; the repeat used eleven. The second count avoids a scheduling pattern that can accidentally keep a session aligned with a three-way round-robin cycle.

Serving-backend identity was checked by joining response request IDs to the actual model-account diagnostic logs. **All 2,160 requests in the repeat were matched.** Initial-round log coverage remained about 59-62%; those unmatched observations remain unknown. APIM's direct-backend headers additionally identify its explicit selections. A configured pool name was never counted as a serving model account.

"Cached input" below means cached input tokens divided by total input tokens, weighted by tokens, for turns **two through six**. Latency includes the network, gateway, and model. The first-token measurement ignores role-only stream events. A successful stream requires a finish reason and the final completion marker.

## Comparison

The following table shows the eleven-worker repeat. Backend counts are completed requests in **b1 / b2 / b3** order.

| Configuration | Requests per backend | Sessions changing backend | Cached input | Failed requests |
|---|---:|---:|---:|---:|
| APIM, b1 preferred | 353 / 6 / 1 | 7, during recovery | 90.92% | 0 / 360 |
| APIM, standard pool | 119 / 120 / 121 | 60 / 60 | 90.92% | 0 / 360 |
| APIM, session-affinity policy | 119 / 137 / 104 | 3, during recovery | 91.52% | 0 / 360 |
| Standalone gateway, one backend | 360 / 0 / 0 | 0 / 60 | 89.64% | 0 / 360 |
| Standalone gateway, standard pool | 120 / 120 / 120 | 60 / 60 | 90.59% | 0 / 360 |
| Standalone gateway, session headers supplied | 121 / 121 / 118 | 60 / 60 | 91.53% | 0 / 360 |

The APIM reference retains automatic recovery. Seven calls in the repeat used a fallback after transient 500 responses/circuit-breaker activity; it therefore became a b1-preferred reference. The **original strict one-backend run served 360/360 requests on b1**, with **91.22%** cached input after turn one.

For APIM affinity, the original round had **zero switches and 360/360 expected first attempts**. In the repeat, **357/360** requests completed on their expected first attempt (**99.17%**); three requests recovered elsewhere. All **357 healthy first-attempt selections were correct**, with **zero unexplained first-attempt mismatches**. No intentional fault injection overlapped these comparative runs. The root cause of the transient 500 responses was not established.

Initial affinity assignments were **20 / 23 / 17 sessions**, or **33.3% / 38.3% / 28.3%**. Each backend was inside the specified 20-45% range. The affinity cached-input ratio was within five percentage points of the strict single-backend reference in both rounds.

The standalone alias named `sticky` was a probe using its normal equal-weight pool and the existing client headers. No documented header-affinity setting was found in the tested CLI/configuration surface. Its healthy-session switches directly fail the stickiness check, despite its high cache ratio.

### Latency and retries

Values are milliseconds. p50 is the median; p95 is the value at or below which 95% of requests completed.

| Configuration | First token p50 / p95 | Total p50 / p95 | Retried requests |
|---|---:|---:|---:|
| APIM, b1 preferred | 409 / 713 | 500 / 794 | 7 |
| APIM, standard pool | 413 / 746 | 518 / 867 | 0 |
| APIM, affinity | 409 / 682 | 534 / 794 | 3 |
| Standalone, one backend | 418 / 753 | 520 / 834 | Unknown |
| Standalone, standard pool | 453 / 691 | 505 / 789 | Unknown |
| Standalone, session-header probe | 449 / 706 | 517 / 815 | Unknown |

The standalone gateway did not expose per-request attempt counts through the collected telemetry. Gateway-only overhead was not isolated, and these measurements do not establish a gateway-specific latency advantage.

## Failure tests

Faults were injected before response streaming. HTTP errors came from a controlled APIM endpoint; DNS unavailability used a reserved `.invalid` hostname. These were synthetic errors, rather than actual model-quota exhaustion.

| Gateway and injected failure | Completed during fault | Failed | Observed retries |
|---|---:|---:|---:|
| APIM: HTTP 429 | 12 / 12 | 0 | 4 requests |
| APIM: HTTP 503 | 12 / 12 | 0 | 4 requests |
| APIM: DNS unavailable | 12 / 12 | 0 | 4 requests |
| Standalone: HTTP 429 | 12 / 12 | 0 | Unknown |
| Standalone: HTTP 503 | 12 / 12 | 0 | Unknown |
| Standalone: isolated DNS unavailable | 0 / 12 | 12, HTTP 500 | Unknown |

For the isolated standalone DNS test, a fresh provider/priority alias first completed six healthy requests. After its primary endpoint became unavailable, twelve requests failed. Six healthy control requests succeeded after restoration, which was also checked by reading back the endpoint.

An earlier sequence appeared to recover the standalone DNS case after HTTP failures. Existing health/ejection state could have hidden the unavailable primary. That sequence is retained as exploratory evidence; the fresh-provider test provides the isolated result. Older exploratory HTTP tests also had uncertainty about forwarding a path prefix.

APIM made at most three attempts, with a 45-second forward timeout and a 180-second test-client deadline. Affected requests moved to a healthy neighbor; the original home backend was preferred again after recovery. No tested DNS recovery used the policy's additional buffered `on-error` branch, so that branch remains unqualified. Recovery after partial streamed output was outside this test.

## What the cache measurements establish

Three extra trials sent an identical new prompt through APIM to **b1, then b2, then b3, then b1**. Routing was deliberately changed by the session header while the request body stayed identical. All twelve serving-account identities were independently matched to resource logs.

In every trial, the first b1 request reported **zero** cached tokens. The first b2 and b3 requests each reported **4,992** cached tokens. The final b1 request hit in two trials and missed in one.

These are measured usage values. They demonstrate that changing the account/deployment did not necessarily remove reported cache reuse in this same-subscription Global Standard experiment. Worker identity and physical cache ownership were unavailable. Shared infrastructure is a possible explanation, but its implementation was not established.

Consequently, this lab supports APIM for explicit session placement and tested recovery. It provides **no measured cost-saving claim from affinity** for this model/deployment combination. Recheck cache isolation and benefit for the customer's actual model, deployment type, and regions.

## OpenCode and edge cases

The exact official **2.2.5** binary completed real conversations through both gateways, using both the recorder and ordinary direct provider configuration. Completed `ACK` output and terminal stop events were checked.

| Question | Result |
|---|---|
| Four supplied session headers carry the same `ses_` identifier | Confirmed on the tested binary. |
| Continue with `--session` | Same identifier across separate CLI invocations. |
| Start a new conversation | New identifier. |
| Cookie-based affinity usable | The mock returned a cookie; the client returned none. |
| Project ID stable; tracing changes | Confirmed for the captured project ID and `traceparent`. |
| Vendor OpenCode gateway requires a particular header | Unverified; that gateway was outside the lab. |
| Compaction, long-term saved-session restoration, title model, subagents | Unverified. Explicit titles and denied tools kept the test focused. |
| Another client's generic affinity header identifies a conversation | Unverified; each client needs its own header contract. |
| Custom APIM expressions accepted | The deployed SHA-256, string, regex, JSON, and backend-selection expressions ran successfully. |

**33 APIM edge checks passed**, including non-streaming requests, each supported header on its own, reconnection, and explicit rejection of conflicting, oversized, or space-containing identifiers. Twenty-four requests without a session header were distributed **6 / 9 / 9**; they have no session-affinity guarantee.

## Choice and follow-up

The selected APIM policy hashes the model route plus the existing conversation identifier to one of three backends. It needs no shared session database. Equal backend definitions and identical policy configuration are required. The session identifier remains separate from authentication.

Native cookie affinity was excluded because the client did not return cookies. Standard pools supplied useful distribution and failure controls but did not supply the required header-based placement. The standalone priority/weight configuration was evaluated directly. A shared session registry and more elaborate hashing were deferred to keep this three-backend lab simple. APIM response caching was outside the prompt-cache experiment.

Before production, monitor backend selection, cached-token ratios, first-token latency, errors, retries, and session hot spots. Alert on unexplained healthy migrations and exhausted recovery. Validate model/region combinations, capacity under failure, identity permissions, and behavior after a partial stream. Multi-unit/multi-region operation, topology changes, hot-key handling, and stateful Responses API failover remain follow-up work. The current modulo-three mapping is intended for a fixed topology.

The native Application Insights exporter attempt returned a server error. Model-account diagnostics supplied the successful independent backend evidence instead.

## Cost, cleanup, and evidence

The lab used pay-as-you-go models and Basic v2 gateway capacity; no Premium tier or PTU was created. A planning retail lookup returned **USD 0.27/hour** for Basic v2 and **USD 0.04 per 10,000 calls**. Treat these as indicative rates and verify current agreement pricing. Actual invoiced cost and a verified model-token price were unavailable at write-up. Measured token totals and lab timestamps are in the lifecycle evidence; workload bounds were operational guards rather than a hard billing cap.

The comparison consumed **22,733,280 input tokens**, including **17,207,424 reported cached tokens**, and **43,466 output tokens**. These totals exclude the extra client, edge, and fault checks. The group existed for about **75 minutes**; applying the indicative hourly rate continuously gives about **USD 0.34** for APIM capacity alone, before request, model, telemetry, and any billing-rounding effects.

**Cleanup was verified:** the dedicated resource group no longer existed at **20:55 UTC**. The ownership-checked inventory contained only the seven expected resources. Verification and resource types are recorded in [lifecycle evidence](../results/lifecycle.json). Provider registrations and platform soft-delete records are retained.

Detailed evidence: [both comparison rounds](../results/comparisons.json), [per-request measurements](../results/requests.jsonl), [fault runs](../results/faults.json), [cache crossover](../results/cache-scope.json), [OpenCode checks](../results/opencode.json), and [edge cases](../results/edge-checks.json). Private raw outputs remain in the ignored local `.lab` directory.

Reproduction and exact configuration locations are in the [README](../README.md); the deployed APIM templates are in [policies](../policies/).

### Documentation used

- [Standalone Azure AI Gateway](https://learn.microsoft.com/azure/ai-gateway/overview) and [CLI routing reference](https://github.com/Azure/aigateway/blob/main/skills/manage-ai-gateway/references/models-and-routing.md).
- [APIM backend pools](https://learn.microsoft.com/azure/api-management/backends) and [policy expressions](https://learn.microsoft.com/azure/api-management/api-management-policy-expressions).
- [Azure OpenAI prompt caching](https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching): identical-prefix requirements and usage reporting. The current guide states that caches are not shared across subscriptions; it does not establish a deployment-isolation guarantee for this experiment.
- [Official OpenCode 2.2.5 release](https://github.com/anomalyco/opencode/releases/tag/v2.2.5).
