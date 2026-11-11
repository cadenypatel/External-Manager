"""
Equity Manager Tracker
----------------------
Pulls daily total-return (distribution-adjusted) prices for public mutual fund /
ETF proxies of large cap SMA strategies, then measures volatility, beta and
downside behaviour, plus how each manager held up on market shock days.

Outputs
  site/data/data.json          data feed for the website
  site/Manager_Vol_Tracker.xlsx Excel workbook (also linked from the website)

Usage
  python tracker/manager_vol_tracker.py                     # default run
  python tracker/manager_vol_tracker.py --event 2026-11-05  # pick the shock day the Excel sheet focuses on

Shock days: every date listed in EVENTS below, plus any day in the last year
where the S&P 500 moved at least AUTO_EVENT_SIGMA standard deviations
(versus its prior 60-day volatility), is analysed automatically.

Data source: Yahoo Finance via yfinance. Mutual fund NAVs post after the close,
typically 6-8pm ET.
"""

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf
from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference, ScatterChart, Series
from openpyxl.chart.marker import Marker
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent

# ----------------------------------------------------------------------------
# CONFIGURATION - edit here
# ----------------------------------------------------------------------------
# (SMA strategy name, proxy ticker, style, proxy description)
FUNDS = [
    ("JPMorgan Large Cap Growth",            "JLGMX", "Growth", "JPMorgan Large Cap Growth Fund R6"),
    ("Goldman Sachs Strategic Large Growth", "GSGO",  "Growth", "GS Growth Opportunities ETF (successor to GS Strategic Growth Fund, converted Nov 2025)"),
    ("Alger Focus Equity",                   "ALZFX", "Growth", "Alger Focus Equity Fund Z"),
    ("Cantor Fitzgerald LC Focused",         "FICIX", "Growth", "Cantor Fitzgerald Large Cap Focused Fund R6"),
    ("Putnam US LCV Equity Concentrated",    "PVAL",  "Value",  "Putnam Focused Large Cap Value ETF"),
    ("MFS Large Cap Value",                  "MEIKX", "Value",  "MFS Value Fund R6"),
    ("Oakmark Large Cap Value",              "OANMX", "Value",  "Oakmark Fund Institutional"),
    ("BNYM Newton Dynamic Value",            "DRGYX", "Value",  "BNY Mellon Dynamic Value Fund Y"),
]
BENCHMARKS = {"Growth": "IWF", "Value": "IWD", "Market": "SPY"}
BENCH_NAMES = {"IWF": "Russell 1000 Growth (IWF)", "IWD": "Russell 1000 Value (IWD)", "SPY": "S&P 500 (SPY)"}

# Shock days to always analyse: (date, label)
EVENTS = [
    ("2026-11-05", "Nov 5, 2026 sell-off"),
]
AUTO_EVENT_SIGMA = 3.0      # also auto-flag S&P 500 days beyond this many sigmas (last year)
HISTORY_YEARS = 3
TRADING_DAYS = 252
WINDOW_BEFORE, WINDOW_AFTER = 5, 10   # event path chart: trading days around the event

# ----------------------------------------------------------------------------
# DATA
# ----------------------------------------------------------------------------

def fund_tickers():
    return [t for _, t, _, _ in FUNDS]


def all_tickers():
    return fund_tickers() + ["IWF", "IWD", "SPY"]


def fetch_prices(tickers, years):
    start = (dt.date.today() - dt.timedelta(days=int(365.25 * years) + 10)).isoformat()
    px = yf.download(tickers, start=start, auto_adjust=True, progress=False)["Close"]
    if isinstance(px, pd.Series):
        px = px.to_frame()
    px.index = pd.to_datetime(px.index).tz_localize(None).normalize()
    missing = [t for t in tickers if t not in px.columns or px[t].dropna().empty]
    if missing:
        print(f"WARNING: no data returned for {missing}", file=sys.stderr)
    if "SPY" not in px.columns or px["SPY"].dropna().empty:
        raise SystemExit("No S&P 500 (SPY) data returned - aborting so the last good data is kept.")
    px = px[px["SPY"].notna()]                         # market days only
    return px[[t for t in tickers if t in px.columns]]


