# AGENTS.md

## Project purpose

ArtCraft Standalone is an independent, self-hosted web launcher for managing ArtCraft web applications from one browser-based interface. It is not the official desktop launcher and must not be presented as an official Storytold product or as affiliated with or endorsed by upstream projects.

## Working principles

1. Inspect the relevant source, configuration, and documentation before changing anything.
2. Preserve the existing architecture unless the task explicitly requires an architectural change.
3. Keep changes focused. Avoid unrelated refactoring, formatting churn, and dependency upgrades.
4. Do not guess about API contracts, release formats, upstream requirements, or runtime behavior. Inspect the implementation and upstream metadata; state any remaining uncertainty.
5. Treat the runtime registry and installed application files as persistent user data. Never delete, reset, overwrite, or migrate them without an explicit requirement and a safe migration plan.
6. Report only checks actually performed. Never claim a test passed if it was not run.

## Repository workflow

- The active development branch is `develop`.
- Before editing, inspect `git status`, the current branch, and recent commits.
- Do not discard, reset, amend, or overwrite existing user changes.
- Do not commit or push unless explicitly requested.
- Keep generated archives and release bundles out of Git. The application `tar.gz` archive is intended for a GitHub Release, not for the source repository.
- Update documentation when behavior, setup, API contracts, configuration, or security changes.

## Architecture

The Docker Compose deployment currently consists of two services:

- **Web frontend:** Nginx serves the browser interface and proxies API requests.
- **Updater service:** a Python service responsible for application management, release discovery, downloads, and version selection.

Preserve this separation unless a task explicitly requires changing it.

Known API operations:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/apps` | Application catalog and installation state |
| GET | `/api/releases` | Release information |
| POST | `/api/install` | Install an application version |
| POST | `/api/select` | Select an installed version |
| POST | `/api/delete` | Delete an installed version |
| POST | `/api/uninstall` | Uninstall an application |

Before changing an endpoint, inspect its actual request/response schema and all frontend callers. Keep the updater, Nginx proxy configuration, and frontend contract consistent.

## Application and runtime data

- The catalog currently contains 16 application entries. The frontend catalog and backend `APPS` allowlist must stay in sync.
- Applications come from their respective upstream projects. Do not assume they share release asset names, archive layouts, runtime requirements, or licenses.
- Version management supports multiple installed versions and a `current` selection. Preserve the existing version-selection behavior and filesystem layout.
- `data/registry.json` is runtime state and is intentionally excluded from Git. Never add it to commits, replace it with sample data, or delete it during routine cleanup.
- Do not commit downloaded binaries, generated archives, caches, or installed application directories unless explicitly required for a distributable artifact.

## Frontend guidelines

- Keep the interface usable on desktop and mobile browsers.
- Preserve the current visual language and interaction patterns unless a redesign is requested.
- Keep user-facing interface text in English, consistent with the current localization work.
- Avoid unnecessary network requests. Load release details only when needed, and do not check for updates for applications that are not installed.
- Update notifications must concern installed applications and indicate a genuinely newer available version.
- Handle loading, empty, error, and success states explicitly. Do not silently swallow API errors.
- Do not add frontend dependencies for small tasks that the existing implementation can handle.

## Security requirements

The management API includes state-changing operations. Treat the deployment as trusted-network software unless access controls have been added and verified.

- Do not expose the launcher or management API directly to the public internet.
- Do not describe the API as authenticated unless authentication is implemented and tested.
- For remote access, use a trusted private network such as Tailscale or a properly configured reverse proxy with authentication.
- Do not weaken access restrictions, container isolation, or filesystem boundaries.
- Validate application identifiers, versions, paths, and request parameters server-side. Frontend validation is not a security boundary.
- Prevent path traversal; filesystem operations must remain within the intended application data directory.
- Avoid constructing shell commands from untrusted input. Prefer safe argument arrays and validated values.
- Never log secrets, tokens, or sensitive environment values.

If a task changes network exposure, authentication, authorization, download sources, archive extraction, or filesystem operations, perform a security review and document residual risks.

## Licensing and third-party material

- The intended license for the original ArtCraft Standalone code is **GNU GPL-3.0-only**.
- Keep the root `LICENSE` file aligned with the `GPL-3.0-only` identifier.
- The launcher license does not automatically relicense third-party applications, binaries, icons, trademarks, or other assets.
- Preserve upstream license files, copyright notices, `NOTICE` files, and attribution material where required.
- Before removing or replacing any license or attribution file, identify the component it applies to and verify the upstream terms.
- Never claim that all managed applications are GPL-licensed. Their licenses are determined by their upstream projects.

## Testing and validation

Inspect the repository to identify available test and lint commands. Do not invent commands or assume a test suite exists.

Run the most relevant available checks, for example:

- Docker Compose configuration validation.
- Python syntax checks and existing updater tests.
- Frontend syntax/build checks, if provided.
- API smoke tests for affected endpoints.
- HTTP or browser smoke tests for the launcher, when practical.

For installation or API changes, consider success and failure paths: invalid input, missing releases, failed downloads, interrupted operations, and already-installed versions.

If a check cannot be run, explain why and list the remaining manual verification.

## Completion report

At the end of each task, report:
1. A concise summary of changes.
2. The files changed.
3. Checks and tests actually executed, with results.
4. Known limitations, risks, and follow-up work.

Do not report a task as complete if required validation has not been performed.
