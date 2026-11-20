"""
Public-equity-only returns for proxy funds that hold private companies.

Some mutual funds hold private (pre-IPO) stakes that an SMA cannot own - e.g. Alger Focus
Equity holds Databricks, Anthropic and others (~9% in 2026). Those stakes are fair-valued only
occasionally, so on almost every day they don't move. That damps the fund's daily NAV moves and
makes it look less volatile than the all-public-equity SMA.

Method (uses the fund's actual daily NAV, so trading, cash and fees are all included):
  fund return = w_pub * public return + w_priv * private return,  private return ~ 0 on a normal day
  => public return = fund return / w_pub

w_priv comes from the fund's SEC N-PORT filings: every holding is tagged with a fair-value level,
and Level 3 (no observable market price) = the private stakes. Between filings the private value
is held flat and the public sleeve grows with its own returns, so the weights drift naturally;
each new filing resets them.

Limitation: on the day the fund revalues a private stake, that jump is counted as public-stock
return. Revaluations are occasional, so this mainly affects single days, not volatility or beta.

The weight history is stored in config/private_sleeves.json (public SEC data, committed), so the
public site build on GitHub needs no SEC access. Run this file to refresh it:
    python tracker/private_sleeve.py
"""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "config" / "private_sleeves.json"

# ticker -> SEC series ID (from https://www.sec.gov/files/company_tickers_mf.json)
SERIES = {"ALZFX": "S000009201"}


def load():
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def refresh(log=print, count=40):
    """Re-read every N-PORT filing for the funds in SERIES and save the Level 3 weight history."""
    import nport_source as N
    out = load()
    for ticker, sid in SERIES.items():
        points = {}
        for filed, folder in N.list_filings(sid, count=count):
            try:
                root = ET.fromstring(N._get(N._primary_doc_url(folder)))
            except Exception as e:
                log(f"    {ticker} N-PORT {folder}: {e}")
                continue
            for el in root.iter():
                el.tag = el.tag.split("}", 1)[-1]
            if (root.findtext(".//seriesId") or "").strip() != sid:
                continue
            rep = (root.findtext(".//repPdDate") or "").strip()
            if not rep or rep in points:
                continue
            l3, names = 0.0, []
            for s in root.iter("invstOrSec"):
                w = float(s.findtext("pctVal") or 0)
                if (s.findtext("fairValLevel") or "").strip() == "3" and w > 0:
                    l3 += w
                    names.append([(s.findtext("name") or "").strip(), round(w, 3)])
            points[rep] = {"date": rep, "filed": filed, "private_pct": round(l3, 3),
                           "holdings": sorted(names, key=lambda x: -x[1])}
        if points:
            out[ticker] = {"series_id": sid, "source": "SEC Form N-PORT, Level 3 fair-value holdings",
                           "points": [points[k] for k in sorted(points)]}
            last = out[ticker]["points"][-1]
            log(f"  {ticker}: {len(points)} filings, latest {last['date']} private {last['private_pct']:.2f}%")
    STORE.write_text(json.dumps(out, indent=1), encoding="utf-8")
    return out


def private_weight_series(ticker, fund_px, store=None):
    """Daily private weight (0-1) for a fund, from its filings, drifting with public returns between them.
    Returns (weights Series aligned to fund_px.index, public-only price Series)."""
    store = store if store is not None else load()
    pts = (store.get(ticker) or {}).get("points") or []
    px = fund_px.dropna()
    if not pts or px.empty:
        return None, None
    snaps = {pd.Timestamp(p["date"]): p["private_pct"] / 100 for p in pts}
    r = px.pct_change().fillna(0.0)
    w = pd.Series(0.0, index=px.index)
    pub_r = pd.Series(0.0, index=px.index)
    priv_val, pub_val = 0.0, 1.0                      # sleeve values, fund = priv + pub
    snap_dates = sorted(snaps)
    k = 0
    for i, day in enumerate(px.index):
        # weight held at the start of the day (after the previous close)
        wp = priv_val / (priv_val + pub_val) if (priv_val + pub_val) else 0.0
        if i > 0:
            pr = r.iloc[i] / (1 - wp) if wp < 0.95 else r.iloc[i]
            pub_r.iloc[i] = pr
            pub_val *= 1 + pr
        # apply any filing dated today (weights as of this close)
        while k < len(snap_dates) and snap_dates[k] <= day:
            target = snaps[snap_dates[k]]
            tot = priv_val + pub_val
            priv_val, pub_val = target * tot, (1 - target) * tot
            k += 1
        w.iloc[i] = priv_val / (priv_val + pub_val)
    pub_px = (1 + pub_r).cumprod() * px.iloc[0]
    return w.reindex(fund_px.index), pub_px.reindex(fund_px.index)


def adjust_prices(px, log=print):
    """Replace each SERIES fund's price column with its public-equity-only series.
    Keeps the original under '<ticker>_NAV'. Returns (px, info) where info[ticker] describes the adjustment."""
    store = load()
    info = {}
    for t in SERIES:
        if t not in px.columns or t not in store:
            continue
        w, pub = private_weight_series(t, px[t], store)
        if pub is None:
            continue
        px[t + "_NAV"] = px[t]
        px[t] = pub
        last = store[t]["points"][-1]
        info[t] = {"method": "public_equity_only", "raw_series": t + "_NAV",
                   "private_pct_now": round(float(w.dropna().iloc[-1]) * 100, 2),
                   "latest_filing": last["date"], "latest_private_pct": last["private_pct"],
                   "latest_private_holdings": last["holdings"][:8]}
        log(f"  {t}: public-equity-only series (private sleeve now ~{info[t]['private_pct_now']:.1f}%, "
            f"from N-PORT {last['date']})")
    return px, info


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    refresh()
