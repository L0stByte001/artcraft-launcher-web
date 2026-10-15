#!/usr/bin/env python3
import json
import os
import re
import shutil
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path("/opt/artcraft")
WEB = BASE / "www"
APPS_DIR = WEB / "apps"
DATA = BASE / "data"
REGISTRY = DATA / "registry.json"
LOCK = threading.RLock()

# Slug e repository sono definiti dal server, mai forniti come percorso.
APPS = {
    "photocraft":  {"repo": "photocraft",  "version": "0.8.2"},
    "vectorcraft": {"repo": "vectorcraft", "version": "0.10.0"},
    "filmcraft":   {"repo": "filmcraft",   "version": "0.7.2"},
    "lightcraft":  {"repo": "lightcraft",  "version": "0.7.1"},
    "pdfcraft":    {"repo": "pdfcraft",    "version": "0.7.1"},
    "effectcraft": {"repo": "effectcraft", "version": "0.9.2"},
    "designcraft": {"repo": "designcraft", "version": "0.7.1"},
    "wordcraft":   {"repo": "wordcraft",   "version": "0.6.1"},
    "deckcraft":   {"repo": "deckcraft",   "version": "0.6.1"},
    "gridcraft":   {"repo": "gridcraft",   "version": "0.6.1"},
    "cadcraft":    {"repo": "cadcraft",    "version": "0.6.2"},
    "soundcraft":  {"repo": "soundcraft",  "version": "0.6.1"},
}

def version_key(v):
    return tuple(int(x) for x in v.split("."))

def app_root(slug):
    if slug not in APPS:
        raise ValueError("Applicazione non consentita")
    return APPS_DIR / slug

def version_dir(slug, version):
    if slug not in APPS or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Applicazione o versione non valida")
    return app_root(slug) / "versions" / version

def load_registry():
    if not REGISTRY.exists():
        return {"apps": {}}
    with REGISTRY.open() as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("apps"), dict):
        raise ValueError("Registro non valido")
    return data

def save_registry(data):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY.with_suffix(".tmp")
    with tmp.open("w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, REGISTRY)

CACHE_TTL = 6 * 60 * 60

def github_releases(slug):
    repo = APPS[slug]["repo"]
    url = f"https://api.github.com/repos/storytold/{repo}/releases?per_page=100"
    req = urllib.request.Request(url, headers={
        "User-Agent": "ArtCraft-Hub-Updater/1.0",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=20) as response:
        releases = json.load(response)

    found = {}
    for release in releases:
        for asset in release.get("assets", []):
            name = asset.get("name", "")
            match = re.fullmatch(
                re.escape(repo) + r"-web-(\d+\.\d+\.\d+)\.zip", name
            )
            if match:
                version = match.group(1)
                found[version] = {
                    "version": version,
                    "asset": name,
                    "url": asset["browser_download_url"],
                    "size": asset.get("size"),
                    "published_at": release.get("published_at"),
                    "tag": release.get("tag_name"),
                }
    return sorted(found.values(), key=lambda x: version_key(x["version"]),
                  reverse=True)

def cached_github_releases(slug):
    """Restituisce le release dalla cache; usa GitHub solo se necessario."""
    if slug not in APPS:
        raise ValueError("Applicazione non consentita")

    cache_file = DATA / "release-cache" / f"{slug}.json"
    cached = None

    try:
        cached = json.loads(cache_file.read_text())
        if not isinstance(cached, dict) or not isinstance(cached.get("releases"), list):
            cached = None
    except (OSError, ValueError, TypeError):
        cached = None

    now = __import__("time").time()
    if cached and now - float(cached.get("fetched_at", 0)) < CACHE_TTL:
        return cached["releases"], "cache"

    try:
        releases = github_releases(slug)
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "fetched_at": now,
            "releases": releases
        }, indent=2))
        os.replace(tmp, cache_file)
        return releases, "online"
    except Exception:
        if cached:
            return cached["releases"], "cache-stale"
        raise

