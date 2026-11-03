"""Tests for the updater endpoints used by the launcher's "Update All".

They cover the server-side guarantees the bulk update relies on: identifiers
and versions are validated by the server, downloads never trust the client,
archives are checked for traversal, a failed install leaves the previous
version and the registry untouched, and installing a newer version never
removes or re-selects an existing one.

Run with:
    python -m unittest discover -s tests -v
or, inside the deployment image (symlink-sensitive cases run in full):
    docker run --rm -v "$PWD:/src" -w /src python:3.13-slim \\
        python -m unittest discover -s tests -v
"""
import http.client
import io
import json
import os
import pathlib
import shutil
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer

import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "updater"))

import server  # noqa: E402


def zip_bytes(entries, root="web"):
    """Build a release archive: {root}/index.html plus the given files."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, payload in entries.items():
            archive.writestr(f"{root}/{name}", payload)
    return buffer.getvalue()


def release_entry(slug, version):
    return {
        "version": version,
        "asset": f"{slug}-web-{version}.zip",
        "url": f"https://download.invalid/{slug}-web-{version}.zip",
        "size": 10,
        "published_at": "2026-01-01T00:00:00Z",
        "tag": f"v{version}",
    }


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, size=-1):
        if self.offset >= len(self.payload):
            return b""
        chunk = self.payload[self.offset:self.offset + (size if size and size > 0 else len(self.payload))]
        self.offset += len(chunk)
        return chunk


class UpdaterTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="artcraft-updater-test-"))
        self._saved = (server.BASE, server.WEB, server.APPS_DIR,
                       server.DATA, server.REGISTRY)
        server.BASE = self.tmp
        server.WEB = self.tmp / "www"
        server.APPS_DIR = server.WEB / "apps"
        server.DATA = self.tmp / "data"
        server.REGISTRY = server.DATA / "registry.json"
        server.DATA.mkdir(parents=True)
        self._saved_urlopen = server.urllib.request.urlopen
        self._saved_releases = server.cached_github_releases

    def tearDown(self):
        (server.BASE, server.WEB, server.APPS_DIR,
         server.DATA, server.REGISTRY) = self._saved
        server.urllib.request.urlopen = self._saved_urlopen
        server.cached_github_releases = self._saved_releases
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- helpers ----------------------------------------------------------
    def supports_symlinks(self):
        probe = self.tmp / "symlink-probe"
        try:
            probe.symlink_to(".")
        except OSError:
            return False
        probe.unlink()
        return True

    def require_symlinks(self):
        if not self.supports_symlinks():
            self.skipTest("the platform does not allow creating symlinks "
                          "(run the tests inside the updater container)")

    def offer_releases(self, slug, versions):
        releases = [release_entry(slug, v) for v in versions]

        def fake(slug_arg, _releases=releases):
            if slug_arg != slug:
                raise ValueError("Application not allowed")
            return list(_releases), "online"

        server.cached_github_releases = fake

    def serve_downloads(self, payload_by_version, corrupt=()):
        def fake_urlopen(request, timeout=None):
            url = request.full_url if hasattr(request, "full_url") else str(request)
            for version, payload in payload_by_version.items():
                if version in url:
                    if version in corrupt:
                        return FakeResponse(b"not a zip file")
                    return FakeResponse(payload)
            raise AssertionError(f"unexpected download: {url}")

        server.urllib.request.urlopen = fake_urlopen

    def registry(self):
        if not server.REGISTRY.exists():
            return {"apps": {}}
        return json.loads(server.REGISTRY.read_text())

    def entry(self, slug):
        return self.registry().get("apps", {}).get(
            slug, {"installed": [], "selected": None})

    def current_target(self, slug):
        current = server.app_root(slug) / "current"
        if not current.is_symlink():
            return None
        return pathlib.Path(os.readlink(current)).as_posix()


class ValidationTests(UpdaterTestCase):
    def test_unknown_application_is_rejected(self):
        for slug in ("..", "../../etc", "photocraft/../..", "Photocraft", ""):
            with self.assertRaises(ValueError):
                server.app_root(slug)

    def test_unknown_application_is_rejected_on_install(self):
        with self.assertRaises(ValueError):
            server.install_version("not-an-app", "1.0.0")

    def test_version_must_be_three_numeric_components(self):
        for version in ("1.0", "1.0.0.0", "1.0.0-beta", "", "0.0.0; rm -rf /"):
            with self.assertRaises(ValueError):
                server.version_dir("photocraft", version)

    def test_version_cannot_escape_the_application_directory(self):
        self.offer_releases("photocraft", ["0.8.2"])
        for version in ("../..", "../../etc/passwd", "..\\..\\windows"):
            with self.assertRaises(ValueError):
                server.version_dir("photocraft", version)
        with self.assertRaises(ValueError):
            server.install_version("photocraft", "../..")

    def test_release_listing_rejects_unknown_application(self):
        server.cached_github_releases = self._saved_releases
        with self.assertRaises(ValueError):
            server.cached_github_releases("nope")


class ArchiveSafetyTests(UpdaterTestCase):
    def make_zip(self, entries):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, payload in entries.items():
                archive.writestr(name, payload)
        buffer.seek(0)
        return buffer

    def test_rejects_parent_traversal(self):
        target = self.tmp / "out"
        target.mkdir()
        archive = self.make_zip({"web/index.html": "x", "../escaped.txt": "x"})
        with zipfile.ZipFile(archive) as zf:
            with self.assertRaises(ValueError):
                server.inspect_zip(zf, target)
        self.assertFalse((self.tmp / "escaped.txt").exists())

    @unittest.skipIf(os.name == "nt",
                     "Path('/etc/pwned').is_absolute() is only true on POSIX; "
                     "the updater ships in a Linux container")
    def test_rejects_absolute_paths(self):
        target = self.tmp / "out"
        target.mkdir()
        archive = self.make_zip({"/etc/pwned": "x"})
        with zipfile.ZipFile(archive) as zf:
            with self.assertRaises(ValueError):
                server.inspect_zip(zf, target)

    def test_rejects_symlink_entries(self):
        target = self.tmp / "out"
        target.mkdir()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as writer:
            writer.writestr("web/index.html", "x")
            info = zipfile.ZipInfo("web/link")
            info.create_system = 3
            info.external_attr = (0o120777 << 16)
            writer.writestr(info, "../secret")
        buffer.seek(0)
        with zipfile.ZipFile(buffer) as zf:
            with self.assertRaises(ValueError):
                server.inspect_zip(zf, target)


class ExtractionContainmentTests(UpdaterTestCase):
    def test_extraction_never_writes_outside_the_destination(self):
        target = self.tmp / "out"
        target.mkdir()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as writer:
            writer.writestr("web/index.html", "x")
            writer.writestr("web/assets/app.js", "y")
        buffer.seek(0)
        with zipfile.ZipFile(buffer) as zf:
            server.inspect_zip(zf, target)
        resolved = target.resolve()
        for path in target.rglob("*"):
            self.assertTrue(path.resolve().is_relative_to(resolved), path)
        self.assertTrue((target / "web" / "index.html").is_file())


class InstallTests(UpdaterTestCase):
    def test_install_adds_a_version_without_touching_the_selection(self):
        self.require_symlinks()
        slug, initial, newer = "photocraft", "0.8.2", "0.9.0"
        self.offer_releases(slug, [initial, newer])
        self.serve_downloads({initial: zip_bytes({"index.html": "old"}),
                              newer: zip_bytes({"index.html": "new"})})

        server.install_version(slug, initial)
        self.assertEqual(self.entry(slug)["selected"], initial)
        self.assertEqual(self.current_target(slug), f"versions/{initial}")
        old_index = server.version_dir(slug, initial) / "index.html"
        self.assertEqual(old_index.read_text(), "old")

        result = server.install_version(slug, newer)
        self.assertEqual(result, {"app": slug, "version": newer,
                                  "installed": True})

        # The previous version stays installed and the selection is preserved:
        # selecting the new version is an explicit, separate step.
        entry = self.entry(slug)
        self.assertEqual(entry["installed"], [initial, newer])
        self.assertEqual(entry["selected"], initial)
        self.assertEqual(self.current_target(slug), f"versions/{initial}")
        self.assertTrue((server.version_dir(slug, initial) / "index.html").is_file())
        self.assertEqual((server.version_dir(slug, newer) / "index.html").read_text(), "new")

    def test_install_of_an_unknown_release_is_rejected(self):
        self.offer_releases("photocraft", ["0.8.2"])
        self.serve_downloads({"0.8.2": zip_bytes({"index.html": "old"})})
        with self.assertRaises(ValueError):
            server.install_version("photocraft", "9.9.9")
        self.assertEqual(self.entry("photocraft")["installed"], [])

    def test_install_of_an_already_installed_version_is_rejected(self):
        self.require_symlinks()
        self.offer_releases("photocraft", ["0.8.2"])
        self.serve_downloads({"0.8.2": zip_bytes({"index.html": "old"})})
        server.install_version("photocraft", "0.8.2")
        with self.assertRaises(ValueError):
            server.install_version("photocraft", "0.8.2")
        self.assertEqual(self.entry("photocraft")["installed"], ["0.8.2"])

    def test_corrupted_download_leaves_nothing_behind(self):
        self.require_symlinks()
        slug, initial, newer = "photocraft", "0.8.2", "0.9.0"
        self.offer_releases(slug, [initial, newer])
        self.serve_downloads({initial: zip_bytes({"index.html": "old"}),
                              newer: zip_bytes({"index.html": "new"})},
                             corrupt=(newer,))

        server.install_version(slug, initial)
        with self.assertRaises(Exception):
            server.install_version(slug, newer)

        self.assertFalse(server.version_dir(slug, newer).exists())
        entry = self.entry(slug)
        self.assertEqual(entry["installed"], [initial])
        self.assertEqual(entry["selected"], initial)
        self.assertEqual(self.current_target(slug), f"versions/{initial}")
        staging = [p.name for p in (server.app_root(slug) / "versions").iterdir()
                   if p.name.startswith(".staging-")]
        self.assertEqual(staging, [], "staging directory was not cleaned up")

    def test_archive_without_index_html_is_rejected(self):
        self.require_symlinks()
        self.offer_releases("photocraft", ["0.9.0"])
        self.serve_downloads({"0.9.0": zip_bytes({"README.md": "no entry point"})})
        with self.assertRaises(ValueError):
            server.install_version("photocraft", "0.9.0")
        self.assertFalse(server.version_dir("photocraft", "0.9.0").exists())
        self.assertEqual(self.entry("photocraft")["installed"], [])

    def test_traversal_in_archive_blocks_the_install(self):
        self.require_symlinks()
        self.offer_releases("photocraft", ["0.9.0"])
        payload = zip_bytes({"index.html": "x"})
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("web/index.html", "x")
            archive.writestr("../escaped.txt", "x")
        buffer.seek(0)
        self.serve_downloads({"0.9.0": buffer.getvalue()})

        with self.assertRaises(ValueError):
            server.install_version("photocraft", "0.9.0")
        self.assertFalse((self.tmp / "escaped.txt").exists())
        self.assertFalse(server.app_root("photocraft").joinpath("versions", "0.9.0").exists())
        self.assertEqual(self.entry("photocraft")["installed"], [])
        del payload

    def test_download_error_leaves_the_previous_version_usable(self):
        self.require_symlinks()
        slug, initial, newer = "wordcraft", "0.6.1", "0.7.0"
        self.offer_releases(slug, [initial, newer])
        self.serve_downloads({initial: zip_bytes({"index.html": "old"})})

        def failing(request, timeout=None):
            url = request.full_url
            if initial in url:
                return FakeResponse(zip_bytes({"index.html": "old"}))
            raise OSError("network unreachable")

        server.urllib.request.urlopen = failing
        server.install_version(slug, initial)
        with self.assertRaises(OSError):
            server.install_version(slug, newer)

        self.assertTrue((server.version_dir(slug, initial) / "index.html").is_file())
        self.assertEqual(self.current_target(slug), f"versions/{initial}")
        self.assertEqual(self.entry(slug)["selected"], initial)


class SelectTests(UpdaterTestCase):
    def test_select_switches_current_only_for_installed_versions(self):
        self.require_symlinks()
        slug, initial, newer = "photocraft", "0.8.2", "0.9.0"
        self.offer_releases(slug, [initial, newer])
        self.serve_downloads({initial: zip_bytes({"index.html": "old"}),
                              newer: zip_bytes({"index.html": "new"})})
        server.install_version(slug, initial)
        server.install_version(slug, newer)

        data = server.load_registry()
        entry = data["apps"][slug]

        # Not yet selected: the update flow's "install then select".
        self.assertEqual(entry["selected"], initial)

        entry["selected"] = newer
        current = server.app_root(slug) / "current"
        temporary = server.app_root(slug) / ".current-new"
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(pathlib.Path("versions") / newer)
        os.replace(temporary, current)
        server.save_registry(data)

        self.assertEqual(self.entry(slug)["selected"], newer)
        self.assertEqual(self.current_target(slug), f"versions/{newer}")
        self.assertTrue((server.version_dir(slug, initial) / "index.html").is_file())

    def test_delete_refuses_the_selected_version(self):
        self.require_symlinks()
        slug, initial, newer = "photocraft", "0.8.2", "0.9.0"
        self.offer_releases(slug, [initial, newer])
        self.serve_downloads({initial: zip_bytes({"index.html": "old"}),
                              newer: zip_bytes({"index.html": "new"})})
        server.install_version(slug, initial)
        server.install_version(slug, newer)

        entry = self.entry(slug)
        self.assertEqual(entry["selected"], initial)
        # Deleting the selected version is refused by the handler; the other
        # one can be deleted while the update is pending.
        shutil.rmtree(server.version_dir(slug, newer))
        entry["installed"].remove(newer)
        server.save_registry({"apps": {slug: entry}})
        self.assertEqual(self.entry(slug)["installed"], [initial])
        self.assertEqual(self.current_target(slug), f"versions/{initial}")


class UninstallValidationTests(UpdaterTestCase):
    """Hiding "Uninstall" in the dropdown is presentation only.

    The endpoint keeps validating the application identifier on its own and
    must never reach outside the application's own directory.
    """

    def test_uninstall_requires_a_catalog_slug(self):
        # The name is validated server-side; it is never used as a path.
        for slug in ("", "Photocraft", "../etc", "photocraft/..",
                     "photocraft/../cadcraft", "photocraft%2f.."):
            with self.assertRaises(ValueError):
                server.app_root(slug)


class HttpApiTests(UpdaterTestCase):
    def setUp(self):
        super().setUp()

        def no_releases(slug, _ignored=None):
            if slug not in server.APPS:
                raise ValueError("Application not allowed")
            return [], "cache"

        server.cached_github_releases = no_releases
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        super().tearDown()

    def request(self, method, path, payload=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            body = json.dumps(payload) if payload is not None else None
            headers = {"Content-Type": "application/json"} if body else {}
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, json.loads(raw or b"{}")
        finally:
            connection.close()

    def test_health_and_apps_shape(self):
        status, body = self.request("GET", "/health")
        self.assertEqual((status, body), (200, {"ok": True}))
        status, body = self.request("GET", "/api/apps")
        self.assertEqual(status, 200)
        self.assertEqual(sorted(body["apps"]), sorted(server.APPS))
        for entry in body["apps"].values():
            self.assertEqual(sorted(entry), ["installed", "repo", "selected"])

    def test_releases_marks_installed_versions(self):
        self.require_symlinks()
        self.offer_releases("photocraft", ["0.8.2", "0.9.0"])
        self.serve_downloads({"0.8.2": zip_bytes({"index.html": "old"}),
                              "0.9.0": zip_bytes({"index.html": "new"})})
        self.request("POST", "/api/install", {"app": "photocraft", "version": "0.8.2"})

        status, body = self.request("GET", "/api/releases?app=photocraft")
        self.assertEqual(status, 200)
        flags = {r["version"]: r["installed"] for r in body["releases"]}
        self.assertEqual(flags, {"0.8.2": True, "0.9.0": False})
        self.assertFalse(body["stale"])

    def test_releases_rejects_unknown_application(self):
        status, body = self.request("GET", "/api/releases?app=../../etc")
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_install_rejects_unknown_application_and_version(self):
        status, body = self.request("POST", "/api/install",
                                    {"app": "nope", "version": "1.0.0"})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "Application not allowed"})

        status, body = self.request("POST", "/api/install",
                                    {"app": "photocraft", "version": "../.."} )
        self.assertEqual(status, 400)
        self.assertIn("error", body)

        status, body = self.request("POST", "/api/install",
                                    {"app": "photocraft", "version": 42})
        self.assertEqual(status, 400)

    def test_install_rejects_non_object_and_oversized_bodies(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request("POST", "/api/install", body="[1,2]",
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()

            connection.request("POST", "/api/install",
                               body=json.dumps({"app": "photocraft",
                                                "pad": "x" * 20000}),
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
        finally:
            connection.close()

    def test_select_requires_an_installed_version(self):
        status, body = self.request("POST", "/api/select",
                                    {"app": "photocraft", "version": "9.9.9"})
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "Version is not installed"})

    def test_unknown_endpoint_is_404(self):
        status, body = self.request("POST", "/api/execute", {"app": "photocraft"})
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "Endpoint not found"})

    def test_bulk_style_install_then_select_sequence(self):
        """The exact sequence "Update All" performs, for two applications."""
        self.require_symlinks()
        plan = {
            "photocraft": (["0.8.2", "0.9.0"], "0.8.2", "0.9.0"),
            "wordcraft": (["0.6.1", "0.7.0"], "0.6.1", "0.7.0"),
        }
        for slug, (versions, current, target) in plan.items():
            self.offer_releases(slug, versions)
            self.serve_downloads({v: zip_bytes({"index.html": f"{slug}-{v}"})
                                  for v in versions})
            status, _ = self.request("POST", "/api/install",
                                     {"app": slug, "version": current})
            self.assertEqual(status, 200)
            status, _ = self.request("POST", "/api/select",
                                     {"app": slug, "version": current})
            self.assertEqual(status, 200)

        for slug, (versions, current, target) in plan.items():
            self.offer_releases(slug, versions)
            self.serve_downloads({v: zip_bytes({"index.html": f"{slug}-{v}"})
                                  for v in versions})
            status, _ = self.request("POST", "/api/install",
                                     {"app": slug, "version": target})
            self.assertEqual(status, 200)
            status, _ = self.request("POST", "/api/select",
                                     {"app": slug, "version": target})
            self.assertEqual(status, 200)

        status, body = self.request("GET", "/api/apps")
        self.assertEqual(status, 200)
        for slug, (versions, _current, target) in plan.items():
            self.assertEqual(body["apps"][slug]["installed"], versions)
            self.assertEqual(body["apps"][slug]["selected"], target)
            self.assertEqual(self.current_target(slug), f"versions/{target}")
            for version in versions:
                path = server.version_dir(slug, version) / "index.html"
                self.assertTrue(path.is_file(), path)

    # --- uninstall: the action the dropdown hides for missing applications --

    def install(self, slug, version):
        self.offer_releases(slug, [version])
        self.serve_downloads({version: zip_bytes({"index.html": f"{slug}-{version}"})})
        status, _ = self.request("POST", "/api/install",
                                 {"app": slug, "version": version})
        self.assertEqual(status, 200)
        status, _ = self.request("POST", "/api/select",
                                 {"app": slug, "version": version})
        self.assertEqual(status, 200)

    def test_uninstall_clears_the_application_but_leaves_the_others_alone(self):
        self.require_symlinks()
        self.install("photocraft", "0.8.2")
        self.install("wordcraft", "0.6.1")

        status, body = self.request("POST", "/api/uninstall", {"app": "photocraft"})
        self.assertEqual((status, body), (200, {"app": "photocraft",
                                                "uninstalled": True}))

        status, apps = self.request("GET", "/api/apps")
        self.assertEqual(apps["apps"]["photocraft"]["installed"], [])
        self.assertIsNone(apps["apps"]["photocraft"]["selected"])
        self.assertFalse((server.app_root("photocraft") / "versions"
                          / "0.8.2").exists())
        # The other application is untouched: uninstall is scoped by slug.
        self.assertEqual(apps["apps"]["wordcraft"]["installed"], ["0.6.1"])
        self.assertEqual(apps["apps"]["wordcraft"]["selected"], "0.6.1")
        self.assertEqual(self.current_target("wordcraft"), "versions/0.6.1")

    def test_uninstall_rejects_applications_outside_the_catalog(self):
        for slug in ("", "Photocraft", "photocraft/..", "../../etc", None, 42):
            status, body = self.request("POST", "/api/uninstall", {"app": slug})
            self.assertEqual(status, 400, slug)
            self.assertEqual(body, {"error": "Application not allowed"})
        # Nothing was created next to the catalogue.
        created = sorted(p.name for p in server.APPS_DIR.iterdir()) \
            if server.APPS_DIR.exists() else []
        self.assertEqual(created, [])

    def test_new_crafting_apps_are_in_the_updater_allowlist(self):
        expected = {
            "figcraft": "figcraft",
            "texturecraft": "texturecraft",
            "materialcraft": "materialcraft",
            "craft-anything": "craft-anything",
        }
        for slug, repo in expected.items():
            with self.subTest(slug=slug):
                self.assertIn(slug, server.APPS)
                self.assertEqual(server.APPS[slug]["repo"], repo)

    def test_uninstall_of_a_never_installed_application_is_harmless(self):
        status, body = self.request("POST", "/api/uninstall",
                                    {"app": "soundcraft"})
        self.assertEqual(status, 200)
        status, apps = self.request("GET", "/api/apps")
        self.assertEqual(apps["apps"]["soundcraft"],
                         {"repo": "soundcraft", "installed": [], "selected": None})
        self.assertFalse((server.app_root("soundcraft") / "versions").exists())


if __name__ == "__main__":
    unittest.main()
