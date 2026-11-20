/**
 * Forwards the 4:00 AM CT Equity Manager Tracker report from this Gmail to other people.
 * Runs inside YOUR Gmail (Google Apps Script) - no forwarding verification, no API keys.
 *
 * Strict rules - it forwards an email ONLY if ALL of these hold:
 *   - it is from notifications@github.com
 *   - its subject starts with "[cadenypatel/External-Manager] Equity Manager Tracker"
 *     (so no replies, no other repos, no other GitHub email)
 *   - it arrived TODAY (any day of the week), between 03:55 and 10:05 Central Time
 *     (the 4:00 AM report, with room for GitHub starting late)
 *   - it arrived after this script was installed (setup), so older reports are never sent
 *   - nothing has been forwarded yet today (max ONE forward per day)
 *
 * It also STARTS the report: GitHub's own scheduler runs hours late, so at ~3:45 CT each day
 * this script asks GitHub to build the report, and GitHub holds it until exactly 4:00 CT.
 * That needs a GitHub token saved in Project Settings -> Script Properties as GITHUB_TOKEN
 * (fine-grained token, only the External-Manager repo, permission "Actions: Read and write").
 * The token stays in your Google account; it is never in this code or on GitHub.
 *
 * Safety checks (so the report definitely goes out):
 *   - 3:40-3:58 CT: the start request is retried every 5 minutes until GitHub accepts it.
 *   - From 4:05 CT, every 15 minutes until 7:00: if today's report hasn't been sent and
 *     GitHub isn't already working on it, ask GitHub again (it then sends right away).
 *     GitHub never sends twice in one day, so extra requests are harmless.
 *   - 4:30 CT: if the report still hasn't gone out, email ALERT_TO with what went wrong.
 *   - Website data: GitHub's own schedule runs hours late, so this script also asks GitHub to
 *     rebuild the public site at ~9:30 PM CT (after fund NAVs post) and ~3:15 AM CT. From
 *     4:30 to 9:00 AM it compares the site's latest data date with the 4 AM report's; if the
 *     site is behind it asks for another rebuild (every 20 min), and at 6:00 AM emails ALERT_TO.
 *   - If forwarding fails, ALERT_TO gets an email too. Run "checkStatus" any time for a
 *     dry run: it reports what the checks see and changes nothing.
 *
 * Setup: script.google.com -> project -> paste this file -> set RECIPIENTS -> Save ->
 *        run "setup" once and Allow. setup forwards nothing; the first forward is the next
 *        4:00 AM report. After adding GITHUB_TOKEN, run "checkToken" once (it sends nothing).
 */

const RECIPIENTS = "boss@example.com";              // comma-separate for more people
const TZ = "America/Chicago";
const SUBJECT_PREFIX = "[cadenypatel/External-Manager] Equity Manager Tracker";
const WINDOW_START = "03:55";                       // CT
const WINDOW_END = "10:05";                         // CT
const REPO = "cadenypatel/External-Manager";
const START_FROM = "03:40", START_UNTIL = "03:58";  // CT: when to ask GitHub to build the report
const ALERT_TO = "";                                // your own address, for problem alerts ("" = off)
const WATCH_FROM = "04:05", WATCH_UNTIL = "07:00";  // CT: make sure today's report went out
const RETRY_MIN = 15;                               // minutes between extra start requests
const ALERT_AT = "04:30";                           // CT: email ALERT_TO if still nothing by now
const SITE_DATA = "https://cadenypatel.github.io/External-Manager/data/data.json";
const SITE_BUILDS = [["21:30", "21:58"], ["03:10", "03:38"]];  // CT windows: ask GitHub to rebuild the site
const SITE_CHECK_FROM = "04:30", SITE_CHECK_UNTIL = "09:00";  // CT: make sure the site has the latest close
const SITE_RETRY_MIN = 20;                           // minutes between extra rebuild requests
const SITE_ALERT_AT = "06:00";                       // CT: email ALERT_TO if the site is still behind

function forwardReports() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const today = Utilities.formatDate(now, TZ, "yyyy-MM-dd");
  safely_(function () { startReport_(props, now, today); });
  safely_(function () { watchdog_(props, now, today, false); });
  safely_(function () { siteBuild_(props, now, today); });
  safely_(function () { siteWatch_(props, now, today, false); });
  if (props.getProperty("lastForwardDate") === today) return;          // already sent today

  const installedAt = Number(props.getProperty("installedAt") || Date.now());
  const threads = GmailApp.search(
    'from:notifications@github.com subject:"Equity Manager Tracker" newer_than:1d', 0, 10);

  const candidates = [];
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      if (m.getFrom().indexOf("notifications@github.com") === -1) return;
      if (m.getSubject().indexOf(SUBJECT_PREFIX) !== 0) return;       // exact report subject only
      const d = m.getDate();
      if (d.getTime() < installedAt) return;                           // never older reports
      if (Utilities.formatDate(d, TZ, "yyyy-MM-dd") !== today) return; // today's only
      const hm = Utilities.formatDate(d, TZ, "HH:mm");
      if (hm < WINDOW_START || hm > WINDOW_END) return;                // the 4 AM report only
      candidates.push(m);
    });
  });
  if (!candidates.length) return;

  candidates.sort(function (a, b) { return a.getDate() - b.getDate(); });
  try {
    candidates[0].forward(RECIPIENTS, { name: "Equity Manager Tracker" });
  } catch (err) {                                                      // retried next run
    alertOnce_(props, today, "fwd", "The daily report arrived but forwarding it failed",
      "Forwarding to " + RECIPIENTS + " failed: " + err + "\nIt will keep retrying every 5 minutes until " + WINDOW_END + " CT.");
    throw err;
  }
  props.setProperty("lastForwardDate", today);                         // one per day
}

