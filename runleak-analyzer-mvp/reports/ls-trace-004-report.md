# RunLeak Report — Repeated Context Leak

**Synthetic benchmark trace. Not customer data.**

---

## Run Summary

| Metric | Value |
|---|---|
| Case | ls-trace-004 |
| Task | Document Q&A Chain (imported via langsmith-like) |
| Model calls | 5 |
| Tool calls | 1 |
| Retries | 0 |
| Input tokens | 74,900 |
| Output tokens | 5,800 |
| Estimated total cost | $0.25 |

---

## Finding

### repeated context (high)

**Detection method:** `block_id_and_similarity`

**Confidence:** high

### Evidence

Detection method: block_id_and_similarity. The "LangSmith input: document" block (18,600 tokens) appears across 4 model calls. Block ID matched (ls_document) and text similarity confirmed (100%). Block was reused 3 times after first occurrence (child-llm-001).

### Evidence Table

| Property | Value |
|---|---|
| Block ID | `ls_document` |
| Block estimated tokens | 18,600 |
| Total occurrences | 4 |
| Repeated occurrences (waste) | 3 |
| First occurrence (excluded) | child-llm-001 |
| Wasted occurrence steps | child-llm-002, child-llm-003, child-llm-004 |
| Similarity | 100% |
| Estimated waste | $0.14 |

### Cost Math

**Pricing:** gpt-4o at $2.5/M input tokens, $10/M output tokens

- Block size: 18,600 tokens
- Repeated after first occurrence: 3 times
- Waste tokens: 55,800 (18,600 × 3)
- Math: (55,800 / 1,000,000) × $2.5 = $0.14
- First occurrence (child-llm-001) excluded: waste counts only 3 repetitions after first
- Output tokens not counted: waste is on excess input tokens

*Cost calculations use published model pricing. Estimates depend on available trace metadata.*

### Explanation

The "LangSmith input: document" block (18,600 tokens) was included in the model context 4 times but only needed once. After the first use in child-llm-001, the remaining 3 occurrences (child-llm-002, child-llm-003, child-llm-004) passed the same content again, generating an estimated $0.14 in waste. This represents approximately 56% of the total run cost.

### Recommended Fix

Cache the content of "LangSmith input: document" after child-llm-001. Pass a reference ID or cached summary into later steps (child-llm-002, child-llm-003, child-llm-004) instead of the full block.

---

## Cost Caveat

The detected repeated-context waste shown above represents a specific, measured inefficiency in this trace. It does not represent total potential savings. A full cost comparison requires running a fixed version of the same task and comparing total costs. The repeated-context detector explains only the waste from re-passing the same large context block — not the full cost difference between two runs.

## Limitations

- This is a synthetic benchmark trace, not real customer data.
- Cost estimates depend on available token metadata and published model pricing.
- Actual provider pricing, discounts, and caching behavior may differ.
- RunLeak does not guarantee specific savings.

*Report generated at 2026-06-19T20:58:34.038Z*
*RunLeak Analyzer MVP v0.1.0*