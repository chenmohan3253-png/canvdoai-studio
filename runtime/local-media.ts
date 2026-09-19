import {lstatSync,realpathSync} from 'node:fs';
import {extname,join,relative,isAbsolute} from 'node:path';

/** Only application-owned, flat media names are accepted; never resolve an arbitrary URL/path. */
export function resolveGeneratedFile(directory:string,url:unknown,kind:'asset'|'media',extensions:string[]){
  if(typeof url!=='string')throw Error('INVALID_GENERATED_URL');
  const clean=url.split('?',1)[0];
  const legacyPrefix=kind==='asset'?'/api/test-ai/assets/':'/api/test-ai/media/';
  const studioPrefix='/api/studio/media/';
  const shared=clean.startsWith(studioPrefix);
  if(!shared&&!clean.startsWith(legacyPrefix))throw Error('INVALID_GENERATED_URL');
  const fileName=clean.slice((shared?studioPrefix:legacyPrefix).length);
  const namePattern=shared?/^[a-f0-9]{64}\.(png|jpg|webp|mp4|m4a)$/:/^[0-9a-f-]{36}\.[a-z0-9]+$/i;
  const extension=extname(fileName).toLowerCase();
  if(!namePattern.test(fileName)||!extensions.includes(extension)||
    (kind==='asset'&&!['.png','.jpg','.webp'].includes(extension))||
    (kind==='media'&&shared&&!['.mp4','.m4a'].includes(extension)))throw Error('INVALID_GENERATED_URL');
  const folder=join(directory,shared?'studio-assets':kind==='asset'?'.local-generated-assets':'.local-generated-media');
  const path=join(folder,fileName);
  const inside=(root:string,target:string)=>{const part=relative(root,target);return part!==''&&!part.startsWith('..')&&!isAbsolute(part);};
  // Junctions/symlinks must not redirect the resolver outside the current profile.
  if(!inside(realpathSync(directory),realpathSync(folder))||!inside(realpathSync(folder),realpathSync(path))||!lstatSync(path).isFile())throw Error('INVALID_GENERATED_URL');
  return {fileName,path,url:clean};
}

export function concatFileEntry(path:string){
  if(/[\r\n\0]/.test(path))throw Error('INVALID_GENERATED_URL');
  return `file '${path.replace(/\\/g,'/').replace(/'/g,"'\\''")}'`;
}
