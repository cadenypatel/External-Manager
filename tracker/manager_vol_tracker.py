"""
Equity Manager Tracker
----------------------
Pulls daily total-return (distribution-adjusted) end-of-day prices for public
mutual fund / ETF proxies of large cap SMA strategies, then measures volatility,
beta and downside behaviour, plus how each manager held up on market shock days.

Benchmarking
  * Every manager is compared with (1) the benchmark its manager states in the
    prospectus / fact sheet, (2) the S&P 500, and (3) its style index
    (Russell 1000 Growth or Russell 1000 Value).
  * Peer comparisons (rank, peer median) are only ever made WITHIN a style
    group: growth vs growth, value vs value.
  * Benchmarks are the actual total-return indexes (S&P 500 TR, Russell 1000
    Growth TR, Russell 1000 Value TR), not ETFs.

Outputs
  site/data/data.json            data feed for the website
  site/Manager_Vol_Tracker.xlsx  Excel workbook (also linked from the website)

Usage
  python tracker/manager_vol_tracker.py
  python tracker/manager_vol_tracker.py --event 2026-11-05   # shock day the Excel sheet focuses on
"""

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd
import yfinance as yf
from openpyxl import Workbook
from openpyxl.chart import Reference, ScatterChart, Series, LineChart
from openpyxl.chart.marker import Marker
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent

# ----------------------------------------------------------------------------
# CONFIGURATION - edit here
# ----------------------------------------------------------------------------
SP500, R1G, R1V = "^SP500TR", "^RLGTR", "^RLVTR"
INDEXES = {
    SP500: {"name": "S&P 500 Index (TR)",              "short": "S&P 500"},
    R1G:   {"name": "Russell 1000 Growth Index (TR)",  "short": "R1000 Growth"},
    R1V:   {"name": "Russell 1000 Value Index (TR)",   "short": "R1000 Value"},
}
STYLE_INDEX = {"Growth": R1G, "Value": R1V}

# stated_benchmark = the primary benchmark the manager lists; source says where it was confirmed.
FUNDS = [
    dict(manager="JPMorgan Large Cap Growth", ticker="JLGMX", style="Growth", vehicle="Mutual fund",
         description="JPMorgan Large Cap Growth Fund R6", stated_benchmark=R1G,
         source="Fund prospectus / fact sheet"),
    dict(manager="Goldman Sachs Strategic Large Growth", ticker="GSGO", style="Growth", vehicle="ETF",
         description="GS Growth Opportunities ETF (successor to GS Strategic Growth Fund, converted Nov 2025)",
         stated_benchmark=R1G, source="GSAM fund page: 'Benchmark / Comparative Index: Russell 1000 Growth Index'"),
    dict(manager="Alger Focus Equity", ticker="ALZFX", style="Growth", vehicle="Mutual fund",
         description="Alger Focus Equity Fund Z", stated_benchmark=R1G,
         source="Alger fund and SMA composite fact sheets"),
    dict(manager="Cantor Fitzgerald LC Focused", ticker="FICIX", style="Growth", vehicle="Mutual fund",
         description="Cantor Fitzgerald Large Cap Focused Fund R6", stated_benchmark=R1G,
         holdings_alt=["FICHX", "FICGX"],   # Lipper carries holdings on another share class (same portfolio)
         source="Cantor LC Focused SMA fact sheet (S&P 500 shown as secondary comparison)"),
    dict(manager="Putnam US LCV Equity Concentrated", ticker="PVAL", style="Value", vehicle="ETF",
         description="Putnam Focused Large Cap Value ETF", stated_benchmark=R1V,
         source="Franklin Templeton PVAL fact sheet, 9/30/2026"),
    dict(manager="MFS Large Cap Value", ticker="MEIKX", style="Value", vehicle="Mutual fund",
         description="MFS Value Fund R6", stated_benchmark=R1V, source="Fund prospectus / fact sheet"),
    dict(manager="Oakmark Large Cap Value", ticker="OANMX", style="Value", vehicle="Mutual fund",
         description="Oakmark Fund Institutional", stated_benchmark=SP500,
         source="Oakmark commentary names the S&P 500 as the benchmark; Russell 1000 Value is secondary"),
    dict(manager="BNYM Newton Dynamic Value", ticker="DRGYX", style="Value", vehicle="Mutual fund",
         description="BNY Mellon Dynamic Value Fund Y", stated_benchmark=R1V,
         source="BNY Mellon fact sheet, 9/30/2026"),
]

