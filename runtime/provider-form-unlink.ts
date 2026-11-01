// Exact maintenance only. The caller supplies the already-authenticated transport.
// This module does not read configuration/credential files or create generation jobs.
export type FormRef={website_media_id:string;kind:'image'|'video'|'audio';role:'reference'|'first_frame'|'last_frame'};
export type FormUnlinkInput={sourceJobId:string;expectedRefs:FormRef[];confirmUnlink:true};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const path='/v1/maintenance/form-unlink';
type Request=(path:string,body?:unknown)=>Promise<any>;
export function validateFormUnlink(input:unknown):asserts input is FormUnlinkInput{
  const v=input as FormUnlinkInput;
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='confirmUnlink,expectedRefs,sourceJobId'||v.confirmUnlink!==true||typeof v.sourceJobId!=='string'||!uuid.test(v.sourceJobId))throw Error('须明确确认原 sourceJobId、精确 expectedRefs 和 confirmUnlink=true；不支持生成或删库参数');
  if(!Array.isArray(v.expectedRefs)||!v.expectedRefs.length||v.expectedRefs.length>20||v.expectedRefs.some(r=>!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='kind,role,website_media_id'||typeof r.website_media_id!=='string'||!uuid.test(r.website_media_id)||!['image','video','audio'].includes(r.kind)||!['reference','first_frame','last_frame'].includes(r.role)||r.role!=='reference'&&r.kind!=='image')||new Set(v.expectedRefs.map(r=>r.website_media_id)).size!==v.expectedRefs.length)throw Error('expectedRefs 必须为不重复的精确媒体 ID、kind、role');
}
function receipt(v:any,expectedSource?:string){
  if(!v||typeof v.id!=='string'||!uuid.test(v.id)||typeof v.sourceJobId!=='string'||!uuid.test(v.sourceJobId)||expectedSource&&v.sourceJobId!==expectedSource||!['queued','preparing','validated','failed','manual_review','canceled'].includes(v.status)||v.billing_mode!=='no_generation'||v.credits_used!==0||v.prepare_only!==true||v.submitted!==false||v.library_files_deleted!==false||v.removed_count!==null&&(!Number.isInteger(v.removed_count)||v.removed_count<0||v.removed_count>20)||v.status==='validated'&&v.removed_count===null)throw Error('清理回执不完整或超出无生成/不删库边界；停止操作，不自动重试');
  return {id:v.id,sourceJobId:v.sourceJobId,status:v.status,billing_mode:'no_generation',credits_used:0,prepare_only:true,submitted:false,library_files_deleted:false,removed_count:v.removed_count};
}
export async function unlinkProviderForm(request:Request,input:unknown){
  validateFormUnlink(input);
  const caps=await request(path+'/capabilities');
  if(caps?.service!=='higgsfield-browser-bridge'||caps.operation!=='exact_audited_form_unlink'||caps.enabled!==true||caps.billing_mode!=='no_generation'||caps.submitted!==false||caps.library_files_deleted!==false)throw Error('当前已认证服务未启用精确表单清理；须先由管理员升级并明确启用，不切换无认证接口');
  const result=receipt(await request(path,input),input.sourceJobId);
  if(result.status==='validated'&&result.removed_count!==input.expectedRefs.length)throw Error('实际移除数量与明确授权不符；停止操作');
  return result;
}
export async function getProviderFormUnlink(request:Request,jobId:unknown){
  if(typeof jobId!=='string'||!uuid.test(jobId))throw Error('请提供精确 maintenanceJobId');
  return receipt(await request(path+'/'+jobId));
}
