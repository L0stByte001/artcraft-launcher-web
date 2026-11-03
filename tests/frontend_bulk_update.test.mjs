// Frontend behaviour tests for the "Update All" button.
//
// These load the real inline launcher script from www/index.html into a
// dependency-free DOM stub and drive it against an in-memory fake of the
// updater API (tests/fake-updater.mjs), so button state, request sequencing
// and version/current semantics are all asserted on the shipped code.
//
// Run with:  node --test tests/
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadLauncher, createGate, cssRules, ruleFor, allRulesFor, keyframes,
         INDEX_HTML } from "./mini-dom.mjs";
import { SLUG_LIST } from "./fake-updater.mjs";
import { FakeUpdater } from "./fake-updater.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Values produced inside the launcher's vm realm have foreign prototypes, so
// structural comparisons go through JSON.
const jsonEqual = (actual, expected, message) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) await tick();
}

// Prima unità "px" di un valore CSS (null quando non c'è).
const px = value => {
  const match = /(-?[\d.]+)px/.exec(String(value ?? ""));
  return match ? parseFloat(match[1]) : null;
};

async function waitIdle(launcher, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while ((launcher.bulkRunning || launcher.loading || launcher.actionRunning) &&
         Date.now() < deadline) {
    await tick();
  }
  await settle(5);
  assert.equal(launcher.bulkRunning, false, "bulk update should have finished");
  assert.equal(launcher.loading, false, "update check should have finished");
}

function setup(scenario = {}) {
  const updater = new FakeUpdater(scenario);
  const env = loadLauncher({
    updater: (method, url, body) => updater.handle(method, url, body),
  });
  const L = env.launcher;
  return {
    updater,
    env,
    L,
    document: env.document,
    button: () => env.node("#update-all"),
    status: () => env.node("#sync-status").textContent,
    toasts: () => env.toasts(),
    toastTexts: () => env.toasts().map(node =>
      node.querySelector(".toast-message").textContent),
    toastClasses: () => env.toasts().map(node => node.className),
    toastContainer: () => env.node("#toast-container"),
    toastText: () => env.toasts().map(n => n.textContent).join(" | "),
    installs: () => updater.calls.install.map(c => `${c.app}@${c.version}`),
    selects: () => updater.calls.select.map(c => `${c.app}@${c.version}`),
  };
}

const RELEASES = {
  photocraft: ["0.8.1", "0.8.2", "0.9.0"],
  wordcraft: ["0.6.0", "0.6.1", "0.7.0"],
  gridcraft: ["0.6.1"],
  soundcraft: ["0.6.1", "0.7.0"],
};

// 1. Disabled before any update check has run.
test("Update All is disabled before an update check", () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] } });
  const button = t.button();
  assert.ok(button, "the toolbar must contain the Update All button");
  assert.equal(button.textContent, "Update All");
  assert.equal(button.disabled, true);
  assert.equal(t.L.updateCheck.phase, "idle");
  assert.equal(t.env.calls.some(c => c.url.startsWith("/api/apps")), false,
    "the button must not trigger requests before it is used");
});

// The toolbar order is: filters → search → Update All.
test("Update All replaces Check updates at the end of the toolbar", () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] } });
  const toolbar = t.env.document.querySelector(".toolbar");
  const ids = toolbar.children.map(child => child.id);
  jsonEqual(ids, ["filters", "search", "update-all"],
    "filters, search, Update All");

  const [filters, search, updateAll] = toolbar.children;
  assert.ok(filters.classList.contains("filters"),
    "the category filters keep their group");
  assert.equal(search.tagName, "INPUT");
  assert.equal(updateAll.tagName, "BUTTON");
  for (const control of [search, updateAll]) {
    assert.strictEqual(control.parent, toolbar,
      "the search field and Update All remain direct toolbar children");
  }
  assert.ok(!t.env.node("#check-updates"),
    "the Check updates button must be removed");
  assert.ok(!t.env.node("#toolbar-actions"),
    "the old right-hand group is gone");
});

// 1. Adjacent controls are 20px apart, via the container's `gap`.
test("adjacent toolbar controls are separated by exactly 20px", () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] } });

  const rule = ruleFor(".toolbar");
  assert.ok(rule, ".toolbar must be styled");
  assert.equal(rule.declarations.display, "flex");
  assert.equal(rule.declarations.gap, "20px",
    "the 20px separation must come from a flex gap");
  assert.equal(rule.declarations["flex-wrap"], "wrap");
  assert.equal(rule.declarations["column-gap"], undefined,
    "a separate column-gap would contradict the 20px");
  assert.equal(rule.declarations["justify-content"], undefined,
    "justify-content would stretch the gaps beyond 20px");

  // Three direct children → two adjacent pairs, every one of them 20px.
  const toolbar = t.env.document.querySelector(".toolbar");
  assert.equal(toolbar.children.length, 3,
    JSON.stringify(toolbar.children.map(child => child.id)));

  // No margin may add to (or subtract from) that distance.
  for (const selector of ["#update-all", "#search", ".manage",
                          "input", ".toolbar > *", ".toolbar button",
                          ".toolbar input"]) {
    for (const item of allRulesFor(selector)) {
      for (const name of Object.keys(item.declarations)) {
        assert.doesNotMatch(name, /margin|column-gap/,
          `${selector} must not add margins: ${JSON.stringify(item.declarations)}`);
      }
    }
  }

  // The category filters keep the styling they already had.
  assert.equal(ruleFor(".filters").declarations.gap, "8px");
  assert.equal(ruleFor(".filter").declarations.padding, "8px 12px");
  assert.ok(ruleFor("input"), "the search field keeps its own styling");
});

// 2. The search field stays usable on a phone and on a desktop.
test("the search field stays usable at desktop and mobile widths", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.match(html,
    /<input id="search"[\s\S]{0,160}aria-label="Search applications"/,
    "the field keeps its accessible name and placeholder");

  // Desktop: capped at 320px, and never wider than its container.
  const base = ruleFor("input");
  assert.equal(base.declarations.width, "min(100%, 320px)");

  // Never squeezed into a strip: below this the row wraps instead.
  const search = ruleFor("#search");
  assert.ok(search, "#search must be styled");
  const minWidth = parseFloat(search.declarations["min-width"]);
  assert.ok(minWidth >= 160 && minWidth <= 260,
    `a usable minimum width, got ${search.declarations["min-width"]}`);
  assert.match(search.declarations.flex, /^0 1 auto$/, "it may wrap, not shrink away");

  // Mobile (≈360px): <main> tiene 14px di padding, quindi restano 332px.
  const mobileMain = allRulesFor("main").find(rule =>
    /(^|\s)14px(\s|$)/.test(rule.declarations.padding || ""));
  assert.ok(mobileMain, "the page padding shrinks on small screens");
  const available = 360 - 2 * px(mobileMain.declarations.padding.split(" ")[1]);
  const mobile = allRulesFor("input").find(rule => rule.declarations.width === "100%");
  assert.ok(mobile, "on small screens the field takes the whole row");
  assert.ok(minWidth <= available,
    `the field fits a 360px viewport (${available}px available)`);
  assert.ok(px(ruleFor("input").declarations.width) <= available,
    "its desktop cap fits too");

  // The row rearranges instead of overlapping.
  assert.equal(ruleFor(".toolbar").declarations["flex-wrap"], "wrap");
  assert.ok(allRulesFor(".toolbar").some(rule =>
    rule.declarations["align-items"] === "stretch"),
    "mobile stretches the controls to the row");
});

