const fs = require('node:fs');
const path = require('node:path');

// Electron's GUI main process does not reliably inherit MCP stdio on Windows.
// Ship a private Node runtime and a small stdio bridge as installer resources.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const mcpDir = path.join(context.appOutDir, 'resources', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(mcpDir, 'node.exe'));
  fs.copyFileSync(path.join(process.cwd(), 'build', 'mcp-stdio.cjs'), path.join(mcpDir, 'mcp-stdio.cjs'));
  console.log('Bundled private Node.js MCP stdio runtime and bridge.');
};
