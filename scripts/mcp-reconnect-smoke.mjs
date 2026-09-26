import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createPipeServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const appData = join(tmpdir(), `canvdoai-mcp-smoke-${randomUUID()}`);
const suffix = createHash('sha256').update(join(appData, 'canvdoai-desktop').toLowerCase()).digest('hex').slice(0, 24);
const pipeName = `\\\\.\\pipe\\canvdoai-mcp-${suffix}`;
const token = 'test-session-token';
const servers = [];
let currentOrigin = '';
let child;

async function startStudio(label) {
  const server = createHttpServer((request, response) => {
    if (request.headers['x-canvdoai-session'] !== token) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({canvases:[{id:label,name:label,nodes:[]}],tasks:[]}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const pending = new Map();
let buffer = '';
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request ${id} timed out`));
    }, 7000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}

try {
  currentOrigin = await startStudio('before-restart');
  const pipe = createPipeServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (input.includes('\n')) socket.end(JSON.stringify({origin:currentOrigin,token})+'\n');
    });
  });
  pipe.listen(pipeName);
  await once(pipe, 'listening');
  servers.push(pipe);

  child = spawn(process.execPath, ['build/mcp-stdio.cjs'], {
    env:{...process.env,APPDATA:appData},
    stdio:['pipe','pipe','pipe']
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0,newline);
      buffer = buffer.slice(newline+1);
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const initialized = await request(1,'initialize',{protocolVersion:'2025-03-26'});
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  const tools = await request(2,'tools/list');
  if (!tools.result?.tools?.some(tool => tool.name === 'list_canvases')) throw new Error('MCP tools unavailable');

  const first = await request(3,'tools/call',{name:'list_canvases',arguments:{}});
  const firstName = JSON.parse(first.result?.content?.[0]?.text ?? '{}').canvases?.[0]?.name;
  if (firstName !== 'before-restart') throw new Error(`First session failed: ${firstName}`);

  currentOrigin = await startStudio('after-restart');
  const second = await request(4,'tools/call',{name:'list_canvases',arguments:{}});
  const secondName = JSON.parse(second.result?.content?.[0]?.text ?? '{}').canvases?.[0]?.name;
  if (secondName !== 'after-restart') throw new Error(`MCP retained a stale session: ${secondName}; ${stderr}`);

  console.log('MCP reconnect smoke passed: desktop session changed without restarting MCP.');
} finally {
  child?.kill();
  for (const server of servers) await new Promise(resolve => server.close(resolve));
}
