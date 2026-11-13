"""
Gate for the scheduled daily report (default 05:00 America/Chicago).

GitHub cron is UTC, ignores daylight saving, and is best-effort: runs can start late or be
dropped, especially at the top of the hour. So the workflow is scheduled at several off-peak
times around the target, and every scheduled run applies the same rule:

  * more than 70 minutes before the target  -> skip (another slot is closer)
  * up to 70 minutes before the target       -> wait until the target, then send
  * from the target to 4 hours after it      -> send now (a late or backup slot)
  * later than that                          -> skip

The workflow then skips sending if today's report already exists, so backups never duplicate.
Manual runs (workflow_dispatch) always send immediately.
"""

import datetime as dt
import os
import sys
import time
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("REPORT_TZ", "America/Chicago"))
HH, MM = (int(x) for x in os.environ.get("REPORT_TIME", "05:00").split(":"))
MAX_WAIT = 70 * 60
LATE_OK = 4 * 3600


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
    target = now.replace(hour=HH, minute=MM, second=0, microsecond=0)
    gap = (target - now).total_seconds()
    if gap > MAX_WAIT:
        return emit(False, f"{now:%H:%M %Z} is {int(gap / 60)} min before {target:%H:%M}; a later slot will send. Skipping.")
    if gap < -LATE_OK:
        return emit(False, f"{now:%H:%M %Z} is more than 4h after {target:%H:%M}. Skipping.")
    if gap > 0:
        print(f"Waiting {int(gap)}s until {target:%H:%M %Z}...")
        time.sleep(gap)
    else:
        print(f"Running {int(-gap / 60)} min after {target:%H:%M %Z} (late start or backup slot).")
    emit(True, "Send window open.")


if __name__ == "__main__":
    sys.exit(main())