// Run once. Creates the every-5-minutes check. Forwards NOTHING now, and marks today as done,
// so the first forward is the next 4:00 AM report.
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "forwardReports") ScriptApp.deleteTrigger(t);
  });
  const props = PropertiesService.getScriptProperties();
  props.setProperty("installedAt", String(Date.now()));
  props.setProperty("lastForwardDate", Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"));
  ScriptApp.newTrigger("forwardReports").timeBased().everyMinutes(5).create();
}

// ~3:45 CT: ask GitHub to build today's report and hold it until 4:00 CT. Once a day.
function startReport_(props, now, today) {
  const hm = Utilities.formatDate(now, TZ, "HH:mm");
  if (hm < START_FROM || hm > START_UNTIL) return;
  if (props.getProperty("lastStartDate") === today) return;
  if (dispatch_(props)) props.setProperty("lastStartDate", today);
}

// From 4:05 CT: if today's report isn't out and GitHub isn't working on it, ask again.
// dryRun = only report what it sees (used by checkStatus).
function watchdog_(props, now, today, dryRun) {
  const hm = Utilities.formatDate(now, TZ, "HH:mm");
  if (!dryRun && (hm < WATCH_FROM || hm > WATCH_UNTIL)) return "outside " + WATCH_FROM + "-" + WATCH_UNTIL + " CT";
  if (!dryRun && props.getProperty("reportSeenDate") === today) return "already confirmed today";
  if (!token_(props)) return "no GITHUB_TOKEN saved";
  const dayStart = Utilities.parseDate(today + " 00:00", TZ, "yyyy-MM-dd HH:mm");

  const issues = gh_(props, "GET", "/issues?labels=daily-report&state=all&per_page=10&since=" + dayStart.toISOString());
  if (issues.code !== 200) {
    note_(props, "GitHub check failed (" + issues.code + "): " + issues.text);
  } else if (issues.json.some(function (i) { return new Date(i.created_at) >= dayStart; })) {
    if (!dryRun) props.setProperty("reportSeenDate", today);
    return "today's report has been sent";
  }

  const runs = gh_(props, "GET", "/actions/workflows/daily-email.yml/runs?per_page=10");
  const busy = runs.code === 200 && runs.json.workflow_runs.some(function (r) { return r.status !== "completed"; });
  if (busy) return "not sent yet - GitHub is working on it";

  let did = "not sent yet - nothing running";
  if (!dryRun) {
    const last = Number(props.getProperty("lastRetryAt") || 0);
    if (Date.now() - last >= RETRY_MIN * 60 * 1000) {
      props.setProperty("lastRetryAt", String(Date.now()));
      did += dispatch_(props) ? "; asked GitHub to send it now" : "; GitHub refused the request";
    }
    if (hm >= ALERT_AT) {
      alertOnce_(props, today, "late", "Daily report has not gone out yet",
        "As of " + hm + " CT today's Equity Manager Tracker report has not been sent.\n" +
        "The script keeps asking GitHub every " + RETRY_MIN + " minutes until " + WATCH_UNTIL + " CT.\n\n" +
        "Last GitHub message: " + (props.getProperty("lastNote") || "(none)") + "\n\n" +
        "Check: https://github.com/" + REPO + "/actions");
    }
  }
  return did;
}

// Dry run: shows what the checks see right now. Sends nothing, changes nothing.
function checkStatus() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date(), today = Utilities.formatDate(now, TZ, "yyyy-MM-dd");
  console.log("Now " + Utilities.formatDate(now, TZ, "EEE HH:mm") + " CT. Report status: " + watchdog_(props, now, today, true));
  console.log("Website status: " + siteWatch_(props, now, today, true));
  console.log("Started today: " + (props.getProperty("lastStartDate") === today) +
              ". Forwarded today: " + (props.getProperty("lastForwardDate") === today) +
              ". Alerts to: " + (ALERT_TO || "(off)") + ". Last GitHub message: " + (props.getProperty("lastNote") || "(none)"));
}

function dispatch_(props) {
  const res = gh_(props, "POST", "/actions/workflows/daily-email.yml/dispatches", { ref: "main", inputs: { timed: true } });
  if (res.code !== 204) note_(props, "Start request failed (" + res.code + "): " + res.text);
  return res.code === 204;
}

// Ask GitHub to rebuild the public website (fresh prices and every statistic).
function siteDispatch_(props) {
  const res = gh_(props, "POST", "/actions/workflows/public-site.yml/dispatches", { ref: "main" });
  if (res.code !== 204) note_(props, "Site rebuild request failed (" + res.code + "): " + res.text);
  return res.code === 204;
}

