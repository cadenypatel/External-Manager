# Equity Manager Tracker

Tracks daily volatility, beta and shock-day behavior for eight large cap SMA managers (four growth and four value). The SMAs have no public daily data, so each one is tracked through its public mutual fund or ETF proxy.

## Two editions

| | Public site | Private dashboard |
|---|---|---|
| Address | https://cadenypatel.github.io/External-Manager/ | http://localhost:8765/External-Manager/ (this PC only) |
| Built by | GitHub Actions, weekday evenings and mornings | `run_tracker.bat` on your PC |
| Data | Yahoo Finance only | Yahoo, plus Eikon holdings, trades and ETF NAVs |

**Eikon on the public site:** the Holdings & trades section has an **Enter Eikon API** box. With Eikon open and `start_eikon_helper.bat` running, enter your app key and click **Load holdings**. The page asks the helper on *your own PC* (localhost) for the data and shows it in your browser only. The key and the Eikon data never go to GitHub or to anyone else's browser. "Remember on this computer" keeps the key in this browser's local storage only. Other visitors see an empty box that does nothing without their own Eikon and helper.

Your Eikon key (`config/lseg.local.json`) and Eikon data (`private_data/`) are git-ignored and are never committed.

## Managers and proxies

| SMA strategy | Proxy | Peer group | Stated benchmark |
|---|---|---|---|
| JPMorgan Large Cap Growth | JLGMX (R6) | Growth | Russell 1000 Growth |
| Goldman Sachs Strategic Large Growth | GSGO (ETF, successor to the GS Strategic Growth Fund) | Growth | Russell 1000 Growth |
| Alger Focus Equity | ALZFX (Z) | Growth | Russell 1000 Growth |
| Cantor Fitzgerald LC Focused | FICIX (R6) | Growth | Russell 1000 Growth |
| Putnam US LCV Equity Concentrated | PVAL (ETF) | Value | Russell 1000 Value |
| MFS Large Cap Value | MEIKX (R6) | Value | Russell 1000 Value |
| Oakmark Large Cap Value | OANMX (Institutional) | Value | S&P 500 (Russell 1000 Value secondary) |
| BNYM Newton Dynamic Value | DRGYX (Y) | Value | Russell 1000 Value |

## Benchmarking

- Peer groups never mix: growth managers are ranked only against growth peers, and value managers only against value peers.
- Each manager is shown against its **stated benchmark** (the table above), the **S&P 500**, and its **style index** (Russell 1000 Growth or Russell 1000 Value).
- Benchmarks are the actual total-return indexes (S&P 500 TR, Russell 1000 Growth TR, Russell 1000 Value TR), not ETFs.
- All returns are end-of-day: NAV for mutual funds and the 4pm closing price for the two ETFs. No intraday data is used.

## What it measures

- **Shock-day analysis:** each manager's return on a shock day against its benchmark and the S&P 500, the move measured in its own sigmas, and its volatility, beta and downside capture *before* the event. It also splits the return into what beta predicted and what it didn't, and shows the path from 5 days before to 10 days after.
- **Shock days:** the dates listed in `EVENTS`, plus any day in the last year when the S&P 500 moved at least 3σ against its prior 60-day volatility. These are added automatically.
- **Current risk:** 20-day, 60-day and 1-year volatility, beta, correlation, tracking error, up and down capture, maximum drawdown and returns.
- **Time series:** 20-day rolling volatility and cumulative total return, with shock days marked.
- **Holdings & trades (Eikon):** Lipper holdings for each fund, saved as dated snapshots; positions added, trimmed, opened or sold out between reports, net of fund-wide flows.

Prices are total-return adjusted and come from Yahoo Finance. When Eikon is connected, the two ETFs (GSGO, PVAL) switch to official daily NAVs, with distributions added back.

## Setup (one time)

1. **Install:** `pip install -r requirements.txt`
2. **Get an Eikon app key:** open Eikon, type `APPKEY` in the search bar, and open the **App Key Generator**. Register a new app (any name, e.g. "Equity Manager Tracker"), tick **Eikon Data API**, and copy the key.
3. **Paste the key** into `config/lseg.local.json` in place of `PASTE-YOUR-EIKON-APP-KEY-HERE`. Copy `config/lseg.example.json` to that name if it doesn't exist. Git ignores this file, so the key is never pushed.
4. **Check the connection:** with Eikon open and logged in, double-click `check_eikon.bat`. It finds each fund in Eikon, tests which holdings and NAV fields your subscription returns, and saves the working ones. A full report goes to `private_data/lseg_check_report.txt`.

## Daily use

With Eikon open, double-click **`run_tracker.bat`**. It pulls Yahoo prices and Eikon holdings and NAVs, rebuilds the data and the Excel workbook, and opens the dashboard at http://localhost:8765/External-Manager/. Close the server window when you're done. To look again without refreshing, use `open_dashboard.bat`.

- Run it in the evening (after NAVs post, about 8pm ET) or the next morning.
- If Eikon isn't open, everything except holdings still updates.
- Holdings snapshots build up in `private_data/holdings/<ticker>/<date>.csv`. Trades appear once a fund has two reports.
- To run it automatically, use Windows Task Scheduler to run `run_tracker.bat` on weekday evenings while Eikon is logged in.

## Changing the managers or shock days

Edit the `FUNDS` and `EVENTS` lists at the top of [`tracker/manager_vol_tracker.py`](tracker/manager_vol_tracker.py), then run `run_tracker.bat`. If Eikon can't find a fund, add its Lipper ID under `"ids"` in `config/lseg.local.json`, e.g. `"ids": {"GSGO": {"lipper": "40012345"}}`.

## Caveats

- Mutual funds price once a day, at the 4pm ET close, so intraday swings that reverse before the close are invisible.
- Public funds stand in for the SMAs. Actual accounts can differ because of cash, fees, client restrictions and tax-loss harvesting.
- GSGO's price history starts on Nov 17, 2025, when the fund converted from a mutual fund to an ETF.
- With only eight managers, correlations across them show direction only, not statistical proof.
- Eikon/Lipper data is licensed: keep it on this PC and don't publish the dashboard or the Excel workbook outside your firm.
- Fund holdings are the public fund's positions, not your SMA account's. SMA trades differ in timing, size and client-specific restrictions.

For internal research and monitoring. Not investment advice.

## Daily email report

`.github/workflows/daily-email.yml` runs every weekday (Monday to Friday) at 5:00 AM Central Time; Monday's report covers Friday's close, with backup slots in case GitHub drops a scheduled run (only one report is sent per day). It works the same way as RWAPI: it opens a GitHub issue labeled `daily-report` that @mentions you, and GitHub emails it to your account's notification address. No email passwords are involved. The issue covers a market snapshot, notable S&P 500 days, the growth and value peer tables and the latest shock day, plus the website's eight charts (volatility, performance, shock-day scatters and paths), using Yahoo data only (never Eikon). The chart images are stored by date on the `report-assets` branch. It's built from completed sessions only.

- **To get it in a second inbox,** add a forwarding rule in the receiving mailbox, for example Gmail → Settings → Forwarding to your Outlook address.
- **To test it now,** go to **Actions → Daily email report → Run workflow**.
- **To preview it locally,** run `python tracker/daily_report.py --issue-md report.md`.
- **Visibility:** the repo is public, so the report issues are public too. They contain only the same public data the website shows.
