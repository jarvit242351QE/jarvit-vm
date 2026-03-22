// Parse JSON from stdin and extract a dotted key path.
// Usage: echo '{"a":{"b":"c"}}' | node json-get.js a.b
// Output: c
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  try {
    const o = JSON.parse(d);
    const key = process.argv[2];
    const keys = key ? key.split(".") : [];
    let v = o;
    for (const k of keys) v = v[k];
    if (v !== undefined && v !== null) process.stdout.write(String(v));
  } catch (e) {
    // Silently fail -- caller checks for empty output
  }
});
