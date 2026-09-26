import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, cp, access } from 'node:fs/promises';
await import('./generate-drama-routes.mjs');
await import('./collect-licenses.mjs');
await mkdir('build', { recursive: true });
await viteBuild();
for (const [source, output] of [['electron/main.ts','main.cjs'],['electron/preload.ts','preload.cjs'],['runtime/server.ts','server.cjs'],['electron/mcp-stdio.ts','mcp-stdio.cjs']]) {
  await build({ entryPoints:[source], outfile:`build/${output}`, bundle:true, platform:'node', format:'cjs', target:'node22', external:['electron','./server.cjs'], sourcemap:true });
}
const mediaRuntime=await Promise.allSettled([access('vendor/ffmpeg/ffmpeg.exe'),access('vendor/ffmpeg/ffprobe.exe')]);
if(mediaRuntime.some(item=>item.status==='rejected'))console.warn('FFmpeg/FFprobe 未放入 vendor/ffmpeg：源码构建继续，但桌面打包和媒体功能需要使用者自行提供合规二进制。');
await cp('modules/dramaforge/services/assembly-server.mjs','build/remake-media.mjs');
await cp('docs','build/docs',{recursive:true});
