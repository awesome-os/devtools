# Changelog

All notable changes to `awesome-os/devtools` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Canonical verbatim SPDX `LICENSE` for deterministic GitHub Licensee detection.
- `.gitattributes` enforcing consistent LF/CRLF and binary handling across Windows and POSIX.
- `.github/CODEOWNERS` governance and workflow ownership rules.
- `CHANGELOG.md` initialized in Keep a Changelog v1.1.0 format for release traceability.

## [11.0.0] - 2026-11-26

### Changed
- Unified Awesome-OS DevTools monorepo covering IDEs (`code-oss`, `theia`, `b8g-ide`), VS Code / Open VSX extensions, game engines, and standalone `holo_devtools_cli.c` splash launchers over Holo v11 CAS.
- Added `v11-devtools-launchers-latest` release workflow, `holo-ci@v1`, and Holo-E2E Lavapipe Zero-X11 verification.
