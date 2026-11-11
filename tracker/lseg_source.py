"""
Refinitiv Eikon / LSEG Workspace data source (optional).

Uses the LSEG Data Library for Python (`pip install lseg-data`) through a
*desktop session*: Eikon (or Workspace) must be running and logged in on this
PC. Nothing here works from the cloud, and nothing here is published.

What it adds on top of the free Yahoo prices:
  * Fund holdings (Lipper), saved as dated snapshots, so the tracker can show
    what each manager bought / added / trimmed / sold between holdings dates.
  * Official NAVs for the two ETFs (GSGO, PVAL), so every manager is on NAV.

Your app key lives in config/lseg.local.json (git-ignored, never pushed):
    {"app_key": "PASTE-YOUR-KEY-HERE"}
or in the environment variable LSEG_APP_KEY.

Field names: LSEG/Lipper field names vary by entitlement, so each item has a
list of candidate fields. `python tracker/lseg_check.py` tries them all and
writes the ones that work into config/lseg.local.json ("fields": {...}).
"""

import json
import os
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "lseg.local.json"
SNAP_DIR = ROOT / "private_data" / "holdings"          # git-ignored

# Candidate fields, tried in order. lseg_check.py records the first that works.
CANDIDATES = {
    # one row per holding
    "holding_name":   ["TR.FundHoldingName", "TR.FdSecurityOwnedName"],
    "holding_ric":    ["TR.FundHoldingRIC", "TR.FdSecurityOwnedRIC"],
    "holding_weight": ["TR.FundPercentageOfFundAssets", "TR.FdInvestorPercentPortfolio"],
    "holding_shares": ["TR.FundNumberOfShares", "TR.FdSharesHeld"],
    "holding_date":   ["TR.FundPortfolioDate", "TR.FundHoldingDate", "TR.FdHoldingsDate"],
    # daily NAV history
    "nav":            ["TR.FundNAV", "TR.NAV"],
}
HOLDINGS_PARAMS = {"EndNum": 500}


class LsegUnavailable(Exception):
    pass


def load_config():
    cfg = {}
    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    key = os.environ.get("LSEG_APP_KEY") or cfg.get("app_key", "")
    if not key or "PASTE" in key.upper():
        raise LsegUnavailable(f"No app key set. Put it in {CONFIG_PATH} (see README) or set LSEG_APP_KEY.")
    cfg["app_key"] = key
    return cfg


def save_config(cfg):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def open_session(cfg):
    try:
        import lseg.data as ld
    except ImportError as e:
        raise LsegUnavailable("lseg-data is not installed: pip install lseg-data") from e
    try:
        ld.open_session(app_key=cfg["app_key"])          # default = desktop session via Eikon on localhost
    except Exception as e:
        raise LsegUnavailable(f"Could not connect to Eikon. Is Eikon open and logged in? ({e})") from e
    return ld


def close_session(ld):
    try:
        ld.close_session()
    except Exception:
        pass


def resolve_ids(ld, tickers, cfg):
    """Ticker -> {'ric':..., 'lipper':...}. Manual overrides in cfg['ids'] win."""
    from lseg.data.discovery import SymbolTypes, convert_symbols
    out = {t: {} for t in tickers}
    try:
        df = convert_symbols(tickers, from_symbol_type=SymbolTypes.TICKER_SYMBOL,
                             to_symbol_types=[SymbolTypes.RIC, SymbolTypes.LIPPER_ID],
                             preferred_country_code="G:6J")       # G:6J = United States
        for t in tickers:
            if t in df.index:
                row = df.loc[t]
                if isinstance(row, pd.DataFrame):
                    row = row.iloc[0]
                out[t] = {"ric": _s(row.get("RIC")), "lipper": _s(row.get("FundClassLipperID"))}
    except Exception as e:
        print(f"  symbol lookup failed: {e}", file=sys.stderr)
    for t, ids in (cfg.get("ids") or {}).items():
        out.setdefault(t, {}).update({k: v for k, v in ids.items() if v})
    return out


def _s(v):
    return None if v is None or (isinstance(v, float) and pd.isna(v)) or str(v).strip() == "" else str(v).strip()


