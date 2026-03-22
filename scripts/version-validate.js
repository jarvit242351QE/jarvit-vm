// Validate a version string from stdin.
// Outputs "ok" if valid, "bad" if not.
// Valid: [a-zA-Z0-9._-], 1-127 chars
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  const v = d.trim();
  if (/^[a-zA-Z0-9._-]+$/.test(v) && v.length > 0 && v.length < 128) {
    process.stdout.write("ok");
  } else {
    process.stdout.write("bad");
  }
});
