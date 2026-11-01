import { dispatchErrorResponse, dispatchFetch } from "../../../../lib/dispatch";
import {createHash} from 'node:crypto';
import {desktopMediaBucket} from '../../../../lib/desktop-platform';
import {localObjectUrl} from '../../../../lib/drama-upload-server';

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: { category: "validation_error", message: "请选择有效素材" } }, { status: 400 });
    }
    const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a','audio/aac':'aac'};
    const extension=extensions[file.type];
    if(!extension||file.size>100*1024*1024)return Response.json({error:{category:'validation_error',message:'请选择不超过100MB的图片、视频或音频素材'}},{status:400});
    const upstream = new FormData();
    upstream.set("file", file, file.name);
    const result = await dispatchFetch("/v1/assets", { method: "POST", body: upstream });
    if(result.status>=200&&result.status<300){
      const receipt=result.payload as Record<string,unknown>,bytes=new Uint8Array(await file.arrayBuffer()),sha256=createHash('sha256').update(bytes).digest('hex');
      if(typeof receipt.object_key!=='string'||!receipt.object_key||receipt.sha256!==sha256||receipt.kind!==file.type.split('/')[0])throw Error('上传回执与原始素材不匹配，未保存引用');
      const key=`reference-previews/${sha256}.${extension}`;
      const bucket=desktopMediaBucket();
      if(!await bucket.head(key))await bucket.put(key,bytes,{httpMetadata:{contentType:file.type}});
      return Response.json({...receipt,preview_url:localObjectUrl(key),size:file.size,mime_type:typeof receipt.mime_type==='string'?receipt.mime_type:file.type},{status:result.status});
    }
    return Response.json(result.payload, { status: result.status });
  } catch (error) {
    return dispatchErrorResponse(error);
  }
}