// 3. Nothing in the toolbar can push the page sideways.
test("the toolbar introduces no horizontal page overflow", () => {
  const toolbar = ruleFor(".toolbar");
  assert.equal(toolbar.declarations["flex-wrap"], "wrap",
    "controls wrap instead of overflowing the page");

  for (const selector of [".toolbar", "#search", ".filters", ".filter",
                          "#update-all", ".manage", "input"]) {
    for (const rule of allRulesFor(selector)) {
      for (const [name, value] of Object.entries(rule.declarations)) {
        if (name !== "width" && name !== "min-width") continue;
        // Relative sizes scale with the viewport and cannot overflow it.
        if (/%/.test(value) || /min\(/.test(value) || /calc\(/.test(value)) continue;
        const size = parseFloat(value);
        if (Number.isNaN(size)) continue;
        assert.ok(size <= 360,
          `${selector} { ${name}: ${value} } must fit a 360px viewport`);
      }
    }
  }
});

// Markup parity: the stub DOM mirrors www/index.html, so assert the real file.
test("the shipped markup matches the tested structure", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.match(html, /<div class="toolbar">/);
  assert.match(html, /<div class="filters" id="filters">/);
  assert.match(html, /<input id="search"/);
  assert.doesNotMatch(html, /toolbar-actions/,
    "the search field must not be pushed out of the control row again");
  assert.match(html, /<div id="toast-container" class="toast-container"/);
  assert.match(html, /role="region" aria-label="Update notifications"/);
});

// 2. Disabled while the update check is running.
test("Update All stays disabled while an update check runs", async () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] } });
  const running = t.L.refreshData();
  assert.equal(t.L.loading, true);
  assert.equal(t.button().disabled, true, "disabled while the check is in flight");
  await running;
  assert.equal(t.button().disabled, false, "enabled once 0.9.0 is confirmed");
});

// 3. Disabled when nothing installed has an update.
test("Update All stays disabled when no update is available", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2", "0.9.0"], gridcraft: ["0.6.1"] },
    selected: { photocraft: "0.9.0", gridcraft: "0.6.1" },
  });
  await t.L.refreshData();
  assert.equal(t.L.updateCheck.phase, "complete");
  assert.equal(t.L.bulkCandidates().length, 0);
  assert.equal(t.button().disabled, true);
});

// 3b. Nothing installed at all -> still disabled.
test("Update All stays disabled when nothing is installed", async () => {
  const t = setup({ releases: RELEASES, installed: {} });
  await t.L.refreshData();
  assert.equal(t.button().disabled, true);
});

// 4. Enabled as soon as one installed app has a confirmed newer release.
test("Update All becomes enabled when an installed app has an update", async () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] } });
  await t.L.refreshData();
  jsonEqual(t.L.bulkCandidates().map(c => `${c.slug}@${c.current}->${c.latest}`),
    ["photocraft@0.8.2->0.9.0"]);
  assert.equal(t.button().disabled, false);
  assert.equal(t.button().textContent, "Update All");
});

// 4b. An app whose release check failed is never treated as confirmed.
test("A failed release check keeps the app out of the bulk set", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  t.updater.failReleases.add("photocraft");
  await t.L.refreshData();

  assert.equal(t.L.updateCheck.phase, "partial");
  assert.equal(t.L.releaseChecked.photocraft, undefined);
  assert.equal(t.L.releaseChecked.wordcraft, true);
  jsonEqual(t.L.bulkCandidates().map(c => c.slug), ["wordcraft"]);

  // With a verified update available the button is still usable.
  assert.equal(t.button().disabled, false);

  // And with no verified update at all it is disabled.
  t.updater.failReleases.add("wordcraft");
  await t.L.refreshData();
  assert.equal(t.L.bulkCandidates().length, 0);
  assert.equal(t.button().disabled, true);
  assert.match(t.status(), /Catalog partially refreshed · 2 checks failed/);
});

// 4c. Stale release data from an earlier check is not trusted.
test("Stale release data does not keep the button enabled", async () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] } });
  await t.L.refreshData();
  assert.equal(t.button().disabled, false);

  // The release check fails now: the cached 0.9.0 list must not count.
  t.updater.failReleases.add("photocraft");
  await t.L.refreshData();
  assert.ok(t.L.releaseData.photocraft, "cached releases remain for display");
  assert.equal(t.L.releaseChecked.photocraft, undefined);
  assert.equal(t.L.bulkCandidates().length, 0);
  assert.equal(t.button().disabled, true);
  t.button().click();
  await settle(5);
  assert.deepEqual(t.installs(), []);
});

// 5 + 6 + 10. Only installed apps with confirmed updates are processed, all
// eligible apps are updated, and existing versions/selections stay coherent.
test("Update All installs and activates the latest release for every eligible app", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.1", "0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  assert.equal(t.button().disabled, false);

  const before = t.updater.snapshot("photocraft");
  t.button().click();
  await waitIdle(t.L);

  assert.deepEqual(t.installs(), ["photocraft@0.9.0", "wordcraft@0.7.0"]);
  assert.deepEqual(t.selects(), ["photocraft@0.9.0", "wordcraft@0.7.0"]);
  assert.equal(t.updater.maxActive, 1, "installations must run sequentially");

  // Installed versions are preserved and the new version becomes current.
  assert.deepEqual(t.updater.snapshot("photocraft"), {
    installed: ["0.8.1", "0.8.2", "0.9.0"],
    selected: "0.9.0",
    current: "0.9.0",
    disk: ["0.8.1", "0.8.2", "0.9.0"],
  });
  assert.deepEqual(before.installed, ["0.8.1", "0.8.2"]);
  assert.equal(t.updater.snapshot("wordcraft").current, "0.7.0");

  // Summary with updated / failed / skipped counts.
  assert.equal(t.L.bulkResults.updated.length, 2);
  assert.equal(t.L.bulkResults.failed.length, 0);
  assert.equal(t.L.bulkResults.skipped.length, 0);
  assert.match(t.toastText(), /Update All finished · 2 updated · 0 failed · 0 skipped/);
  assert.ok(t.toastTexts().includes("PhotoCraft updated successfully (0.8.2 → 0.9.0)"),
    JSON.stringify(t.toastTexts()));
});

