// Compare two semver versions from stdin.
// Input: "v1.2.3 v1.2.2" (space-separated)
// Output: "yes" if first > second, "no" otherwise
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  const parts = d.trim().split(" ");
  const a = parts[0].replace(/^v/, "").split(".").map(Number);
  const b = parts[1].replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) { process.stdout.write("yes"); process.exit(0); }
    if (x < y) { process.stdout.write("no"); process.exit(0); }
  }
  process.stdout.write("no");
});
