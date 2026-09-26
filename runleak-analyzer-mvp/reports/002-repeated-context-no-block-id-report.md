# RunLeak Report — Repeated Context Leak

**Synthetic benchmark trace. Not customer data.**

---

## Run Summary

| Metric | Value |
|---|---|
| Case | 002-repeated-context-no-block-id |
| Task | Document Q&A agent — answer 3 policy questions — prompt blocks have no block_id |
| Model calls | 4 |
| Tool calls | 1 |
| Retries | 0 |
| Input tokens | 58,200 |
| Output tokens | 5,200 |
| Estimated total cost | $0.18 |

---

## Finding

### repeated context (medium)

**Detection method:** `text_similarity`

**Confidence:** high

### Evidence

Detection method: text_similarity. The "Full employee handbook content" block (18,520 tokens) appears across 3 model calls. Block ID was not available or unreliable. Detection relied on normalized text similarity (score: 100%). Block was reused 2 times after first occurrence (step-1).

### Evidence Table

| Property | Value |
|---|---|
| Block ID | `text_match_group` |
| Block estimated tokens | 18,520 |
| Total occurrences | 3 |
| Repeated occurrences (waste) | 2 |
| First occurrence (excluded) | step-1 |
| Wasted occurrence steps | step-2, step-3 |
| Similarity | 100% |
| Estimated waste | $0.09 |

### Cost Math

**Pricing:** gpt-4o at $2.5/M input tokens, $10/M output tokens

- Block size: 18,520 tokens
- Repeated after first occurrence: 2 times
- Waste tokens: 37,040 (18,520 × 2)
- Math: (37,040 / 1,000,000) × $2.5 = $0.09
- First occurrence (step-1) excluded: waste counts only 2 repetitions after first
- Output tokens not counted: waste is on excess input tokens

*Cost calculations use published model pricing. Estimates depend on available trace metadata.*

### Explanation

The "Full employee handbook content" block (18,520 tokens) was included in the model context 3 times but only needed once. After the first use in step-1, the remaining 2 occurrences (step-2, step-3) passed the same content again, generating an estimated $0.09 in waste. This represents approximately 11% of the total run cost.

### Recommended Fix

Cache the content of "Full employee handbook content" after step-1. Pass a reference ID or cached summary into later steps (step-2, step-3) instead of the full block.

---

## Limitations

- This is a synthetic benchmark trace, not real customer data.
- Cost estimates depend on available token metadata and published model pricing.
- Actual provider pricing, discounts, and caching behavior may differ.
- RunLeak does not guarantee specific savings.

*Report generated at 2026-06-19T06:14:43.746Z*
*RunLeak Analyzer MVP v0.1.0*