import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runMcpStdio } from './mcp-server';

type Bridge = { origin: string; token: string };

function getBridge(): Promise<Bridge> {
  const userData = join(process.env.APPDATA || '', 'canvdoai-desktop').toLowerCase();
  const suffix = createHash('sha256').update(userData).digest('hex').slice(0, 24);
  const pipe = `\\\\.\\pipe\\canvdoai-mcp-${suffix}`;
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe);
    let buffer = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('CanvDoAI 工作室未运行。请先打开桌面软件并保持运行。')); }, 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write('GET\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const bridge = JSON.parse(buffer.slice(0, newline)) as Bridge;
        if (typeof bridge.origin !== 'string' || typeof bridge.token !== 'string') throw new Error('MCP 会话数据无效');
        socket.end();
        resolve(bridge);
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.on('error', error => { clearTimeout(timeout); reject(new Error(`无法连接 CanvDoAI 本地会话：${error.message}`)); });
  });
}

// Keep MCP discovery available even if the desktop app is temporarily closed.
// Each tool call reacquires the current named-pipe session after an app restart.
runMcpStdio(getBridge).catch(error => {
  process.stderr.write(`CanvDoAI MCP: ${error instanceof Error ? error.message : '启动失败'}\n`);
  process.exitCode = 1;
});
