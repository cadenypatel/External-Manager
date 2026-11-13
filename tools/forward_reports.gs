/**
 * Forward the daily Equity Manager Tracker report from your Gmail to other people.
 * Runs inside YOUR Gmail (Google Apps Script) - no forwarding verification, no API keys.
 *
 * Setup: script.google.com -> New project -> paste this file -> set RECIPIENTS below ->
 *        Save -> run "setup" once and click Allow. Done: it checks every 5 minutes.
 */

// Who gets a copy. Add more addresses separated by commas.
const RECIPIENTS = "boss@example.com";

// Which emails count as the report.
const SEARCH = 'from:notifications@github.com subject:"Equity Manager Tracker" newer_than:3d -label:report-forwarded';

function forwardReports() {
  const label = GmailApp.getUserLabelByName("report-forwarded") || GmailApp.createLabel("report-forwarded");
  const threads = GmailApp.search(SEARCH, 0, 20);
  threads.forEach(function (thread) {
    const msg = thread.getMessages()[0];               // the report itself (first message in the thread)
    msg.forward(RECIPIENTS, { name: "Equity Manager Tracker" });
    thread.addLabel(label);                            // never forward the same report twice
  });
}

// Run this once: creates the every-5-minutes check and sends any report already waiting.
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "forwardReports") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("forwardReports").timeBased().everyMinutes(5).create();
  forwardReports();
}
