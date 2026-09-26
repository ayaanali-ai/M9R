RunLeak Cost Comparison

| Metric | Bad Run | Fixed Run | Change |
|---|---|---|---|
| Estimated cost | $1.42 | $0.74 | -$0.68 |
| Input tokens | 92,300 | 41,800 | -50,500 |
| Output tokens | 8,100 | 6,900 | -1,200 |
| Model calls | 17 | 11 | -6 |
| Tool calls | 6 | 4 | -2 |
| Retries | 1 | 0 | -1 |
| Waste % | — | — | 48% |

### Leak Findings in Bad Trace
- repeated_context (high): $0.18 waste
  - Detection: block_id_and_similarity | 18,420 tokens × 5 occurrences | 4 wasted

### Cost Attribution

| Component | Amount |
|---|---|
| Bad run cost | $1.42 |
| Fixed run cost | $0.74 |
| Total cost delta | $0.68 |
| Detected repeated-context waste | $0.18 |
| Unattributed delta | $0.50 |

RunLeak's repeated-context detector explains $0.18 of the cost difference in this synthetic trace. The remaining $0.50 comes from broader changes in the fixed run, including fewer model calls, fewer tool calls, and lower total input tokens. This report does not claim the repeated-context finding alone caused the full $0.68 reduction.

---
*Synthetic benchmark trace. Not customer data.*