EVENTS = [("2026-11-05", "Nov 5, 2026 sell-off")]
AUTO_EVENT_SIGMA = 3.0
HISTORY_YEARS = 3
TRADING_DAYS = 252
WINDOW_BEFORE, WINDOW_AFTER = 5, 10

# ----------------------------------------------------------------------------
# DATA
# ----------------------------------------------------------------------------

def fund_tickers():
    return [f["ticker"] for f in FUNDS]


def all_tickers():
    return fund_tickers() + [R1G, R1V, SP500]


ETF_NAV_FROM_EIKON = set()   # filled at run time when Eikon supplies ETF NAVs


def pricing_basis(f):
    if f["vehicle"] == "Mutual fund":
        return "Daily NAV (4pm ET)"
    return "Daily NAV (4pm ET, Eikon)" if f["ticker"] in ETF_NAV_FROM_EIKON else "Daily closing price (4pm ET)"


def nav_total_return_index(nav, ticker):
    """Turn an ETF NAV series into a total-return index: add back per-share
    distributions on their ex-dates (amounts from Yahoo)."""
    nav = nav.copy()
    nav.index = pd.to_datetime(nav.index).tz_localize(None).normalize()
    try:
        div = yf.Ticker(ticker).dividends
        div.index = pd.to_datetime(div.index).tz_localize(None).normalize()
    except Exception:
        div = pd.Series(dtype=float)
    d = div.reindex(nav.index).fillna(0.0)
    r = (nav + d) / nav.shift(1) - 1
    return (1 + r.fillna(0)).cumprod()


def apply_eikon_nav(px, navs):
    for t, s in navs.items():
        if t not in px.columns or len(s) < 20:
            continue
        idx = nav_total_return_index(s, t)
        r_nav = idx.pct_change().reindex(px.index)
        r_px = px[t].pct_change()
        r = r_nav.where(r_nav.notna(), r_px)              # fall back to price where NAV is missing
        first = px[t].first_valid_index()
        rebuilt = (1 + r.loc[first:].fillna(0)).cumprod() * px.at[first, t]
        px.loc[first:, t] = rebuilt
        ETF_NAV_FROM_EIKON.add(t)
    return px


def fetch_prices(tickers, years):
    start = (dt.date.today() - dt.timedelta(days=int(365.25 * years) + 10)).isoformat()
    px = yf.download(tickers, start=start, auto_adjust=True, progress=False)["Close"]
    if isinstance(px, pd.Series):
        px = px.to_frame()
    px.index = pd.to_datetime(px.index).tz_localize(None).normalize()
    missing = [t for t in tickers if t not in px.columns or px[t].dropna().empty]
    if missing:
        print(f"WARNING: no data returned for {missing}", file=sys.stderr)
    if SP500 not in px.columns or px[SP500].dropna().empty:
        raise SystemExit("No S&P 500 data returned - aborting so the last good site stays up.")
    px = px[px[SP500].notna()]
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


def add_peer_stats(df, key, higher_is_better=True, prefix=None):
    """Rank and median WITHIN each style group only."""
    prefix = prefix or key
    df[f"{prefix}_peer_median"] = df.groupby("style")[key].transform("median")
    df[f"{prefix}_vs_peer"] = df[key] - df[f"{prefix}_peer_median"]
    df[f"{prefix}_peer_rank"] = df.groupby("style")[key].rank(ascending=not higher_is_better, method="min")
    df[f"peer_count"] = df.groupby("style")[key].transform("count")
    return df


