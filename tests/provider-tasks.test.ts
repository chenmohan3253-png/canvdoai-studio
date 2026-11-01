// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {persistentVideoJob,readVideoJobResult,ProviderPendingError,savedProviderTask,type VideoJobOptions} from '../runtime/provider-tasks';
import {ResultDownloadError} from '../runtime/result-download';
import {ProviderHttpError,parseProviderHttpError} from '../runtime/provider-http-error';
import {StudioStore} from '../runtime/studio-store';
const directories:string[]=[];
function fixture(){const directory=mkdtempSync(join(tmpdir(),'canvdoai-provider-test-'));directories.push(directory);return {directory,key:'fixture-key',account:'fixture-account',intervalMs:1,create:vi.fn(async()=>({id:'job-1',status:'succeeded',result_url:'https://example.invalid/old'})),poll:vi.fn(async()=>({id:'job-1',status:'succeeded',result_url:'https://example.invalid/fresh'}))};}
afterEach(()=>{for(const dir of directories.splice(0)){if(!resolve(dir).startsWith(resolve(tmpdir())+sep)||!basename(dir).startsWith('canvdoai-provider-test-'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}});
describe('云端已成功结果恢复',()=>{
  it('首次成功下载不额外查询或重新生成',async()=>{const opt=fixture(),read=vi.fn(async()=>new Uint8Array([1]));await readVideoJobResult(opt,read);expect(opt.create).toHaveBeenCalledOnce();expect(opt.poll).not.toHaveBeenCalled();expect(read).toHaveBeenCalledWith('https://example.invalid/old');});
  it('重新进入按原ID刷新链接且不重建任务',async()=>{const opt=fixture();await persistentVideoJob(opt);expect((await persistentVideoJob(opt)).result_url).toContain('/fresh');expect(opt.poll).toHaveBeenCalledWith('job-1');expect(opt.create).toHaveBeenCalledOnce();});
  it.each([401,403,404,410])('下载HTTP %s只刷新原任务一次',async status=>{const opt=fixture(),read=vi.fn().mockRejectedValueOnce(new ResultDownloadError(status)).mockResolvedValueOnce('bytes');expect((await readVideoJobResult(opt,read)).value).toBe('bytes');expect(opt.create).toHaveBeenCalledOnce();expect(opt.poll).toHaveBeenCalledOnce();expect(read).toHaveBeenLastCalledWith('https://example.invalid/fresh');});
  it('二次下载仍过期就停止，不无限重试或重新生成',async()=>{const opt=fixture(),read=vi.fn().mockRejectedValue(new ResultDownloadError(403));await expect(readVideoJobResult(opt,read)).rejects.toThrow('HTTP 403');expect(read).toHaveBeenCalledTimes(2);expect(opt.poll).toHaveBeenCalledOnce();expect(opt.create).toHaveBeenCalledOnce();});
  it.each([new Error('ENOSPC'),new Error('connection lost'),new ResultDownloadError(500)])('磁盘/网络/服务器错误不会创建新任务',async error=>{const opt=fixture();await expect(readVideoJobResult(opt,async()=>{throw error;})).rejects.toThrow();expect(opt.poll).not.toHaveBeenCalled();expect(opt.create).toHaveBeenCalledOnce();});
  it('服务商查询失败保留成功记录并明确表示可续查，后续仍只查询原任务',async()=>{const opt=fixture();await persistentVideoJob(opt);opt.poll.mockRejectedValueOnce(Error('offline'));await expect(persistentVideoJob(opt)).rejects.toBeInstanceOf(ProviderPendingError);const store=new StudioStore(opt.directory);try{expect(store.get<any>('provider-task',opt.key)).toMatchObject({state:'SUCCEEDED',job:{id:'job-1'}});}finally{store.close();}await persistentVideoJob(opt);expect(opt.create).toHaveBeenCalledOnce();});
  it('错误任务ID不能污染原任务',async()=>{const opt=fixture();await persistentVideoJob(opt);opt.poll.mockResolvedValueOnce({id:'other-job',status:'succeeded',result_url:'https://example.invalid/other'});await expect(persistentVideoJob(opt)).rejects.toThrow('其他任务');expect(opt.create).toHaveBeenCalledOnce();});
  it('仅刷新模式不允许在缺失记录时创建任务',async()=>{const opt=fixture();await expect(persistentVideoJob({...opt,refreshOnly:true})).rejects.toThrow('缺少原任务ID');expect(opt.create).not.toHaveBeenCalled();});
  it('相同账户并发仅提交一次',async()=>{const opt=fixture();await Promise.all([persistentVideoJob(opt),persistentVideoJob(opt)]);expect(opt.create).toHaveBeenCalledOnce();});
  it('不同账户不能复用内存中的在途任务',async()=>{const opt=fixture();let finish!:(value:any)=>void;opt.create.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const first=persistentVideoJob(opt);await expect(persistentVideoJob({...opt,account:'other-account'})).rejects.toThrow('原API账户');finish({id:'job-1',status:'succeeded'});await first;expect(opt.create).toHaveBeenCalledOnce();});
  it('超时恢复继续查询，不重复创建',async()=>{const opt:VideoJobOptions=fixture();const create=vi.fn(async()=>({id:'queued-1',status:'queued'}));opt.create=create;opt.poll=vi.fn(async()=>({id:'queued-1',status:'succeeded',result_url:'https://example.invalid/fresh'}));await expect(persistentVideoJob({...opt,deadlineMs:-1})).rejects.toThrow('不会重新提交');await persistentVideoJob(opt);expect(create).toHaveBeenCalledOnce();});
  it('提交结果未知不自动补单',async()=>{const opt=fixture();opt.create.mockRejectedValueOnce(Error('lost'));await expect(persistentVideoJob(opt)).rejects.toThrow();await expect(persistentVideoJob(opt)).rejects.toThrow('结果未知');expect(opt.create).toHaveBeenCalledOnce();});
  it('网站回执待确认只保留原ID续查，不当作已确认失败或再次提交',async()=>{const opt=fixture();opt.create.mockResolvedValueOnce({id:'job-1',status:'manual_review',result_url:''});await expect(persistentVideoJob(opt)).rejects.toThrow('回执待核对');await persistentVideoJob({...opt,refreshOnly:true});expect(opt.poll).toHaveBeenCalledWith('job-1');expect(opt.create).toHaveBeenCalledOnce();});
});

describe('明确拒绝与未知提交分别保留',()=>{
  it.each([400,401,403,404,405,413,415,422])('HTTP %s 保存拒绝证据，同键重调不再提交',async status=>{
    const opt=fixture();
    const error=new ProviderHttpError({status,path:'/v1/video-jobs',requestId:'fixture-request',message:'prompt too long',detail:{max_length:15000}});
    opt.create.mockRejectedValueOnce(error);
    await expect(persistentVideoJob(opt)).rejects.toBe(error);
    expect(savedProviderTask(opt.directory,opt.key)).toMatchObject({state:'REJECTED',error:{status,path:'/v1/video-jobs',requestId:'fixture-request',detail:{max_length:15000}}});
    await expect(persistentVideoJob(opt)).rejects.toThrow('prompt too long');
    await expect(persistentVideoJob({...opt,refreshOnly:true})).rejects.toBeInstanceOf(ProviderHttpError);
    expect(opt.create).toHaveBeenCalledOnce();expect(opt.poll).not.toHaveBeenCalled();
  });
  it.each([408,409,429,500,502,503,504])('HTTP %s 仍为 UNKNOWN，不能自动重投',async status=>{
    const opt=fixture();opt.create.mockRejectedValueOnce(new ProviderHttpError({status,path:'/v1/video-jobs',message:'ambiguous response'}));
    await expect(persistentVideoJob(opt)).rejects.toThrow();
    expect(savedProviderTask(opt.directory,opt.key)).toMatchObject({state:'UNKNOWN',error:{status}});
    await expect(persistentVideoJob(opt)).rejects.toThrow('结果未知');expect(opt.create).toHaveBeenCalledOnce();
  });
  it('成功响应无 ID 和纯文字 HTTP 400 错误不当成明确拒绝',async()=>{
    for(const failure of [undefined,Error('HTTP 400 invalid input')]){
      const opt=fixture();if(failure)opt.create.mockRejectedValueOnce(failure);else opt.create.mockResolvedValueOnce({id:'',status:'succeeded',result_url:''});
      await expect(persistentVideoJob(opt)).rejects.toThrow();expect(savedProviderTask(opt.directory,opt.key)?.state).toBe('UNKNOWN');
      await expect(persistentVideoJob(opt)).rejects.toThrow('结果未知');expect(opt.create).toHaveBeenCalledOnce();
    }
  });
  it('既存 UNKNOWN 不按旧错误文本解锁，也不能借新账户重投',async()=>{
    const opt=fixture(),store=new StudioStore(opt.directory);
    store.put('provider-task',opt.key,{key:opt.key,account:opt.account,state:'UNKNOWN',updatedAt:'old',error:{status:400,path:'/v1/videos',message:'old HTTP 400'}});store.close();
    await expect(persistentVideoJob(opt)).rejects.toThrow('结果未知');
    await expect(persistentVideoJob({...opt,account:'different-account'})).rejects.toThrow('原API账户');expect(opt.create).not.toHaveBeenCalled();
  });
  it('持久化拒绝只保存脱敏证据，不保存输入正文或密钥',async()=>{
    const opt=fixture(),secret='fixture-private-key-12345',prompt='private production prompt fixture';
    const error=await parseProviderHttpError(Response.json({message:'invalid '+prompt,detail:{input:prompt,api_key:secret},errors:[{message:'max 15000'}]},{status:422}),'/v1/videos',{secrets:[secret],requestBody:{prompt}});
    opt.create.mockRejectedValueOnce(error);await expect(persistentVideoJob(opt)).rejects.toThrow('15000');
    const saved=JSON.stringify(savedProviderTask(opt.directory,opt.key));expect(saved).not.toContain(secret);expect(saved).not.toContain(prompt);expect(saved).toContain('15000');
  });
  it('已取得任务 ID 后查询 4xx 仍保留原任务，只续查不重投',async()=>{
    const opt=fixture();opt.create.mockResolvedValueOnce({id:'job-1',status:'processing',result_url:''});
    opt.poll.mockRejectedValueOnce(new ProviderHttpError({status:404,path:'/v1/videos/job-1',message:'temporarily missing'}));
    await expect(persistentVideoJob(opt)).rejects.toBeInstanceOf(ProviderPendingError);
    expect(savedProviderTask(opt.directory,opt.key)).toMatchObject({state:'REMOTE',job:{id:'job-1'}});
    await persistentVideoJob(opt);expect(opt.create).toHaveBeenCalledOnce();
  });
  it('新键显式重试不删除原拒绝证据',async()=>{
    const opt=fixture();opt.create.mockRejectedValueOnce(new ProviderHttpError({status:422,path:'/v1/videos',message:'invalid'}));
    await expect(persistentVideoJob(opt)).rejects.toThrow();
    await persistentVideoJob({...opt,key:'explicit-new-attempt'});
    expect(opt.create).toHaveBeenCalledTimes(2);expect(savedProviderTask(opt.directory,opt.key)?.state).toBe('REJECTED');
  });
});
