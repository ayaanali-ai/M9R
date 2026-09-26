# RunLeak Report — Repeated Context Leak

**Synthetic benchmark trace. Not customer data.**

---

## Run Summary

| Metric | Value |
|---|---|
| Case | otel-trace-005 |
| Task | imported from OTel GenAI spans (imported via otel-genai-like) |
| Model calls | 4 |
| Tool calls | 1 |
| Retries | 0 |
| Input tokens | 74,500 |
| Output tokens | 5,600 |
| Estimated total cost | $0.24 |

---

## Finding

### repeated context (high)

**Detection method:** `block_id_and_similarity`

**Confidence:** high

### Evidence

Detection method: block_id_and_similarity. The "OTel prompt: gpt-4o" block (17,300 tokens) appears across 4 model calls. Block ID matched (otel_prompt_6f8f3539) and text similarity confirmed (99%). Block was reused 3 times after first occurrence (span-001).

### Evidence Table

| Property | Value |
|---|---|
| Block ID | `otel_prompt_6f8f3539` |
| Block estimated tokens | 17,300 |
| Total occurrences | 4 |
| Repeated occurrences (waste) | 3 |
| First occurrence (excluded) | span-001 |
| Wasted occurrence steps | span-002, span-003, span-005 |
| Similarity | 99% |
| Estimated waste | $0.13 |

### Cost Math

**Pricing:** gpt-4o at $2.5/M input tokens, $10/M output tokens

- Block size: 17,300 tokens
- Repeated after first occurrence: 3 times
- Waste tokens: 51,900 (17,300 × 3)
- Math: (51,900 / 1,000,000) × $2.5 = $0.13
- First occurrence (span-001) excluded: waste counts only 3 repetitions after first
- Output tokens not counted: waste is on excess input tokens

*Cost calculations use published model pricing. Estimates depend on available trace metadata.*

### Explanation

The "OTel prompt: gpt-4o" block (17,300 tokens) was included in the model context 4 times but only needed once. After the first use in span-001, the remaining 3 occurrences (span-002, span-003, span-005) passed the same content again, generating an estimated $0.13 in waste. This represents approximately 54% of the total run cost.

### Recommended Fix

Cache the content of "OTel prompt: gpt-4o" after span-001. Pass a reference ID or cached summary into later steps (span-002, span-003, span-005) instead of the full block.

---

## Cost Caveat

The detected repeated-context waste shown above represents a specific, measured inefficiency in this trace. It does not represent total potential savings. A full cost comparison requires running a fixed version of the same task and comparing total costs. The repeated-context detector explains only the waste from re-passing the same large context block — not the full cost difference between two runs.

## Limitations

- This is a synthetic benchmark trace, not real customer data.
- Cost estimates depend on available token metadata and published model pricing.
- Actual provider pricing, discounts, and caching behavior may differ.
- RunLeak does not guarantee specific savings.

*Report generated at 2026-06-19T20:58:37.033Z*
*RunLeak Analyzer MVP v0.1.0*