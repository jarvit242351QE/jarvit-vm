// Compare two versions from stdin.
// Input: "v1.2.3 v1.2.2" or "release-abc123 release-def456" (space-separated)
// Output: "yes" if first is newer than second, "no" otherwise
//
// Handles two formats:
//   - Semver: v1.2.3 > v1.2.2 → "yes" (numeric comparison)
//   - SHA-based: release-abc123 != release-def456 → "yes" (any difference = newer,
//     since GitHub "latest" release is the only one that matters)
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  const parts = d.trim().split(" ");
  const latest = parts[0], current = parts[1];

  // Same tag → not newer
  if (latest === current) { process.stdout.write("no"); process.exit(0); }

  // SHA-based tags (release-{sha}): any difference means newer
  if (latest.startsWith("release-") || current.startsWith("release-")) {
    process.stdout.write("yes");
    process.exit(0);
  }

  // Semver comparison
  const a = latest.replace(/^v/, "").split(".").map(Number);
  const b = current.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) { process.stdout.write("yes"); process.exit(0); }
    if (x < y) { process.stdout.write("no"); process.exit(0); }
  }
  process.stdout.write("no");
});