# ----------------------------------------------------------------------------
# METRICS
# ----------------------------------------------------------------------------

def ann_vol(r):
    r = r.dropna()
    return r.std() * np.sqrt(TRADING_DAYS) if len(r) > 5 else np.nan


def _pair(r, b, n=20):
    d = pd.concat([r, b], axis=1).dropna()
    return d if len(d) >= n else None


def beta(r, b):
    d = _pair(r, b)
    return np.nan if d is None else d.iloc[:, 0].cov(d.iloc[:, 1]) / d.iloc[:, 1].var()


def correlation(r, b):
    d = _pair(r, b)
    return np.nan if d is None else d.iloc[:, 0].corr(d.iloc[:, 1])


def tracking_error(r, b):
    d = _pair(r, b)
    return np.nan if d is None else (d.iloc[:, 0] - d.iloc[:, 1]).std() * np.sqrt(TRADING_DAYS)


def capture(r, b, side):
    """Compounded fund return / compounded benchmark return on the benchmark's up or down days."""
    d = _pair(r, b, 1)
    if d is None:
        return np.nan
    d = d[d.iloc[:, 1] < 0] if side == "down" else d[d.iloc[:, 1] > 0]
    if len(d) < 10:
        return np.nan
    f, m = (1 + d.iloc[:, 0]).prod() - 1, (1 + d.iloc[:, 1]).prod() - 1
    return f / m if m else np.nan


def max_drawdown(r):
    r = r.dropna()
    if r.empty:
        return np.nan
    w = (1 + r).cumprod()
    return (w / w.cummax() - 1).min()


def period_return(s, start_date):
    s = s.dropna()
    base = s[s.index <= start_date]
    return np.nan if base.empty or s.empty else s.iloc[-1] / base.iloc[-1] - 1


def spy_sigma_series(rets):
    sd = rets["SPY"].rolling(60, min_periods=40).std().shift(1)
    return rets["SPY"] / sd


def find_events(rets):
    """Configured events plus auto-detected S&P 500 shock days in the last year."""
    out = {}
    for d, label in EVENTS:
        ts = pd.Timestamp(d)
        if ts in rets.index:
            out[ts] = {"label": label, "auto": False}
        else:
            print(f"WARNING: configured event {d} is not a trading day in the data - skipped", file=sys.stderr)
    sig = spy_sigma_series(rets).iloc[-TRADING_DAYS:]
    for ts, s in sig[sig.abs() >= AUTO_EVENT_SIGMA].items():
        if ts not in out:
            r = rets.at[ts, "SPY"]
            out[ts] = {"label": f"{ts:%b %d, %Y} S&P 500 {'drop' if r < 0 else 'rally'} ({s:+.1f} sigma)", "auto": True}
    return dict(sorted(out.items()))