def find_events(rets):
    out = {}
    for d, label in EVENTS:
        ts = pd.Timestamp(d)
        if ts in rets.index:
            out[ts] = {"label": label, "auto": False}
        else:
            print(f"WARNING: configured event {d} is not a trading day in the data - skipped", file=sys.stderr)
    sd = rets[SP500].rolling(60, min_periods=40).std().shift(1)
    sig = (rets[SP500] / sd).iloc[-TRADING_DAYS:]
    for ts, s in sig[sig.abs() >= AUTO_EVENT_SIGMA].items():
        if ts not in out:
            r = rets.at[ts, SP500]
            out[ts] = {"label": f"{ts:%b %d, %Y} S&P 500 {'drop' if r < 0 else 'rally'} ({s:+.1f} sigma)", "auto": True}
    return dict(sorted(out.items()))


def event_analysis(rets, px, event):
    pre = rets[rets.index < event]
    spy_ev = rets.at[event, SP500]
    rows = []
    for f in FUNDS:
        tkr, style = f["ticker"], f["style"]
        if tkr not in rets.columns:
            continue
        sb, si = f["stated_benchmark"], STYLE_INDEX[style]
        r_pre = pre[tkr].dropna()
        ev = rets.at[event, tkr]
        sd60 = r_pre.iloc[-60:].std()
        r1y = r_pre.iloc[-TRADING_DAYS:]
        b_spy = beta(r1y, pre[SP500])
        rows.append({
            "manager": f["manager"], "ticker": tkr, "style": style,
            "stated_benchmark": sb, "style_index": si,
            "event_ret": ev,
            "stated_bmk_ret": rets.at[event, sb],
            "excess_stated": ev - rets.at[event, sb],
            "style_index_ret": rets.at[event, si],
            "excess_style": ev - rets.at[event, si],
            "excess_spy": ev - spy_ev,
            "sigma_own": ev / sd60 if sd60 else np.nan,
            "vol20_pre": ann_vol(r_pre.iloc[-20:]),
            "vol60_pre": ann_vol(r_pre.iloc[-60:]),
            "vol1y_pre": ann_vol(r1y),
            "beta_spy_pre": b_spy,
            "beta_stated_pre": beta(r1y, pre[sb]),
            "down_cap_pre": capture(r1y, pre[sb], "down"),
            "pred_ret": b_spy * spy_ev,
            "alpha_day": ev - b_spy * spy_ev,
            "since_event": period_return(px[tkr], event),
        })
    df = pd.DataFrame(rows)
    df = add_peer_stats(df, "event_ret", True, "event")
    spy_pre = pre[SP500].dropna()
    market = {
        "spy_ret": spy_ev,
        "spy_sigma60": spy_ev / spy_pre.iloc[-60:].std(),
        "spy_sigma1y": spy_ev / spy_pre.iloc[-TRADING_DAYS:].std(),
        "r1g_ret": rets.at[event, R1G],
        "r1v_ret": rets.at[event, R1V],
    }
    groups = []
    for style in ("Growth", "Value"):
        g = df[df["style"] == style]
        si = STYLE_INDEX[style]
        groups.append({"style": style, "style_index": si, "style_index_ret": rets.at[event, si],
                       "n": int(len(g)), "event_ret_median": g["event_ret"].median(),
                       **{k: g[k].mean() for k in ["event_ret", "excess_stated", "excess_style", "excess_spy",
                                                   "vol60_pre", "beta_spy_pre", "down_cap_pre", "alpha_day", "since_event"]}})
    corr_tests = [
        ("Pre-event 60d volatility vs event-day return (all 8)", "vol60_pre", "event_ret"),
        ("Pre-event beta vs event-day return (all 8)", "beta_spy_pre", "event_ret"),
        ("Pre-event downside capture vs excess vs stated benchmark (all 8)", "down_cap_pre", "excess_stated"),
    ]
    corrs = [{"label": l, "x": x, "y": y, "value": df[x].corr(df[y])} for l, x, y in corr_tests]
    return df, market, groups, corrs


