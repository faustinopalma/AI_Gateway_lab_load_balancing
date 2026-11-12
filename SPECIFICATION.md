# Lab Specification: LLM Load Balancing and Session Stickiness

**Purpose:** Scope and acceptance criteria for the laboratory.

**Date:** 12 November 2026  
**Client:** OpenCode CLI

## 1. Objective

Test a simple gateway behavior:

- Independent OpenCode sessions are distributed across three LLM backends.
- Every request in one session, for the same model, reaches the same backend while the backends are healthy.
- Affinity works without client cookies or changes to the OpenCode application.
- Prompt-cache reuse is measured alongside routing, so the benefit of stickiness can be assessed.

Prefer the simplest supported configuration. Select an implementation after checking native capabilities; no hashing algorithm or external session store is prescribed.

## 2. Gateway configurations to evaluate

Run the same tests against both configurations:

| Configuration | Scope |
|---|---|
| APIM configured directly | Azure API Management exposing the model endpoints and managing backend selection. |
| Standalone Azure AI Gateway | The new dedicated `Microsoft.ApiManagement/aigateways` resource, exposing a path usable by OpenCode. |

The [standalone AI Gateway](https://learn.microsoft.com/azure/ai-gateway/overview) is a dedicated product sharing the APIM resource provider. Record actual resources, endpoints, SKU, and configuration differences.

Confirm that OpenCode traffic actually traverses each tested gateway. If a configuration cannot expose the required client path or support the routing behavior, report that limitation. Foundry model router is outside this comparison.

Use the same three backend endpoints for both configurations. Each backend must have the same model, model version, deployment type, and deployment name, hosted in a separate Azure resource. Different backend regions are useful when practical.

## 3. OpenCode and session identification

OpenCode 2.2.5 is the required end-to-end client. Record its provider configuration, API surface, streaming mode, and observed headers.

Only normal endpoint, model, and authentication configuration changes are allowed. The client cannot be required to preserve or return cookies.

Verify that these headers carry the same conversation identifier:

- `x-opencode-session`
- `x-opencode-session-id`
- `x-session-affinity`
- `x-session-id`

Verify which header remains stable across turns and changes for a new session. Use an existing conversation identifier for affinity. Project IDs, connection IDs, and per-request tracing IDs are unsuitable substitutes.

Keep affinity separate for different model routes within the same session, including any title-generation calls. Authenticate the caller independently of the session identifier.

Without a valid session header, distribute requests normally and record that affinity is unavailable. Handle conflicting or malformed identifiers explicitly.

## 4. Tests

For each gateway configuration, use these three comparative cases:

| Case | Purpose |
|---|---|
| A. One backend | Establish the achievable cache-reuse reference. |
| B. Three backends, standard balancing | Observe distribution and cache reuse without affinity. |
| C. Three backends, session affinity | Verify distribution across sessions and stickiness within each session. |

Use equivalent workloads and model settings in all cases. Synthetic traffic may reproduce the verified OpenCode headers for repeatable measurements, but successful real OpenCode conversations through each configuration are required.

Start with at least 60 independent, equal-length sessions of at least six turns for the balancing and stickiness checks. Run multiple sessions concurrently, keeping turns ordered within each session. Adjust request rate to the approved quota and budget.

Use realistic stable system instructions and tool definitions totaling several thousand tokens, followed by growing conversation history. Verify the selected model's caching requirements; the current [prompt-caching guide](https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching) specifies a minimum identical prefix of 1,024 tokens.

Prevent previous comparative runs from unintentionally warming the next case, using a distinct stable run prefix where practical. Keep request cache options equivalent across cases.

Also check:

- New sessions are independently assigned; reconnecting with the same session identifier preserves affinity.
- OpenCode streaming completes correctly, and a small non-streaming control behaves consistently.
- Requests without session headers follow the documented fallback.
- During active sessions, one backend returns 429 or becomes unavailable before a response starts. Verify recovery through a healthy backend, record affected-session migrations, and observe behavior after recovery.

Only the failure test permits intentional backend migration. Once streamed output has reached the client, transparent continuation on another backend is outside the guarantee; interrupted output must be reported as a failure.

## 5. Measurements and acceptance

Retain enough correlated evidence to identify each request's session, model route, turn, actual serving backend, outcome, and any retry. Verify actual backend identity rather than relying only on the configured pool name.

| Check | Measurement | Acceptance |
|---|---|---|
| Balancing | Distinct sessions and completed requests per backend. | All three backends receive sessions. For equal-weight, equal-length traffic, each receives 20-45% of sessions. Report request distribution too. |
| Stickiness | Number of distinct serving backends per session/model pair. | Exactly one in every healthy, unchanged-topology session: zero unexplained backend switches. |
| Cache reuse | `sum(cached input tokens) / sum(total input tokens)`, overall and by turn. | After the first turn, Case C is within five percentage points of Case A. If the reference has no repeatable cache hits, diagnose the test before claiming success. |
| Client compatibility | Completed real OpenCode conversations through each configuration. | Works with existing session headers, without cookies or application changes. |
| Basic resilience | Failed requests, retries, and backend migrations during the controlled outage. | No failed requests in the pre-response fault test when a compatible healthy backend has capacity and recovery fits the declared deadline. |

For Chat Completions, collect `usage.prompt_tokens` and `usage.prompt_tokens_details.cached_tokens`, including final streaming usage where supported. Adapt field names to the API actually used. Missing usage is unknown and must have its coverage reported.

Also report time-to-first-token for streaming, total latency p50/p95, and errors. Establish a finite retry limit and request deadline before the fault test.

Stable backend routing increases cache-reuse opportunities. Service-managed worker placement and cache eviction can still cause misses. Report measured routing and measured cache behavior separately. A standard pool may also warm several caches over time; an improvement over Case B must be demonstrated.

## 6. Lab constraints

- Create resources only in a dedicated lab resource group. Apply `purpose=llm-cache-affinity-lab` and `owner=fausto.palma` to the group and taggable resources.
- Use managed identity between the gateway and model backends, with scoped inference permissions and no plaintext model keys.
- Use the minimum sufficient SKU and quota. Estimate costs before deployment and obtain approval for the spending envelope, particularly Premium tiers or PTU.
- Save eventual resources and configuration as Bicep or reproducible CLI scripts.
- Use synthetic content and sanitized telemetry; retain no credentials in evidence.
- Supply resource inventory and exact cleanup commands. Delete nothing without explicit confirmation.

## 7. Deliverables

1. A short report comparing both gateway configurations and Cases A/B/C, including session/request distribution, stickiness violations, cache ratios, latency, failures, and retry behavior.
2. The tested gateway configuration, policies, and reproducible infrastructure/test instructions.
3. OpenCode version/configuration and evidence of the session header used.
4. Limitations, estimated cost, and cleanup commands.

Distinguish documented behavior, supplied observations, measurements, and conclusions. Report unsupported or unverified behavior explicitly.

## 8. Deferred scope

Multi-unit and multi-region gateway validation, backend addition/removal, external affinity registries, hot-key optimization, stateful Responses API failover, and comprehensive production sizing are follow-up work. They are excluded from this first laboratory milestone.
