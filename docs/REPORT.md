# LLM gateway lab: results

**Test date:** 12 November 2026  
**Client:** OpenCode 2.2.5  
**Scope:** three identical model backends, cookie-free sessions, and basic recovery.

## Results in brief

**APIM's configurability allowed us to implement and validate the required routing.** A custom policy distributed 60 sessions across three backends in a **20 / 23 / 17** split. Every healthy first-attempt selection matched the expected backend. All requests completed during the controlled 429, 503, and unavailable-hostname tests.

**Standalone Azure AI Gateway also has a documented native session-affinity feature.** Additional research identified its session-key expression and routing-order settings. The original measurements used ordinary pools with this feature disabled. Native affinity with OpenCode remains **documented and awaiting a separate runtime test**.

**A cache-saving advantage from affinity was not demonstrated with this model.** Cached input stayed near 91% after the first turn with standard balancing too. A separate probe confirmed reported cache reuse across the three model accounts in this Global Standard setup.

## Test setup

![Laboratory architecture](architecture.png)

The [editable SVG](architecture.svg) uses official Azure service icons and straight connectors, rendered with Inkscape.

The isolated lab contained one **APIM Basic v2** unit, one **standalone AI Gateway Standard preview**, three Azure OpenAI accounts in **Sweden Central**, Log Analytics, and Application Insights. Each account deployed **gpt-5-nano**, version **2025-08-07**, deployment name **gpt-5-nano**, using **Global Standard**. Physical inference placement is service-managed.

Both gateways used managed identities scoped to the model accounts; model API-key authentication was disabled. All seven top-level resources belonged to a new ownership-tagged group. Existing subscription resources were left unchanged.

Each comparison ran **60 sessions of six turns**, at **36 requests/minute**, with about **5,200-5,300 input tokens**, a tool definition, and growing history. Unique early prefixes kept first turns cold. Two rounds produced **4,320 completed requests**. Six cases ran concurrently; the repeat used eleven session workers to avoid accidental alignment with three-way round-robin scheduling.

Actual serving accounts were identified by joining response request IDs to model diagnostics. Coverage was **100% for all 2,160 repeat requests** and about **59-62%** in the first round. Unmatched observations remain unknown. A pool name was never counted as a serving account.

## Measured comparison

This table shows the eleven-worker repeat. Each row contains **360 completed requests and zero client errors**. Backend counts are in **b1 / b2 / b3** order. Cached input is the token-weighted cached/total input ratio for turns **two through six**.

| Configuration | Requests per backend | Sessions changing backend | Cached input |
|---|---:|---:|---:|
| APIM, b1 preferred | 353 / 6 / 1 | 7, during recovery | 90.92% |
| APIM, standard pool | 119 / 120 / 121 | 60 / 60 | 90.92% |
| APIM, session-affinity policy | 119 / 137 / 104 | 3, during recovery | 91.52% |
| Standalone gateway, one backend | 360 / 0 / 0 | 0 / 60 | 89.64% |
| Standalone gateway, standard pool | 120 / 120 / 120 | 60 / 60 | 90.59% |
| Standalone gateway, pool with session headers | 121 / 121 / 118 | 60 / 60 | 91.53% |

APIM affinity assigned **33.3% / 38.3% / 28.3%** of sessions to the backends, within the specified 20-45% range. The original round had **zero switches and 360/360 expected first attempts**. In the repeat, **357/360 requests (99.17%)** completed on the expected first attempt; three recovered elsewhere. All 357 healthy first-attempt selections were correct.

The APIM reference also retained automatic recovery: seven repeat requests used another backend following transient 500 responses and circuit-breaker activity. The original strict reference served **360/360 on b1**, with **91.22%** cached input. Affinity stayed within five percentage points of that reference in both rounds. No intentional faults overlapped comparison runs; the transient responses' root cause was not established.

The historical standalone alias named `sticky` had the same equal-weight pool as `balanced`. Sending session headers alone left ordinary load balancing active. These rows measure pool behavior; they leave the native-affinity configuration below unmeasured.

## Native AI Gateway configuration

