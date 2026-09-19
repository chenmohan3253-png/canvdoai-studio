// One-time mechanical adaptation of the copied embedded module; original package remains unchanged.
import {readFile,writeFile,readdir} from 'node:fs/promises';
async function visit(dir) {
  for(const e of await readdir(dir,{withFileTypes:true})) {
    const p=`${dir}/${e.name}`;
    if(e.isDirectory()) {if(e.name!=='desktop')await visit(p);continue;}
    if(!/\.tsx?$/.test(p))continue;
    let s=await readFile(p,'utf8');
    if(s.includes('window.localStorage')) {
      s='import { durableStorage } from "../desktop/storage";\n'+s.replaceAll('window.localStorage','durableStorage');
      await writeFile(p,s);
    }
  }
}
await visit('src');
const path='runtime/test-ai-proxy.ts';
let s=await readFile(path,'utf8');
s=s.replace('import type { Plugin } from "vite";', 'import type { Server } from "connect";');
s=s.replace('export function testAiProxy(): Plugin {\n  return {\n    name: "canvdoai-test-ai-proxy",\n    configureServer(server) {','export function registerGenerationRoutes(middlewares: Server) {');
s=s.replaceAll('server.middlewares.use','middlewares.use');
s=s.replace(/    },\r?\n  };\r?\n}\s*$/, '}\n');
// Environment configuration is set by the encrypted desktop settings, before the runtime is loaded.
s=s.replace('const DISPATCH_BASE_URL =','let DISPATCH_BASE_URL =');
s=s.replaceAll('join(process.cwd(),', 'join(process.env.CANVDOAI_DATA_DIR ?? process.cwd(),');
s=s.replace('const apiKey = chatApiKey;\n        const baseUrl = (process.env.CHATGPT_API_BASE ?? DEFAULT_BASE_URL).replace(/\\/$/, "");\n        const model = process.env.CHATGPT_IMAGE_MODEL', 'const apiKey = process.env.IMAGE_API_KEY?.trim() || chatApiKey;\n        const baseUrl = (process.env.IMAGE_API_BASE || process.env.CHATGPT_API_BASE || DEFAULT_BASE_URL).replace(/\\/$/, "");\n        const model = process.env.CHATGPT_IMAGE_MODEL');
s=s.replaceAll('320, 1920','320, 4096');
await writeFile(path,s);