def fund_universe(ids):
    """Best instrument code for fund-level (Lipper) fields."""
    if ids.get("lipper"):
        return f"LP{ids['lipper']}" if not str(ids["lipper"]).startswith("LP") else ids["lipper"]
    return ids.get("ric")


def _field(cfg, key):
    return (cfg.get("fields") or {}).get(key)


def get_holdings(ld, code, cfg, fields=None):
    """Latest holdings for one fund. Returns DataFrame[name, ric, weight, shares, date]."""
    fields = fields or {k: _field(cfg, k) for k in ("holding_name", "holding_ric", "holding_weight", "holding_shares", "holding_date")}
    use = {k: v for k, v in fields.items() if v}
    if "holding_name" not in use or "holding_weight" not in use:
        raise LsegUnavailable("Holdings fields not configured - run tracker/lseg_check.py first.")
    df = ld.get_data(code, list(use.values()), parameters=HOLDINGS_PARAMS)
    if df is None or df.empty:
        return pd.DataFrame()
    df = df.drop(columns=[c for c in df.columns if c.lower() == "instrument"], errors="ignore")
    df.columns = list(use.keys())[: len(df.columns)]
    df = df.rename(columns={"holding_name": "name", "holding_ric": "ric", "holding_weight": "weight",
                            "holding_shares": "shares", "holding_date": "date"})
    df = df[df["name"].notna() & (df["name"].astype(str).str.strip() != "")]
    if "weight" in df:
        df["weight"] = pd.to_numeric(df["weight"], errors="coerce")
    if "shares" in df:
        df["shares"] = pd.to_numeric(df["shares"], errors="coerce")
    return df.reset_index(drop=True)


def get_nav_history(ld, code, cfg, start, end=None):
    f = _field(cfg, "nav")
    if not f:
        return pd.Series(dtype=float)
    df = ld.get_data(code, [f, f"{f}.date"], parameters={"SDate": str(start), "EDate": str(end or pd.Timestamp.today().date()), "Frq": "D"})
    if df is None or df.empty or df.shape[1] < 3:
        return pd.Series(dtype=float)
    s = pd.Series(pd.to_numeric(df.iloc[:, 1], errors="coerce").values, index=pd.to_datetime(df.iloc[:, 2], errors="coerce"))
    return s.dropna().sort_index()


# ----------------------------------------------------------------------------
# Snapshots & trades
# ----------------------------------------------------------------------------

def snapshot_key(df):
    if "date" in df and df["date"].notna().any():
        return pd.to_datetime(df["date"].dropna().iloc[0]).strftime("%Y-%m-%d")
    return pd.Timestamp.today().strftime("%Y-%m-%d")


def save_snapshot(ticker, df):
    d = SNAP_DIR / ticker
    d.mkdir(parents=True, exist_ok=True)
    key = snapshot_key(df)
    df.to_csv(d / f"{key}.csv", index=False)
    return key


def load_snapshots(ticker):
    d = SNAP_DIR / ticker
    if not d.exists():
        return []
    return [(p.stem, pd.read_csv(p)) for p in sorted(d.glob("*.csv"))]


