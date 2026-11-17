/**
 * Forwards the 5:00 AM CT Equity Manager Tracker report from this Gmail to other people.
 * Runs inside YOUR Gmail (Google Apps Script) - no forwarding verification, no API keys.
 *
 * Strict rules - it forwards an email ONLY if ALL of these hold:
 *   - it is from notifications@github.com
 *   - its subject starts with "[cadenypatel/External-Manager] Equity Manager Tracker"
 *     (so no replies, no other repos, no other GitHub email)
 *   - it arrived TODAY (any day of the week), between 04:55 and 10:05 Central Time
 *     (the 5:00 AM report, with room for GitHub starting late)
 *   - it arrived after this script was installed (setup), so older reports are never sent
 *   - nothing has been forwarded yet today (max ONE forward per day)
 *
 * It also STARTS the report: GitHub's own scheduler runs hours late, so at ~4:45 CT each day
 * this script asks GitHub to build the report, and GitHub holds it until exactly 5:00 CT.
 * That needs a GitHub token saved in Project Settings -> Script Properties as GITHUB_TOKEN
 * (fine-grained token, only the External-Manager repo, permission "Actions: Read and write").
 * The token stays in your Google account; it is never in this code or on GitHub.
 *
 * Setup: script.google.com -> project -> paste this file -> set RECIPIENTS -> Save ->
 *        run "setup" once and Allow. setup forwards nothing; the first forward is the next
 *        5:00 AM report. After adding GITHUB_TOKEN, run "checkToken" once (it sends nothing).
 */

const RECIPIENTS = "boss@example.com";              // comma-separate for more people
const TZ = "America/Chicago";
const SUBJECT_PREFIX = "[cadenypatel/External-Manager] Equity Manager Tracker";
const WINDOW_START = "04:55";                       // CT
const WINDOW_END = "10:05";                         // CT
const REPO = "cadenypatel/External-Manager";
const START_FROM = "04:40", START_UNTIL = "04:58";  // CT: when to ask GitHub to build the report

function forwardReports() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const today = Utilities.formatDate(now, TZ, "yyyy-MM-dd");
  startReport_(props, now, today);
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
      if (hm < WINDOW_START || hm > WINDOW_END) return;                // the 5 AM report only
      candidates.push(m);
    });
  });
  if (!candidates.length) return;

  candidates.sort(function (a, b) { return a.getDate() - b.getDate(); });
  candidates[0].forward(RECIPIENTS, { name: "Equity Manager Tracker" });
  props.setProperty("lastForwardDate", today);                         // one per day
}

// Run once. Creates the every-5-minutes check. Forwards NOTHING now, and marks today as done,
// so the first forward is the next 5:00 AM report.
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "forwardReports") ScriptApp.deleteTrigger(t);
  });
  const props = PropertiesService.getScriptProperties();
  props.setProperty("installedAt", String(Date.now()));
  props.setProperty("lastForwardDate", Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"));
  ScriptApp.newTrigger("forwardReports").timeBased().everyMinutes(5).create();
}

// ~4:45 CT: ask GitHub to build today's report and hold it until 5:00 CT. Once a day.
function startReport_(props, now, today) {
  const hm = Utilities.formatDate(now, TZ, "HH:mm");
  if (hm < START_FROM || hm > START_UNTIL) return;
  if (props.getProperty("lastStartDate") === today) return;
  const token = (props.getProperty("GITHUB_TOKEN") || "").replace(/\s|"|'/g, "");
  if (!token) return;
  const res = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + REPO + "/actions/workflows/daily-email.yml/dispatches", {
      method: "post", contentType: "application/json", muteHttpExceptions: true,
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
      payload: JSON.stringify({ ref: "main", inputs: { timed: true } }) });
  if (res.getResponseCode() === 204) props.setProperty("lastStartDate", today);
  else console.log("GitHub start failed: " + res.getResponseCode() + " " + res.getContentText());
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
  console.log(res.getResponseCode() === 200 ? "Token OK - the 4:45 CT start is ready."
                                           : "Token problem: " + res.getResponseCode() + " " + res.getContentText());
}
