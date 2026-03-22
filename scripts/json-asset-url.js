// Find a GitHub release asset's download URL by name.
// Usage: echo '<release-json>' | node json-asset-url.js jarvit-vm.tar.gz
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  try {
    const o = JSON.parse(d);
    const name = process.argv[2];
    const a = (o.assets || []).find(a => a.name === name);
    if (a) process.stdout.write(a.browser_download_url || a.url);
  } catch (e) {
    // Silently fail
  }
});
