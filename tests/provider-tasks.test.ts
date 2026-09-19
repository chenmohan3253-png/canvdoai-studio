// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {persistentVideoJob,readVideoJobResult,type VideoJobOptions} from '../runtime/provider-tasks';
import {ResultDownloadError} from '../runtime/result-download';
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
  it('服务商查询失败保留成功记录，后续仍只查询原任务',async()=>{const opt=fixture();await persistentVideoJob(opt);opt.poll.mockRejectedValueOnce(Error('offline'));await expect(persistentVideoJob(opt)).rejects.toThrow('offline');const store=new StudioStore(opt.directory);try{expect(store.get<any>('provider-task',opt.key)).toMatchObject({state:'SUCCEEDED',job:{id:'job-1'}});}finally{store.close();}await persistentVideoJob(opt);expect(opt.create).toHaveBeenCalledOnce();});
  it('错误任务ID不能污染原任务',async()=>{const opt=fixture();await persistentVideoJob(opt);opt.poll.mockResolvedValueOnce({id:'other-job',status:'succeeded',result_url:'https://example.invalid/other'});await expect(persistentVideoJob(opt)).rejects.toThrow('其他任务');expect(opt.create).toHaveBeenCalledOnce();});
  it('仅刷新模式不允许在缺失记录时创建任务',async()=>{const opt=fixture();await expect(persistentVideoJob({...opt,refreshOnly:true})).rejects.toThrow('缺少原任务ID');expect(opt.create).not.toHaveBeenCalled();});
  it('相同账户并发仅提交一次',async()=>{const opt=fixture();await Promise.all([persistentVideoJob(opt),persistentVideoJob(opt)]);expect(opt.create).toHaveBeenCalledOnce();});
  it('不同账户不能复用内存中的在途任务',async()=>{const opt=fixture();let finish!:(value:any)=>void;opt.create.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const first=persistentVideoJob(opt);await expect(persistentVideoJob({...opt,account:'other-account'})).rejects.toThrow('原API账户');finish({id:'job-1',status:'succeeded'});await first;expect(opt.create).toHaveBeenCalledOnce();});
  it('超时恢复继续查询，不重复创建',async()=>{const opt:VideoJobOptions=fixture();const create=vi.fn(async()=>({id:'queued-1',status:'queued'}));opt.create=create;opt.poll=vi.fn(async()=>({id:'queued-1',status:'succeeded',result_url:'https://example.invalid/fresh'}));await expect(persistentVideoJob({...opt,deadlineMs:-1})).rejects.toThrow('不会重新提交');await persistentVideoJob(opt);expect(create).toHaveBeenCalledOnce();});
  it('提交结果未知不自动补单',async()=>{const opt=fixture();opt.create.mockRejectedValueOnce(Error('lost'));await expect(persistentVideoJob(opt)).rejects.toThrow();await expect(persistentVideoJob(opt)).rejects.toThrow('结果未知');expect(opt.create).toHaveBeenCalledOnce();});
});