def event_analysis(rets, px, event):
    pre = rets[rets.index < event]
    spy_ev = rets.at[event, "SPY"]
    rows = []
    for name, tkr, style, _ in FUNDS:
        if tkr not in rets.columns:
            continue
        bt = BENCHMARKS[style]
        r_pre = pre[tkr].dropna()
        ev, bench_ev = rets.at[event, tkr], rets.at[event, bt]
        sd60 = r_pre.iloc[-60:].std()
        r1y = r_pre.iloc[-TRADING_DAYS:]
        b_spy = beta(r1y, pre["SPY"])
        rows.append({
            "manager": name, "ticker": tkr, "style": style, "benchmark": bt,
            "event_ret": ev,
            "bench_ret": bench_ev,
            "excess_bmk": ev - bench_ev,
            "excess_spy": ev - spy_ev,
            "sigma_own": ev / sd60 if sd60 else np.nan,
            "vol20_pre": ann_vol(r_pre.iloc[-20:]),
            "vol60_pre": ann_vol(r_pre.iloc[-60:]),
            "vol1y_pre": ann_vol(r1y),
            "beta_spy_pre": b_spy,
            "beta_bmk_pre": beta(r1y, pre[bt]),
            "down_cap_pre": capture(r1y, pre[bt], "down"),
            "pred_ret": b_spy * spy_ev,
            "alpha_day": ev - b_spy * spy_ev,
            "since_event": period_return(px[tkr], event),
        })
    df = pd.DataFrame(rows)
    spy_pre = pre["SPY"].dropna()
    market = {
        "spy_ret": spy_ev,
        "spy_sigma60": spy_ev / spy_pre.iloc[-60:].std(),
        "spy_sigma1y": spy_ev / spy_pre.iloc[-TRADING_DAYS:].std(),
        "iwf_ret": rets.at[event, "IWF"],
        "iwd_ret": rets.at[event, "IWD"],
    }
    groups = []
    for style in ("Growth", "Value"):
        g = df[df["style"] == style]
        groups.append({"style": style, **{k: g[k].mean() for k in
                       ["event_ret", "excess_bmk", "vol60_pre", "beta_spy_pre", "down_cap_pre", "alpha_day", "since_event"]}})
    corr_tests = [
        ("Pre-event 60d volatility vs event-day return", "vol60_pre", "event_ret"),
        ("Pre-event beta vs event-day return", "beta_spy_pre", "event_ret"),
        ("Pre-event downside capture vs excess vs benchmark", "down_cap_pre", "excess_bmk"),
    ]
    corrs = [{"label": l, "x": x, "y": y, "value": df[x].corr(df[y])} for l, x, y in corr_tests]
    return df, market, groups, corrs


def event_window(px, event):
    """Cumulative total return from the close BEFORE the event, t-WINDOW_BEFORE..t+WINDOW_AFTER."""
    idx = px.index
    i = idx.get_loc(event)
    lo, hi = max(i - WINDOW_BEFORE, 1), min(i + WINDOW_AFTER, len(idx) - 1)
    base_px = px.iloc[i - 1]
    win = px.iloc[lo:hi + 1]
    cum = win / base_px - 1
    return {
        "dates": [d.strftime("%Y-%m-%d") for d in win.index],
        "offsets": list(range(lo - i, hi - i + 1)),
        "series": {t: cum[t].tolist() for t in px.columns},
    }


def current_risk(rets, px):
    last = rets.index[-1]
    ytd_start = pd.Timestamp(year=last.year, month=1, day=1) - pd.Timedelta(days=1)
    rows = []
    entries = [(n, t, s, BENCHMARKS[s]) for n, t, s, _ in FUNDS if t in rets.columns]
    entries += [(BENCH_NAMES[b], b, "Benchmark", None) for b in ("IWF", "IWD", "SPY")]
    for name, tkr, style, bt in entries:
        r = rets[tkr].dropna()
        r1y = r.iloc[-TRADING_DAYS:]
        ld = r.index[-1]
        rows.append({
            "manager": name, "ticker": tkr, "style": style, "benchmark": bt or "",
            "last_date": ld.strftime("%Y-%m-%d"),
            "ret_1d": r.iloc[-1],
            "ret_1m": period_return(px[tkr], ld - pd.DateOffset(months=1)),
            "ret_3m": period_return(px[tkr], ld - pd.DateOffset(months=3)),
            "ret_ytd": period_return(px[tkr], ytd_start),
            "ret_1y": period_return(px[tkr], ld - pd.DateOffset(years=1)),
            "vol20": ann_vol(r.iloc[-20:]),
            "vol60": ann_vol(r.iloc[-60:]),
            "vol1y": ann_vol(r1y),
            "beta_spy": beta(r1y, rets["SPY"]),
            "beta_bmk": beta(r1y, rets[bt]) if bt else np.nan,
            "corr_bmk": correlation(r1y, rets[bt]) if bt else np.nan,
            "te_bmk": tracking_error(r1y, rets[bt]) if bt else np.nan,
            "up_cap": capture(r1y, rets[bt], "up") if bt else np.nan,
            "down_cap": capture(r1y, rets[bt], "down") if bt else np.nan,
            "max_dd_1y": max_drawdown(r1y),
            "obs_1y": int(len(r1y)),
        })
    return pd.DataFrame(rows)


