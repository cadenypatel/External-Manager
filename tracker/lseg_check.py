"""
One-time Eikon connection check.

  1. Open Eikon and log in.
  2. Put your app key in config/lseg.local.json.
  3. Run:  python tracker/lseg_check.py      (or double-click check_eikon.bat)

It connects, finds the Eikon/Lipper identifier for each fund, tries every
candidate field for holdings and NAV, saves the ones that return data into
config/lseg.local.json, and writes a full report to private_data/lseg_check_report.txt.
Re-run it any time something stops working.
"""

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pandas as pd

import lseg_source as L
from manager_vol_tracker import FUNDS

REPORT = L.ROOT / "private_data" / "lseg_check_report.txt"


def try_field(ld, code, field, params=None):
    try:
        df = ld.get_data(code, [field], parameters=params or {})
        if df is None or df.empty or df.shape[1] < 2:
            return None
        vals = df.iloc[:, 1].dropna()
        vals = vals[vals.astype(str).str.strip() != ""]
        return vals if len(vals) else None
    except Exception as e:
        return f"error: {e}"


def main():
    buf = io.StringIO()
    ok = True
    with redirect_stdout(buf):
        print("Eikon connection check\n" + "=" * 60)
        try:
            cfg = L.load_config()
            print("App key: found")
        except L.LsegUnavailable as e:
            print(f"FAIL: {e}")
            ok = False
            cfg = None
        ld = None
        if cfg:
            try:
                ld = L.open_session(cfg)
                print("Session: connected to Eikon")
            except L.LsegUnavailable as e:
                print(f"FAIL: {e}")
                ok = False

        if ld:
            tickers = [f["ticker"] for f in FUNDS]
            ids = L.resolve_ids(ld, tickers, cfg)
            print("\nIdentifiers (ticker -> RIC / Lipper ID / code used)")
            codes = {}
            for t in tickers:
                i = ids.get(t, {})
                codes[t] = L.fund_universe(i)
                print(f"  {t:6s}  RIC={i.get('ric')}  Lipper={i.get('lipper')}  -> {codes[t]}")
            missing = [t for t, c in codes.items() if not c]
            if missing:
                print(f"  ! No identifier for {missing}. Look them up in Eikon and add under \"ids\" in config/lseg.local.json, e.g.")
                print('    "ids": {"' + missing[0] + '": {"lipper": "40012345"}}')

            test = [t for t in tickers if codes.get(t)]
            found = {}
            for item, cands in L.CANDIDATES.items():
                print(f"\nField: {item}")
                targets = ([t for t in test if next(f for f in FUNDS if f["ticker"] == t)["vehicle"] == "ETF"]
                           if item == "nav" else test[:3])
                for fld in cands:
                    hits = []
                    for t in targets:
                        params = L.HOLDINGS_PARAMS if item.startswith("holding") else None
                        if item == "nav":
                            params = {"SDate": str((pd.Timestamp.today() - pd.Timedelta(days=10)).date()),
                                      "EDate": str(pd.Timestamp.today().date()), "Frq": "D"}
                        r = try_field(ld, codes[t], fld, params)
                        if isinstance(r, pd.Series):
                            hits.append(f"{t}: {len(r)} values, e.g. {r.iloc[0]!r}")
                        elif isinstance(r, str):
                            hits.append(f"{t}: {r[:120]}")
                    good = [h for h in hits if "values" in h]
                    print(f"  {fld:34s} {'OK' if good else 'no data'}")
                    for h in hits:
                        print(f"      {h}")
                    if good and item not in found:
                        found[item] = fld
            cfg.setdefault("fields", {}).update(found)
            L.save_config(cfg)
            print("\nSaved working fields to config/lseg.local.json:")
            for k in L.CANDIDATES:
                print(f"  {k:15s} {found.get(k, '-- none worked --')}")
            if "holding_name" not in found or "holding_weight" not in found:
                ok = False
                print("\n! Holdings fields did not return data. Your Eikon entitlement may not include Lipper holdings,")
                print("  or the field names differ. Send private_data/lseg_check_report.txt to whoever is maintaining this.")

            if "holding_name" in found and test:
                print("\nSample holdings for", test[0])
                try:
                    h = L.get_holdings(ld, codes[test[0]], cfg)
                    print(h.head(10).to_string())
                    print(f"  ... {len(h)} rows")
                except Exception as e:
                    print(f"  failed: {e}")
            L.close_session(ld)

        print("\nRESULT:", "READY - run run_tracker.bat" if ok else "NOT READY - see messages above")

    text = buf.getvalue()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(text, encoding="utf-8")
    print(text)
    print(f"(Report saved to {REPORT})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