// Requirement 4/5/9: not-installed and up-to-date apps are never touched.
test("Update All skips applications that are not installed or already current", async () => {
  const t = setup({
    releases: RELEASES,
    // gridcraft is up to date, soundcraft is not installed at all.
    installed: { photocraft: ["0.8.2"], gridcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", gridcraft: "0.6.1" },
  });
  await t.L.refreshData();
  const installCalls = t.updater.calls.install.length;

  t.button().click();
  await waitIdle(t.L);

  assert.deepEqual(t.installs(), ["photocraft@0.9.0"]);
  assert.equal(t.updater.calls.install.length, installCalls + 1);
  assert.equal(t.updater.calls.select.length, 1);
  assert.deepEqual(t.updater.snapshot("gridcraft"), {
    installed: ["0.6.1"], selected: "0.6.1", current: "0.6.1", disk: ["0.6.1"],
  });
  assert.deepEqual(t.updater.snapshot("soundcraft"), {
    installed: [], selected: null, current: null, disk: [],
  });
});

// 6 + 10. One failure must not stop the others nor corrupt state.
test("A failing application does not stop the remaining updates", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"], gridcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1", gridcraft: "0.6.1" },
  });
  t.updater.failInstall.add("wordcraft");
  await t.L.refreshData();
  const photocraftBefore = t.updater.snapshot("photocraft");

  t.button().click();
  await waitIdle(t.L);

  assert.deepEqual(t.installs(), ["photocraft@0.9.0", "wordcraft@0.7.0"]);
  assert.deepEqual(t.selects(), ["photocraft@0.9.0"],
    "a failed install must not be activated");
  assert.equal(t.L.bulkResults.updated.length, 1);
  assert.equal(t.L.bulkResults.failed.length, 1);
  assert.match(t.toastText(), /Update All finished · 1 updated · 1 failed · 0 skipped/);
  assert.match(t.toastText(), /WordCraft could not be updated: install failed/);

  // The failed app keeps its previous version, current selection and files.
  assert.deepEqual(t.updater.snapshot("wordcraft"), {
    installed: ["0.6.1"], selected: "0.6.1", current: "0.6.1", disk: ["0.6.1"],
  });
  assert.equal(photocraftBefore.current, "0.8.2");
  assert.equal(t.updater.snapshot("photocraft").current, "0.9.0");
});

// If activation fails after a successful install the old version stays live.
test("A failed activation leaves the previous version current", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  t.updater.failSelect.add("wordcraft");
  await t.L.refreshData();

  t.button().click();
  await waitIdle(t.L);

  assert.equal(t.L.bulkResults.failed.length, 1);
  assert.equal(t.L.bulkResults.updated.length, 1);
  assert.match(t.toastText(), /WordCraft could not be updated: installed 0\.7\.0 but it could not be activated/,
    "the notification must say which phase failed");
  const word = t.updater.snapshot("wordcraft");
  assert.equal(word.current, "0.6.1", "the running version must not change");
  assert.equal(word.selected, "0.6.1");
  assert.deepEqual(word.disk, ["0.6.1", "0.7.0"]);
});

// 7 + duplicate protection.
test("The button is disabled and duplicate clicks are ignored while running", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  assert.equal(t.button().disabled, false);

  t.updater.gate = createGate();
  t.button().click();
  await settle(30);

  assert.equal(t.L.bulkRunning, true);
  assert.equal(t.button().disabled, true, "disabled while the bulk run is active");
  assert.equal(t.button().textContent, "Updating…");
  assert.equal(t.button().getAttribute("aria-busy"), "true");
  assert.equal(t.toastContainer().children.length, 0,
    "no notification before the run finishes");
  assert.match(t.status(), /Updating PhotoCraft 0\.8\.2 → 0\.9\.0 \(1 of 2\)/);

  // Duplicate requests while running are refused.
  const installsDuringRun = t.updater.calls.install.length;
  t.button().click();
  t.L.runBulkUpdate();
  await settle(10);
  assert.equal(t.updater.calls.install.length, installsDuringRun);

  t.updater.gate.release();
  t.updater.gate = null;
  await waitIdle(t.L);

  assert.equal(t.button().disabled, true,
    "both applications are current now, so there is nothing left to update");
  assert.equal(t.button().textContent, "Update All");
  assert.equal(t.button().hasAttribute("aria-busy"), false);
  assert.deepEqual(t.installs(), ["photocraft@0.9.0", "wordcraft@0.7.0"]);
});

// Progress names the application currently being updated.
test("Progress reports each application while the bulk update runs", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();

  const seen = [];
  t.updater.gate = createGate();
  t.button().click();
  await settle(30);
  seen.push(t.status());
  t.updater.gate.release();

  t.updater.gate = createGate();
  await settle(30);
  seen.push(t.status());
  t.updater.gate.release();

  await waitIdle(t.L);
  assert.match(seen[0], /PhotoCraft/);
  assert.match(seen[0], /1 of 2/);
  assert.match(seen[1], /WordCraft/);
  assert.match(seen[1], /2 of 2/);
  assert.doesNotMatch(t.status(), /\(2 of 2\)/, "progress is cleared when finished");
});

// 8. State and update availability are refreshed after completion.
test("The launcher refreshes installed state after a bulk update", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"] },
    selected: { photocraft: "0.8.2" },
  });
  await t.L.refreshData();
  const appsCallsBefore = t.updater.calls.apps;
  const releasesCallsBefore = t.updater.calls.releases.length;

  t.button().click();
  await waitIdle(t.L);

  assert.ok(t.updater.calls.apps > appsCallsBefore + 1,
    "installed state is re-read before and after the run");
  assert.ok(t.updater.calls.releases.length > releasesCallsBefore + 1,
    "release availability is re-checked during and after the run");
  assert.equal(t.L.installedData.photocraft.selected, "0.9.0");
  jsonEqual(t.L.installedData.photocraft.installed, ["0.8.2", "0.9.0"]);
  assert.equal(t.button().disabled, true, "no updates left -> disabled again");
});

// 8b. It stays enabled when confirmed updates remain (e.g. after a failure).
test("The button stays enabled when a confirmed update is still pending", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  t.updater.failInstall.add("wordcraft");
  await t.L.refreshData();

  t.button().click();
  await waitIdle(t.L);

  assert.equal(t.L.bulkResults.updated.length, 1);
  assert.equal(t.button().disabled, false,
    "wordcraft still has a verified newer release");
  jsonEqual(t.L.bulkCandidates().map(c => c.slug), ["wordcraft"]);
});

// 9. Never trust the queue captured when the button was clicked.
test("Applications that became current meanwhile are skipped, not reinstalled", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  jsonEqual(t.L.bulkCandidates().map(c => c.slug).sort(),
    ["photocraft", "wordcraft"]);

  // Someone else activates 0.9.0 for photocraft in the meantime.
  t.updater.setInstalled("photocraft", ["0.8.2", "0.9.0"], "0.9.0");

  t.button().click();
  await waitIdle(t.L);

  assert.deepEqual(t.installs(), ["wordcraft@0.7.0"]);
  assert.equal(t.L.bulkResults.skipped.length, 1);
  assert.match(t.toastText(), /Update All finished · 1 updated · 0 failed · 1 skipped/);
  assert.equal(t.toastTexts().filter(text => text.includes("PhotoCraft")).length, 0,
    `skipped applications must not be notified: ${JSON.stringify(t.toastTexts())}`);
  assert.equal(t.updater.current.photocraft, "0.9.0");
});

// An application uninstalled meanwhile is skipped instead of being installed.
test("Applications uninstalled meanwhile are skipped", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"] },
    selected: { photocraft: "0.8.2" },
  });
  await t.L.refreshData();
  t.updater.setInstalled("photocraft", []);

  t.button().click();
  await waitIdle(t.L);

  assert.deepEqual(t.installs(), []);
  assert.deepEqual(t.selects(), []);
  assert.equal(t.L.bulkResults.skipped.length, 1);
  assert.equal(t.toastTexts().filter(text => text.includes("PhotoCraft")).length, 0,
    "an application skipped as uninstalled gets no notification");
  assert.match(t.toastText(), /0 updated · 0 failed · 1 skipped/);
  assert.deepEqual(t.updater.snapshot("photocraft"), {
    installed: [], selected: null, current: null, disk: [],
  });
});