// ~9:30 PM and ~3:15 AM CT: rebuild the site once in each window.
function siteBuild_(props, now, today) {
  const hm = Utilities.formatDate(now, TZ, "HH:mm");
  SITE_BUILDS.forEach(function (w, i) {
    if (hm < w[0] || hm > w[1]) return;
    const key = "siteBuild" + i;
    if (props.getProperty(key) === today) return;
    if (siteDispatch_(props)) props.setProperty(key, today);
  });
}

// 4:30-9:00 AM CT: the site's latest data date must match the 4 AM report's (holidays included).
function siteWatch_(props, now, today, dryRun) {
  const hm = Utilities.formatDate(now, TZ, "HH:mm");
  if (!dryRun && (hm < SITE_CHECK_FROM || hm > SITE_CHECK_UNTIL)) return "outside " + SITE_CHECK_FROM + "-" + SITE_CHECK_UNTIL + " CT";
  if (!dryRun && props.getProperty("siteOkDate") === today) return "already confirmed today";
  if (!token_(props)) return "no GITHUB_TOKEN saved";
  if (!dryRun) {
    const lastCheck = Number(props.getProperty("siteCheckAt") || 0);
    if (Date.now() - lastCheck < SITE_RETRY_MIN * 60 * 1000) return "checked recently";
    props.setProperty("siteCheckAt", String(Date.now()));
  }
  const issues = gh_(props, "GET", "/issues?labels=daily-report&state=all&per_page=1");
  if (issues.code !== 200 || !issues.json.length) return "can't read the latest report";
  const m = issues.json[0].title.match(/ · ([A-Z][a-z]{2} \d{1,2}, \d{4}) · /);
  if (!m) return "can't read the report's data date";
  const want = Utilities.formatDate(Utilities.parseDate(m[1], TZ, "MMM d, yyyy"), TZ, "yyyy-MM-dd");
  const res = UrlFetchApp.fetch(SITE_DATA + "?t=" + Date.now(), { muteHttpExceptions: true });
  let have = "";
  try { have = JSON.parse(res.getContentText()).as_of || ""; } catch (e) {}
  if (have && have >= want) {
    if (!dryRun) props.setProperty("siteOkDate", today);
    return "site is current (data through " + have + ")";
  }
  let did = "site is behind: has " + (have || "?") + ", latest close " + want;
  if (!dryRun) {
    did += siteDispatch_(props) ? "; asked GitHub to rebuild it" : "; GitHub refused the rebuild";
    if (hm >= SITE_ALERT_AT) {
      alertOnce_(props, today, "site", "Website data is behind",
        "As of " + hm + " CT the public site shows data through " + (have || "?") + ", but the latest close is " + want + ".\n" +
        "The script keeps asking GitHub to rebuild it every " + SITE_RETRY_MIN + " minutes until " + SITE_CHECK_UNTIL + " CT.\n\n" +
        "Last GitHub message: " + (props.getProperty("lastNote") || "(none)") + "\n\n" +
        "Check: https://github.com/" + REPO + "/actions");
    }
  }
  return did;
}

function gh_(props, method, path, body) {
  const opts = { method: method.toLowerCase(), muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + token_(props), Accept: "application/vnd.github+json" } };
  if (body) { opts.contentType = "application/json"; opts.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch("https://api.github.com/repos/" + REPO + path, opts);
  const text = res.getContentText();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { code: res.getResponseCode(), text: text.slice(0, 300), json: json };
}

function token_(props) { return (props.getProperty("GITHUB_TOKEN") || "").replace(/\s|"|'/g, ""); }

function note_(props, msg) {
  console.log(msg);
  props.setProperty("lastNote", Utilities.formatDate(new Date(), TZ, "MMM d HH:mm") + " CT - " + msg);
}

function alertOnce_(props, today, kind, subject, body) {
  if (!ALERT_TO || props.getProperty("alert_" + kind) === today) return;
  props.setProperty("alert_" + kind, today);
  GmailApp.sendEmail(ALERT_TO, "[Report check] " + subject, body);
}

// One failing check must never stop the others (or the forward).
function safely_(fn) {
  try { fn(); } catch (err) { console.log("Check failed: " + err); }
}

// Run once after saving GITHUB_TOKEN. Only checks the token can see the workflow; sends nothing.
function checkToken() {
  const raw = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN") || "";
  const token = raw.replace(/\s|"|'/g, "");
  if (!token) throw new Error("Add GITHUB_TOKEN under Project Settings -> Script Properties first.");
  // Describes the saved value without revealing it.
  console.log("Saved token: " + token.length + " characters, starts with github_pat_: " +
              (token.indexOf("github_pat_") === 0) + ", extra spaces/quotes removed: " + (raw !== token));
  const res = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + REPO + "/actions/workflows/daily-email.yml", {
      muteHttpExceptions: true,
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" } });
  console.log(res.getResponseCode() === 200 ? "Token OK - the 3:45 CT start is ready."
                                           : "Token problem: " + res.getResponseCode() + " " + res.getContentText());
}
