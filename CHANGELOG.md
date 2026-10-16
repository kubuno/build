# Changelog

All notable changes to **kubuno-build** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/). Entries are added under
`[Unreleased]` **as the change is made**; `_tools/release.sh` stamps them under the version
number at release time, and CI publishes that section as the GitHub Release notes.

## [Unreleased]

### Security

- **The signed-in user is now taken from the core's signed identity token only.** The module used to trust the
  plain `X-Kubuno-User-Id` / `-Role` / `-Email` headers, so any process able to reach its local port could
  act as any user, administrators included. It now accepts a request only with a valid `X-Kubuno-Auth` token
  signed by the core with this module's own secret, for this module, and not expired (`kubuno-modauth`); the
  plain headers are ignored. With no internal secret configured, every user request is refused. The `/ipc/*` guard now compares `X-Internal-Secret` in constant time and refuses every request when no secret is configured (an empty header used to match an empty secret).

- **Database driver updated past an unfixable advisory.** The previous line
  pulled in an RSA implementation vulnerable to a timing side-channel
  (RUSTSEC-2023-0071) for which no fix will ever exist. The new line does not
  depend on it at all, and it refuses any SQL string built at run time unless it
  has been audited - every such query here was checked and is now assembled
  at compile time, so none is built at run time at all.

### Changed
- **The ribbon comes from the shared Kubuno UI library.** The module's own copy of the ribbon is replaced by the
  one of `@kubuno/ui` (0.1.18), shared by every module that has a ribbon. Build gets back what its copy had lost: the ribbon on phones (bottom command bar and palette) and the larger 32 px icons of the large buttons.

- **The repository is organised by platform.** The server (its sources, migrations, tests and configuration
  example) moves to `server/` and the web frontend to `web/`, with their history, and `mobile/` is reserved
  for the mobile apps. The `.kbpkg` is unchanged (same files, same contents); the build script, the CI
  workflows and the Makefile follow (whose targets now build `kubuno-build`, not the maps binary), and the
  repository gets its Visual Studio solution, `Kubuno.Build.slnx`, like the other modules.
- **This module now installs as a Kubuno package (`.kbpkg`) only.** Its system
  packages (Debian/RPM and the Windows and macOS installers) are no longer
  built: the module is distributed as one `.kbpkg` per platform (Linux, Windows,
  macOS) that the Kubuno server installs itself - from the admin console, or
  offline with `kubuno modules:install <file>.kbpkg`.




### Fixed

- **The package could not be built where `zip` is absent.** The Windows job of
  the continuous integration has no `zip`, so the Windows package was simply lost
  the first time it was attempted - a script failure, not a build failure. The
  builder now falls back to 7-Zip, then to PowerShell.
### Added

- **This module now ships a `.kbpkg`** - the single package format a Kubuno
  server installs by itself, the same file on Linux, Windows and macOS. It
  carries the same binary, interface and manifest as the system packages,
  arranged the way the server expects to find a module on disk, plus a
  `SHA256SUMS` so a copy carried offline can be checked without the catalogue.
  Nothing changes for existing installations: the `.deb`, `.rpm`, `.exe` and
  `.pkg` are still published, and a catalogue that sees both simply prefers the
  new one. It is also the only format the server can unpack without an external
  tool, which is what makes one-click installation possible away from
  Debian-like systems.
### Fixed

- **A built package could be thrown away instead of published.** The job that
  attaches a package to the release waited ten minutes for another workflow to
  create that release, then gave up with "release never appeared - build.yml
  likely failed". The diagnosis was wrong: on a repository whose `.deb` takes
  longer than ten minutes to build, the release simply did not exist yet, and a
  package that had built perfectly was discarded. Four modules reached v0.1.6
  with packages missing for some systems because of it. The job now creates the
  release itself when it is missing, so it no longer depends on another workflow
  finishing first.
[Unreleased]: https://github.com/kubuno/build/compare/HEAD...HEAD