def inspect_zip(zf, destination):
    # Blocca path traversal, symlink e archivi eccessivamente grandi.
    infos = zf.infolist()
    if len(infos) > 20000:
        raise ValueError("Archivio con troppi file")
    total = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        path = Path(name)
        mode = (info.external_attr >> 16) & 0o170000
        if path.is_absolute() or ".." in path.parts or mode == 0o120000:
            raise ValueError("Percorso non sicuro nell'archivio")
        total += info.file_size
        if total > 4 * 1024**3:
            raise ValueError("Archivio decompresso troppo grande")
    zf.extractall(destination)

def install_version(slug, version):
    if slug not in APPS:
        raise ValueError("Applicazione non consentita")
    releases, _source = cached_github_releases(slug)
    release = next((r for r in releases if r["version"] == version), None)
    if release is None:
        raise ValueError("Release web non trovata su GitHub")

    target = version_dir(slug, version)
    if target.exists():
        raise ValueError("Versione già installata")

    target.parent.mkdir(parents=True, exist_ok=True)
    temp_parent = target.parent
    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=temp_parent))
    archive = staging / "release.zip"
    extracted = staging / "extracted"
    extracted.mkdir()

    try:
        req = urllib.request.Request(release["url"], headers={
            "User-Agent": "ArtCraft-Hub-Updater/1.0"
        })
        with urllib.request.urlopen(req, timeout=120) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)

        with zipfile.ZipFile(archive) as zf:
            if zf.testzip() is not None:
                raise ValueError("Archivio ZIP danneggiato")
            inspect_zip(zf, extracted)

        # Cerca la directory che contiene index.html.
        candidates = [p.parent for p in extracted.rglob("index.html")
                      if p.is_file()]
        if not candidates:
            raise ValueError("Nell'archivio non è presente index.html")
        source = min(candidates, key=lambda p: len(p.parts))

        # Pubblica solo dopo download, verifica ed estrazione completati.
        shutil.copytree(source, target)
        data = load_registry()
        app = data["apps"].setdefault(slug, {"installed": [], "selected": None})
        if version not in app["installed"]:
            app["installed"].append(version)
        app["installed"].sort(key=version_key)
        if app["selected"] is None:
            root = app_root(slug)
            current = root / "current"
            temporary = root / ".current-new"
            temporary.unlink(missing_ok=True)
            temporary.symlink_to(Path("versions") / version)
            os.replace(temporary, current)
            app["selected"] = version
        save_registry(data)
        return {"app": slug, "version": version, "installed": True}
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)

def initialize_registry():
    data = load_registry()
    for slug, info in APPS.items():
        root = app_root(slug)
        versions_root = root / "versions"
        versions_root.mkdir(parents=True, exist_ok=True)
        entry = data["apps"].setdefault(
            slug, {"installed": [], "selected": None}
        )

        # Migra una copia della versione attualmente pubblicata, senza
        # cancellare o modificare i file in uso.
        initial = info["version"]
        target = version_dir(slug, initial)
        old_index = root / "index.html"
        if not target.exists() and old_index.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.mkdir()
            for item in root.iterdir():
                if item.name in ("versions", "index.html"):
                    continue
                dest = target / item.name
                if item.is_dir():
                    shutil.copytree(item, dest, dirs_exist_ok=True)
                elif item.is_file():
                    shutil.copy2(item, dest)
            shutil.copy2(old_index, target / "index.html")

        if target.is_dir() and (target / "index.html").is_file():
            if initial not in entry["installed"]:
                entry["installed"].append(initial)
        entry["installed"] = sorted(set(entry["installed"]),
                                    key=version_key)
        if entry["selected"] not in entry["installed"]:
            entry["selected"] = initial if initial in entry["installed"] else (
                entry["installed"][-1] if entry["installed"] else None
            )
    save_registry(data)