The current [session-affinity documentation](https://ai.gateway.azure.com/docs/models/session-affinity) describes deterministic backend preference from a string session key. The [configuration guide](https://ai.gateway.azure.com/docs/models/guides/configure-session-affinity) explicitly covers coding clients that send their conversation context on every turn.

For this workload, apply the following in the **AI Gateway portal**, in workspace **default**, by editing a dedicated model alias such as **gpt-5-nano-affinity**:

1. Select the same three `lab-chat` backend registrations and leave automatic model selection off.
2. Under **Session affinity**, enable **Enable session affinity**.
3. Enter this Common Expression Language (CEL) expression:

   ```cel
   'x-opencode-session' in request.headers ? request.headers['x-opencode-session'][0] : ''
   ```

4. Give all targets priority **0** and weight **1**.
5. Under **Routing order**, select **Session affinity before priority**, then save.
6. Point OpenCode's normal model setting to this alias. It already sends the required header.

This reads an existing conversation header and requires no cookies or application changes. An absent header returns an empty key, allowing the other routing settings to distribute requests. According to the documentation, affinity bypasses weights when it selects a backend. An unavailable or excluded preferred backend invokes the remaining routing settings; its original preference is retained. Changing the backend set can change the mapping.

The original CLI-based reproduction script never set the native `sessionBackendPreference` property. A dedicated rerun should now measure distribution, healthy-session consistency, cache usage, missing-header behavior, streaming, and recovery with this setting enabled. **No new Azure resources were created during this documentation review.**

## Latency and recovery

Values below are milliseconds, including network, gateway, and model time. p50 is the median; 95% of observations are at or below p95. First-token timing excludes role-only events. Streams were checked for a finish reason and final completion marker.

| Configuration | First token p50 / p95 | Total p50 / p95 | Retried requests |
|---|---:|---:|---:|
| APIM, b1 preferred | 409 / 713 | 500 / 794 | 7 |
| APIM, standard pool | 413 / 746 | 518 / 867 | 0 |
| APIM, affinity | 409 / 682 | 534 / 794 | 3 |
| Standalone, one backend | 418 / 753 | 520 / 834 | Unknown |
| Standalone, standard pool | 453 / 691 | 505 / 789 | Unknown |
| Standalone, pool with session headers | 449 / 706 | 517 / 815 | Unknown |

Standalone per-request attempt counts and gateway-only overhead were not available in the collected evidence.

Recovery tests injected errors before streaming: a controlled APIM endpoint supplied HTTP 429/503, and a reserved `.invalid` hostname simulated an unavailable endpoint. Actual quota exhaustion was outside the test.

| Gateway and injected condition | Completed model responses | HTTP 500 responses | Observed retries |
|---|---:|---:|---:|
| APIM: HTTP 429 | 12 / 12 | 0 | 4 requests |
| APIM: HTTP 503 | 12 / 12 | 0 | 4 requests |
| APIM: unavailable hostname | 12 / 12 | 0 | 4 requests |
| Standalone: HTTP 429 | 12 / 12 | 0 | Unknown |
| Standalone: HTTP 503 | 12 / 12 | 0 | Unknown |
| Standalone: isolated unavailable hostname | 0 / 12 | 12 | Unknown |

The isolated standalone test used a fresh provider/priority alias, with six healthy controls before the change and six after restoration. The twelve outage requests returned HTTP 500. An earlier sequential probe had different results after HTTP-error tests; prior health state was not isolated there. This observation applies to the tested transport-recovery configuration and is separate from native session affinity.

APIM used at most three attempts, a 45-second forward timeout, and a 180-second client deadline. Affected requests moved to a healthy neighbor; the home backend was preferred again after recovery. The additional buffered recovery branch and recovery after partial streaming remain untested.

## What the cache measurements establish

Three additional trials sent an identical new prompt through APIM to **b1, then b2, then b3, then b1**. Only the session header changed. All twelve serving-account identities were independently matched to resource logs.

In every trial, the first b1 request reported **zero cached tokens**. The first b2 and b3 requests each reported **4,992**. The final b1 request hit in two trials and missed in one.

Thus, changing account/deployment preserved reported cache reuse in this same-subscription Global Standard experiment. Physical cache ownership and worker identity were unavailable. Recheck the customer's model, deployment type, and regions before estimating a financial benefit from affinity.

## OpenCode and edge cases

The official **OpenCode 2.2.5** binary completed real conversations through both gateways in observed and ordinary direct-provider modes. Completed `ACK` output and terminal stop events were checked.

| Question | Evidence |
|---|---|
| Session headers identify the conversation | The four observed headers carried the same `ses_` identifier. |
| Continue with `--session`; start a new conversation | Continuation preserved the identifier across invocations; a new conversation changed it. |
| Cookie handling | A mock returned a cookie; the client returned none. |
| Project and tracing headers | Project identifier stayed stable; `traceparent` changed. |
| Vendor OpenCode gateway requires a particular header | Unverified; that gateway was outside the lab. |
| Compaction, long-term restoration, title model, subagents | Unverified. Explicit titles and denied tools kept the test focused. |
| Another client's generic affinity header identifies a conversation | Unverified; establish a separate client header contract. |
| APIM expression support | The deployed SHA-256, string, regex, JSON, and backend-selection expressions ran successfully. |

**33 APIM edge checks passed**, covering non-streaming, individual header alternatives, reconnection, and explicit handling of conflicting or malformed identifiers. Twenty-four requests without a session header distributed **6 / 9 / 9**, with ordinary request-level balancing.

## Implementation choice and production follow-up

APIM provided the flexibility to combine OpenCode's existing headers, model-specific hashing, identifier validation, and bounded recovery in one policy. The tested mapping uses a fixed three-backend topology and needs no shared session database. Native cookie affinity was excluded because of the client's behavior. More elaborate hashing, external session registries, and response caching were outside this focused lab.

For standalone AI Gateway, the documented native alias setting is the next configuration to qualify. Keep its future results separate from the historical pool probes.

Before production, monitor backend selection, cached-token ratios, first-token latency, errors, retries, and session hot spots. Validate capacity during an outage, scoped identity permissions, and partial-stream handling. Multi-unit/multi-region operation, topology changes, hot-key handling, and stateful Responses API failover remain follow-up work.

## Cost, cleanup, and evidence

The lab used pay-as-you-go models and Basic v2 capacity. The planning lookup returned **USD 0.27/hour** plus **USD 0.04 per 10,000 calls** for APIM. About **75 minutes** corresponds to **USD 0.34** for capacity alone, before request, model, telemetry, and billing-rounding effects. Current agreement prices and actual invoiced cost require separate verification.

Comparisons consumed **22,733,280 input tokens**, including **17,207,424 reported cached tokens**, and **43,466 output tokens**. Extra client, edge, and recovery probes are excluded. Workload limits were operational spending guards.

**Cleanup was verified at 20:55 UTC:** the dedicated group and its seven top-level resources were absent. Authorized provider registrations and platform soft-delete records were retained. See [lifecycle evidence](../results/lifecycle.json).

Detailed evidence: [comparison rounds](../results/comparisons.json), [request measurements](../results/requests.jsonl), [recovery runs](../results/faults.json), [cache crossover](../results/cache-scope.json), [OpenCode checks](../results/opencode.json), and [edge cases](../results/edge-checks.json). Exact reproduction steps and configuration locations are in the [README](../README.md); tested APIM templates are in [policies](../policies/).

### Primary references

- [Standalone Azure AI Gateway overview](https://learn.microsoft.com/azure/ai-gateway/overview), [native session affinity](https://ai.gateway.azure.com/docs/models/session-affinity), [configuration guide](https://ai.gateway.azure.com/docs/models/guides/configure-session-affinity), and [routing order](https://ai.gateway.azure.com/docs/models/routing-order).
- [APIM backend pools](https://learn.microsoft.com/azure/api-management/backends) and [policy expressions](https://learn.microsoft.com/azure/api-management/api-management-policy-expressions).
- [Azure OpenAI prompt caching](https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching): identical-prefix requirements and usage reporting. Its cross-subscription isolation statement does not establish deployment-level isolation for this experiment.
- [Official OpenCode 2.2.5 release](https://github.com/anomalyco/opencode/releases/tag/v2.2.5).
- [Azure architecture icon terms](https://learn.microsoft.com/azure/architecture/icons/).