def diff_holdings(prev, cur):
    """Classify position changes between two holdings snapshots.

    Share-count changes include fund flows (investor buys/redemptions scale every
    position), so we strip the fund-wide flow out: a position counts as 'Added'
    or 'Trimmed' only if its share change differs from the portfolio-wide median
    share change by more than 2 percentage points. Weight change is shown too.
    """
    key = "ric" if "ric" in cur and cur["ric"].notna().any() and "ric" in prev else "name"
    p = prev.set_index(prev[key].astype(str))
    c = cur.set_index(cur[key].astype(str))
    rows = []
    both = p.index.intersection(c.index)
    flow = None
    if "shares" in c and "shares" in p and len(both):
        chg = (c.loc[both, "shares"] / p.loc[both, "shares"] - 1).replace([float("inf"), -float("inf")], pd.NA).dropna()
        flow = float(chg.median()) if len(chg) else None
    for k in c.index.union(p.index):
        inp, inc = k in p.index, k in c.index
        name = (c.loc[k, "name"] if inc else p.loc[k, "name"])
        w0 = float(p.loc[k, "weight"]) if inp and pd.notna(p.loc[k, "weight"]) else 0.0
        w1 = float(c.loc[k, "weight"]) if inc and pd.notna(c.loc[k, "weight"]) else 0.0
        s0 = float(p.loc[k, "shares"]) if inp and "shares" in p and pd.notna(p.loc[k, "shares"]) else None
        s1 = float(c.loc[k, "shares"]) if inc and "shares" in c and pd.notna(c.loc[k, "shares"]) else None
        sh_chg = (s1 / s0 - 1) if (s0 and s1 is not None) else None
        if not inp:
            action = "New position"
        elif not inc:
            action = "Sold out"
        elif sh_chg is not None and flow is not None:
            net = sh_chg - flow
            action = "Added" if net > 0.02 else "Trimmed" if net < -0.02 else "Held"
        else:
            dw = w1 - w0
            action = "Added" if dw > 0.25 else "Trimmed" if dw < -0.25 else "Held"
        rows.append({"name": str(name), "id": k, "action": action, "weight_prev": w0, "weight_now": w1,
                     "weight_change": w1 - w0, "shares_prev": s0, "shares_now": s1, "share_change": sh_chg})
    out = pd.DataFrame(rows)
    order = {"New position": 0, "Sold out": 1, "Added": 2, "Trimmed": 3, "Held": 4}
    out["o"] = out["action"].map(order)
    out = out.sort_values(["o", "weight_change"], key=lambda s: s if s.name == "o" else -s.abs()).drop(columns="o")
    return out, flow


def pull(fund_list, start):
    """Called by the main tracker. Returns {'holdings': {...}, 'nav': {ticker: Series}, 'status': str}."""
    try:
        cfg = load_config()
    except LsegUnavailable as e:
        return {"status": f"LSEG not configured: {e}", "holdings": {}, "nav": {}}
    try:
        ld = open_session(cfg)
    except LsegUnavailable as e:
        return {"status": str(e), "holdings": {}, "nav": {}}
    result = {"status": "ok", "holdings": {}, "nav": {}}
    try:
        tickers = [f["ticker"] for f in fund_list]
        ids = resolve_ids(ld, tickers, cfg)
        for f in fund_list:
            t = f["ticker"]
            code = fund_universe(ids.get(t, {}))
            if not code:
                print(f"  {t}: no Eikon identifier found (add it under 'ids' in config/lseg.local.json)", file=sys.stderr)
                continue
            try:
                h = get_holdings(ld, code, cfg)
                if not h.empty:
                    key = save_snapshot(t, h)
                    print(f"  {t}: {len(h)} holdings as of {key}")
            except Exception as e:
                print(f"  {t}: holdings failed: {e}", file=sys.stderr)
            if f["vehicle"] == "ETF":
                try:
                    s = get_nav_history(ld, code, cfg, start)
                    if len(s):
                        result["nav"][t] = s
                        print(f"  {t}: {len(s)} daily NAVs")
                except Exception as e:
                    print(f"  {t}: NAV history failed: {e}", file=sys.stderr)
    finally:
        close_session(ld)

    for f in fund_list:
        snaps = load_snapshots(f["ticker"])
        if not snaps:
            continue
        latest_date, latest = snaps[-1]
        entry = {"as_of": latest_date, "snapshots": [d for d, _ in snaps],
                 "top": latest.sort_values("weight", ascending=False).head(15)[["name", "weight"]].to_dict("records"),
                 "n_holdings": int(len(latest)), "changes": None}
        if len(snaps) >= 2:
            prev_date, prev = snaps[-2]
            ch, flow = diff_holdings(prev, latest)
            entry["changes"] = {"from": prev_date, "to": latest_date, "fund_flow_share_change": flow,
                                "rows": ch[ch["action"] != "Held"].to_dict("records"),
                                "counts": ch["action"].value_counts().to_dict()}
        result["holdings"][f["ticker"]] = entry
    return result