// If the authoritative state cannot be read, nothing is downloaded.
test("No installation is attempted when the installed state cannot be read", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  t.updater.failApps = true;

  t.button().click();
  await waitIdle(t.L);

  assert.deepEqual(t.installs(), []);
  assert.equal(t.L.bulkResults.failed.length, 2);
  assert.match(t.toastText(), /0 updated · 2 failed · 0 skipped/);
  assert.equal(t.toastTexts().filter(text => /installed state could not be read/.test(text)).length, 2);
});

// Confirmation before mutating the server, consistent with the other actions.
test("Declining the confirmation changes nothing", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"] },
    selected: { photocraft: "0.8.2" },
  });
  await t.L.refreshData();
  t.env.setConfirmAnswer(false);
  t.button().click();
  await settle(10);

  assert.equal(t.env.confirmCalls.length, 1);
  assert.match(t.env.confirmCalls[0], /Update 1 installed application/);
  assert.deepEqual(t.installs(), []);
  assert.equal(t.updater.current.photocraft, "0.8.2");
});

// Clicking a disabled button (or with nothing queued) is a no-op.
test("Clicking Update All with no confirmed update performs no request", async () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] } });
  const before = t.env.calls.length;
  t.button().click();
  await settle(5);
  assert.equal(t.env.calls.length, before, "no request before the first check");

  await t.L.refreshData();
  const afterCheck = t.env.calls.length;
  t.updater.setInstalled("photocraft", ["0.9.0"], "0.9.0");
  await t.L.refreshData();
  t.button().click();
  await settle(5);
  assert.equal(t.env.calls.filter(c => c.url === "/api/install").length, 0);
  assert.ok(t.env.calls.length >= afterCheck);
});

// Existing single-application flow keeps working unchanged.
test("The single-application update path is untouched", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"] },
    selected: { photocraft: "0.8.2" },
  });
  await t.L.refreshData();

  const card = t.env.document.querySelector("#grid");
  const trigger = card.querySelectorAll(".menu-trigger")[0];
  trigger.click();
  const menu = card.querySelectorAll(".app-menu")[0];
  const items = menu.children.map(child => child.textContent);
  assert.ok(items.includes("Update to latest version"), JSON.stringify(items));

  const updateItem = menu.children.find(c => c.textContent === "Update to latest version");
  updateItem.click();
  await waitIdle(t.L);

  assert.deepEqual(t.installs(), ["photocraft@0.9.0"]);
  assert.deepEqual(t.selects(), ["photocraft@0.9.0"]);
  assert.equal(t.updater.current.photocraft, "0.9.0");
});

// The card badge and the button agree about what counts as an update.
test("The update badge and Update All use the same verified information", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();

  const notes = t.env.document.querySelectorAll(".update-note").map(n => n.textContent);
  assert.equal(notes.length, 2, JSON.stringify(notes));
  assert.equal(t.L.bulkCandidates().length, 2);

  t.updater.setInstalled("photocraft", ["0.9.0"], "0.9.0");
  await t.L.refreshData();
  const remaining = t.env.document.querySelectorAll(".update-note").map(n => n.textContent);
  assert.equal(remaining.length, 1, JSON.stringify(remaining));
  jsonEqual(t.L.bulkCandidates().map(c => c.slug), ["wordcraft"]);
});

// ============================ Toast notifications ==========================

function hexTone(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || "").trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return { r: int >> 16 & 255, g: int >> 8 & 255, b: int & 255 };
}

const isGreen = value => {
  const tone = hexTone(value);
  return Boolean(tone) && tone.g > tone.r && tone.g > tone.b;
};
const isRed = value => {
  const tone = hexTone(value);
  return Boolean(tone) && tone.r > tone.g && tone.r > tone.b;
};

// Una traslazione orizzontale positiva sposta la notifica oltre il bordo
// destro del contenitore: è proprio quello che fa comparire la scrollbar.
function outwardTranslation(transform) {
  const pattern =
    /translateX\(\s*(-?[\d.]+)(?:px|%)?\s*\)|translate\(\s*(-?[\d.]+)(?:px|%)?\s*(?:,\s*-?[\d.]+(?:px|%)?)?\s*\)/g;
  for (const match of String(transform ?? "none").matchAll(pattern)) {
    const x = parseFloat(match[1] !== undefined ? match[1] : match[2]);
    if (x > 0) return x;
  }
  return null;
}

// Nomi del catalogo, per ritrovare le card nel DOM stub.
const NAMES = {
  photocraft: "PhotoCraft", vectorcraft: "VectorCraft", filmcraft: "FilmCraft",
  lightcraft: "LightCraft", pdfcraft: "PdfCraft", effectcraft: "EffectCraft",
  designcraft: "DesignCraft", figcraft: "FigCraft", texturecraft: "TextureCraft",
  materialcraft: "MaterialCraft", wordcraft: "WordCraft", soundcraft: "SoundCraft",
  deckcraft: "DeckCraft", cadcraft: "CADCraft", gridcraft: "GridCraft",
  "craft-anything": "Craft Anything",
};

function gridCard(t, slug) {
  const grid = t.env.document.querySelector("#grid");
  const card = grid.children[SLUG_LIST.indexOf(slug)];
  assert.ok(card, `the ${slug} card must be rendered`);
  assert.equal(card.querySelector("h3").textContent, NAMES[slug],
    "the cards must follow the catalog order");
  return card;
}

function downloadButtonOf(t, slug) {
  // Il selettore composto non è supportato dallo stub DOM: si filtra a mano.
  const button = gridCard(t, slug).querySelectorAll(".open")
    .find(node => node.tagName === "BUTTON" && node.textContent === "Download");
  assert.ok(button, `the ${slug} card must offer a Download action`);
  return button;
}

function actionButtonIn(row, label) {
  const button = row.querySelectorAll(".action-button")
    .find(node => node.tagName === "BUTTON" && node.textContent === label);
  assert.ok(button, `the release row must offer "${label}"`);
  return button;
}

function menuItem(t, slug, label) {
  const item = openMenu(t, slug).children
    .find(child => child.textContent === label);
  assert.ok(item, `the ${slug} menu must offer "${label}"`);
  return item;
}

function uninstallItem(t, slug) {
  return menuItem(t, slug, "Uninstall app");
}

const successesOf = t => t.toasts().filter(node =>
  node.className.includes("toast-success"));
const errorsOf = t => t.toasts().filter(node =>
  node.className.includes("toast-error"));
const messageOf = node => node.querySelector(".toast-message").textContent;

function openMenu(t, slug) {
  const index = SLUG_LIST.indexOf(slug);
  assert.ok(index >= 0, `unknown slug ${slug}`);
  const grid = t.env.document.querySelector("#grid");
  grid.querySelectorAll(".menu-trigger")[index].click();
  return grid.querySelectorAll(".app-menu")[index];
}

const menuLabels = menu => menu.children.map(child => child.textContent);
// 2. The summary panel above the cards is gone for good.
test("the bulk summary panel is replaced by notifications", async () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] },
                    selected: { photocraft: "0.8.2" } });
  await t.L.refreshData();
  t.button().click();
  await waitIdle(t.L);

  for (const selector of ["#bulk-panel", "#bulk-progress", "#bulk-summary",
                          "#bulk-results", ".bulk-panel", ".bulk-results"]) {
    assert.equal(t.env.document.querySelectorAll(selector).length, 0,
      `${selector} must no longer be rendered`);
  }
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  for (const name of ["bulk-panel", "bulk-progress", "bulk-summary",
                      "bulk-results"]) {
    assert.ok(!html.includes(name), `${name} must be removed from index.html`);
  }
  assert.ok(t.toasts().length > 0, "the result is a notification instead");
});

