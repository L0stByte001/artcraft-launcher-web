// Optional end-to-end check: the real launcher script in www/index.html
// driving a real updater service through the stub DOM.
//
// Nothing runs by default. The integration is opt-in so it can never write to
// a live deployment by accident:
//
//   ARTCRAFT_UPDATER_BASE=http://127.0.0.1:18090 ARTCRAFT_INTEGRATION=1 \
//       node tests/integration_launcher_vs_updater.mjs
//
// Add ARTCRAFT_INTEGRATION_INSTALL=<slug> to also install and activate the
// latest release of one application (an additive operation; it never deletes
// anything, and it is skipped when that version is already installed).
import assert from "node:assert/strict";

import { loadLauncher } from "./mini-dom.mjs";

const BASE = process.env.ARTCRAFT_UPDATER_BASE;
const ENABLED = process.env.ARTCRAFT_INTEGRATION === "1";
const INSTALL_APP = process.env.ARTCRAFT_INTEGRATION_INSTALL || "";

if (!ENABLED) {
  console.log("skipped: set ARTCRAFT_INTEGRATION=1 and ARTCRAFT_UPDATER_BASE "
    + "to run the launcher against a real updater service");
  process.exit(0);
}
assert.ok(BASE, "ARTCRAFT_UPDATER_BASE is required (no default on purpose)");
assert.doesNotMatch(String(BASE), /github\.com|api\./,
  "ARTCRAFT_UPDATER_BASE must point at your own updater service");

const calls = [];
async function updater(method, url, body) {
  const target = new URL(url, BASE);
  calls.push(`${method} ${target.pathname}${target.search}`);
  const response = await fetch(target, {
    method,
    headers: body ? { "Content-Type": "application/json", Accept: "application/json" }
                  : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

const env = loadLauncher({ updater });
const L = env.launcher;
const button = () => env.node("#update-all");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function waitIdle(timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while ((L.bulkRunning || L.loading || L.actionRunning) && Date.now() < deadline) {
    await tick();
  }
  assert.equal(L.bulkRunning, false, "the bulk update should have finished");
}

// 1. Before the first check the button is disabled and no request is made.
assert.equal(button().disabled, true, "Update All must start disabled");
assert.equal(calls.length, 0, "no request before an update check");
console.log("ok  disabled before the first update check");

// 2. A real check against the real service.
await L.refreshData();
assert.equal(L.updateCheck.phase, "complete",
  `the check should succeed, got ${L.updateCheck.phase}`);
const installed = Object.entries(L.installedData)
  .filter(([, entry]) => (entry.installed || []).length)
  .map(([slug, entry]) => `${slug}@${entry.selected}`);
console.log(`ok  update check complete · installed: ${installed.join(", ") || "none"}`);
console.log(`ok  button ${button().disabled ? "disabled" : "ENABLED"} · `
  + `${L.bulkCandidates().length} confirmed update(s)`);

// 3. The button state agrees with the confirmed pending updates.
assert.equal(button().disabled, L.bulkCandidates().length === 0,
  "the button must be enabled exactly when a verified update exists");

// 4. Optional: install the latest release of one application for real.
if (INSTALL_APP) {
  const { status, body } = await updater("GET", `/api/releases?app=${INSTALL_APP}`);
  assert.equal(status, 200, `releases for ${INSTALL_APP}: ${JSON.stringify(body)}`);
  const latest = (body.releases || [])[0];
  assert.ok(latest, `no web release published for ${INSTALL_APP}`);

  const before = await updater("GET", "/api/apps");
  const entry = before.body.apps[INSTALL_APP];
  if (!(entry.installed || []).includes(latest.version)) {
    const install = await updater("POST", "/api/install",
      { app: INSTALL_APP, version: latest.version });
    assert.equal(install.status, 200, JSON.stringify(install.body));
    const select = await updater("POST", "/api/select",
      { app: INSTALL_APP, version: latest.version });
    assert.equal(select.status, 200, JSON.stringify(select.body));
    console.log(`ok  installed and activated ${INSTALL_APP} ${latest.version}`);
  } else {
    console.log(`ok  ${INSTALL_APP} ${latest.version} already installed (no reinstall)`);
  }
  await L.refreshData();
  assert.equal(L.installedData[INSTALL_APP].selected, latest.version);
}

// 5. Run the real bulk update against the real service.
if (L.bulkCandidates().length) {
  const queue = L.bulkCandidates().map(c => `${c.slug}@${c.latest}`);
  env.setConfirmAnswer(true);
  button().click();
  await waitIdle();
  console.log(`ok  Update All processed ${queue.join(", ")}`);
  console.log(`    ${L.bulkSummaryText}`);
  await waitIdle();
  assert.equal(L.bulkRunning, false);
  assert.equal(button().disabled, true,
    "no verified update may remain after a successful bulk update");

  const after = await updater("GET", "/api/apps");
  for (const { slug, version } of L.bulkResults.updated) {
    assert.equal(after.body.apps[slug]?.selected, version,
      `${slug} should be on ${version}`);
    assert.ok(after.body.apps[slug].installed.includes(version));
  }
} else {
  console.log("ok  nothing to update; the button stayed disabled");
}

console.log(`\n${calls.length} requests exercised against ${BASE}`);
console.log("integration check passed");
