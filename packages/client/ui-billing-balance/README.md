# @deepseek-ai/dsh-client-ui-billing-balance

Shows the account's remaining provider balance, or this month's spend, in the bottom-left corner of the Harness shell.
The chip occupies the root-level `shell.bottom` seat, which both the conversation layout and the IDE/工作站 layout keep laid out, so the number stays visible while the side columns are hidden.

## What it does

| State | Rendered line |
| --- | --- |
| A provider reports `totalBalance` | `余额 ¥12.34` |
| Only the billing service's month cost is known | `本月 ¥1.86` |
| No usable amount yet, or every request so far failed | nothing; the row keeps zero height |

The chip keeps its last successful sample when a request fails, polls every 60 seconds, and pauses while the page is hidden.

## Data sources

- `billingMetrics` — the optional Cordis service of the usage-billing plugin, when that plugin is installed. The chip reads `monthCost` through `readCosts`/`subscribeCosts` and makes the chip clickable through `openDashboard`.
- `GET /api/billing/usage-stats` — the same-origin fallback that returns one row per provider (`provider`, `displayName`, `currency`, `totalBalance`, `error`). A row that carries `error` is skipped.

## Not here

- No host half: this package contributes no route, tool, or prompt section.
- No dashboard of its own: a click delegates to the installed billing plugin.
- No currency conversion: the first provider with a usable balance wins, as reported.

## Known Limitations and Deferred Work

- **Balance wins over spend** — once a provider reports `totalBalance`, the month cost is no longer shown; per-provider detail stays in the billing plugin's sidebar.
- **60-second freshness** — the chip polls on its own cadence instead of sharing the billing plugin's 30-second timer, because that plugin's service may be absent.
- **Provider order decides the balance** — with several providers the first usable row wins; aggregating them waits for the billing host to define one.