// 3. Successes are one green notification each, naming the version change.
test("each successful update produces one green notification", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.1", "0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  t.button().click();
  await waitIdle(t.L);

  const texts = t.toastTexts();
  assert.ok(texts.includes("PhotoCraft updated successfully (0.8.2 → 0.9.0)"),
    JSON.stringify(texts));
  assert.ok(texts.includes("WordCraft updated successfully (0.6.1 → 0.7.0)"),
    JSON.stringify(texts));

  const classes = t.toastClasses();
  assert.equal(classes.filter(c => c.includes("toast-success")).length, 2);
  assert.equal(classes.filter(c => c.includes("toast-error")).length, 0);
  const toast = t.toasts()[0];
  assert.equal(toast.getAttribute("role"), "status");
  assert.equal(toast.getAttribute("aria-live"), "polite");

  const success = ruleFor(".toast-success");
  assert.ok(success, ".toast-success must be styled");
  assert.ok(isGreen(success.declarations["border-left-color"]),
    `success must read as green: ${success.declarations["border-left-color"]}`);
});

// 4. Failures are error notifications naming the application and the reason.
test("a failed update produces an error notification", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  t.updater.failInstall.add("wordcraft");
  await t.L.refreshData();
  t.button().click();
  await waitIdle(t.L);

  assert.equal(t.toastClasses().filter(c => c.includes("toast-error")).length, 1);
  assert.equal(t.toastClasses().filter(c => c.includes("toast-success")).length, 1);
  assert.match(t.toastText(),
    /WordCraft could not be updated: install failed: download failed for wordcraft/);

  const failing = t.toasts().find(node => node.className.includes("toast-error"));
  assert.equal(failing.getAttribute("role"), "alert");
  assert.equal(failing.getAttribute("aria-live"), "assertive");

  const error = ruleFor(".toast-error");
  assert.ok(error && isRed(error.declarations["border-left-color"]),
    `failures must read as errors: ${error && error.declarations["border-left-color"]}`);
});

// 5. Skipped applications never generate a success notification.
test("skipped applications generate no success notification", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"], gridcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1", gridcraft: "0.6.1" },
  });
  // gridcraft gains a newer release before the check; wordcraft is updated
  // elsewhere in the meantime, so it becomes "skipped" during the run.
  t.updater.setReleases("gridcraft", ["0.6.1", "0.7.0"]);
  await t.L.refreshData();
  t.updater.setInstalled("wordcraft", ["0.6.1", "0.7.0"], "0.7.0");
  t.updater.failInstall.add("gridcraft");

  t.button().click();
  await waitIdle(t.L);

  const texts = t.toastTexts();
  assert.equal(texts.filter(text => text.includes("PhotoCraft")).length, 1,
    JSON.stringify(texts));
  assert.equal(texts.filter(text => text.includes("WordCraft")).length, 0,
    `a skipped application must not be notified: ${JSON.stringify(texts)}`);
  assert.equal(texts.filter(text => text.includes("GridCraft")).length, 1);
  assert.equal(t.toastClasses().filter(c => c.includes("toast-success")).length, 1);
  assert.equal(t.toastClasses().filter(c => c.includes("toast-error")).length, 1);
  assert.match(t.toastText(), /1 updated · 1 failed · 1 skipped/);
});

// 6. They stack in one vertical column and never overlap.
test("notifications stack vertically in a top-right overlay", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  t.button().click();
  await waitIdle(t.L);

  const container = t.toastContainer();
  const toasts = t.toasts();
  assert.ok(toasts.length >= 3, JSON.stringify(t.toastTexts()));
  assert.equal(container.children.length, toasts.length);
  assert.equal(JSON.stringify(toasts.map(node => container.children.indexOf(node))),
    JSON.stringify(toasts.map((_, index) => index)),
    "one below the other, in creation order, no interleaving");
  assert.equal(new Set(toasts).size, toasts.length, "each is its own node");

  const rule = ruleFor(".toast-container");
  assert.equal(rule.declarations.position, "fixed", "must overlay the interface");
  assert.ok(rule.declarations.top && rule.declarations.right, "top-right corner");
  assert.equal(rule.declarations["flex-direction"], "column", "stacked vertically");
  assert.ok(parseInt(rule.declarations.gap, 10) > 0, "a gap keeps them apart");
  assert.equal(rule.declarations["pointer-events"], "none",
    "the overlay must not intercept clicks meant for the interface");

  // Accessibility and keyboard behaviour: a labelled region that never steals
  // the focus away from the page.
  assert.equal(container.getAttribute("role"), "region");
  assert.equal(container.getAttribute("aria-label"), "Update notifications");
  assert.equal(container.getAttribute("tabindex"), null);
  assert.equal(toasts.every(node => node.getAttribute("tabindex") === null), true);
  assert.equal(toasts.every(node => node.querySelector(".toast-close")
    .getAttribute("aria-label") === "Dismiss notification"), true);
});

// 9. The cards cannot move: the overlay lives outside <main>.
test("notifications do not alter the application grid", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  const grid = t.env.document.querySelector("#grid");
  const structure = node => JSON.stringify(node, (key, value) =>
    key === "parent" || key === "classList" || key === "attributes" ||
    key === "createElement" || key === "dataset" || key === "style" ? undefined : value);
  const names = () => grid.children.map(card => card.querySelector("h3").textContent);
  const before = structure(grid);
  const beforeNames = names();
  assert.equal(beforeNames.length, 16, "the whole catalog is rendered");
  for (const name of ["FigCraft", "TextureCraft", "MaterialCraft", "Craft Anything"]) {
    assert.ok(beforeNames.includes(name), `${name} must be part of the catalog`);
  }

  // A notification on its own must not touch the grid at all.
  t.L.notify("VectorCraft updated successfully (0.19.0 → 0.21.0)", "success");
  assert.equal(structure(grid), before, "the grid subtree is untouched");

  // And not even a full bulk run may change the grid's shape: only the
  // refreshed content of the updated cards.
  t.button().click();
  await waitIdle(t.L);

  assert.ok(t.toasts().length >= 3);
  assert.equal(grid.children.length, beforeNames.length);
  assert.deepEqual(names(), beforeNames, "same cards, same order");
  assert.equal(grid.querySelectorAll(".toast").length, 0,
    "notifications are not rendered inside the grid");
  assert.equal(t.env.document.querySelector("main").querySelectorAll(".toast").length, 0,
    "the overlay is outside <main>, so it cannot shift the cards");
  assert.strictEqual(t.toastContainer().parent, t.env.document.body,
    "the overlay is a direct child of <body>");
});

