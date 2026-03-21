#!/usr/bin/env python3
"""
Generate manifest.json for a JARVIT VM release.

The manifest maps absolute VM filesystem paths to their SHA256 checksums.
During updates, the vm-updater plugin compares these checksums to detect
which files the user has modified (and should not be overwritten).

Usage: python3 generate-manifest.py <version>
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

def main():
    if len(sys.argv) < 2:
        print("Usage: generate-manifest.py <version>", file=sys.stderr)
        sys.exit(1)

    version = sys.argv[1]

    # Files to track: everything under scripts/, plugins/, config/
    # Mapped to their absolute paths inside the VM
    file_map = {}

    # Map local repo paths to VM absolute paths
    path_mappings = [
        ("scripts/vm-auto-update.sh", "/opt/jarvit/scripts/vm-auto-update.sh"),
        ("scripts/vm-simple-update.sh", "/opt/jarvit/scripts/vm-simple-update.sh"),
        # systemd timer/service are included for reference but the VM uses
        # a background loop in entrypoint.sh (no systemd in Firecracker VMs)
    ]

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

    # Generate checksums
    for local_path, vm_path in path_mappings:
        if os.path.exists(local_path) and os.path.isfile(local_path):
            file_map[vm_path] = file_sha256(local_path)

    manifest = {
        "version": version,
        "files": file_map,
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    }

    with open("manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"Generated manifest.json: {len(file_map)} files, version {version}")

if __name__ == "__main__":
    main()
