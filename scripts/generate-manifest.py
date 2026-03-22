#!/usr/bin/env python3
"""
Generate manifest.json for a JARVIT VM release.

The manifest maps absolute VM filesystem paths to their checksums and types.
During updates, the vm-updater plugin uses this to decide how to handle each
file based on whether the user modified it and the file's type:

  - "security": ALWAYS applied, even over user modifications (security patches
    are non-negotiable). User customizations are re-applied on top via AI merge.
  - "feature": Merged with user's changes. Keeps what they built, adds what's new.
  - "config": Merged conservatively. Never overwrites user config changes.
  - "system": Always replaced (scripts, internal plumbing).

Usage:
  python3 generate-manifest.py <version> [--security <path1> <path2> ...]

Examples:
  python3 generate-manifest.py v1.2.0
  python3 generate-manifest.py v1.2.1 --security plugins/jarvit-router/dist/index.js
"""

import hashlib
import json
import os
import sys


def file_sha256(filepath: str) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def classify_file(local_path: str, vm_path: str, security_paths: set) -> str:
    """Determine the update type for a file.

    Returns one of: security, system, config, feature.
    """
    # Explicitly marked as security
    if local_path in security_paths or vm_path in security_paths:
        return "security"

    # System scripts -- always replace
    if vm_path.startswith("/opt/jarvit/scripts/"):
        return "system"

    # Config files
    if vm_path.startswith("/opt/jarvit/config/"):
        return "config"
    if vm_path.endswith("jarvit.json") or vm_path.endswith(".env"):
        return "config"

    # Plugin metadata
    if vm_path.endswith("jarvit.plugin.json") or vm_path.endswith("openclaw.plugin.json"):
        return "config"

    # Everything else (plugin code, etc.) is a feature
    return "feature"


def main():
    if len(sys.argv) < 2:
        print("Usage: generate-manifest.py <version> [--security <path> ...]", file=sys.stderr)
        sys.exit(1)

    version = sys.argv[1]

    # Parse --security flags
    security_paths = set()
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--security" and i + 1 < len(sys.argv):
            i += 1
            # Collect all paths until the next flag
            while i < len(sys.argv) and not sys.argv[i].startswith("--"):
                security_paths.add(sys.argv[i])
                i += 1
        else:
            i += 1

    # Files to track: everything under scripts/, plugins/, config/
    # Mapped to their absolute paths inside the VM
    path_mappings = []

    # Map local repo paths to VM absolute paths
    path_mappings.extend([
        ("scripts/vm-auto-update.sh", "/opt/jarvit/scripts/vm-auto-update.sh"),
        ("scripts/vm-simple-update.sh", "/opt/jarvit/scripts/vm-simple-update.sh"),
        ("scripts/json-get.js", "/opt/jarvit/scripts/json-get.js"),
        ("scripts/json-asset-url.js", "/opt/jarvit/scripts/json-asset-url.js"),
        ("scripts/version-validate.js", "/opt/jarvit/scripts/version-validate.js"),
        ("scripts/version-compare.js", "/opt/jarvit/scripts/version-compare.js"),
    ])

    # Skip patterns: build/dev artifacts that don't need checksum tracking
    skip_suffixes = (".d.ts", ".d.ts.map", ".js.map", ".tsbuildinfo")
    skip_names = {"tsconfig.json", "package-lock.json"}

    # Add all plugin files
    for root, dirs, files in os.walk("plugins"):
        # Skip node_modules and src (only dist matters)
        dirs[:] = [d for d in dirs if d not in ("node_modules", "src", ".git")]
        for fname in files:
            if fname in skip_names or any(fname.endswith(s) for s in skip_suffixes):
                continue
            local_path = os.path.join(root, fname)
            # Map to /opt/jarvit/<path>
            vm_path = f"/opt/jarvit/{local_path}"
            path_mappings.append((local_path, vm_path))

    # Add config files
    if os.path.exists("config"):
        for root, dirs, files in os.walk("config"):
            for fname in files:
                local_path = os.path.join(root, fname)
                vm_path = f"/opt/jarvit/{local_path}"
                path_mappings.append((local_path, vm_path))

    # Generate checksums with types
    file_map = {}
    for local_path, vm_path in path_mappings:
        if os.path.exists(local_path) and os.path.isfile(local_path):
            file_type = classify_file(local_path, vm_path, security_paths)
            file_map[vm_path] = {
                "checksum": file_sha256(local_path),
                "type": file_type,
            }

    manifest = {
        "version": version,
        "files": file_map,
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    }

    with open("manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    # Summary
    type_counts = {}
    for info in file_map.values():
        t = info["type"]
        type_counts[t] = type_counts.get(t, 0) + 1

    summary = ", ".join(f"{v} {k}" for k, v in sorted(type_counts.items()))
    print(f"Generated manifest.json: {len(file_map)} files ({summary}), version {version}")
    if security_paths:
        print(f"Security-flagged paths: {', '.join(sorted(security_paths))}")


if __name__ == "__main__":
    main()
