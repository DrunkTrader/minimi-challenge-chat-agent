# Eval results

Run: 2026-11-12T12:10:51.930Z · 9/9 passed · first token p50 3117ms / p95 9426ms · total p50 3829ms

| case | pass | first token | total | answered by | notes |
|---|---|---|---|---|---|
| smalltalk | ✓ | 1216ms | 1231ms | groq:openai/gpt-oss-20b |  |
| recall-exact-date | ✓ | 3117ms | 3497ms | gemini:gemini-3.5-flash |  |
| recall-empty-date | ✓ | 1825ms | 2031ms | gemini:gemini-3.5-flash |  |
| recheck-exact-date | ✓ | 2397ms | 3829ms | gemini:gemini-3.5-flash |  |
| recheck-crm-monday | ✓ | 4995ms | 7843ms | gemini:gemini-3.5-flash |  |
| recheck-postgres-tuesday | ✓ | 9426ms | 9927ms | gemini:gemini-flash-lite-latest |  |
| fresh-fact | ✓ | 4464ms | 4608ms | gemini:gemini-flash-lite-latest |  |
| follow-up | ✓ | 4473ms | 4735ms | gemini:gemini-flash-lite-latest |  |
| no-fake-memory | ✓ | 2416ms | 2573ms | gemini:gemini-flash-lite-latest |  |
