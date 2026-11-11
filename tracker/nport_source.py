"""
SEC Form N-PORT holdings (free, public, quarterly).

Every US mutual fund files its full portfolio with the SEC each quarter; the
filing is public about 60 days after quarter-end. Used for funds whose Lipper
holdings aren't in Eikon (e.g. Cantor Fitzgerald Large Cap Focused).

The SEC requires automated requests to identify themselves: the contact used is
"sec_user_agent" in config/lseg.local.json (git-ignored, never published).
Requests are kept well under the SEC's 10-per-second limit.
"""

import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "lseg.local.json"
_last = [0.0]


class NportUnavailable(Exception):
    pass


def _user_agent():
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        cfg = {}
    ua = (cfg.get("sec_user_agent") or "").strip()
    if not ua or "@" not in ua:
        raise NportUnavailable('SEC downloads need a contact: add "sec_user_agent": "Your Name you@example.com" '
                               "to config/lseg.local.json")
    return ua


def _get(url):
    wait = 0.25 - (time.time() - _last[0])                # stay far below the SEC's rate limit
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": _user_agent(), "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=30) as r:
        _last[0] = time.time()
        return r.read()


def list_filings(series_id, count=8):
    """Recent NPORT-P filings for a fund series: [(filing_date, accession_folder_url)]."""
    url = ("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK="
           f"{series_id}&type=NPORT-P&dateb=&owner=include&count={count}&output=atom")
    root = ET.fromstring(_get(url))
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for e in root.findall("a:entry", ns):
        c = e.find("a:content", ns)
        if c is None:
            continue
        date = (c.findtext("a:filing-date", default="", namespaces=ns) or "").strip()
        href = (c.findtext("a:filing-href", default="", namespaces=ns) or "").strip()
        if href:
            out.append((date, href.rsplit("/", 1)[0] + "/"))
    return out


def _primary_doc_url(folder):
    m = re.search(r"/Archives/edgar/data/(\d+)/(\d{18})/", folder)
    if m:
        return f"https://www.sec.gov/Archives/edgar/data/{m.group(1)}/{m.group(2)}/primary_doc.xml"
    return folder + "primary_doc.xml"


def parse_nport(xml_bytes, series_id=None):
    """Holdings from one N-PORT filing -> (report_date, DataFrame[name, cusip, weight, shares, value, date])."""
    root = ET.fromstring(xml_bytes)
    strip = lambda tag: tag.split("}", 1)[-1]
    for el in root.iter():                                  # drop namespaces for simple lookups
        el.tag = strip(el.tag)
    if series_id:
        sid = root.findtext(".//seriesId") or ""
        if sid and sid.strip() != series_id:
            return None, pd.DataFrame()
    rep = (root.findtext(".//repPdDate") or "").strip()
    rows = []
    for s in root.iter("invstOrSec"):
        units = (s.findtext("units") or "").strip()
        rows.append({
            "name": (s.findtext("name") or s.findtext("title") or "").strip(),
            "cusip": (s.findtext("cusip") or "").strip(),
            "weight": pd.to_numeric(s.findtext("pctVal"), errors="coerce"),
            "shares": pd.to_numeric(s.findtext("balance"), errors="coerce") if units in ("NS", "") else None,
            "value": pd.to_numeric(s.findtext("valUSD"), errors="coerce"),
            "date": rep,
        })
    df = pd.DataFrame(rows)
    if not df.empty:
        df["ric"] = df["cusip"].where(df["cusip"].str.len() > 0)   # CUSIP is the stable ID for comparisons
    return rep, df


def get_reports(series_id, max_reports=3, log=print):
    """Latest N-PORT holdings reports for a series: [(report_date, DataFrame)], oldest first."""
    reports = {}
    for filed, folder in list_filings(series_id):
        if len(reports) >= max_reports:
            break
        try:
            rep, df = parse_nport(_get(_primary_doc_url(folder)), series_id)
        except Exception as e:
            log(f"    N-PORT {folder}: {e}")
            continue
        if rep and not df.empty and rep not in reports:
            reports[rep] = df
    return sorted(reports.items())


if __name__ == "__main__":
    sid = sys.argv[1] if len(sys.argv) > 1 else "S000075628"
    for rep, df in get_reports(sid):
        print(rep, len(df), "holdings; top:", df.sort_values("weight", ascending=False).head(3)[["name", "weight"]].values.tolist())
