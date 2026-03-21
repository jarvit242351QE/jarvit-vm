# Changelog

## v0.1.0 (2026-03-22)

Initial release of the JARVIT VM auto-update system.

### Added
- `vm-auto-update.sh` — polls GitHub releases every 30 minutes
- `vm-simple-update.sh` — fallback updater when OpenClaw endpoint is unreachable
- `vm-updater` plugin — OpenClaw plugin that handles intelligent 3-way merge updates
- `manifest.json` generation for tracking file checksums
- systemd timer/service for automatic polling
- GitHub Actions workflow for building releases
