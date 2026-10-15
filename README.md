# ArtCraft Standalone

A self-hosted launcher for managing ArtCraft applications from a single web interface.

## Features

- A launcher with 12 application entries.
- Application installation and removal through the management interface.
- Release discovery and version selection.
- Docker Compose deployment.
- Persistent application registry.

## Requirements

- Linux
- Docker Engine
- Docker Compose v2
- Network access to GitHub Releases to download applications

## Quick start

Clone the repository and switch to the development branch:

```bash
git clone -b develop <REPOSITORY_URL>
cd artcraft-standalone
```

Prepare the runtime directories and start the services:

```bash
mkdir -p www/apps data/release-cache
docker compose up -d --build
```

Open `http://localhost:8080` in your browser.

If deploying on a remote server, replace `localhost` with the server address, provided the service is reachable from your client.

## Configuration

The Docker Compose configuration publishes port `8080`. Review the port mapping and your firewall rules before deployment.

The `.env.example` file documents example bind and port settings. Do not put credentials, private keys, or other secrets in Git.

## Application data

- `data/registry.json` stores the application installation registry.
- `data/release-cache/` stores regenerable release metadata.
- `www/apps/` contains downloaded application payloads.

Back up the registry and installed application data before performing maintenance.

## Security

**Do not expose the management interface to the public internet without appropriate access controls.**

Application installation and removal are management operations. Restrict access to trusted users and networks, such as a private LAN or VPN, and review the API access controls before deploying this service on an untrusted network.

## Development

The `develop` branch is the development branch. Releases should be published separately using GitHub Releases.

## License

See the license and attribution notices included in the repository. Review the licenses of bundled components and downloaded applications separately.
