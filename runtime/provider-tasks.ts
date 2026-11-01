import {createHash} from 'node:crypto';
import {StudioStore} from './studio-store';
import {ResultDownloadError} from './result-download';
import {ProviderHttpError,isDefiniteProviderRejection,type ProviderHttpErrorEvidence} from './provider-http-error';
export interface RemoteJob {id?:string;model?:string;status?:string;result_url?:string|null;failure?:{message?:string;category?:string}|null;}
export interface ProviderIntent {key:string;account:string;state:string;job?:RemoteJob;error?:ProviderHttpErrorEvidence;updatedAt:string;}
type Intent=ProviderIntent;
export class ProviderPendingError extends Error {
  constructor(readonly providerKey:string,readonly remoteId:string,detail='远端仍在运行'){
    super(`${detail}；已保存远端任务 ${remoteId}，将仅按原ID续查并收片，不会重新提交`);this.name='ProviderPendingError';
  }
}
export class ProviderFailedError extends Error {constructor(detail:string){super('远端生成失败：'+detail);this.name='ProviderFailedError';}}
export function savedProviderTask(directory:string,key:string):ProviderIntent|undefined {
  const store=new StudioStore(directory);try{return store.get<Intent>('provider-task',key);}finally{store.close();}
}
export interface FailedProviderTask {key:string;shotId:string;updatedAt:string;job?:RemoteJob;}
export interface VideoJobOptions {directory:string;key:string;account:string;create:()=>Promise<RemoteJob>;poll:(id:string)=>Promise<RemoteJob>;deadlineMs?:number;intervalMs?:number;refreshOnly?:boolean;onRemote?:(job:RemoteJob)=>void;shouldStop?:()=>boolean;}
const inFlight=new Map<string,{account:string;promise:Promise<RemoteJob>}>();
export function accountFingerprint(base:string,key:string){return createHash('sha256').update(base+'\0'+key).digest('hex');}
export function failedProviderTasks(directory:string,projectId:string):FailedProviderTask[]{
  const safeProject=projectId.slice(0,48).replace(/[^a-zA-Z0-9_-]/g,'-');
  const prefix=`canvdoai-${safeProject}-`;
  const store=new StudioStore(directory);
  try{
    return store.list<Intent>('provider-task')
      .filter(record=>record.state==='FAILED'&&record.key.startsWith(prefix))
      .map(record=>({
        key:record.key,
        shotId:record.key.slice(prefix.length).replace(/-[a-f0-9]{32}$/i,''),
        updatedAt:record.updatedAt,
        job:record.job,
      }));
  }finally{store.close();}
}
export async function persistentVideoJob(options:VideoJobOptions):Promise<RemoteJob>{
  const lock=options.directory+'\0'+options.key;
  const pending=inFlight.get(lock);
  if(pending){if(pending.account!==options.account)throw Error('该在途任务属于原API账户，请恢复原接口配置；不会向新账户重复提交');return pending.promise;}
  const work=async()=>{
    const store=new StudioStore(options.directory);
    const save=(record:Intent)=>{record.updatedAt=new Date().toISOString();store.put('provider-task',options.key,record);};
    try{
      let record=store.get<Intent>('provider-task',options.key);
      const resumed=Boolean(record?.job?.id);
      if(record&&record.account!==options.account)throw Error('该在途任务属于原API账户，请恢复原接口配置；不会向新账户重复提交');
      if(record?.state==='REJECTED'){
        const suffix='原拒绝记录及幂等键已保留，只有明确重新生成并使用新幂等键才可重试；不会自动提交';
        if(record.error)throw new ProviderHttpError({...record.error,message:record.error.message+'；'+suffix});
        throw Error('服务商已明确拒绝原请求；'+suffix);
      }
      if(record?.state==='UNKNOWN'||(record?.state==='SUBMITTING'&&!record.job?.id))throw Error('远端提交结果未知，已保留幂等键。请先在服务商后台确认/关联任务ID，禁止盲目重新扣费');
      if(record?.state==='FAILED'){
        const detail=record.job?.failure?.message||record.job?.status||'服务商未返回明确失败原因';
        throw new ProviderFailedError(detail+'；原失败任务已保留，只有作者明确重试才会创建新任务');
      }
      if(options.refreshOnly&&!record?.job?.id)throw Error('缺少原任务ID，不能刷新下载地址；不会创建新视频任务');
      if(record?.job?.id)options.onRemote?.(record.job);
      // A resumed successful job may carry an expired signed URL. Refresh by ID only.
      if(record?.state==='SUCCEEDED'){
        const id=record.job?.id;if(!id)throw Error('缺少原任务ID；不会重新生成视频');
        let fresh:RemoteJob;
        try{fresh=await options.poll(id);}catch(error){throw new ProviderPendingError(options.key,id,'原任务查询暂不可用');}
        if(fresh.id&&fresh.id!==id)throw Error('服务商返回了其他任务的结果；已保留原任务');
        if(fresh.status!=='succeeded'||!fresh.result_url)throw new ProviderPendingError(options.key,id,'原成功任务的下载地址暂不可用');
        record.job={...fresh,id};save(record);return record.job;
      }
      if(!record){
        record={key:options.key,account:options.account,state:'SUBMITTING',updatedAt:''};save(record);
        try{const job=await options.create();if(!job.id)throw Error('服务商未返回任务ID');record.job=job;record.state='REMOTE';save(record);}
        catch(e){record.state=isDefiniteProviderRejection(e)?'REJECTED':'UNKNOWN';if(e instanceof ProviderHttpError)record.error=e.evidence;save(record);throw e;}
        options.onRemote?.(record.job!);
      }
      if(resumed&&record.state==='REMOTE'){
        const id=record.job!.id!;if(options.shouldStop?.())throw new ProviderPendingError(options.key,id,'本地查询已暂停');
        let fresh:RemoteJob;try{fresh=await options.poll(id);}catch(error){throw new ProviderPendingError(options.key,id,'原任务查询暂不可用');}
        if(fresh.id&&fresh.id!==id)throw Error('服务商返回了其他任务的结果；已保留原任务');
        record.job={...fresh,id};save(record);
      }
      const deadline=Date.now()+(options.deadlineMs??25*60000);
      let job=record.job!;
      while(job.status!=='succeeded'){
        if(['failed','cancelled','canceled'].includes(String(job.status))){record.state='FAILED';record.job=job;save(record);throw new ProviderFailedError(job.failure?.message||job.status||'服务商明确失败');}
        if(job.status==='manual_review')throw new ProviderPendingError(options.key,job.id!,'网站提交回执待核对');
        if(options.shouldStop?.()||Date.now()>=deadline)throw new ProviderPendingError(options.key,job.id!);
        await new Promise(r=>setTimeout(r,options.intervalMs??10000));
        if(options.shouldStop?.())throw new ProviderPendingError(options.key,job.id!,'本地查询已暂停');
        const id=record.job!.id!;
        try{job=await options.poll(id);}catch(error){throw new ProviderPendingError(options.key,id,'原任务查询暂不可用');}
        if(job.id&&job.id!==id)throw Error('服务商返回了其他任务的结果；已保留原任务');
        job.id=id;record.job=job;save(record);
      }
      record.state='SUCCEEDED';record.job=job;save(record);return job;
    }finally{store.close();}
  };
  const promise=work().finally(()=>inFlight.delete(lock));inFlight.set(lock,{account:options.account,promise});return promise;
}

/** Download failures never create a second generation request. Refresh at most once. */
export async function readVideoJobResult<T>(options:VideoJobOptions,read:(url:string)=>Promise<T>){
  let job=await persistentVideoJob(options);
  for(let attempt=0;attempt<2;attempt++){
    try{
      if(!job.result_url)throw new ResultDownloadError(410);
      return {job,value:await read(job.result_url)};
    }catch(error){
      if(attempt||!(error instanceof ResultDownloadError)||![401,403,404,410].includes(error.status)){
        if(job.id&&(error instanceof ResultDownloadError||error instanceof Error&&/fetch failed|ECONNRESET|ETIMEDOUT|connection lost/i.test(error.message)))throw new ProviderPendingError(options.key,job.id,error instanceof ResultDownloadError?`成品下载HTTP ${error.status}暂不可用`:'成品下载连接暂不可用');
        throw error;
      }
      job=await persistentVideoJob({...options,refreshOnly:true});
    }
  }
  throw Error('视频下载失败，原任务已保留');
}
