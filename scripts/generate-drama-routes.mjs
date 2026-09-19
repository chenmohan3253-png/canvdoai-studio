import { readdir, writeFile } from 'node:fs/promises';
const root = 'modules/dramaforge/app/api/drama/v1';
async function routes(dir) {
  const result = [];
  for (const e of await readdir(dir, {withFileTypes:true})) {
    if (e.isDirectory()) result.push(...await routes(`${dir}/${e.name}`));
    else if (e.name === 'route.ts') result.push(`${dir}/route.ts`);
  }
  return result;
}
const files = (await routes(root)).sort();
const imports = files.map((file,i)=>`import * as r${i} from '../${file.slice(0,-3)}';`);
const entries = files.map((file,i)=>`  { path: ${JSON.stringify('/api/drama/v1'+file.slice(root.length,-9))}, handlers: r${i} }`);
await writeFile('runtime/drama-routes.generated.ts', '// Generated from audited module routes; do not edit by hand.\n'+imports.join('\n')+'\nexport const dramaRoutes = [\n'+entries.join(',\n')+'\n];\n');