// 7. Five seconds visible, then a smooth fade-out, then removed from the DOM.
test("notifications last five seconds and leave the DOM after the fade", async () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] },
                    selected: { photocraft: "0.8.2" } });
  assert.equal(t.L.TOAST_VISIBLE_MS, 5000);
  await t.L.refreshData();
  t.button().click();
  await waitIdle(t.L);

  const count = t.toasts().length;
  assert.ok(count >= 2);
  assert.equal(t.toasts().filter(n => n.classList.contains("toast-hide")).length, 0);

  t.env.advance(4999);
  assert.equal(t.toasts().length, count, "still visible just before 5s");
  assert.equal(t.toasts().filter(n => n.classList.contains("toast-hide")).length, 0);

  t.env.advance(1);
  assert.equal(t.toasts().length, count, "kept in the DOM while fading out");
  assert.equal(t.toasts().filter(n => n.classList.contains("toast-hide")).length, count);

  t.env.advance(t.L.TOAST_FADE_MS);
  assert.equal(t.toasts().length, 0, "removed from the DOM after the transition");
  assert.equal(t.toastContainer().children.length, 0);

  const toast = ruleFor(".toast");
  assert.match(toast.declarations.transition, /opacity/, "the fade-out is animated");
  const reduced = cssRules().filter(rule =>
    rule.selector.includes(".toast") && rule.declarations.transition === "none");
  assert.ok(reduced.length, "prefers-reduced-motion disables the animation");
});

// 8. Independent dismissal timers.
test("dismissing one notification does not affect the others", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  t.button().click();
  await waitIdle(t.L);

  const [first, second, third] = t.toasts();
  assert.ok(third, "expected at least three notifications");

  t.env.advance(2000);
  second.querySelector(".toast-close").click();
  assert.ok(second.classList.contains("toast-hide"), "the clicked one fades out");
  assert.equal(first.classList.contains("toast-hide"), false);
  assert.equal(third.classList.contains("toast-hide"), false);

  t.env.advance(t.L.TOAST_FADE_MS);
  assert.equal(t.toasts().includes(second), false, "the clicked one is gone");
  const survivors = t.toasts();
  assert.equal(survivors.length, 2);
  assert.strictEqual(survivors[0], first);
  assert.strictEqual(survivors[1], third);

  // The survivors keep their own schedule (created at t=0, 5s lifetime).
  t.env.advance(3000);
  assert.ok(first.classList.contains("toast-hide") &&
            third.classList.contains("toast-hide"),
  "they still expire on their own timers");
  t.env.advance(t.L.TOAST_FADE_MS);
  assert.equal(t.toasts().length, 0);
});

test("a new notification does not reset existing timers", async () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] },
                    selected: { photocraft: "0.8.2" } });
  await t.L.refreshData();
  t.button().click();
  await waitIdle(t.L);

  const original = t.toasts();
  assert.equal(original.length >= 2, true);
  t.env.advance(3000);

  t.L.notify("VectorCraft updated successfully (0.19.0 → 0.21.0)", "success");
  const deadlines = t.env.pendingTimers().map(timer => timer.at);
  assert.equal(deadlines.filter(at => at === 5000).length, original.length,
    "the existing timers keep their original deadlines");
  assert.equal(deadlines.filter(at => at === 8000).length, 1,
    "the new notification gets its own 5s timer");

  t.env.advance(2000);
  assert.equal(t.toasts().filter(n => n.classList.contains("toast-hide")).length,
    original.length);
  assert.equal(t.toasts().filter(n => !n.classList.contains("toast-hide")).length, 1);
});

// ============== Notification overflow, motion and shared styling ==========

// 11 / 15. L'animazione di chiusura non può mai allargare il contenitore.
test("dismissing a notification creates no horizontal overflow", async () => {
  const t = setup({ releases: RELEASES, installed: { photocraft: ["0.8.2"] },
                    selected: { photocraft: "0.8.2" } });
  await t.L.refreshData();
  t.button().click();
  await waitIdle(t.L);

  const toasts = t.toasts();
  assert.ok(toasts.length >= 2, JSON.stringify(t.toastTexts()));

  // Il pulsante di chiusura resta raggiungibile fino all'uscita dal DOM.
  const [victim] = toasts;
  const close = victim.querySelector(".toast-close");
  assert.ok(close, "every notification carries a close button");
  assert.equal(close.getAttribute("aria-label"), "Dismiss notification");
  close.click();
  assert.ok(victim.classList.contains("toast-hide"), "it fades out…");
  assert.ok(victim.querySelector(".toast-close"),
    "…without losing its close button behind a scrollbar");
  assert.ok(!t.toasts().some(node => node !== victim &&
                                   node.classList.contains("toast-hide")),
    "and without disturbing the stack");
  t.env.advance(t.L.TOAST_FADE_MS);
  assert.equal(t.toasts().includes(victim), false, "then it is removed");

  // Il contenitore è l'unico box scrollabile: con la sola overflow-y, il
  // browser calcolerebbe overflow-x come "auto" e la barra comparirebbe.
  const container = ruleFor(".toast-container");
  assert.match(container.declarations["overflow-x"], /^(hidden|clip)$/,
    "overflow-x must be declared explicitly, or it computes to auto");
  assert.equal(container.declarations["overflow-y"], "auto",
    "a long stack still scrolls vertically");
  assert.match(container.declarations.width,
    /min\(360px,\s*calc\(100vw - 32px\)\)/,
    "the overlay can never be wider than the viewport");
  assert.equal(ruleFor("body").declarations.overflow, undefined,
    "the fix is scoped to the overlay, not applied to the whole page");
  for (const name of Object.keys(container.declarations)) {
    assert.doesNotMatch(name, /margin/,
      `the overlay is positioned, not margined: ${name}`);
  }

  // Nessun fotogramma delle animazioni può uscire dalla larghezza del
  // contenitore: niente translateX positiva, niente scale sopra 1.
  const entrance = keyframes("toast-in") || {};
  const animated = [
    [".toast", ruleFor(".toast")],
    [".toast.toast-hide", ruleFor(".toast.toast-hide")],
    ["@keyframes toast-in from", entrance.from],
    ["@keyframes toast-in to", entrance.to],
  ];
  assert.ok(entrance.from, "the entrance animation must be declared");
  for (const [label, declarations] of animated) {
    if (!declarations) continue;
    const transform = declarations.transform || "none";
    assert.equal(outwardTranslation(transform), null,
      `${label} transform "${transform}" would overflow the container`);
    for (const match of String(transform).matchAll(/scale(?:x)?\(\s*([\d.]+)\s*\)/g)) {
      assert.ok(parseFloat(match[1]) <= 1,
        `${label} may only shrink: ${transform}`);
    }
  }
  assert.match(ruleFor(".toast").declarations.transition, /opacity/,
    "the dismissal stays a smooth fade");

  // Niente margini che sporgano dal contenitore.
  for (const name of Object.keys(ruleFor(".toast").declarations)) {
    assert.doesNotMatch(name, /margin/, `.toast must not be margined: ${name}`);
  }
});

// 17. Le preferenze di movimento sono rispettate.
test("reduced motion preferences disable the notification animations", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.match(html, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.ok(allRulesFor(".toast").some(rule =>
    rule.declarations.animation === "none" && rule.declarations.transition === "none"),
    "the entrance and the fade-out are both disabled");
  assert.ok(allRulesFor(".toast.toast-hide").some(rule =>
    rule.declarations.transform === "none"),
    "the dismissal keeps still too");
  const reduced = allRulesFor(".toast").find(rule =>
    rule.declarations.animation === "none");
  assert.equal(outwardTranslation(reduced.declarations.transform), null,
    "and no movement is reintroduced");
});

