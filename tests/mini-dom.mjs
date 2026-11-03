// Minimal dependency-free DOM stub + launcher loader used by the frontend
// tests. It implements only the browser APIs that www/index.html uses, so the
// tests exercise the real launcher script instead of a reimplementation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INDEX_HTML = path.join(HERE, "..", "www", "index.html");

class ClassList {
  constructor(node) { this.node = node; }
  _list() { return (this.node.className || "").split(/\s+/).filter(Boolean); }
  _set(list) { this.node.className = [...new Set(list)].join(" "); }
  add(...names) { this._set([...this._list(), ...names]); }
  remove(...names) {
    this._set(this._list().filter(name => !names.includes(name)));
  }
  contains(name) { return this._list().includes(name); }
  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this.add(name); else this.remove(name);
    return want;
  }
}

class Node {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = "";
    this.id = "";
    this._text = null;
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.classList = new ClassList(this);
  }

  get childElementCount() { return this.children.length; }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map(child => child.textContent).join("");
  }

  set textContent(value) {
    this._text = value === undefined ? "" : String(value);
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name === "id") this.id = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) { return this.attributes.has(name); }

  removeAttribute(name) { this.attributes.delete(name); }

  append(...nodes) {
    for (const node of nodes) {
      if (node === undefined || node === null) continue;
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = nodes.filter(node => node !== undefined && node !== null);
    for (const child of this.children) child.parent = this;
  }

  insertBefore(node, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    node.parent = this;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  remove() {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
    }
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  focus() { this.focused = true; }

  dispatch(type, event = {}) {
    const fake = {
      type,
      target: this,
      currentTarget: this,
      stopPropagation() {},
      preventDefault() {},
      key: event.key,
      ...event,
    };
    for (const handler of [...(this.listeners.get(type) || [])]) {
      handler(fake);
    }
  }

  click() { this.dispatch("click"); }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
}

// Static markup of www/index.html, limited to the nodes the script touches.
function buildDocument() {
  const doc = new Node("#document");

  const body = new Node("body");
  const main = new Node("main");
  doc.append(body);
  body.append(main);

  const toolbar = new Node("div");
  toolbar.className = "toolbar";
  const filters = new Node("div");
  filters.className = "filters";
  filters.id = "filters";
  for (const name of ["All", "Creative", "Productivity", "Technical", "Audio & Video"]) {
    const button = new Node("button");
    button.className = name === "All" ? "filter active" : "filter";
    button.dataset.category = name;
    button.textContent = name;
    filters.append(button);
  }
  const search = new Node("input");
  search.id = "search";
  search.type = "search";
  search.value = "";
  // "Update All" e "Check updates" li crea lo script, ai lati della ricerca.
  toolbar.append(filters, search);

  const count = new Node("h2");
  count.id = "count";
  count.textContent = "12 APPLICATIONS";

  const syncStatus = new Node("p");
  syncStatus.id = "sync-status";
  syncStatus.textContent = "Applications available";

  const grid = new Node("section");
  grid.id = "grid";
  grid.className = "grid";
  main.append(toolbar, count, syncStatus, grid);

  const toastContainer = new Node("div");
  toastContainer.id = "toast-container";
  toastContainer.className = "toast-container";
  toastContainer.setAttribute("role", "region");
  toastContainer.setAttribute("aria-label", "Update notifications");
  body.append(toastContainer);

  const backdrop = new Node("div");
  backdrop.id = "version-modal-backdrop";
  backdrop.className = "modal-backdrop";
  backdrop.hidden = true;
  const title = new Node("h3");
  title.id = "version-modal-title";
  const subtitle = new Node("p");
  subtitle.id = "version-modal-subtitle";
  const icon = new Node("img");
  icon.id = "version-modal-icon";
  const close = new Node("button");
  close.id = "version-modal-close";
  const modalBody = new Node("div");
  modalBody.id = "version-modal-body";
  backdrop.append(icon, title, subtitle, close, modalBody);
  body.append(backdrop);

  doc.body = body;
  doc.createElement = tag => new Node(tag);
  return doc;
}

// The launcher lives in the single inline <script> of index.html.
export function launcherScript(source = null) {
  const html = source ?? fs.readFileSync(INDEX_HTML, "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(code => code.includes("const apps = ["));
  if (blocks.length !== 1) {
    throw new Error(`Expected one launcher <script> block, found ${blocks.length}`);
  }
  return blocks[0];
}

const EXPORT_FOOTER = `
;globalThis.__launcher = {
  get bulkRunning() { return bulkRunning; },
  get loading() { return loading; },
  get actionRunning() { return actionRunning; },
  get updateCheck() { return updateCheck; },
  get releaseChecked() { return releaseChecked; },
  get releaseData() { return releaseData; },
  get installedData() { return installedData; },
  get bulkResults() { return bulkResults; },
  notify,
  refreshData,
  runBulkUpdate,
  bulkCandidates,
  pendingUpdateFor,
  render,
  TOAST_VISIBLE_MS,
  TOAST_FADE_MS,
};`;

// A waiting gate lets a test freeze the bulk loop and inspect running state.
export function createGate() {
  const gate = {};
  gate.promise = new Promise(resolve => { gate.release = resolve; });
  return gate;
}

/**
 * Load the real launcher script against the stub DOM and a stubbed fetch.
 * `options.updater` is a function (method, url, body) -> {status, body}.
 */
export function loadLauncher({ updater, confirmAnswer = true } = {}) {
  const document = buildDocument();
  const frames = [];
  const alerts = [];
  const calls = [];
  const timers = [];
  let timerSeq = 0;
  let clock = 0;
  let confirmCalls = [];

  const sandbox = {
    document,
    console,
    fetch: async (url, options = {}) => {
      const method = (options.method || "GET").toUpperCase();
      let body = null;
      if (options.body) {
        try { body = JSON.parse(options.body); } catch { body = options.body; }
      }
      calls.push({ method, url, body });
      const result = await updater(method, url, body);
      const status = result.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => result.body,
      };
    },
    alert: message => { alerts.push(message); },
    confirm: message => { confirmCalls.push(message); return confirmAnswer; },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    // Orologio virtuale: i test fanno scorrere i 5s delle notifiche senza
    // aspettare tempo reale, e ogni timer resta indipendente.
    setTimeout: (fn, ms = 0) => {
      const timer = { id: ++timerSeq, fn, at: clock + Number(ms), cancelled: false, fired: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: id => {
      const timer = timers.find(item => item.id === id);
      if (timer) timer.cancelled = true;
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(launcherScript() + EXPORT_FOOTER, context, {
    filename: "www/index.html",
  });

  const flushFrames = () => {
    let guard = 0;
    while (frames.length && guard++ < 10) {
      const callback = frames.shift();
      callback();
    }
  };

  // Fa scorrere l'orologio virtuale di `ms` e scatena i timer scaduti,
  // in ordine di scadenza, includendo quelli pianificati durante il passo.
  const advance = (ms) => {
    const target = clock + Number(ms);
    for (let guard = 0; guard < 1000; guard++) {
      const due = timers
        .filter(timer => !timer.cancelled && !timer.fired && timer.at <= target)
        .sort((a, b) => a.at - b.at);
      if (!due.length) break;
      const timer = due[0];
      timer.fired = true;
      clock = Math.max(clock, timer.at);
      timer.fn();
    }
    clock = target;
  };

  const pendingTimers = () => timers.filter(t => !t.cancelled && !t.fired);

  return {
    document,
    launcher: sandbox.__launcher,
    calls,
    alerts,
    timers,
    pendingTimers,
    advance,
    get confirmCalls() { return confirmCalls; },
    setConfirmAnswer: value => { confirmAnswer = value; },
    flushFrames,
    node: selector => document.querySelector(selector),
    toasts: () => document.querySelectorAll(".toast"),
  };
}

export { Node };

// Regole CSS del foglio di stile incluso in index.html, per le asserzioni
// sulla disposizione (i test DOM non hanno un motore di layout).
export function cssRules(source = null) {
  const html = source ?? fs.readFileSync(INDEX_HTML, "utf8");
  const style = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map(match => match[1]).join("\n");
  const stripped = style.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    if (!selector || selector.startsWith("@")) continue;
    const declarations = {};
    for (const part of match[2].split(";")) {
      const [name, ...rest] = part.split(":");
      if (!name || !rest.length) continue;
      declarations[name.trim()] = rest.join(":").trim();
    }
    rules.push({ selector, declarations });
  }
  return rules;
}

export function ruleFor(selector, source = null) {
  return cssRules(source).find(rule => rule.selector === selector) || null;
}

// Regole dichiarate più volte (base + media query): `ruleFor` si ferma alla
// prima, queste servono ad affermare le override di prefers-reduced-motion.
export function allRulesFor(selector, source = null) {
  return cssRules(source).filter(rule => rule.selector === selector);
}

// Blocchi @keyframes, non parsati da cssRules perché annidati. Restituisce
// { from: {...}, to: {...}, "0%": {...}, "100%": {...} } oppure null.
export function keyframes(name, source = null) {
  const html = source ?? fs.readFileSync(INDEX_HTML, "utf8");
  const style = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map(match => match[1]).join("\n");
  const stripped = style.replace(/\/\*[\s\S]*?\*\//g, "");
  const marker = stripped.indexOf(`@keyframes ${name}`);
  if (marker < 0) return null;

  const open = stripped.indexOf("{", marker);
  let depth = 0;
  let end = -1;
  for (let i = open; i < stripped.length; i++) {
    if (stripped[i] === "{") depth += 1;
    else if (stripped[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;

  const steps = {};
  const body = stripped.slice(open + 1, end);
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = {};
    for (const part of match[2].split(";")) {
      const [property, ...rest] = part.split(":");
      if (!property || !rest.length) continue;
      declarations[property.trim()] = rest.join(":").trim();
    }
    for (const selector of match[1].split(",")) {
      steps[selector.trim()] = declarations;
    }
  }
  return steps;
}
