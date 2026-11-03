# ArtCraft Standalone

An independent, self-hosted web launcher for managing ArtCraft web applications from a single interface.

<img width="1366" height="622" alt="ArtCraft Standalone launcher interface" src="https://github.com/user-attachments/assets/3dae0d68-b28b-48f9-8241-368cb9d7d801" />

## Features

- **Centralized application catalog** — browse all 16 applications in the ArtCraft suite from a single web interface.
- **Search and category filters** — find applications by name, description, or category.
- **On-demand installation** — download application releases when you choose to install them.
- **Version management** — inspect available releases and manage installed versions.
- **Application updates** — installed applications are checked automatically when the launcher loads; update all eligible applications with **Update All** when newer releases are available.
- **Web-based access** — manage applications through a browser without requiring a separate desktop launcher.
- **Containerized deployment** — run the web interface and application management service with Docker Compose.

The catalog includes PhotoCraft, VectorCraft, FilmCraft, LightCraft, PdfCraft, EffectCraft, DesignCraft, FigCraft, TextureCraft, MaterialCraft, WordCraft, SoundCraft, DeckCraft, CADCraft, GridCraft, and Craft Anything. Release availability is discovered from each application's official GitHub repository; only matching web-build archives are installable through this launcher.

## Requirements

- Linux host
- Docker Engine
- Docker Compose v2

## Quick start

Clone the repository and switch to the development branch:

```bash
git clone -b develop https://github.com/GioTem/artcraft-launcher-web.git
cd artcraft-launcher-web
```

Start the services:

```bash
docker compose up -d
```

Open the launcher in your browser:

```text
http://localhost:8080
```

## Architecture

ArtCraft Standalone consists of two services:

- **Web frontend** — serves the launcher interface and proxies API requests.
- **Updater service** — handles application management, release discovery, downloads, and version selection.

Both services are orchestrated using Docker Compose.

## Development checks

The repository has no build step: the launcher interface is the single
`www/index.html` file and the updater is a single Python module. The checks
below are the ones used while working on them.

```bash
# Frontend behaviour (button state, bulk update sequencing, version handling)
node --test tests/*.test.mjs

# Updater API, validation and install/select safety
python -m unittest discover -s tests -p 'test_*.py'
```

The updater tests create the `current` symlink that the service uses, which
needs symlink privileges; run them inside the deployment image to execute
every case:

```bash
docker build -t artcraft-updater ./updater
docker run --rm -v "$PWD:/src" -w /src artcraft-updater \
    python -m unittest discover -s tests -p 'test_*.py'
```

There is also an opt-in end-to-end check that drives the real launcher script
against a running updater service. It is inert unless both variables are set,
so it cannot write to a live deployment by accident:

```bash
ARTCRAFT_UPDATER_BASE=http://127.0.0.1:8090 ARTCRAFT_INTEGRATION=1 \
    node tests/integration_launcher_vs_updater.mjs
```

## Security

**Do not expose the management API or launcher directly to the public internet without appropriate access controls.**

Review the API access controls and deployment configuration before using this project on an untrusted network.

## License

ArtCraft Standalone is licensed under the **GNU General Public License v3.0 only (GPL-3.0-only)**.

You may use, study, modify, and redistribute this software, including for commercial purposes, subject to the terms of the GPL-3.0.

Modified versions distributed to others must comply with the license's applicable source-code and redistribution requirements.

See [`LICENSE`](LICENSE) for the full license text.

This license applies only to the original code in this repository. Third-party applications, trademarks, logos, and other assets remain subject to their respective licenses and terms.
