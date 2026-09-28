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
  const projects = [], canvases = [{id:label,name:label,nodes:[]}];
  const server = createHttpServer(async (request, response) => {
    if (request.headers['x-canvdoai-session'] !== token) {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    let value;
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (url.pathname === '/api/studio/project') {
        value = {id:`project-${label}`,name:input.name};projects.push(value);
      } else if (url.pathname === '/api/studio/canvas/create') {
        value = {id:`canvas-${label}`,name:input.name,projectId:input.projectId,nodes:[],revision:1};canvases.push(value);
      }
    }
    if (url.pathname === '/api/studio/state') value = {projects,canvases:canvases.filter(canvas=>!url.searchParams.has('projectId')||canvas.projectId===url.searchParams.get('projectId')),tasks:[]};
    if (!value) { response.writeHead(404).end();return; }
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify(value));
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
  for (const name of ['list_canvases','list_projects','create_project','create_canvas']) if (!tools.result?.tools?.some(tool => tool.name === name)) throw new Error(`MCP tool unavailable: ${name}`);

  const first = await request(3,'tools/call',{name:'list_canvases',arguments:{}});
  const firstName = JSON.parse(first.result?.content?.[0]?.text ?? '{}').canvases?.[0]?.name;
  if (firstName !== 'before-restart') throw new Error(`First session failed: ${firstName}`);
  const createdProject = await request(5,'tools/call',{name:'create_project',arguments:{name:'隔离测试项目'}});
  const projectId = JSON.parse(createdProject.result?.content?.[0]?.text ?? '{}').project?.id;
  if (projectId !== 'project-before-restart') throw new Error('MCP project creation failed');
  const createdCanvas = await request(6,'tools/call',{name:'create_canvas',arguments:{projectId,name:'项目内画布',templateId:'blank'}});
  if (JSON.parse(createdCanvas.result?.content?.[0]?.text ?? '{}').canvas?.projectId !== projectId) throw new Error('MCP project-scoped canvas creation failed');
  const projectCanvases = await request(7,'tools/call',{name:'list_canvases',arguments:{projectId}});
  if (JSON.parse(projectCanvases.result?.content?.[0]?.text ?? '{}').canvases?.length !== 1) throw new Error('MCP project filter failed');

  currentOrigin = await startStudio('after-restart');
  const second = await request(4,'tools/call',{name:'list_canvases',arguments:{}});
  const secondName = JSON.parse(second.result?.content?.[0]?.text ?? '{}').canvases?.[0]?.name;
  if (secondName !== 'after-restart') throw new Error(`MCP retained a stale session: ${secondName}; ${stderr}`);

  console.log('MCP reconnect smoke passed: desktop session changed without restarting MCP.');
} finally {
  child?.kill();
  for (const server of servers) await new Promise(resolve => server.close(resolve));
}