// 16. Una sola notifica condivisa per le tre operazioni.
test("every operation shares one container and one notification style", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { wordcraft: ["0.6.1"] },
    selected: { wordcraft: "0.6.1" },
  });
  await t.L.refreshData();

  t.button().click();                       // bulk update
  await waitIdle(t.L);
  downloadButtonOf(t, "photocraft").click(); // download / installazione
  await settle(60);
  uninstallItem(t, "wordcraft").click();     // disinstallazione
  await waitIdle(t.L);

  const containers = t.env.document.querySelectorAll(".toast-container");
  assert.equal(containers.length, 1, "one container for every operation");
  assert.strictEqual(containers[0], t.toastContainer());

  const toasts = t.toasts();
  assert.ok(toasts.length >= 4, JSON.stringify(t.toastTexts()));
  for (const toast of toasts) {
    assert.strictEqual(toast.parent, t.toastContainer(),
      "everything is stacked in the same overlay");
    assert.ok(toast.classList.contains("toast"), "shared base style");
    assert.ok(toast.querySelector(".toast-message"), "shared message node");
    assert.ok(toast.querySelector(".toast-close"), "shared close button");
    const modifiers = ["toast-success", "toast-error", "toast-info"]
      .filter(name => toast.classList.contains(name));
    assert.equal(modifiers.length, 1, `one modifier only: ${toast.className}`);
    assert.equal(toast.getAttribute("aria-live"),
      modifiers[0] === "toast-error" ? "assertive" : "polite");
  }

  const texts = t.toastTexts();
  assert.ok(texts.some(text => /updated successfully/.test(text)),
    JSON.stringify(texts));
  assert.ok(texts.some(text => /downloaded and installed successfully/.test(text)));
  assert.ok(texts.some(text => /uninstalled successfully/.test(text)));
  assert.equal(t.env.alerts.length, 0, "none of them falls back to alert()");
});

// ===================== Uninstall visibility in the dropdown ================

test("Uninstall is offered for installed applications", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.1", "0.8.2"], wordcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1" },
  });
  await t.L.refreshData();

  assert.ok(menuLabels(openMenu(t, "photocraft")).includes("Uninstall app"),
    "an application with several installed versions must offer Uninstall");
  assert.ok(menuLabels(openMenu(t, "wordcraft")).includes("Uninstall app"));
});

test("Uninstall is absent for applications that are not installed", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"] },
    selected: { photocraft: "0.8.2" },
  });
  await t.L.refreshData();

  // soundcraft is in the catalog and has releases, but is not installed.
  const soundcraft = openMenu(t, "soundcraft");
  const labels = menuLabels(soundcraft);
  assert.equal(labels.includes("Uninstall app"), false, JSON.stringify(labels));

  // the same for an application without any release data at all
  assert.equal(menuLabels(openMenu(t, "cadcraft")).includes("Uninstall app"), false);
});

test("Uninstall follows the installed list, not the selected version", async () => {
  // Versions are present on the server while nothing is selected: the
  // authoritative property is installed[], so Uninstall must be available.
  const t = setup({
    releases: RELEASES,
    installed: { soundcraft: ["0.6.1"] },
    selected: { soundcraft: null },
  });
  await t.L.refreshData();

  assert.equal(t.updater.snapshot("soundcraft").selected, null);
  assert.deepEqual(t.updater.snapshot("soundcraft").installed, ["0.6.1"]);
  assert.ok(menuLabels(openMenu(t, "soundcraft")).includes("Uninstall app"));
});

test("the other dropdown actions are unchanged", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.1", "0.8.2"], wordcraft: ["0.6.1"],
                 gridcraft: ["0.6.1"] },
    selected: { photocraft: "0.8.2", wordcraft: "0.6.1", gridcraft: "0.6.1" },
  });
  await t.L.refreshData();

  assert.equal(JSON.stringify(menuLabels(openMenu(t, "photocraft"))),
    JSON.stringify(["Manage versions", "Update to latest version",
                    "Uninstall app", "GitHub releases"]));
  assert.equal(JSON.stringify(menuLabels(openMenu(t, "gridcraft"))),
    JSON.stringify(["Manage versions", "Uninstall app", "GitHub releases"]),
    "an up-to-date application has no update entry");
  assert.equal(JSON.stringify(menuLabels(openMenu(t, "soundcraft"))),
    JSON.stringify(["Manage versions", "GitHub releases"]),
    "a not installed application has neither update nor uninstall entry");

  const source = openMenu(t, "soundcraft").children[1];
  assert.equal(source.href, "https://github.com/storytold/soundcraft/releases");
  assert.equal(source.target, "_blank");
  assert.equal(source.rel, "noopener noreferrer");
});

test("uninstalling from the dropdown still works", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { wordcraft: ["0.6.1"] },
    selected: { wordcraft: "0.6.1" },
  });
  await t.L.refreshData();

  const uninstall = openMenu(t, "wordcraft").children
    .find(child => child.textContent === "Uninstall app");
  uninstall.click();
  await waitIdle(t.L);

  assert.equal(JSON.stringify(t.updater.calls.uninstall),
    JSON.stringify(["wordcraft"]));
  assert.deepEqual(t.updater.snapshot("wordcraft"), {
    installed: [], selected: null, current: null, disk: [],
  });
  assert.equal(t.button().disabled, true);
  assert.equal(menuLabels(openMenu(t, "wordcraft")).includes("Uninstall app"), false,
    "the menu re-renders without Uninstall once the application is gone");
});

// ================== Download / installation notifications =================

// 18. One success notification, naming the application and the version.
test("a successful download notifies once with the name and version", async () => {
  const t = setup({ releases: RELEASES });
  await t.L.refreshData();
  assert.equal(t.toasts().length, 0, "nothing is notified before the click");

  downloadButtonOf(t, "photocraft").click();
  await settle(60);

  const successes = successesOf(t);
  assert.equal(successes.length, 1, JSON.stringify(t.toastTexts()));
  assert.equal(t.toasts().length, 1, "exactly one notification per operation");
  assert.equal(messageOf(successes[0]),
    "PhotoCraft 0.9.0 downloaded and installed successfully");
  assert.equal(successes[0].getAttribute("role"), "status");
  assert.equal(successes[0].getAttribute("aria-live"), "polite");
  assert.equal(t.env.alerts.length, 0, "the outcome is a notification, not an alert");

  // 21. L'installazione in sé non è cambiata: le stesse due richieste di prima.
  jsonEqual(t.installs(), ["photocraft@latest"]);
  jsonEqual(t.selects(), ["photocraft@0.9.0"]);
  assert.deepEqual(t.updater.snapshot("photocraft"), {
    installed: ["0.9.0"], selected: "0.9.0", current: "0.9.0", disk: ["0.9.0"],
  });
});

// 20. The notification waits for the whole operation, not for the request.
test("the success notification waits for the installation to finish", async () => {
  const t = setup({ releases: RELEASES });
  await t.L.refreshData();

  const gate = createGate();
  t.updater.gate = gate;
  const button = downloadButtonOf(t, "photocraft");
  button.click();
  await settle(30);

  assert.equal(t.updater.calls.install.length, 1, "the download is in flight");
  assert.equal(t.toasts().length, 0,
    "a download that has merely started is not a result");
  assert.equal(button.textContent, "Downloading...",
    "the loading indicator stays while it runs");
  assert.equal(button.disabled, true, "and the button stays locked");

  gate.release();
  t.updater.gate = null;
  await settle(60);

  assert.equal(t.toasts().length, 1, "the result arrives when it is a result");
  assert.ok(t.toasts()[0].className.includes("toast-success"));
});