def event_window(px, event):
    idx = px.index
    i = idx.get_loc(event)
    lo, hi = max(i - WINDOW_BEFORE, 1), min(i + WINDOW_AFTER, len(idx) - 1)
    win = px.iloc[lo:hi + 1]
    cum = win / px.iloc[i - 1] - 1
    return {"dates": [d.strftime("%Y-%m-%d") for d in win.index],
            "offsets": list(range(lo - i, hi - i + 1)),
            "series": {t: cum[t].tolist() for t in px.columns}}


def current_risk(rets, px):
    last = rets.index[-1]
    ytd_start = pd.Timestamp(year=last.year, month=1, day=1) - pd.Timedelta(days=1)

    def row(name, tkr, style, sb, basis):
        r = rets[tkr].dropna()
        r1y = r.iloc[-TRADING_DAYS:]
        ld = r.index[-1]
        has_b = sb is not None
        return {
            "manager": name, "ticker": tkr, "style": style, "stated_benchmark": sb or "",
            "pricing_basis": basis, "last_date": ld.strftime("%Y-%m-%d"),
            "ret_1d": r.iloc[-1],
            "ret_1m": period_return(px[tkr], ld - pd.DateOffset(months=1)),
            "ret_3m": period_return(px[tkr], ld - pd.DateOffset(months=3)),
            "ret_ytd": period_return(px[tkr], ytd_start),
            "ret_1y": period_return(px[tkr], ld - pd.DateOffset(years=1)),
            "vol20": ann_vol(r.iloc[-20:]), "vol60": ann_vol(r.iloc[-60:]), "vol1y": ann_vol(r1y),
            "beta_spy": beta(r1y, rets[SP500]),
            "beta_stated": beta(r1y, rets[sb]) if has_b else np.nan,
            "corr_stated": correlation(r1y, rets[sb]) if has_b else np.nan,
            "te_stated": tracking_error(r1y, rets[sb]) if has_b else np.nan,
            "up_cap": capture(r1y, rets[sb], "up") if has_b else np.nan,
            "down_cap": capture(r1y, rets[sb], "down") if has_b else np.nan,
            "max_dd_1y": max_drawdown(r1y),
            "obs_1y": int(len(r1y)),
        }

    rows = [row(f["manager"], f["ticker"], f["style"], f["stated_benchmark"], pricing_basis(f))
            for f in FUNDS if f["ticker"] in rets.columns]
    df = pd.DataFrame(rows)
    df = add_peer_stats(df, "vol20", False, "vol20")      # rank 1 = lowest short-term vol in peer group
    df = add_peer_stats(df, "ret_1m", True, "ret_1m")
    bench = pd.DataFrame([row(INDEXES[b]["name"], b, "Benchmark", None, "Index level (close)") for b in (R1G, R1V, SP500)])
    return df, bench


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


