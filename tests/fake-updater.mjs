// In-memory stand-in for updater/server.py. It reproduces the documented API
// contract and the version/current semantics of the real updater so the
// frontend tests assert real behaviour instead of mocked responses.

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SLUGS = [
  "photocraft", "vectorcraft", "filmcraft", "lightcraft", "pdfcraft",
  "effectcraft", "designcraft", "figcraft", "texturecraft", "materialcraft",
  "wordcraft", "soundcraft", "deckcraft", "cadcraft", "gridcraft",
  "craft-anything",
];

function versionKey(value) {
  return value.split(".").map(Number);
}

function compareVersions(a, b) {
  const aa = versionKey(a);
  const bb = versionKey(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const diff = (aa[i] || 0) - (bb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export class FakeUpdater {
  constructor({ releases = {}, installed = {}, selected = {} } = {}) {
    this.releases = {};
    for (const [slug, versions] of Object.entries(releases)) {
      this.releases[slug] = [...versions].sort(compareVersions).reverse();
    }
    this.registry = {};
    this.disk = {};
    this.current = {};
    for (const slug of SLUGS) {
      const versions = installed[slug] || [];
      const explicit = Object.prototype.hasOwnProperty.call(selected, slug);
      this.registry[slug] = {
        installed: [...versions].sort(compareVersions),
        selected: explicit ? selected[slug]
          : (versions.length ? versions[versions.length - 1] : null),
      };
      this.disk[slug] = new Set(versions);
      this.current[slug] = this.registry[slug].selected;
    }

    this.failReleases = new Set();
    this.failInstall = new Set();
    this.failSelect = new Set();
    this.failUninstall = new Set();
    this.failApps = false;
    this.gate = null;

    this.calls = { apps: 0, releases: [], install: [], select: [], uninstall: [] };
    this.active = 0;
    this.maxActive = 0;
  }

  // --- helpers used by the tests -----------------------------------------
  setInstalled(slug, versions, selected) {
    this.registry[slug].installed = [...versions].sort(compareVersions);
    this.disk[slug] = new Set(versions);
    this.registry[slug].selected = selected ?? null;
    this.current[slug] = this.registry[slug].selected;
  }

  setReleases(slug, versions) {
    this.releases[slug] = [...versions].sort(compareVersions).reverse();
  }

  snapshot(slug) {
    return {
      installed: [...this.registry[slug].installed],
      selected: this.registry[slug].selected,
      current: this.current[slug],
      disk: [...this.disk[slug]].sort(compareVersions),
    };
  }

  releaseList(slug) {
    const installed = this.registry[slug].installed;
    return this.releases[slug].map(version => ({
      version,
      asset: `${slug}-web-${version}.zip`,
      url: `https://example.invalid/${slug}-web-${version}.zip`,
      size: 1024,
      published_at: "2026-01-01T00:00:00Z",
      tag: `v${version}`,
      installed: installed.includes(version) && this.disk[slug].has(version),
    }));
  }

  // --- HTTP surface -------------------------------------------------------
  async handle(method, url, body) {
    const [path, queryString] = url.split("?");
    const query = new URLSearchParams(queryString || "");

    if (method === "GET" && path === "/api/apps") {
      this.calls.apps += 1;
      if (this.failApps) return { status: 400, body: { error: "apps unavailable" } };
      const apps = {};
      for (const slug of SLUGS) {
        const entry = this.registry[slug];
        apps[slug] = {
          repo: slug,
          selected: entry.selected,
          installed: entry.installed.filter(v => this.disk[slug].has(v)),
        };
      }
      return { status: 200, body: { apps } };
    }

    if (method === "GET" && path === "/api/releases") {
      const slug = query.get("app");
      this.calls.releases.push(slug);
      if (!SLUGS.includes(slug)) {
        return { status: 400, body: { error: "Application not allowed" } };
      }
      if (this.failReleases.has(slug)) {
        return { status: 400, body: { error: `release check failed for ${slug}` } };
      }
      return {
        status: 200,
        body: { app: slug, releases: this.releaseList(slug), source: "cache", stale: false },
      };
    }

    if (method === "POST" && path === "/api/install") {
      const slug = body?.app;
      let version = body?.version;
      this.calls.install.push({ app: slug, version });
      if (!SLUGS.includes(slug)) return { status: 400, body: { error: "Application not allowed" } };
      if (typeof version !== "string") return { status: 400, body: { error: "Invalid version" } };

      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        if (this.gate) await this.gate.promise;

        if (!VERSION_RE.test(version) && version !== "latest") {
          return { status: 400, body: { error: "Invalid application or version" } };
        }
        const releases = this.releases[slug] || [];
        if (version === "latest") {
          if (!releases.length) return { status: 400, body: { error: "No web releases available" } };
          version = releases[0];
        }
        if (!releases.includes(version)) {
          return { status: 400, body: { error: "Web release not found on GitHub" } };
        }
        if (this.failInstall.has(slug)) {
          // A failed download leaves nothing behind on the server.
          return { status: 400, body: { error: `download failed for ${slug}` } };
        }
        if (this.disk[slug].has(version)) {
          return { status: 400, body: { error: "Version already installed" } };
        }

        this.disk[slug].add(version);
        const entry = this.registry[slug];
        if (!entry.installed.includes(version)) {
          entry.installed = [...entry.installed, version].sort(compareVersions);
        }
        if (entry.selected === null) {
          entry.selected = version;
          this.current[slug] = version;
        }
        return { status: 200, body: { app: slug, version, installed: true } };
      } finally {
        this.active -= 1;
      }
    }

    if (method === "POST" && path === "/api/select") {
      const slug = body?.app;
      const version = body?.version;
      this.calls.select.push({ app: slug, version });
      if (!SLUGS.includes(slug)) return { status: 400, body: { error: "Application not allowed" } };
      if (typeof version !== "string") return { status: 400, body: { error: "Invalid version" } };
      if (!VERSION_RE.test(version)) {
        return { status: 400, body: { error: "Invalid application or version" } };
      }
      const entry = this.registry[slug];
      if (!entry.installed.includes(version) || !this.disk[slug].has(version)) {
        return { status: 400, body: { error: "Version is not installed" } };
      }
      if (this.failSelect.has(slug)) {
        return { status: 400, body: { error: `activate failed for ${slug}` } };
      }
      entry.selected = version;
      this.current[slug] = version;
      return { status: 200, body: { app: slug, selected: version } };
    }

    if (method === "POST" && path === "/api/uninstall") {
      const slug = body?.app;
      this.calls.uninstall.push(slug);
      if (!SLUGS.includes(slug)) {
        return { status: 400, body: { error: "Application not allowed" } };
      }
      if (this.failUninstall.has(slug)) {
        // Come nel servizio reale: un errore lascia registro, versioni e
        // collegamento current esattamente come erano prima della richiesta.
        return { status: 400, body: { error: `uninstall failed for ${slug}` } };
      }
      this.registry[slug] = { installed: [], selected: null };
      this.disk[slug] = new Set();
      this.current[slug] = null;
      return { status: 200, body: { app: slug, uninstalled: true } };
    }

    return { status: 404, body: { error: "Endpoint not found" } };
  }
}

export const SLUG_LIST = SLUGS;
