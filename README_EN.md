<div align="center">

# AGY Dock (`AGY-Dock` v2.10.0)

**AGY Dock** (formerly *AGY Plugin Manager* / `AGY-Launcher`) is a decoupled Windows desktop control center, process supervisor, and Chrome DevTools Protocol (CDP) bridge launcher for **Google Antigravity IDE**.

[简体中文](README.md) | **English**

[Overview](#overview) · [Plugin Integration Spec](PLUGIN_INTEGRATION.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Submit Official Plugin](.github/ISSUE_TEMPLATE/submit-official-plugin.yml) · [Submit Third-Party Plugin](.github/ISSUE_TEMPLATE/submit-third-party-plugin.yml)

</div>

---

## Overview

AGY Dock launches **Google Antigravity IDE** cleanly with on-demand proxy injection and orchestrates external plugins without modifying host IDE binaries (`Antigravity.exe`, `app.asar`, or `version.dll`).

### Key Capabilities

- **Clean Host Isolation**: User data (`plugins.json`, `plugins/`, `logs/`, `account-quota-cache.json`) lives under `%LOCALAPPDATA%\AGY-Plugin-Manager` (or next to the executable in portable mode when `plugins.json` or `.portable` is present), separated from bundled binaries.
- **Dual-Track Plugin Marketplace**:
  - **Official Marketplace** ([`plugins-catalog.json`](plugins-catalog.json)): Verified plugins audited or maintained for AGY Dock.
  - **Third-Party Marketplace** ([`third-party-catalog.json`](third-party-catalog.json)): Community plugins hosted in external GitHub repositories with automated two-tier static security screening (`Low`, `Medium`, `High` risk ratings + sensitive capability tags) and custom private repository feeds.
  - **One-Click Plugin Submission**: Submit official or third-party plugins via GitHub Issue forms or the in-app **Quick Submit** workflow, backed by automated release validation and upstream release synchronization.
- **Multiple Plugin Runtimes & Safe Bridge**:
  - Supports `node-cdp`, `exe-cdp`, `node-companion`, `ps-companion`, `py-companion`, and `custom` plugins.
  - **Manager Safe Process Bridge**: Companion plugins receive a loopback endpoint (`AGY_BRIDGE_URL`) for permissioned local operations without granting raw unconstrained host access.
- **Workspace, Quota & Storage Tools**:
  - Live Antigravity quota/telemetry status, native extension inventory, automated IDE & proxy client detection, interactive **Storage Manager** (AGY Local Data & Project Files treemap/list cleanup), and non-blocking update notifications.

---

## Documentation

| Document | Purpose |
| :--- | :--- |
| [`PLUGIN_INTEGRATION.md`](PLUGIN_INTEGRATION.md) | Complete plugin architecture, `agy-plugin.json` manifest contract, dual-track marketplace spec, `settings.html` SDK, and companion safe bridge protocol. |
| [`CHANGELOG.md`](CHANGELOG.md) | Full release history across desktop app, marketplace, security scanner, and launcher updates. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Quick guide for submitting plugins to the marketplace and contributing code to AGY Dock. |

---

## Official Marketplace Catalog & Bundled Packages

AGY Dock ships sample unified `.zip` packages in [`AGY-Launcher/plugin-packages/`](AGY-Launcher/plugin-packages/) and publishes the official catalog in [`plugins-catalog.json`](plugins-catalog.json):

| Plugin ID | Name | Type | Description |
| :--- | :--- | :--- | :--- |
| `office-viewer` | Antigravity Office Viewer | `node-cdp` | Real-time Word, Excel, PowerPoint, and offline PDF preview panel via Antigravity CDP. |
| `antigravity-hans` | Antigravity Hans | `node-cdp` | Pure Node.js dynamic localization engine for the Antigravity UI, Agent panel, and Swarm board. |
| `agy-telemetry` | Antigravity Telemetry | `node-cdp` | Minimalist session output speed, cache hit rate, and context usage telemetry HUD. |
| `agy-quota-badge` | Antigravity Quota Badge | `node-cdp` | Live 5-hour and weekly quota badge beside the model selector with countdown tooltips and custom styling. |
| `agy-pixel-pets` | AGY Pixel Pets | `node-cdp` | Hardware-accelerated interactive pixel companions synced with Antigravity AI activity. |
| `obsidian-prism-lite` | Obsidian Prism Lite | `node-cdp` | Lightweight optical theme enhancement with multi-theme palettes, animations, and sidebar controls. |

Each package carries a root `agy-plugin.json` manifest (`schemaVersion: 1`). See [`PLUGIN_INTEGRATION.md`](PLUGIN_INTEGRATION.md) for the full packaging and distribution specification.

---

## Installation & Quick Start

### Option 1: Standalone Windows Setup Installer (Recommended)

1. Download or build `dist-release/AGY-Dock-Setup-v2.10.0.exe`.
2. Run the setup wizard:
   - Automatically detects your local `Antigravity.exe` installation (with manual browse override).
   - Installs clean manager binaries to `%LOCALAPPDATA%\AGY-Plugin-Manager` by default while preserving existing configurations and plugins on upgrade.
   - Creates **Desktop** and **Start Menu** shortcuts (`AGY Dock`), then launches immediately.
3. Silent installation for automation or CI:
   ```powershell
   .\AGY-Dock-Setup-v2.10.0.exe /S
   ```

### Option 2: Installing Plugins (Marketplace or Drag-and-Drop)

1. Open **AGY Dock** and install plugins directly from the **Plugin Marketplace** (Official or Third-Party tabs).
2. Or go to **My Plugins** and drag and drop any `.zip`, `.agypkg`, or `.agy-plugin` archive onto the window (or click **Install Package**).
3. AGY Dock validates archive paths (blocking path traversal), checks `agy-plugin.json`, runs static security screening when required, extracts files to `plugins/<id>/`, and registers the plugin in `plugins.json`.

---

## Auto-Detection, Storage & Updates

- **Antigravity IDE Detection**: Locates `Antigravity.exe` across active processes, Windows Registry entries (`Uninstall`, `App Paths`, URL protocol), standard local app folders (`%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe`), and shortcuts.
- **Local Proxy Detection**: Reads Windows Internet Settings (`ProxyEnable` / `ProxyServer`), environment variables, and common proxy clients (`Clash`, `Mihomo`, `Clash Verge`, `FlClash`, `v2ray`, `xray`, `sing-box`, `Hiddify`, `Shadowsocks`) to prefill on-demand proxy launch settings without altering system-wide proxy configuration.
- **Storage Management**: Switch between **AGY Local Data** and **Project Files** to inspect large directories, browse nested folders, and safely clean caches while keeping registered project roots intact.
- **Update Service**: Checks `https://www.haoanlab.xyz` on startup, every 15 minutes, and manually from **Settings**. Existing `ahmustudyhelper.xyz` configurations remain compatible during migration.

---

## Development & Building from Source

### Prerequisites

- Node.js 22+ and npm
- Rust stable toolchain (`x86_64-pc-windows-msvc`) and Tauri v2 Windows build prerequisites
- Python 3.11+ (for packaging plugin archives)

### Run from Source

```powershell
npm ci
npm run tauri:dev
```

### Build Unified Plugin Packages

```powershell
cd AGY-Launcher
python scripts/package_plugins.py
```

### Scan a Plugin Package Locally

```powershell
node scripts/scan-plugin.mjs path/to/plugin.zip
```

### Build Windows Desktop App & Setup Installer

```powershell
node scripts/build.mjs windows x64
```

The build writes `dist-release/AGY-Dock-Setup-v<VERSION>.exe`.

### Run Tests

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
node --test AGY-Launcher/tests/process-manager.test.mjs
```
