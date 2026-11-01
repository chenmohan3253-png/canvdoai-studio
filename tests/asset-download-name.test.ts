import {describe,expect,it} from 'vitest';
import {studioAssetDownloadName} from '../src/desktop/canvas-model';

describe('本机素材下载文件名',()=>{
  it.each(['wav','mp3','m4a','mp4','webp'])('保留%s真实格式而不是伪装成M4A',extension=>{
    const value={name:'sample',kind:'audio' as const,url:'/api/studio/media/file.'+extension+'?token=private'};
    expect(studioAssetDownloadName(value)).toBe('sample.'+extension);
    expect(studioAssetDownloadName({...value,name:'sample.'+extension})).toBe('sample.'+extension);
  });
});