def build_json(px, rets, events, cur_df, bench_df):
    roll = rets.rolling(20, min_periods=15).std() * np.sqrt(TRADING_DAYS)
    ev_out = []
    for ts, meta in events.items():
        df, market, groups, corrs = event_analysis(rets, px, ts)
        ev_out.append({"date": ts.strftime("%Y-%m-%d"), "label": meta["label"], "auto": meta["auto"],
                       "market": market, "rows": df.to_dict("records"), "groups": groups,
                       "correlations": corrs, "window": event_window(px, ts)})
    return _clean({
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "as_of": rets.index[-1].strftime("%Y-%m-%d"),
        "config": {"auto_event_sigma": AUTO_EVENT_SIGMA, "trading_days": TRADING_DAYS,
                   "window_before": WINDOW_BEFORE, "window_after": WINDOW_AFTER},
        "indexes": INDEXES, "style_index": STYLE_INDEX, "sp500": SP500,
        "funds": [{**f, "pricing_basis": pricing_basis(f)} for f in FUNDS],
        "current": cur_df.to_dict("records"),
        "current_benchmarks": bench_df.to_dict("records"),
        "events": ev_out,
        "series": {"dates": [d.strftime("%Y-%m-%d") for d in px.index],
                   "price": {t: px[t].tolist() for t in px.columns},
                   "vol20": {t: roll[t].tolist() for t in px.columns}},
    })


# ----------------------------------------------------------------------------
# EXCEL
# ----------------------------------------------------------------------------
LABELS = {
    "manager": "Manager", "ticker": "Proxy", "style": "Peer group", "stated_benchmark": "Stated benchmark",
    "style_index": "Style index", "pricing_basis": "Pricing basis",
    "event_ret": "Event-day return", "stated_bmk_ret": "Stated benchmark return", "excess_stated": "vs stated benchmark",
    "style_index_ret": "Style index return", "excess_style": "vs style index", "excess_spy": "vs S&P 500",
    "event_peer_median": "Peer median", "event_vs_peer": "vs peer median", "event_peer_rank": "Peer rank",
    "peer_count": "Peers", "sigma_own": "Move in own sigmas",
    "vol20_pre": "Pre-event vol 20d", "vol60_pre": "Pre-event vol 60d", "vol1y_pre": "Pre-event vol 1y",
    "beta_spy_pre": "Pre-event beta vs S&P 500", "beta_stated_pre": "Pre-event beta vs stated bmk",
    "down_cap_pre": "Pre-event downside capture vs stated bmk", "pred_ret": "Beta-predicted return",
    "alpha_day": "Beyond beta", "since_event": "Since event close",
    "last_date": "Last price date", "ret_1d": "1D", "ret_1m": "1M", "ret_3m": "3M", "ret_ytd": "YTD", "ret_1y": "1Y",
    "vol20": "Vol 20d", "vol60": "Vol 60d", "vol1y": "Vol 1y", "beta_spy": "Beta vs S&P 500",
    "beta_stated": "Beta vs stated bmk", "corr_stated": "Corr vs stated bmk", "te_stated": "Tracking error vs stated bmk",
    "up_cap": "Upside capture", "down_cap": "Downside capture", "max_dd_1y": "Max drawdown 1y", "obs_1y": "Obs (1y)",
    "vol20_peer_rank": "Vol 20d peer rank (1=lowest)", "vol20_peer_median": "Vol 20d peer median",
    "ret_1m_peer_rank": "1M peer rank", "n": "Managers", "event_ret_median": "Median event-day return",
}
RATIO_KEYS = {"sigma_own", "beta_spy_pre", "beta_stated_pre", "down_cap_pre", "beta_spy", "beta_stated",
              "corr_stated", "up_cap", "down_cap"}
TEXT_KEYS = {"manager", "ticker", "style", "stated_benchmark", "style_index", "pricing_basis", "last_date",
             "obs_1y", "event_peer_rank", "peer_count", "vol20_peer_rank", "ret_1m_peer_rank", "n"}
HDR_FILL, HDR_FONT = PatternFill("solid", fgColor="1F3864"), Font(color="FFFFFF", bold=True)
FILLS = {"Growth": PatternFill("solid", fgColor="DDEBF7"), "Value": PatternFill("solid", fgColor="FCE4D6"),
         "Benchmark": PatternFill("solid", fgColor="F2F2F2")}


def idx_name(v):
    return INDEXES[v]["name"] if v in INDEXES else v


