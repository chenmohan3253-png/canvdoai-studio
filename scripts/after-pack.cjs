const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Electron's GUI main process does not reliably inherit MCP stdio on Windows.
// Ship a private Node runtime and a small stdio bridge as installer resources.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const mcpDir = path.join(context.appOutDir, 'resources', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  // The private runtime must ship its matching license and bundled-library notices.
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const cacheDir = path.join(process.cwd(), 'vendor', 'node-licenses');
  const cacheFile = path.join(cacheDir, `node-${process.version}-LICENSE.txt`);
  let license;
  if (fs.existsSync(cacheFile)) {
    license = fs.readFileSync(cacheFile, 'utf8');
  } else {
    const response = await fetch(licenseUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Node.js license download failed: HTTP ${response.status}`);
    license = await response.text();
  }
  if (!license.includes('Node.js is licensed') || !license.includes('Permission is hereby granted')) {
    throw new Error(`Invalid Node.js license for ${process.version}`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, license);
  fs.writeFileSync(path.join(mcpDir, 'node-LICENSE.txt'), license);
  fs.writeFileSync(path.join(mcpDir, 'node-runtime.json'), JSON.stringify({
    version: process.version, licenseSource: licenseUrl,
    licenseSha256: createHash('sha256').update(license).digest('hex'),
  }, null, 2));
  fs.copyFileSync(process.execPath, path.join(mcpDir, 'node.exe'));
  fs.copyFileSync(path.join(process.cwd(), 'build', 'mcp-stdio.cjs'), path.join(mcpDir, 'mcp-stdio.cjs'));
  console.log('Bundled private Node.js MCP stdio runtime, matching license and bridge.');
};
