# 0012: Test reuse of Python's compact JSON encoder

Status: isolated candidate verified and measured, 2026-11-18. No consistent throughput improvement was established; the candidate is not adopted. No production change.

## Problem and scope

The standalone host still loses to matched TypeScript on the Python statistics route. Phase instrumentation of the original host attributes most worker time to guest execution and imports. A separate Wasmtime call-hook diagnostic places most of that interval inside Wasm rather than host functions. Instrumentation has overhead and does not establish a speedup or precise uninstrumented cost.

`Response.json` calls `json.dumps(data, separators=(",", ":"))` for every response. The checked Python standard-library implementation constructs a new `JSONEncoder` whenever custom separators are supplied. Its default-separator path already reuses an encoder. Test the same reuse for Polyroute's fixed compact separators, without changing the route algorithm, request parsing, response class, headers, status, or public API.

## Candidate

Create one private `JSONEncoder(separators=(",", ":"))` in the Python adapter and call its `encode` method from `Response.json`. Keep every other encoder option at its existing default. Leave `Response` construction and subclass handling unchanged. No user payload, mutable per-response data, or returned string is cached. Do not change the Go SDK or the host dispatcher in this experiment.

## Acceptance and verification

Build original and candidate components with the same installed compiler, WIT worlds, and native precompiler. Compare real guest responses in reused and per-request instances. Cover Unicode, escapes, nested and large values, non-finite numbers, supported mapping keys, unsupported objects, circular references, recovery after errors, subclasses, custom headers, and repeated calls whose previous results remain retained. Exercise the portable adapter as well before production adoption because this module is shared.

Only after correctness checks, compare the unchanged statistics workload against the original component and matched TypeScript through the original standalone host. Use five alternating rounds, one-second warmups, three-second samples, one and ten connections, every arm's A/A control, and twenty cold samples. Retain raw samples, p95, environment, hashes, artifact sizes, and failures. A short diagnostic may reject a candidate but cannot establish acceptance. Do not run builds during timing.

Adopt only if the improvement exceeds observed control variation without a behavior or cold-start regression. This isolated Python change cannot satisfy the remaining Go, cross-platform, production packaging, or serverless-provider gates by itself.

## Correctness evidence

The isolated `polyroute-python-encoder-20261118` experiment changes only the adapter's encoder construction and call. `python3 prepare.py` built all six original/candidate statistics, native-validation, and portable-validation components with componentize-py 0.25.1 and the unchanged repository WIT. The current build-time addon precompiled each component. The standalone HTTP host is the original measured binary from ADR 0010, with the same hash.

`node validate.mjs` passed 1,390 real guest response checks. The 173-case sequence ran against both adapter variants, both native and portable WIT worlds, and both instance-reuse modes. It compares status, headers, body bytes, and error outcome; it also checks independent expected values for body boundaries, supported JSON keys, non-finite numbers, reentrant encoding, and retained responses. Circular and unsupported values fail and recover as before. Six additional checks cover the unchanged statistics route's normal and invalid input. The portable components ran through the existing Wasmtime host; this is not a jco deployment check.

`node measure.mjs --mode check --comparison ab` also validated the real HTTP response from both components and the matched TypeScript server. That check is not performance evidence. The subsequent short timing diagnostic remains separate from the required full comparison and controls.

The first short timing run completed nine correct samples but failed its final upstream-count assertion: the copied six-workload harness assumed one relay initialization, while this Python-only experiment has no relay. The correction derives the expected initialization count from the relay routes actually present. The original harness, manifest, failure, and nine samples remain preserved in `initial-diagnostic`; they are not accepted timing evidence. No response check or workload was removed to address the failure.

## Full measurement and decision

`python3 run-full.py` completed all twelve reports. `python3 summarize.py` recalculated medians and p95, checked alternating order, settings and artifact identity, and verified 90 warm samples and 180 cold samples, with zero errors and no discarded samples. Environment: Apple M1, eight logical CPUs, darwin 25.2.0, Node 24.21.0, Wasmtime 50.0.2. No builds or other load tests ran during timing. Ordinary background system activity remains represented in the controls.

| Connections | Original / candidate / TypeScript req/s | Candidate / original | Original / candidate / TypeScript p95 (ms) |
| ----------- | --------------------------------------: | -------------------: | -----------------------------------------: |
| 1           |                   7,197 / 7,251 / 7,828 |               1.008× |                      0.146 / 0.148 / 0.133 |
| 10          |                14,136 / 13,957 / 14,758 |               0.987× |                      0.804 / 0.830 / 0.678 |

The p95 column is the median of the five per-round p95 values. Paired A/A ratios for original, candidate, and TypeScript respectively were:

- 1 connection: 1.005–1.022×, 0.988–1.008×, 0.984–1.041×.
- 10 connections: 0.992–1.009×, 0.998–1.032×, 0.966–1.007×.

Cold original/candidate medians were 11.139/11.153 ms, with p95 12.021/13.063 ms. Matched TypeScript measured 48.846 ms median and 50.665 ms p95. The encoder changes the native median by +0.014 ms; original and candidate A/A median differences were +0.035 and +0.263 ms. This does not establish an encoder cold-start improvement. The standalone host’s existing advantage over Node remains a separate result.

The original/candidate precompiled statistics components are 32,547,368/32,547,368 bytes. The HTTP host, route algorithm, request data and TypeScript server are unchanged. Source hashes, binary hashes, raw samples, the failed initial harness run, successful diagnostic, commands, validation responses and controls remain in the experiment directory.

The small single-connection median increase does not exceed observed control variation, and the ten-connection median is lower. Neither count beats TypeScript. Do not integrate this candidate as a performance optimization; it adds a shared encoder without a demonstrated consistent benefit. No production, packed, cross-platform or provider integration of this candidate was attempted.
