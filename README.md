# Equity Manager Tracker

Tracks daily volatility, beta and shock-day behavior for eight large cap SMA managers (four growth and four value). The SMAs have no public daily data, so each one is tracked through its public mutual fund or ETF proxy.

**Live dashboard:** https://cadenypatel.github.io/External-Manager/

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

Prices are total-return adjusted, with distributions reinvested, and come from Yahoo Finance.

## How it updates

The GitHub Actions workflow [`.github/workflows/update-site.yml`](.github/workflows/update-site.yml) runs on weekday evenings at 8:30pm ET and again the next morning to catch late NAVs. It pulls fresh prices, rebuilds `site/data/data.json` and the Excel workbook, and deploys the site to GitHub Pages. To refresh by hand, open **Actions → Refresh data and deploy site → Run workflow**.

## Run it locally

```bash
pip install -r requirements.txt
python tracker/manager_vol_tracker.py
python -m http.server 8000 --directory site   # then open http://localhost:8000
```

On Windows you can also double-click `run_tracker.bat`, which refreshes the data and opens the Excel workbook.

## Changing the managers or shock days

Edit the `FUNDS` and `EVENTS` lists at the top of [`tracker/manager_vol_tracker.py`](tracker/manager_vol_tracker.py) and push. The site rebuilds automatically.

## Caveats

- Mutual funds price once a day, at the 4pm ET close, so intraday swings that reverse before the close are invisible.
- Public funds stand in for the SMAs. Actual accounts can differ because of cash, fees, client restrictions and tax-loss harvesting.
- GSGO's price history starts on Nov 17, 2025, when the fund converted from a mutual fund to an ETF.
- With only eight managers, correlations across them show direction only, not statistical proof.

For internal research and monitoring. Not investment advice.
