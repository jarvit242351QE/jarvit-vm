# Changelog

## v1.2.1 (2026-03-22)

### Fixed
- **Version comparison**: Auto-update now checks semantic versioning (prevents downgrades from v1.2.0 to v1.1.1)
- **Self-replacement crash**: vm-auto-update.sh copies vm-simple-update.sh to /tmp before running it (prevents shell corruption when the script replaces itself on disk)
- **Manifest format**: All releases now use structured manifest with file types (security/system/config/feature)

### Changed
- Auto-update poller requires LATEST > CURRENT (not just LATEST != CURRENT)
- Simple update fallback runs from /tmp copy to prevent mid-execution file corruption

## v1.2.0 (2026-03-22)

### Added
- vm-updater v2.0.0: AI-powered merge with security-first updates
- Aggressive disk cleanup in auto-update system
- Obsolete file cleanup during updates
- Manifest now includes file types (security, system, config, feature)

## v1.1.0 (2026-03-22)

### Fixed
- Fixed auto-update poller not starting: removed github-token requirement from entrypoint.sh
- Fixed background update loop: added `set +e` and `trap '' HUP` to survive parent exec
- Moved `mkdir -p /data/logs /data/updates` before background loop start

### Added
- E2E auto-update audit test: verifies poller, download, apply, and user modification preservation

## v1.0.2 (2026-03-22)

### Fixed
- vm-updater correctly preserves user-modified files during updates
- Bumped vm-updater plugin version to 1.0.2

## v1.0.1 (2026-03-22)

### Fixed
- Bumped vm-updater plugin version to 1.0.1 for E2E update test

## v1.0.0 (2026-03-22)

### Changed
- Replaced python3 with node for JSON parsing in update scripts (python3 not available in minimal Debian rootfs)
- Fixed vm-updater plugin to use correct OpenClaw plugin API (`registerHttpRoute`)
- Used `browser_download_url` for asset downloads to avoid API rate limits
- Removed GitHub token requirement for auto-update (repo is now public)

### Added
- `vm-auto-update.sh` -- polls GitHub releases every 30 minutes
- `vm-simple-update.sh` -- fallback updater when OpenClaw endpoint is unreachable
- `vm-updater` plugin -- OpenClaw plugin that handles intelligent 3-way merge updates
- `manifest.json` generation for tracking file checksums
- GitHub Actions workflow for building releases
- VM internet access via relay: DNS + nftables + TC configuration in init.sh

## v0.0.1-test (2026-03-21)

### Added
- Initial test release for auto-update system verification
