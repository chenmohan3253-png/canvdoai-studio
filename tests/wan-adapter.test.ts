// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {videoGatewayFetch,wanCreateBody,normalizeWanJob} from '../runtime/fuliu-adapter';
import {nodeFingerprints} from '../runtime/canvas-fingerprint';
import {newNode} from '../src/desktop/canvas-model';

const config={videoProtocol:'dispatch',videoBase:'https://video.example.com',videoKey:'test-key'};
const task={
  model:'wan-3.0:standard',prompt:'一位旅客走进车内',
  parameters:{duration_seconds:8,resolution:'480p',aspect_ratio:'9:16',generate_audio:true},
  assets:[{role:'first_frame',kind:'image',cdn_url:'https://cdn.example.com/first.png'}]
};

describe('Wan 3.0 专用网关',()=>{
  it('提交时使用异步任务路径，并保留首帧和原生音轨',async()=>{
    const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>Response.json({output:{task_id:'wan-task-1',task_status:'PENDING'}}));
    const response=await videoGatewayFetch(config,'/v1/video-jobs',{method:'POST',body:JSON.stringify(task)},fetcher as typeof fetch);
    const [url,options]:any=fetcher.mock.calls[0];
    expect(url).toBe('https://video.example.com/api/v1/services/aigc/video-generation/video-synthesis');
    expect(options.headers.get('X-DashScope-Async')).toBe('enable');
    expect(JSON.parse(options.body)).toMatchObject({model:'wan3.0-video',input:{media:[{type:'first_frame',url:'https://cdn.example.com/first.png'}]},parameters:{resolution:'480P',ratio:'9:16',duration:8,audio:true}});
    expect(await response.json()).toMatchObject({id:'wan-task-1',status:'processing'});
  });
  it('Wan 任务查询走专用路径，但其它模型保持通用任务路径',async()=>{
    const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>Response.json({output:{task_id:'wan-task-1',task_status:'SUCCEEDED',video_url:'https://cdn.example.com/video.mp4'}}));
    const response=await videoGatewayFetch(config,'/v1/wan-tasks/wan-task-1',{},fetcher as typeof fetch);
    expect(fetcher.mock.calls[0][0]).toBe('https://video.example.com/api/v1/tasks/wan-task-1');
    expect(await response.json()).toMatchObject({status:'succeeded',result_url:'https://cdn.example.com/video.mp4'});
    await videoGatewayFetch(config,'/v1/video-jobs/seedance-task-1',{},fetcher as typeof fetch);
    expect(fetcher.mock.calls[1][0]).toBe('https://video.example.com/v1/video-jobs/seedance-task-1');
  });
  it('Seedance 创建请求保持旧协议',async()=>{
    const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>Response.json({id:'seedance-task-1'}));
    await videoGatewayFetch(config,'/v1/video-jobs',{method:'POST',body:JSON.stringify({...task,model:'seedance-2.5'})},fetcher as typeof fetch);
    expect(fetcher.mock.calls[0][0]).toBe('https://video.example.com/v1/video-jobs');
  });
  it('关闭原生音轨时参数为 false；失败状态保留服务商原因',()=>{
    expect(wanCreateBody({...task,parameters:{...task.parameters,generate_audio:false}}).parameters.audio).toBe(false);
    expect(normalizeWanJob({output:{task_id:'wan-task-2',task_status:'FAILED',code:'CONTENT_REVIEW',message:'审核未通过'}})).toMatchObject({id:'wan-task-2',status:'failed',failure:{message:'CONTENT_REVIEW: 审核未通过'}});
  });
  it('音频开关改变指纹，不会重用旧视频版本',()=>{
    const node=newNode('videoGenerate');
    const original=nodeFingerprints(node,[],{videoBase:config.videoBase});
    node.data.generateAudio=false;
    const silent=nodeFingerprints(node,[],{videoBase:config.videoBase});
    expect(silent.current).not.toBe(original.current);
    expect(silent.legacy).toBe(original.legacy);
  });
});
