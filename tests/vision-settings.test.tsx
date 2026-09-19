import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {Settings} from '../src/desktop/Settings';
import {defaults} from '../electron/config';
import type {ConfigView} from '../src/desktop/bridge';
import type {VisionReport} from '../src/desktop/vision-types';

afterEach(()=>{delete window.desktop;});
function fixture(){
  const {chatKey,visionKey,imageKey,videoKey,transcriptionKey,assetUploadKey,...plain}=defaults;
  const view:ConfigView={...plain,chatConfigured:true,visionConfigured:true,imageConfigured:true,videoConfigured:false,transcriptionConfigured:true,assetUploadConfigured:false,dataPath:'test-data',encrypted:true};
  const report:VisionReport={baseUrl:view.chatBase,effectiveModel:view.textModel,phase:'idle',candidates:[],catalogMessage:'尚未读取目录',message:'等待手动检测',tested:0,maxTests:4};
  let listener:(r:VisionReport)=>void=()=>{};
  const api={settings:vi.fn(async()=>view),visionReport:vi.fn(async()=>report),onVisionProgress:vi.fn(fn=>{listener=fn;return vi.fn();}),runVision:vi.fn(async()=>report),cancelVision:vi.fn(async()=>{}),saveSettings:vi.fn(async input=>({...view,...input})),testConnection:vi.fn(async()=>({message:'ok'}))};
  window.desktop=api as unknown as NonNullable<Window['desktop']>;
  const candidates:VisionReport['candidates']=[{id:'vision-one',source:'catalog',priority:80,hint:'目录声明',status:'passed',message:'两张随机图片验证通过'},{id:'vision-two',source:'catalog',priority:50,hint:'模型名称',status:'untested',message:'未测试'}];
  return {view,report,api,candidates,progress:(r:VisionReport)=>listener(r)};
}
async function ready(){await screen.findByText('等待手动检测');}
describe('视觉模型选择界面',()=>{
  it('视频设置只保留 Dispatch / Seedance，不再显示伏流海外协议',async()=>{
    fixture();render(<Settings/>);await ready();
    expect(screen.queryByText(/伏流海外/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('接口协议')).not.toBeInTheDocument();
    expect(screen.getByText('Dispatch / Seedance · /v1/video-jobs')).toBeInTheDocument();
    expect(screen.getByLabelText('视频 API Key')).toBeInTheDocument();
  });
  it('旧伏流配置被停用时给出重新填写提示',async()=>{
    const f=fixture();f.view.removedLegacyVideoConfig=true;render(<Settings/>);await ready();
    expect(screen.getByText(/已停用旧版“伏流海外分组”配置/)).toBeInTheDocument();
  });
  it('进入设置不会自动调用付费视觉探测',async()=>{
    const f=fixture();render(<Settings/>);await ready();expect(f.api.runVision).not.toHaveBeenCalled();
    expect(screen.getByText(/当前模型尚未验证通过/)).toBeInTheDocument();expect(screen.getByText('模型：your-text-model（共用文本模型）')).toBeInTheDocument();
  });
  it('自动推荐后仅填入视觉模型，用户保存才生效，不覆盖文本模型',async()=>{
    const f=fixture();f.api.runVision.mockResolvedValue({...f.report,phase:'complete',candidates:f.candidates,recommendedModel:'vision-one',tested:1,message:'基础验证通过'});
    render(<Settings/>);await ready();fireEvent.click(screen.getByRole('button',{name:'自动检测并推荐视觉模型'}));
    await waitFor(()=>expect(screen.getByLabelText('视觉模型 ID（也可手动填写）')).toHaveValue('vision-one'));
    expect(f.api.runVision).toHaveBeenCalledWith('detect',undefined);expect(f.api.saveSettings).not.toHaveBeenCalled();expect(screen.getByLabelText('文本模型 ID')).toHaveValue(f.view.textModel);
    expect(screen.getByText(/模型选择尚未保存/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'保存全部配置'}));await waitFor(()=>expect(f.api.saveSettings).toHaveBeenCalledWith({visionModel:'vision-one'}));
    await waitFor(()=>expect(screen.queryByText(/已选中 vision-one，请点击上方/)).not.toBeInTheDocument());
  });
  it('失败保留目录，显示原因并可手动换模型继续验证',async()=>{
    const f=fixture();f.api.runVision.mockResolvedValue({...f.report,phase:'complete',candidates:[{...f.candidates[0],status:'unverified',message:'HTTP 502：网关暂时异常，暂未验证'},f.candidates[1]],message:'暂未找到通过者'});
    render(<Settings/>);await ready();fireEvent.click(screen.getByRole('button',{name:'自动检测并推荐视觉模型'}));
    await screen.findByText('HTTP 502：网关暂时异常，暂未验证');const select=screen.getByLabelText('从接口模型目录选择');
    expect(within(select).getAllByRole('option')).toHaveLength(3);expect(screen.getByLabelText('视觉模型 ID（也可手动填写）')).toHaveValue('');
    fireEvent.change(select,{target:{value:'vision-two'}});fireEvent.click(screen.getByRole('button',{name:'验证当前选择的模型'}));
    await waitFor(()=>expect(f.api.runVision).toHaveBeenLastCalledWith('test','vision-two'));
  });
  it('存在未保存接口时阻止测试，避免密钥发到旧接口',async()=>{
    const f=fixture();render(<Settings/>);await ready();fireEvent.change(screen.getByLabelText('视觉 API Base URL（留空共用剧本接口）'),{target:{value:'https://new.invalid/v1'}});
    fireEvent.click(screen.getByRole('button',{name:'自动检测并推荐视觉模型'}));await screen.findByText(/接口配置有未保存修改/);expect(f.api.runVision).not.toHaveBeenCalled();
  });
  it('没有目录也可手动填写模型验证，不要求先保存模型',async()=>{
    const f=fixture();render(<Settings/>);await ready();fireEvent.change(screen.getByLabelText('视觉模型 ID（也可手动填写）'),{target:{value:'custom-vl'}});
    fireEvent.click(screen.getByRole('button',{name:'验证当前选择的模型'}));await waitFor(()=>expect(f.api.runVision).toHaveBeenCalledWith('test','custom-vl'));
  });
  it('检测进度可见、保存被禁用、可停止检测',async()=>{
    const f=fixture();let finish!:(r:VisionReport)=>void;f.api.runVision.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    render(<Settings/>);await ready();fireEvent.click(screen.getByRole('button',{name:'自动检测并推荐视觉模型'}));
    act(()=>f.progress({...f.report,phase:'testing',activeModel:'vision-one',message:'正在测试 vision-one',candidates:[{...f.candidates[0],status:'testing'}]}));
    await screen.findByText('正在测试 vision-one');expect(screen.getByRole('button',{name:'保存全部配置'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'停止检测'}));expect(f.api.cancelVision).toHaveBeenCalledOnce();
    await act(async()=>finish({...f.report,phase:'cancelled',message:'已停止检测'}));expect(screen.getByRole('button',{name:'保存全部配置'})).toBeEnabled();
  });
  it('只读取目录不触发自动检测或自动选中',async()=>{
    const f=fixture();f.api.runVision.mockResolvedValue({...f.report,phase:'complete',candidates:[f.candidates[1]],message:'仅目录'});
    render(<Settings/>);await ready();fireEvent.click(screen.getByRole('button',{name:'只读取模型目录'}));await screen.findByText('仅目录');
    expect(f.api.runVision).toHaveBeenCalledWith('read',undefined);expect(screen.getByLabelText('视觉模型 ID（也可手动填写）')).toHaveValue('');
  });
});
