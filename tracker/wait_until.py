"""
Gate for the scheduled daily report (default 05:00 America/Chicago, Monday-Friday).

GitHub's scheduler is best-effort, and for this repo scheduled runs have started 7-8 hours
late. So the workflow is triggered every hour, around the clock, and every run applies one rule
against the next 05:00 CT target (today's, or tomorrow's once today's window has passed):

  * target day is Saturday/Sunday              -> skip
  * more than MAX_WAIT before the target       -> skip (a later run will be closer)
  * up to MAX_WAIT before the target           -> wait until the target, then send
  * from the target to LATE_OK after it        -> send now (GitHub started it late)

MAX_WAIT stays under GitHub's 6-hour job limit. The workflow then skips if today's report
already exists, so only one report goes out per day. Manual runs always send immediately.
"""

import datetime as dt
import os
import sys
import time
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("REPORT_TZ", "America/Chicago"))
HH, MM = (int(x) for x in os.environ.get("REPORT_TIME", "05:00").split(":"))
MAX_WAIT = int(os.environ.get("MAX_WAIT_MIN", "340")) * 60     # 5h40m: fits in a 6h job
LATE_OK = int(os.environ.get("LATE_OK_MIN", "300")) * 60       # still send if GitHub is up to 5h late


def decide(now):
    """Return (action, target, gap_seconds). action: 'wait', 'send' or 'skip:<reason>'."""
    today = now.replace(hour=HH, minute=MM, second=0, microsecond=0)
    for target in (today, today + dt.timedelta(days=1)):
        gap = (target - now).total_seconds()
        if -LATE_OK <= gap:
            break
    if target.weekday() >= 5:
        return f"skip:{target:%A} is not a weekday", target, gap
    if gap > MAX_WAIT:
        return f"skip:{int(gap / 60)} min before {target:%a %H:%M} - a later run will be closer", target, gap
    return ("wait" if gap > 0 else "send"), target, gap


def main():
    out = os.environ.get("GITHUB_OUTPUT")

    def emit(go, why):
        print(why)
        if out:
            with open(out, "a") as f:
                f.write(f"send={'true' if go else 'false'}\n")

    if os.environ.get("GITHUB_EVENT_NAME", "") != "schedule":
        return emit(True, "Manual run: sending now.")
    now = dt.datetime.now(TZ)
    action, target, gap = decide(now)
    if action.startswith("skip"):
        return emit(False, f"{now:%a %H:%M %Z}: {action[5:]}. Skipping.")
    if action == "wait":
        print(f"{now:%a %H:%M %Z}: waiting {int(gap / 60)} min until {target:%a %H:%M %Z}...")
        time.sleep(gap)
    else:
        print(f"{now:%a %H:%M %Z}: {int(-gap / 60)} min after {target:%H:%M} (GitHub started late) - sending now.")
    emit(True, "Send window open.")


if __name__ == "__main__":
    sys.exit(main())