// 19. A failure is one error notification, naming the reason.
test("a failed download reports one error and no success", async () => {
  const t = setup({ releases: RELEASES });
  t.updater.failInstall.add("photocraft");
  await t.L.refreshData();

  downloadButtonOf(t, "photocraft").click();
  await settle(60);

  assert.equal(t.toasts().length, 1);
  assert.equal(successesOf(t).length, 0);
  assert.equal(errorsOf(t).length, 1);
  assert.equal(messageOf(errorsOf(t)[0]),
    "PhotoCraft could not be installed: download failed for photocraft");
  assert.equal(errorsOf(t)[0].getAttribute("role"), "alert");
  assert.equal(errorsOf(t)[0].getAttribute("aria-live"), "assertive");
  assert.equal(t.env.alerts.length, 0);

  assert.deepEqual(t.updater.snapshot("photocraft").installed, [],
    "a failed download leaves nothing behind");
  const button = downloadButtonOf(t, "photocraft");
  assert.equal(button.disabled, false, "the button is usable again");
  assert.equal(button.textContent, "Download");
});

// The version may land on the server and still never be published.
test("a download that never gets activated is an error, not a success", async () => {
  const t = setup({ releases: RELEASES });
  t.updater.failSelect.add("photocraft");
  await t.L.refreshData();

  downloadButtonOf(t, "photocraft").click();
  await settle(60);

  assert.equal(successesOf(t).length, 0,
    "the files are on the server but the application is not usable yet");
  assert.equal(errorsOf(t).length, 1);
  assert.match(t.toastText(),
    /PhotoCraft could not be installed: activate failed for photocraft/);
  jsonEqual(t.installs(), ["photocraft@latest"]);
  jsonEqual(t.selects(), ["photocraft@0.9.0"]);
});

// A cancelled confirmation is not an outcome.
test("a cancelled download notifies nothing", async () => {
  const t = setup({ releases: RELEASES });
  await t.L.refreshData();
  t.env.setConfirmAnswer(false);

  downloadButtonOf(t, "photocraft").click();
  await settle(30);

  assert.equal(t.toasts().length, 0);
  assert.equal(t.env.alerts.length, 0);
  assert.equal(t.updater.calls.install.length, 0);
  assert.equal(t.env.confirmCalls.length, 1);
});

// The same notification covers the version picker's Install action.
test("installing a chosen version from the version modal notifies once", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { photocraft: ["0.8.2"] },
    selected: { photocraft: "0.8.2" },
  });
  await t.L.refreshData();

  menuItem(t, "photocraft", "Manage versions").click();
  await settle(40);
  const body = t.env.node("#version-modal-body");
  const row = body.children.find(node => {
    const strong = node.querySelector("strong");
    return strong && strong.textContent === "v0.9.0";
  });
  assert.ok(row, "the missing release is listed");
  const install = actionButtonIn(row, "Install");

  install.click();
  await waitIdle(t.L);

  const successes = successesOf(t);
  assert.equal(successes.length, 1, JSON.stringify(t.toastTexts()));
  assert.equal(messageOf(successes[0]),
    "PhotoCraft 0.9.0 downloaded and installed successfully");
  jsonEqual(t.installs(), ["photocraft@0.9.0"]);
  jsonEqual(t.selects(), [],
    "installation and activation stay separate operations, as before");
});

// ========================= Uninstall notifications ========================

// 22. One success notification, after the server confirms the removal.
test("a successful uninstall notifies once", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { wordcraft: ["0.6.0", "0.6.1"] },
    selected: { wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  assert.equal(t.toasts().length, 0);

  uninstallItem(t, "wordcraft").click();
  await waitIdle(t.L);

  const successes = successesOf(t);
  assert.equal(successes.length, 1, JSON.stringify(t.toastTexts()));
  assert.equal(t.toasts().length, 1, "exactly one notification per uninstall");
  assert.equal(messageOf(successes[0]), "WordCraft uninstalled successfully");
  assert.equal(successes[0].getAttribute("role"), "status");
  assert.equal(t.env.alerts.length, 0);

  jsonEqual(t.updater.calls.uninstall, ["wordcraft"]);
  assert.deepEqual(t.updater.snapshot("wordcraft"), {
    installed: [], selected: null, current: null, disk: [],
  });
});

// 23. A refused removal is an error that names the application and reason.
test("a failed uninstall reports one error and keeps the application", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { wordcraft: ["0.6.1"] },
    selected: { wordcraft: "0.6.1" },
  });
  t.updater.failUninstall.add("wordcraft");
  await t.L.refreshData();

  uninstallItem(t, "wordcraft").click();
  await waitIdle(t.L);

  assert.equal(t.toasts().length, 1);
  assert.equal(successesOf(t).length, 0);
  assert.equal(errorsOf(t).length, 1);
  assert.equal(messageOf(errorsOf(t)[0]),
    "WordCraft could not be uninstalled: uninstall failed for wordcraft");
  assert.equal(errorsOf(t)[0].getAttribute("role"), "alert");
  assert.equal(t.env.alerts.length, 0);

  assert.deepEqual(t.updater.snapshot("wordcraft"), {
    installed: ["0.6.1"], selected: "0.6.1", current: "0.6.1", disk: ["0.6.1"],
  }, "a failed uninstall changes nothing");
  assert.ok(menuLabels(openMenu(t, "wordcraft")).includes("Uninstall app"),
    "the action stays available after a failure");
});

// 24. Cancelling the confirmation is not an outcome.
test("a cancelled uninstall produces no notification and no request", async () => {
  const t = setup({
    releases: RELEASES,
    installed: { wordcraft: ["0.6.1"] },
    selected: { wordcraft: "0.6.1" },
  });
  await t.L.refreshData();
  t.env.setConfirmAnswer(false);

  uninstallItem(t, "wordcraft").click();
  await settle(30);

  assert.equal(t.toasts().length, 0, "cancelling notifies nothing");
  assert.equal(t.env.alerts.length, 0);
  assert.equal(t.updater.calls.uninstall.length, 0);
  assert.equal(t.env.confirmCalls.length, 1);
  assert.deepEqual(t.updater.snapshot("wordcraft").installed, ["0.6.1"]);
});

// 28. The hidden action is presentation only: the endpoint keeps validating.
test("the uninstall endpoint keeps validating on its own", async () => {
  const t = setup({ releases: RELEASES });
  await t.L.refreshData();

  // A soundcraft non installata non corrisponde alcuna voce Uninstall…
  assert.equal(
    menuLabels(openMenu(t, "soundcraft")).includes("Uninstall app"), false);

  // …ma una richiesta diretta arriva comunque al servizio, che giudica per
  // conto proprio: nascondere l'azione non è un controllo di accesso.
  const allowed = await t.updater.handle("POST", "/api/uninstall",
    { app: "soundcraft" });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, { app: "soundcraft", uninstalled: true });

  for (const app of ["../etc", "Photocraft", "photocraft/..", ""]) {
    const rejected = await t.updater.handle("POST", "/api/uninstall", { app });
    assert.equal(rejected.status, 400, `${JSON.stringify(app)} must be refused`);
    assert.equal(rejected.body.error, "Application not allowed");
  }
});