class Handler(BaseHTTPRequestHandler):
    server_version = "ArtCraftUpdater/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Content-Length non valido")
        if length <= 0 or length > 16384:
            raise ValueError("Dimensione richiesta non valida")
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError("JSON deve essere un oggetto")
        return data

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            with LOCK:
                data = load_registry()
                if parsed.path == "/health":
                    return self.send_json(200, {"ok": True})
                if parsed.path == "/api/apps":
                    result = {}
                    for slug, meta in APPS.items():
                        entry = data["apps"].get(slug, {})
                        installed = entry.get("installed", [])
                        result[slug] = {
                            "repo": meta["repo"],
                            "selected": entry.get("selected"),
                            "installed": [
                                v for v in installed
                                if version_dir(slug, v).is_dir()
                            ],
                        }
                    return self.send_json(200, {"apps": result})
                if parsed.path == "/api/releases":
                    slug = query.get("app", [""])[0]
                    if slug not in APPS:
                        raise ValueError("Applicazione non consentita")
                    releases, source = cached_github_releases(slug)
                    installed = data["apps"].get(slug, {}).get("installed", [])
                    for release in releases:
                        release["installed"] = (
                            release["version"] in installed and
                            version_dir(slug, release["version"]).is_dir()
                        )
                    return self.send_json(200, {
                        "app": slug,
                        "releases": releases,
                        "source": source,
                        "stale": source == "cache-stale"
                    })
            return self.send_json(404, {"error": "Endpoint inesistente"})
        except Exception as exc:
            return self.send_json(400, {"error": str(exc)})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ("/api/install", "/api/select",
                               "/api/delete", "/api/uninstall"):
            return self.send_json(404, {"error": "Endpoint inesistente"})

        try:
            payload = self.read_json()
            slug = payload.get("app")
            version = payload.get("version")

            if slug not in APPS:
                raise ValueError("Applicazione non consentita")

            with LOCK:
                data = load_registry()
                entry = data["apps"].setdefault(
                    slug, {"installed": [], "selected": None}
                )

                if parsed.path == "/api/uninstall":
                    # Rimuove l'intera app, incluse le versioni e i file legacy.
                    root = app_root(slug)
                    shutil.rmtree(root, ignore_errors=False)
                    root.mkdir(parents=True, exist_ok=True)
                    data["apps"][slug] = {
                        "installed": [],
                        "selected": None
                    }
                    save_registry(data)
                    return self.send_json(200, {
                        "app": slug, "uninstalled": True
                    })

                if parsed.path == "/api/install":
                    if version == "latest":
                        releases, _source = cached_github_releases(slug)
                        if not releases:
                            raise ValueError("Nessuna release web disponibile")
                        version = releases[0]["version"]

                    if not isinstance(version, str):
                        raise ValueError("Versione non valida")

                    result = install_version(slug, version)
                    return self.send_json(200, result)

                if not isinstance(version, str):
                    raise ValueError("Versione non valida")

                target = version_dir(slug, version)

                if parsed.path == "/api/select":
                    if version not in entry["installed"] or not (
                        target / "index.html"
                    ).is_file():
                        raise ValueError("Versione non installata")

                    root = app_root(slug)
                    current = root / "current"
                    temporary = root / ".current-new"
                    temporary.unlink(missing_ok=True)
                    temporary.symlink_to(Path("versions") / version)
                    os.replace(temporary, current)

                    entry["selected"] = version
                    save_registry(data)
                    return self.send_json(200, {
                        "app": slug, "selected": version
                    })

                if parsed.path == "/api/delete":
                    if entry.get("selected") == version:
                        raise ValueError(
                            "Seleziona prima un'altra versione oppure "
                            "disinstalla l'intera applicazione"
                        )

                    if version not in entry["installed"] or not target.is_dir():
                        raise ValueError("Versione non installata")

                    shutil.rmtree(target)
                    entry["installed"].remove(version)
                    save_registry(data)
                    return self.send_json(200, {
                        "app": slug, "deleted": version
                    })

            return self.send_json(404, {"error": "Endpoint inesistente"})

        except Exception as exc:
            return self.send_json(400, {"error": str(exc)})

def main():
    DATA.mkdir(parents=True, exist_ok=True)
    initialize_registry()
    # Solo loopback: il servizio non è esposto direttamente sulla LAN.
    server = ThreadingHTTPServer(("0.0.0.0", 8090), Handler)
    print("ArtCraft updater in ascolto su 0.0.0.0:8090", flush=True)
    server.serve_forever()

if __name__ == "__main__":
    main()