# ----------------------------------------------------------------------------
# JSON
# ----------------------------------------------------------------------------

def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else round(f, 6)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (pd.Timestamp, dt.date)):
        return o.strftime("%Y-%m-%d")
    return o


def build_json(px, rets, events, cur_df):
    roll = rets.rolling(20, min_periods=15).std() * np.sqrt(TRADING_DAYS)
    ev_out = []
    for ts, meta in events.items():
        df, market, groups, corrs = event_analysis(rets, px, ts)
        ev_out.append({
            "date": ts.strftime("%Y-%m-%d"), "label": meta["label"], "auto": meta["auto"],
            "market": market, "rows": df.to_dict("records"), "groups": groups,
            "correlations": corrs, "window": event_window(px, ts),
        })
    return _clean({
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "as_of": rets.index[-1].strftime("%Y-%m-%d"),
        "config": {"auto_event_sigma": AUTO_EVENT_SIGMA, "trading_days": TRADING_DAYS,
                   "window_before": WINDOW_BEFORE, "window_after": WINDOW_AFTER},
        "funds": [{"manager": n, "ticker": t, "style": s, "description": d,
                   "benchmark": BENCHMARKS[s], "benchmark_name": BENCH_NAMES[BENCHMARKS[s]]} for n, t, s, d in FUNDS],
        "benchmarks": BENCH_NAMES,
        "current": cur_df.to_dict("records"),
        "events": ev_out,
        "series": {
            "dates": [d.strftime("%Y-%m-%d") for d in px.index],
            "price": {t: px[t].tolist() for t in px.columns},
            "vol20": {t: roll[t].tolist() for t in px.columns},
        },
    })


# ----------------------------------------------------------------------------
# EXCEL
# ----------------------------------------------------------------------------
LABELS = {
    "manager": "Manager", "ticker": "Proxy", "style": "Style", "benchmark": "Benchmark",
    "event_ret": "Event-day return", "bench_ret": "Benchmark return", "excess_bmk": "Excess vs benchmark",
    "excess_spy": "Excess vs S&P 500", "sigma_own": "Move in own sigmas", "vol20_pre": "Pre-event vol 20d (ann.)",
    "vol60_pre": "Pre-event vol 60d (ann.)", "vol1y_pre": "Pre-event vol 1y (ann.)",
    "beta_spy_pre": "Pre-event beta vs S&P 500 (1y)", "beta_bmk_pre": "Pre-event beta vs style bmk (1y)",
    "down_cap_pre": "Pre-event downside capture vs bmk (1y)", "pred_ret": "Beta-predicted return",
    "alpha_day": "Unexplained by beta (alpha on day)", "since_event": "Return since event close",
    "last_date": "Last NAV date", "ret_1d": "1-day return", "ret_1m": "1-month return", "ret_3m": "3-month return",
    "ret_ytd": "YTD return", "ret_1y": "1-year return", "vol20": "Vol 20d (ann.)", "vol60": "Vol 60d (ann.)",
    "vol1y": "Vol 1y (ann.)", "beta_spy": "Beta vs S&P 500 (1y)", "beta_bmk": "Beta vs style bmk (1y)",
    "corr_bmk": "Correlation vs bmk (1y)", "te_bmk": "Tracking error vs bmk (1y)", "up_cap": "Upside capture (1y)",
    "down_cap": "Downside capture (1y)", "max_dd_1y": "Max drawdown (1y)", "obs_1y": "Obs. in 1y window",
}
RATIO_KEYS = {"sigma_own", "beta_spy_pre", "beta_bmk_pre", "down_cap_pre", "beta_spy", "beta_bmk",
              "corr_bmk", "up_cap", "down_cap"}
