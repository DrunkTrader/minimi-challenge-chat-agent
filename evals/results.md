# Eval results

Run: 2026-11-12T13:12:35.899Z · 11/11 passed · first token p50 3112ms / p95 5366ms · total p50 3335ms

| case | pass | first token | total | answered by | notes |
|---|---|---|---|---|---|
| smalltalk | ✓ | 873ms | 890ms | groq:openai/gpt-oss-20b |  |
| recall-exact-date | ✓ | 3112ms | 3335ms | gemini:gemini-flash-lite-latest |  |
| recall-empty-date | ✓ | 3422ms | 3647ms | gemini:gemini-flash-lite-latest |  |
| recheck-exact-date | ✓ | 3975ms | 5226ms | gemini:gemini-flash-lite-latest |  |
| recheck-crm-monday | ✓ | 4185ms | 5820ms | gemini:gemini-flash-lite-latest |  |
| recheck-postgres-tuesday | ✓ | 3324ms | 3770ms | gemini:gemini-flash-lite-latest |  |
| fresh-fact | ✓ | 2946ms | 3064ms | gemini:gemini-flash-lite-latest |  |
| follow-up | ✓ | 2407ms | 2521ms | gemini:gemini-flash-lite-latest |  |
| recall-by-topic | ✓ | 2373ms | 2526ms | gemini:gemini-flash-lite-latest |  |
| states-date-used | ✓ | 2640ms | 2845ms | gemini:gemini-flash-lite-latest |  |
| no-fake-memory | ✓ | 5366ms | 5484ms | gemini:gemini-flash-lite-latest |  |