def write_table(ws, df, r0):
    cols = list(df.columns)
    for j, k in enumerate(cols, start=1):
        c = ws.cell(row=r0, column=j, value=LABELS.get(k, k))
        c.fill, c.font = HDR_FILL, HDR_FONT
        c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
        ws.column_dimensions[get_column_letter(j)].width = 34 if k == "manager" else (26 if k in ("stated_benchmark", "style_index", "pricing_basis") else 13)
    ws.row_dimensions[r0].height = 48
    for i, row in enumerate(df.to_dict("records"), start=1):
        fill = FILLS.get(row.get("style"))
        for j, k in enumerate(cols, start=1):
            v = row[k]
            if isinstance(v, float) and math.isnan(v):
                v = None
            if k in ("stated_benchmark", "style_index", "ticker") and isinstance(v, str):
                v = idx_name(v) if k != "ticker" else (INDEXES[v]["short"] if v in INDEXES else v)
            if k in ("event_peer_rank", "vol20_peer_rank", "ret_1m_peer_rank", "peer_count") and v is not None:
                v = int(v)
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


EVENT_COLS = ["manager", "ticker", "stated_benchmark", "event_ret", "stated_bmk_ret", "excess_stated",
              "excess_spy", "style_index_ret", "excess_style", "event_peer_median", "event_vs_peer", "event_peer_rank",
              "sigma_own", "vol20_pre", "vol60_pre", "vol1y_pre", "beta_spy_pre", "beta_stated_pre", "down_cap_pre",
              "pred_ret", "alpha_day", "since_event"]
RISK_COLS = ["manager", "ticker", "stated_benchmark", "pricing_basis", "last_date", "ret_1d", "ret_1m", "ret_1m_peer_rank",
             "ret_3m", "ret_ytd", "ret_1y", "vol20", "vol20_peer_rank", "vol60", "vol1y", "beta_spy", "beta_stated",
             "corr_stated", "te_stated", "up_cap", "down_cap", "max_dd_1y"]


