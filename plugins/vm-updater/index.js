// Re-export from dist for OpenClaw plugin discovery
// OpenClaw looks for index.js at the plugin root directory
module.exports = require("./dist/index.js");
