// Verify a cosign signature using Node.js crypto.
// Compatible with cosign sign-blob (ECDSA P-256 / SHA-256).
// Usage: node verify-cosign.js <pubkey.pem> <sig-file> <data-file>
// Exit code: 0 = valid, 1 = invalid/error
const crypto = require("crypto");
const fs = require("fs");

const [,, pubKeyPath, sigPath, dataPath] = process.argv;
if (!pubKeyPath || !sigPath || !dataPath) {
  process.stderr.write("Usage: verify-cosign.js <pubkey> <sig-file> <data-file>\n");
  process.exit(1);
}

try {
  const pubKey = fs.readFileSync(pubKeyPath, "utf8");
  const sigBase64 = fs.readFileSync(sigPath, "utf8").trim();
  const sig = Buffer.from(sigBase64, "base64");
  const data = fs.readFileSync(dataPath);
  const ok = crypto.verify("sha256", data, pubKey, sig);
  process.exit(ok ? 0 : 1);
} catch (e) {
  process.stderr.write("Verify error: " + e.message + "\n");
  process.exit(1);
}
