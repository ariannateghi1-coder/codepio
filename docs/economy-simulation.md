# Economy simulation

`simulateEconomy()` in `src/lib/services/economy-simulation.ts` projects credit sources, the campaign-budget sink, and net issuance without touching the database.

Baseline (`10,000 users × 20 supports/day`, current 10 supporter + 3 creator credits, no bonuses):

- supports: `200,000/day`
- supporter source: `2,000,000`
- creator source: `600,000`
- campaign budget spend: `2,000,000`
- net issuance: `+600,000 credits/day` (`+3/support`)

Mutual, optional-task, referral, streak, and badge rewards are explicit parameters. Campaign funding is counted once as the sink; `Campaign.spentCredits` only consumes an already-funded budget and must not be subtracted again.

Use the simulation before reward changes. A sustainable target can be tested by raising `budgetSpendPerSupport`, reducing platform-funded sources, or adding an explicit non-circular sink. The function is deterministic and covered by unit tests.
