# RunLeak Report — Repeated Context Leak

**Synthetic benchmark trace. Not customer data.**

---

## Run Summary

| Metric | Value |
|---|---|
| Case | 001-repeated-context |
| Task | Document Q&A agent — answer 4 questions from a 50-page product spec document |
| Model calls | 8 |
| Tool calls | 1 |
| Retries | 1 |
| Input tokens | 92,300 |
| Output tokens | 8,100 |
| Estimated total cost | $0.32 |

---

## Finding

### repeated context (high)

**Detection method:** `block_id_and_similarity`

**Confidence:** high

### Evidence

Detection method: block_id_and_similarity. The "Full product spec document (50 pages)" block (18,420 tokens) appears across 5 model calls. Block ID matched (full_doc_18420) and text similarity confirmed (100%). Block was reused 4 times after first occurrence (step-3).

### Evidence Table

| Property | Value |
|---|---|
| Block ID | `full_doc_18420` |
| Block estimated tokens | 18,420 |
| Total occurrences | 5 |
| Repeated occurrences (waste) | 4 |
| First occurrence (excluded) | step-3 |
| Wasted occurrence steps | step-4, step-5, step-6, step-7 |
| Similarity | 100% |
| Estimated waste | $0.18 |

### Cost Math

**Pricing:** gpt-4o at $2.5/M input tokens, $10/M output tokens

- Block size: 18,420 tokens
- Repeated after first occurrence: 4 times
- Waste tokens: 73,680 (18,420 × 4)
- Math: (73,680 / 1,000,000) × $2.5 = $0.18
- First occurrence (step-3) excluded: waste counts only 4 repetitions after first
- Output tokens not counted: waste is on excess input tokens

*Cost calculations use published model pricing. Estimates depend on available trace metadata.*

### Explanation

The "Full product spec document (50 pages)" block (18,420 tokens) was included in the model context 5 times but only needed once. After the first use in step-3, the remaining 4 occurrences (step-4, step-5, step-6, step-7) passed the same content again, generating an estimated $0.18 in waste. This represents approximately 13% of the total run cost.

### Recommended Fix

Cache the content of "Full product spec document (50 pages)" after step-3. Pass a reference ID or cached summary into later steps (step-4, step-5, step-6, step-7) instead of the full block.

---

## Cost Caveat

The detected repeated-context waste shown above represents a specific, measured inefficiency in this trace. It does not represent total potential savings. A full cost comparison requires running a fixed version of the same task and comparing total costs. The repeated-context detector explains only the waste from re-passing the same large context block — not the full cost difference between two runs.

## Limitations

- This is a synthetic benchmark trace, not real customer data.
- Cost estimates depend on available token metadata and published model pricing.
- Actual provider pricing, discounts, and caching behavior may differ.
- RunLeak does not guarantee specific savings.

*Report generated at 2026-06-19T20:58:51.218Z*
*RunLeak Analyzer MVP v0.1.0*