TEXT_KEYS = {"manager", "ticker", "style", "benchmark", "last_date", "obs_1y"}
HDR_FILL, HDR_FONT = PatternFill("solid", fgColor="1F3864"), Font(color="FFFFFF", bold=True)
FILLS = {"Growth": PatternFill("solid", fgColor="E2EFDA"), "Value": PatternFill("solid", fgColor="DDEBF7"),
         "Benchmark": PatternFill("solid", fgColor="F2F2F2")}


def write_table(ws, df, r0):
    cols = list(df.columns)
    for j, k in enumerate(cols, start=1):
        c = ws.cell(row=r0, column=j, value=LABELS.get(k, k))
        c.fill, c.font = HDR_FILL, HDR_FONT
        c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
        ws.column_dimensions[get_column_letter(j)].width = 34 if k == "manager" else 14
    ws.row_dimensions[r0].height = 45
    for i, row in enumerate(df.to_dict("records"), start=1):
        fill = FILLS.get(row.get("style"))
        for j, k in enumerate(cols, start=1):
            v = row[k]
            if isinstance(v, float) and math.isnan(v):
                v = None
            c = ws.cell(row=r0 + i, column=j, value=v)
            if k not in TEXT_KEYS and isinstance(v, (int, float)):
                c.number_format = "0.00" if k in RATIO_KEYS else "0.00%"
            if fill:
                c.fill = fill
    return r0 + len(df)


def add_scatter(ws, anchor, title, x_title, df, x_key, data_row0, data_col0):
    ws.cell(row=data_row0, column=data_col0, value="Chart data: " + title).font = Font(italic=True, color="808080")
    for i, row in enumerate(df.to_dict("records"), start=1):
        ws.cell(row=data_row0 + i, column=data_col0, value=row["ticker"])
        ws.cell(row=data_row0 + i, column=data_col0 + 1, value=float(row[x_key]))
        ws.cell(row=data_row0 + i, column=data_col0 + 2, value=float(row["event_ret"])).number_format = "0.00%"
    ch = ScatterChart()
    ch.title, ch.style, ch.height, ch.width = title, 13, 9, 16
    ch.x_axis.title, ch.y_axis.title = x_title, "Event-day return"
    ch.x_axis.delete = ch.y_axis.delete = False
    ch.x_axis.crosses, ch.x_axis.tickLblPos, ch.x_axis.majorGridlines = "min", "low", None
    ch.x_axis.number_format = "0%" if "vol" in x_key else "0.0"
    ch.y_axis.number_format = "0.0%"
    ch.legend.position, ch.legend.overlay = "r", False
    for i, row in enumerate(df.to_dict("records"), start=1):
        r = data_row0 + i
        s = Series(Reference(ws, min_col=data_col0 + 2, min_row=r), Reference(ws, min_col=data_col0 + 1, min_row=r),
                   title=f"{row['ticker']} ({row['style'][0]})")
        color = "2A78D6" if row["style"] == "Growth" else "EB6834"
        s.marker = Marker(symbol="circle" if row["style"] == "Growth" else "diamond", size=10)
        s.marker.graphicalProperties.solidFill = color
        s.marker.graphicalProperties.line.solidFill = color
        s.graphicalProperties.line.noFill = True
        ch.series.append(s)
    ws.add_chart(ch, anchor)