def build_workbook(path, px, rets, event, label, cur_df, bench_df):
    df, market, groups, corrs = event_analysis(rets, px, event)
    wb = Workbook()
    ws = wb.active
    ws.title = "Event Analysis"
    ws["A1"] = f"Shock-day analysis: {label} ({event:%A %d %b %Y})"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = ("Peer ranks and medians are within the style group only (growth vs growth, value vs value). "
                "Benchmarks are total-return indexes. Pre-event metrics use only data before the event.")
    ws["A2"].font = Font(italic=True, color="595959")
    mk = [("S&P 500 TR event-day return", market["spy_ret"], "0.00%"),
          ("S&P 500 move in sigmas (vs prior 60d)", market["spy_sigma60"], "0.00"),
          ("S&P 500 move in sigmas (vs prior 1y)", market["spy_sigma1y"], "0.00"),
          ("Russell 1000 Growth TR event-day return", market["r1g_ret"], "0.00%"),
          ("Russell 1000 Value TR event-day return", market["r1v_ret"], "0.00%")]
    for i, (k, v, f) in enumerate(mk, start=4):
        ws.cell(row=i, column=1, value=k).font = Font(bold=True)
        ws.cell(row=i, column=2, value=float(v)).number_format = f
    r = 10
    for style in ("Growth", "Value"):
        ws.cell(row=r, column=1, value=f"{style} peer group").font = Font(bold=True, size=12)
        sub = df[df["style"] == style].sort_values("event_ret", ascending=False)[EVENT_COLS + ["style"]]
        r = write_table(ws, sub.drop(columns="style").assign(style=style), r + 1) + 2
    ws.cell(row=r, column=1, value="Peer group averages").font = Font(bold=True, size=12)
    gdf = pd.DataFrame(groups)[["style", "n", "style_index", "style_index_ret", "event_ret", "event_ret_median",
                                "excess_stated", "excess_style", "excess_spy", "vol60_pre", "beta_spy_pre",
                                "down_cap_pre", "alpha_day", "since_event"]]
    r = write_table(ws, gdf, r + 1) + 2
    ws.cell(row=r, column=1, value="Correlation across all 8 managers (directional - small sample)").font = Font(bold=True, size=12)
    for i, c in enumerate(corrs, start=1):
        ws.cell(row=r + i, column=1, value=c["label"])
        ws.cell(row=r + i, column=2, value=float(c["value"])).number_format = "0.00"
    chart_row = r + len(corrs) + 3
    data_col = len(EVENT_COLS) + 4
    add_scatter(ws, f"A{chart_row}", "Pre-event volatility vs event-day return", "Pre-event 60d vol (ann.)", df, "vol60_pre", 4, data_col)
    add_scatter(ws, f"J{chart_row}", "Pre-event beta vs event-day return", "Beta vs S&P 500 (1y)", df, "beta_spy_pre", 16, data_col)
    ws.freeze_panes = "C1"

    ws2 = wb.create_sheet("Current Risk")
    ws2["A1"] = f"Risk snapshot as of {rets.index[-1].date()} - peer ranks within style group (vol rank 1 = lowest vol)"
    ws2["A1"].font = Font(bold=True, size=13)
    r = 3
    for style in ("Growth", "Value"):
        ws2.cell(row=r, column=1, value=f"{style} peer group").font = Font(bold=True, size=12)
        sub = cur_df[cur_df["style"] == style][RISK_COLS].assign(style=style)
        r = write_table(ws2, sub, r + 1) + 2
    ws2.cell(row=r, column=1, value="Benchmarks").font = Font(bold=True, size=12)
    write_table(ws2, bench_df[[c for c in RISK_COLS if c in bench_df.columns]].assign(style="Benchmark"), r + 1)
    ws2.freeze_panes = "C1"

    order = [t for t in all_tickers() if t in rets.columns]
    roll = (rets[order].rolling(20, min_periods=15).std() * np.sqrt(TRADING_DAYS)).iloc[-TRADING_DAYS:]
    nice = lambda t: INDEXES[t]["short"] if t in INDEXES else t
    ws3 = wb.create_sheet("Rolling Vol 20d")
    for j, t in enumerate(["Date"] + [nice(t) for t in order], start=1):
        c = ws3.cell(row=1, column=j, value=t)
        c.fill, c.font = HDR_FILL, HDR_FONT
    for i, (d, row) in enumerate(roll.iterrows(), start=2):
        ws3.cell(row=i, column=1, value=d.date()).number_format = "yyyy-mm-dd"
        for j, t in enumerate(order, start=2):
            if pd.notna(row[t]):
                ws3.cell(row=i, column=j, value=float(row[t])).number_format = "0.0%"
    n = len(roll) + 1
    for title, style, anchor in [("Growth peers - 20d rolling vol vs Russell 1000 Growth", "Growth", "N2"),
                                 ("Value peers - 20d rolling vol vs Russell 1000 Value", "Value", "N22")]:
        lc = LineChart()
        lc.title, lc.height, lc.width = title, 9, 20
        lc.y_axis.number_format, lc.x_axis.number_format = "0%", "mmm-yy"
        lc.x_axis.delete = lc.y_axis.delete = False
        lc.legend.position, lc.legend.overlay = "b", False
        for t in [f["ticker"] for f in FUNDS if f["style"] == style and f["ticker"] in order] + [STYLE_INDEX[style]]:
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
        for j, t in enumerate(["Date"] + [nice(t) for t in order], start=1):
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
    hdr = ["SMA strategy", "Proxy", "Peer group", "Vehicle", "Pricing basis", "Proxy fund", "Stated benchmark", "Benchmark source"]
    for j, h in enumerate(hdr, start=1):
        c = wn.cell(row=3, column=j, value=h)
        c.fill, c.font = HDR_FILL, HDR_FONT
    for i, f in enumerate(FUNDS, start=4):
        for j, v in enumerate([f["manager"], f["ticker"], f["style"], f["vehicle"], pricing_basis(f), f["description"],
                               idx_name(f["stated_benchmark"]), f["source"]], start=1):
            wn.cell(row=i, column=j, value=v)
    for col, w in zip("ABCDEFGH", (36, 9, 11, 12, 26, 60, 30, 70)):
        wn.column_dimensions[col].width = w
    notes = [
        "Benchmarks are total-return index levels (S&P 500 TR, Russell 1000 Growth TR, Russell 1000 Value TR) from Yahoo Finance.",
        "Each manager is shown against its stated benchmark, the S&P 500 and its style index. Peer ranks/medians are within style group only.",
        "Returns are end-of-day (4pm ET): NAV for mutual funds, closing price for the two ETFs. No intraday data is used.",
        "Volatility = stdev of daily returns x sqrt(252). Beta = cov(fund, index) / var(index), trailing year.",
        "Downside capture = compounded fund return / compounded stated-benchmark return on benchmark down days (<1.00 = lost less).",
        "Beyond beta = event-day return minus (pre-event beta to S&P 500 x S&P 500 event-day return).",
        "Proxies vs SMAs: same team and process, but holdings, trade timing, cash, client restrictions and TLH differ - see website methodology.",
    ]
    for i, t in enumerate(notes, start=len(FUNDS) + 6):
        wn.cell(row=i, column=1, value=t)
    wb.save(path)


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", help="shock day the Excel workbook focuses on (YYYY-MM-DD); default = most recent")
    ap.add_argument("--site-dir", default=str(ROOT / "site"))
    ap.add_argument("--no-eikon", action="store_true", help="skip the Eikon/LSEG pull")
    ap.add_argument("--public", action="store_true",
                    help="build the public edition: free data only, never touches Eikon (used by GitHub Actions)")
    args = ap.parse_args()
    if args.public:
        args.no_eikon = True

    site = Path(args.site_dir)
    (site / "data").mkdir(parents=True, exist_ok=True)

    print(f"Downloading {len(all_tickers())} price series (Yahoo)...")
    px = fetch_prices(all_tickers(), HISTORY_YEARS)

    lseg = {"status": "public edition" if args.public else "skipped (--no-eikon)", "holdings": {}, "nav": {}}
    if not args.no_eikon:
        print("Pulling holdings and ETF NAVs from Eikon...")
        import lseg_source
        lseg = lseg_source.pull(FUNDS, px.index[0].date())
        print(f"  Eikon: {lseg['status']}")
        if lseg["nav"]:
            px = apply_eikon_nav(px, lseg["nav"])
    rets = px.pct_change(fill_method=None)
    events = find_events(rets)
    if not events:
        raise SystemExit("No shock days found - add one to EVENTS.")
    cur_df, bench_df = current_risk(rets, px)

    data = build_json(px, rets, events, cur_df, bench_df)
    data["edition"] = "public" if args.public else "private"
    if not args.public:                       # Eikon data only ever goes into the private, local build
        data["eikon"] = _clean({"status": lseg["status"], "holdings": lseg["holdings"]})
    (site / "data" / "data.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")

    focus = pd.Timestamp(args.event) if args.event else max(events)
    if focus not in events:
        if focus not in rets.index:
            raise SystemExit(f"{focus.date()} is not a trading day in the data.")
        events[focus] = {"label": f"{focus:%b %d, %Y}", "auto": False}
    xlsx = site / "Manager_Vol_Tracker.xlsx"
    build_workbook(xlsx, px, rets, focus, events[focus]["label"], cur_df, bench_df)
    print(f"As of {data['as_of']}: {len(events)} shock day(s): " + ", ".join(d.strftime("%Y-%m-%d") for d in events))
    print(f"Wrote {site / 'data' / 'data.json'} and {xlsx}")


if __name__ == "__main__":
    main()
