<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

<div align="center">

# Kubuno — Build

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Rust](https://img.shields.io/badge/Rust-edition_2021-orange.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![Three.js](https://img.shields.io/badge/Three.js-WebGL-000000.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)
![Status](https://img.shields.io/badge/status-alpha-yellow.svg)

**Computer-aided design for Kubuno — the self-hosted, libre (AGPLv3) cloud platform, a sovereign alternative to Google Workspace and Microsoft 365.**

Build bundles two design applications behind one module: **Architect**, for buildings, houses and urban layouts in 2D plan and 3D, and **CAO3D**, a parametric 3D modeller with metric dimensions. Everything is drawn and rendered in the browser with WebGL; your models are stored as ordinary files in your Kubuno Drive.

</div>

---

## ✨ Features

### 🏙️ Architect — buildings & urbanism (2D / 3D)

- 📐 **Draw a plan, get a model** — walls (as chains), rooms (a rectangle becomes four walls plus a slab), doors and windows placed by clicking a wall, and roads drawn as ribbons. Live dimensions (length, angle, area) as you draw.
- 🚪 **Real openings** — doors and windows are cut into walls as piers, lintels and sills with a visible, selectable leaf or glazing, and the 2D plan and the 3D elevation are the very same geometry seen through two cameras.
- 🏠 **Roofs** — gable, hip and flat roofs raised on top of a selected slab.
- 🌆 **Procedural generation** — generate multi-storey buildings, setback and tapered skyscrapers, arched bridges and whole city blocks from a seed and a few parameters, then keep editing the result.

### 🧩 CAO3D — parametric 3D modelling

- 🕰️ **Feature timeline** — a model is a rollback-able history of features (sketch, pad, revolve, loft, boolean, pocket/groove, primitives, mirror/pattern). Nothing is consumed destructively: earlier features stay editable, and dependents recompute in cascade.
- ✏️ **Constrained 2D sketcher** — segments, rectangles, circles and arcs on a chosen plane, with geometric and dimensional constraints solved live; a degrees-of-freedom indicator tells you when a sketch is fully constrained, and dragging a point re-solves in real time.
- 🧊 **Solid kernel** — a robust geometry kernel drives extrude, revolve, loft, pocket and groove, boolean union / subtract / intersect, fillets and chamfers, native primitives (box, cylinder, sphere, cone, torus), and mirror / linear / polar patterns.
- 🗺️ **Sketch planes** — sketch on the ground, on the standard planes, or on the face of an existing solid.
- 🧭 **CAD navigation & export** — an orientation navcube, orthographic 3D toggle, hover pre-highlighting, and export to **STL** and **glTF/GLB**.

### 🎛️ Shared

- 📁 **Documents are real Drive files** — each model lives in a file you can see, move and rename in Files (`Build/Architect/<title>.kbarch`, `Build/CAO3D/<title>.kbcao`, stored gzipped); the database keeps only metadata.
- 🖥️ **Office-style ribbon** — both editors share the Kubuno Office shell (ribbon, backstage, save badge, undo/redo).
- 💾 **Autosave & metric units** — configurable autosave interval and a default metric unit (mm / cm / m); administrators can also cap the maximum size of a saved document.

## 🏗️ Architecture

Kubuno is **modular**: each module is a **separate process** that registers with the [core](https://github.com/kubuno/core) at startup. The core proxies its routes, forwards the authenticated user, and serves its runtime-loaded React frontend bundle. A module never links the core — shared Rust crates come from tagged git dependencies, and shared frontend libraries (`@kubuno/sdk`, `@ui`, `@kubuno/drive`) are resolved at runtime by the host import map.

| | |
|---|---|
| Port | `3124` |
| PostgreSQL schema | `build` |
| Sidebar | `Build` |
| Process isolation | `kubuno-seccomp` (no `execve` on the host) |

- **Server** — `server/`: Axum + SQLx (PostgreSQL, schema `build`); document CRUD with trash / restore / duplicate, and per-document content files written into the Drive module via the `kubuno-drive` client. Purges a user's documents on the `UserDeleted` core event.
- **Web** — `web/`: a React 19 bundle built to `entry.js`, rendering with **Three.js** (WebGL). It consumes `@kubuno/sdk`, `@ui` and `@kubuno/drive` from npm, provided by the host at runtime via the import map.
- **Mobile** — `mobile/`: reserved for the mobile apps (see `mobile/README.md`).

## 📦 Install

This module ships in the **all-in-one [Kubuno](https://github.com/kubuno/core) Docker image** (`ghcr.io/kubuno/kubuno`) — the easiest way to self-host a full Kubuno instance (core + every module). See **[kubuno/docker](https://github.com/kubuno/docker)** for `docker compose` instructions.

A Kubuno module is distributed as a single **`.kbpkg`** — a self-contained package the Kubuno server installs itself, identical on Linux, Windows and macOS. Tagged releases attach one `.kbpkg` per platform to the [GitHub Releases](https://github.com/kubuno/build/releases) page. Install it from the admin console, or offline from the command line:

```bash
sudo kubuno modules:install build-<version>-<os>-<arch>.kbpkg
sudo systemctl restart kubuno              # the core loads the module on (re)start
```

## 🛠️ Build & development

**Requirements:** Rust ≥ 1.82, Node.js ≥ 24, PostgreSQL 16.

```bash
cd server && cargo build --release         # backend (shared crates from git tags)
cd web && npm ci && npm run build          # frontend bundle → web/dist/{entry.js, entry.css}
bash build_kbpkg.sh                        # → dist/build-<version>-<os>-<arch>.kbpkg
bash build_kbpkg.sh --install              # build + install into the local store + restart
bash ../_tools/deploy_local.sh build       # fast local rebuild + restart (after first install)
```

> Shared dependencies come from Kubuno — no `kubuno/core` checkout required:
> - **Rust** — shared crates via tagged git dependencies (`kubuno-seccomp`, `kubuno-drive`).
> - **Frontend** — `@kubuno/sdk`, `@ui`, `@kubuno/drive` from the `@kubuno` npm scope, resolved by the host at runtime.

## 🧰 Tech stack

Rust 2021 · Axum 0.7 · Tokio · SQLx 0.8 (PostgreSQL 16) — React 19 · TypeScript · Vite · Three.js (WebGL).

## 🤝 Contributing

Contributions are welcome. Please open an issue to discuss any significant change before submitting a pull request.

## 📄 License

[AGPL-3.0-or-later](LICENSE) © Kubuno contributors.
