import {createHash} from 'node:crypto';
import {StudioStore} from './studio-store';
import {ResultDownloadError} from './result-download';
export interface RemoteJob {id?:string;status?:string;result_url?:string|null;failure?:{message?:string;category?:string}|null;}
interface Intent {key:string;account:string;state:string;job?:RemoteJob;updatedAt:string;}
export interface FailedProviderTask {key:string;shotId:string;updatedAt:string;job?:RemoteJob;}
export interface VideoJobOptions {directory:string;key:string;account:string;create:()=>Promise<RemoteJob>;poll:(id:string)=>Promise<RemoteJob>;deadlineMs?:number;intervalMs?:number;refreshOnly?:boolean;}
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
      if(record&&record.account!==options.account)throw Error('该在途任务属于原API账户，请恢复原接口配置；不会向新账户重复提交');
      if(record?.state==='UNKNOWN'||(record?.state==='SUBMITTING'&&!record.job?.id))throw Error('远端提交结果未知，已保留幂等键。请先在服务商后台确认/关联任务ID，禁止盲目重新扣费');
      if(record?.state==='FAILED'){
        const detail=record.job?.failure?.message||record.job?.status||'服务商未返回明确失败原因';
        throw Error('远端生成失败：'+detail+'；原失败任务已保留，只有作者明确重试才会创建新任务');
      }
      if(options.refreshOnly&&!record?.job?.id)throw Error('缺少原任务ID，不能刷新下载地址；不会创建新视频任务');
      // A resumed successful job may carry an expired signed URL. Refresh by ID only.
      if(record?.state==='SUCCEEDED'){
        const id=record.job?.id;if(!id)throw Error('缺少原任务ID；不会重新生成视频');
        const fresh=await options.poll(id);
        if(fresh.id&&fresh.id!==id)throw Error('服务商返回了其他任务的结果；已保留原任务');
        if(fresh.status!=='succeeded'||!fresh.result_url)throw Error('云端成功任务的下载地址暂不可用；原任务保留，请稍后继续，不会重新生成');
        record.job={...fresh,id};save(record);return record.job;
      }
      if(!record){
        record={key:options.key,account:options.account,state:'SUBMITTING',updatedAt:''};save(record);
        try{const job=await options.create();if(!job.id)throw Error('服务商未返回任务ID');record.job=job;record.state='REMOTE';save(record);}
        catch(e){record.state='UNKNOWN';save(record);throw e;}
      }
      const deadline=Date.now()+(options.deadlineMs??25*60000);
      let job=record.job!;
      while(job.status!=='succeeded'){
        if(['failed','cancelled','canceled'].includes(String(job.status))){record.state='FAILED';record.job=job;save(record);throw Error('远端生成失败：'+(job.failure?.message||job.status));}
        if(Date.now()>=deadline)throw Error(`远端任务 ${job.id} 仍在运行；已保存ID，下次继续查询，不会重新提交`);
        await new Promise(r=>setTimeout(r,options.intervalMs??10000));
        const id=record.job!.id!;job=await options.poll(id);
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
      if(attempt||!(error instanceof ResultDownloadError)||![401,403,404,410].includes(error.status))throw error;
      job=await persistentVideoJob({...options,refreshOnly:true});
    }
  }
  throw Error('视频下载失败，原任务已保留');
}