def build_workbook(path, px, rets, event, label, cur_df):
    df, market, groups, corrs = event_analysis(rets, px, event)
    wb = Workbook()
    ws = wb.active
    ws.title = "Event Analysis"
    ws["A1"] = f"Shock-day analysis: {label} ({event:%A %d %b %Y})"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = "Pre-event metrics use only data BEFORE the event date. Green = growth, blue = value."
    ws["A2"].font = Font(italic=True, color="595959")
    mk = [("S&P 500 event-day return", market["spy_ret"], "0.00%"),
          ("S&P 500 move in sigmas (vs prior 60d)", market["spy_sigma60"], "0.00"),
          ("S&P 500 move in sigmas (vs prior 1y)", market["spy_sigma1y"], "0.00"),
          ("Russell 1000 Growth event-day return", market["iwf_ret"], "0.00%"),
          ("Russell 1000 Value event-day return", market["iwd_ret"], "0.00%")]
    for i, (k, v, f) in enumerate(mk, start=4):
        ws.cell(row=i, column=1, value=k).font = Font(bold=True)
        ws.cell(row=i, column=2, value=float(v)).number_format = f
    r = write_table(ws, df, 10) + 2
    ws.cell(row=r, column=1, value="Growth vs Value averages").font = Font(bold=True, size=12)
    gdf = pd.DataFrame(groups).rename(columns={"style": "manager"})
    r = write_table(ws, gdf, r + 1) + 2
    ws.cell(row=r, column=1, value="Correlation across the managers (directional - small sample)").font = Font(bold=True, size=12)
    for i, c in enumerate(corrs, start=1):
        ws.cell(row=r + i, column=1, value=c["label"])
        ws.cell(row=r + i, column=2, value=float(c["value"])).number_format = "0.00"
    chart_row = r + len(corrs) + 3
    data_col = len(df.columns) + 3
    add_scatter(ws, f"A{chart_row}", "Pre-event volatility vs event-day return", "Pre-event 60d vol (ann.)", df, "vol60_pre", 4, data_col)
    add_scatter(ws, f"J{chart_row}", "Pre-event beta vs event-day return", "Beta vs S&P 500 (1y)", df, "beta_spy_pre", 16, data_col)
    ws.freeze_panes = "C1"

    ws2 = wb.create_sheet("Current Risk")
    ws2["A1"] = f"Risk snapshot as of {rets.index[-1].date()} (ETFs/benchmarks may show a newer date than mutual fund NAVs)"
    ws2["A1"].font = Font(bold=True, size=13)
    write_table(ws2, cur_df, 3)
    ws2.freeze_panes = "C4"

    order = [t for t in all_tickers() if t in rets.columns]
    roll = (rets[order].rolling(20, min_periods=15).std() * np.sqrt(TRADING_DAYS)).iloc[-TRADING_DAYS:]
    ws3 = wb.create_sheet("Rolling Vol 20d")
    for j, t in enumerate(["Date"] + order, start=1):
        c = ws3.cell(row=1, column=j, value=t)
        c.fill, c.font = HDR_FILL, HDR_FONT
    for i, (d, row) in enumerate(roll.iterrows(), start=2):
        ws3.cell(row=i, column=1, value=d.date()).number_format = "yyyy-mm-dd"
        for j, t in enumerate(order, start=2):
            if pd.notna(row[t]):
                ws3.cell(row=i, column=j, value=float(row[t])).number_format = "0.0%"
    n = len(roll) + 1
    for title, style, bt, anchor in [("Growth managers - 20d rolling vol vs IWF", "Growth", "IWF", "N2"),
                                     ("Value managers - 20d rolling vol vs IWD", "Value", "IWD", "N22")]:
        lc = LineChart()
        lc.title, lc.height, lc.width = title, 9, 20
        lc.y_axis.number_format, lc.x_axis.number_format = "0%", "mmm-yy"
        lc.x_axis.delete = lc.y_axis.delete = False
        lc.legend.position, lc.legend.overlay = "b", False
        for t in [t for _, t, s, _ in FUNDS if s == style and t in order] + [bt]:
            lc.add_data(Reference(ws3, min_col=order.index(t) + 2, min_row=1, max_row=n), titles_from_data=True)
        lc.set_categories(Reference(ws3, min_col=1, min_row=2, max_row=n))
        for s in lc.series:
            s.smooth = False
            s.graphicalProperties.line.width = 15000
        lc.series[-1].graphicalProperties.line.dashStyle = "dash"
        lc.series[-1].graphicalProperties.line.solidFill = "000000"
        ws3.add_chart(lc, anchor)

    for name, frame, fmt in [("Daily Returns", rets[order].iloc[1:], "0.00%"), ("Prices (TR adj.)", px[order], "0.0000")]:
        w = wb.create_sheet(name)
        for j, t in enumerate(["Date"] + order, start=1):
            c = w.cell(row=1, column=j, value=t)
            c.fill, c.font = HDR_FILL, HDR_FONT
        for i, (d, row) in enumerate(frame.sort_index(ascending=False).iterrows(), start=2):
            w.cell(row=i, column=1, value=d.date()).number_format = "yyyy-mm-dd"
            for j, t in enumerate(order, start=2):
                if pd.notna(row[t]):
                    w.cell(row=i, column=j, value=float(row[t])).number_format = fmt
        w.column_dimensions["A"].width = 12
        w.freeze_panes = "B2"

    wn = wb.create_sheet("Notes & Mapping")
    wn["A1"] = "SMA strategy to proxy mapping"
    wn["A1"].font = Font(bold=True, size=13)
    for i, (n_, t, s, d) in enumerate([("SMA strategy", "Proxy", "Style", "Proxy description")] + FUNDS, start=3):
        for j, v in enumerate((n_, t, s, d), start=1):
            c = wn.cell(row=i, column=j, value=v)
            if i == 3:
                c.fill, c.font = HDR_FILL, HDR_FONT
    wn.column_dimensions["A"].width, wn.column_dimensions["D"].width = 38, 80
    notes = [
        "Prices are total-return adjusted (distributions reinvested), so year-end distributions do not show as losses.",
        "Volatility = stdev of daily returns x sqrt(252). Beta = cov(fund, index) / var(index), trailing year.",
        "Downside capture = compounded fund return / compounded benchmark return on benchmark down days (<1.00 = lost less).",
        "Beta-predicted return = pre-event beta to S&P 500 x S&P 500 event-day return; 'unexplained by beta' is the remainder.",
        "Mutual funds strike one NAV at the 4pm ET close; intraday swings that reversed are invisible. GSGO and PVAL are ETFs.",
        "Public-fund proxies can differ from actual SMA accounts (cash, fees, restrictions, tax-loss harvesting).",
        "GSGO history starts 17-Nov-2025 (converted from the GS Strategic Growth mutual fund).",
    ]
    for i, t in enumerate(notes, start=len(FUNDS) + 6):
        wn.cell(row=i, column=1, value=t)
    wb.save(path)


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", help="shock day the Excel workbook focuses on (YYYY-MM-DD); default = most recent")
    ap.add_argument("--site-dir", default=str(ROOT / "site"))
    args = ap.parse_args()

    site = Path(args.site_dir)
    (site / "data").mkdir(parents=True, exist_ok=True)

    print(f"Downloading {len(all_tickers())} tickers...")
    px = fetch_prices(all_tickers(), HISTORY_YEARS)
    rets = px.pct_change(fill_method=None)
    events = find_events(rets)
    if not events:
        raise SystemExit("No shock days found - add one to EVENTS.")
    cur_df = current_risk(rets, px)

    data = build_json(px, rets, events, cur_df)
    (site / "data" / "data.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")

    focus = pd.Timestamp(args.event) if args.event else max(events)
    if focus not in events:
        if focus not in rets.index:
            raise SystemExit(f"{focus.date()} is not a trading day in the data.")
        events[focus] = {"label": f"{focus:%b %d, %Y}", "auto": False}
    xlsx = site / "Manager_Vol_Tracker.xlsx"
    build_workbook(xlsx, px, rets, focus, events[focus]["label"], cur_df)

    print(f"As of {data['as_of']}: {len(events)} shock day(s) analysed: " + ", ".join(d.strftime("%Y-%m-%d") for d in events))
    print(f"Wrote {site / 'data' / 'data.json'} and {xlsx}")


if __name__ == "__main__":
    main()
