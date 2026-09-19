import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {VideoModelSelect} from '../src/desktop/VideoModelSelect';
import {readVideoCatalog,useVideoCatalog} from '../src/desktop/use-video-catalog';
import type {VideoProviderModel} from '../src/video-studio/types';

const model={id:'fuliu-intl-sd20-pro-480p',name:'伏流 SD2.0 Pro 480P',capabilities:['text_to_video'],resolutions:['480p'],aspectRatios:['9:16'],durationMin:4,durationMax:15};
const session=(models:unknown[]=[])=>({configured:true,baseUrl:'https://fuliuapi.top/v1',models});
function response(body:unknown,status=200){return new Response(JSON.stringify(body),{status});}
function Harness({value='',onChange=vi.fn(),onOpenSettings=vi.fn()}:{value?:string;onChange?:(model:VideoProviderModel)=>void;onOpenSettings?:()=>void}){
  const catalog=useVideoCatalog();return <VideoModelSelect catalog={catalog} value={value} disabled={false} onChange={onChange} onOpenSettings={onOpenSettings}/>;
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('画布视频模型目录',()=>{
  it('已认证但空目录：明确说明原因，不假装未配置或提供虚构模型',async()=>{
    const fetcher=vi.fn().mockResolvedValue(response(session()));vi.stubGlobal('fetch',fetcher);render(<Harness/>);
    expect(await screen.findByText(/Key 已连接，但服务商没有返回可用视频模型/)).toBeInTheDocument();
    expect(screen.getByRole('combobox',{name:'视频模型'})).toBeDisabled();
    expect(screen.getByRole('option')).toHaveTextContent('已连接，但无可用视频模型');
    expect(screen.getByRole('button',{name:'刷新模型目录'})).toBeEnabled();
    expect(fetcher.mock.calls[0][1]).toMatchObject({cache:'no-store'});
  });
  it('未配置和空目录分别提示',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({...session(),configured:false})));render(<Harness/>);expect(await screen.findByText(/请先保存视频 API 地址和 Key/)).toBeInTheDocument();expect(screen.getByRole('option')).toHaveTextContent('尚未保存视频 API Key');});
  it.each([401,403,402,504,502])('HTTP %s 错误不会变成成功的空目录',async status=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({message:'upstream error'},status)));render(<Harness/>);expect(await screen.findByText('连接异常')).toBeInTheDocument();expect(screen.getByRole('option')).toHaveTextContent('目录读取失败');expect(screen.getByRole('combobox')).toBeDisabled();});
  it('权限开通后，刷新可以读到和选择真实返回的模型',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(response(session())).mockResolvedValueOnce(response(session([model])));vi.stubGlobal('fetch',fetcher);const change=vi.fn();render(<Harness onChange={change}/>);
    await screen.findByText(/Key 已连接/);fireEvent.click(screen.getByRole('button',{name:'刷新模型目录'}));
    await waitFor(()=>expect(screen.getByRole('combobox')).toBeEnabled());fireEvent.change(screen.getByRole('combobox'),{target:{value:model.id}});
    expect(change).toHaveBeenCalledWith(model);expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls.every(call=>call[0]==='/api/test-ai/video-provider'&&!call[1].body)).toBe(true);
  });
  it('目录有模型但尚未适配时不误称账号未开通',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({...session(),catalog:{reportedModels:2,checkedAt:'2026-08-31'}})));render(<Harness/>);expect(await screen.findByText(/服务商返回了 2 个模型，但当前协议没有可用适配/)).toBeInTheDocument();});
  it('原模型下架时保留选择记录，不偷偷换成第一项',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(session([model]))));const change=vi.fn();render(<Harness value="previous-model" onChange={change}/>);await screen.findByText(/原来选择的模型不在当前目录/);expect(screen.getByRole('combobox')).toHaveValue('previous-model');expect(change).not.toHaveBeenCalled();});
  it('设置入口可以直接打开，不会启动生成',async()=>{const fetcher=vi.fn().mockResolvedValue(response(session()));vi.stubGlobal('fetch',fetcher);const open=vi.fn();render(<Harness onOpenSettings={open}/>);await screen.findByText(/Key 已连接/);fireEvent.click(screen.getByRole('button',{name:'打开 API 接口设置'}));expect(open).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();});
  it('后续读取失败会清除过期目录，避免继续使用旧的可用状态',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response(session([model]))).mockResolvedValueOnce(response({},403)));render(<Harness value={model.id}/>);await waitFor(()=>expect(screen.getByRole('combobox')).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'刷新模型目录'}));await screen.findByText('连接异常');expect(screen.getByRole('combobox')).toBeDisabled();});
  it('缺少目录结构时报告格式问题',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({data:[]})));await expect(readVideoCatalog()).rejects.toThrow('目录格式无效');});
  it('离开页面时中止目录请求',async()=>{
    let signal:AbortSignal|undefined;
    vi.stubGlobal('fetch',vi.fn((_url,options)=>{signal=options.signal;return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('aborted'))));}));
    const view=render(<Harness/>);view.unmount();expect(signal?.aborted).toBe(true);await act(async()=>{});
  });
});
