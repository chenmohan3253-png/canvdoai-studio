import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AssetLibrary} from '../src/desktop/AssetLibrary';
import {studioApi} from '../src/desktop/studio-client';
import type {StudioAsset} from '../src/desktop/canvas-model';

vi.mock('../src/desktop/studio-client',()=>({studioApi:vi.fn(),downloadStudio:vi.fn()}));
afterEach(()=>{vi.clearAllMocks();});

const assets:StudioAsset[]=[
  {id:'a-photo',name:'甲项目角色照',kind:'image',createdAt:'',sha256:'a'.repeat(64),origin:{module:'import',projectId:'project-a'},catalog:{episodeId:'E001',shotId:'S01',characterId:'C01'}},
  {id:'b-photo',name:'乙项目角色照',kind:'image',createdAt:'',sha256:'b'.repeat(64),origin:{module:'import',projectId:'project-b'}},
  {id:'shared-photo',name:'总库授权素材',kind:'image',createdAt:'',sha256:'c'.repeat(64),libraryScope:'shared',origin:{module:'import',projectId:'project-a'},catalog:{reviewStatus:'approved',reuseAllowed:true,rightsNote:'自有版权',sourceAssetId:'a-photo',sourceSha256:'c'.repeat(64)}}
];
const state={projects:[{id:'project-a',name:'甲项目',createdAt:'',updatedAt:''},{id:'project-b',name:'乙项目',createdAt:'',updatedAt:''}],canvases:[],tasks:[],assets};

describe('分层素材中心',()=>{
  it('总库与各项目素材分栏展示，不把其他项目素材混进当前列表',async()=>{
    vi.mocked(studioApi).mockResolvedValue(state as any);
    render(<MemoryRouter><AssetLibrary/></MemoryRouter>);
    expect(await screen.findByText('总库授权素材')).toBeInTheDocument();
    expect(screen.queryByText('甲项目角色照')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:/甲项目 1/}));
    expect(screen.getByText('甲项目角色照')).toBeInTheDocument();
    expect(screen.queryByText('乙项目角色照')).not.toBeInTheDocument();
    expect(screen.queryByText('总库授权素材')).not.toBeInTheDocument();
  });
  it('引用总库原件时明确指定目标项目并使用新的项目素材记录',async()=>{
    vi.mocked(studioApi).mockImplementation(async(path)=>{
      if(path==='/state')return state as any;
      if(path==='/asset/reference')return {...assets[2],id:'project-copy',libraryScope:'project',origin:{module:'import',projectId:'project-b'}} as any;
      throw Error('unexpected '+path);
    });
    render(<MemoryRouter><AssetLibrary/></MemoryRouter>);
    await screen.findByText('总库授权素材');
    fireEvent.click(screen.getByRole('button',{name:'查看详情'}));
    fireEvent.change(screen.getByLabelText('目标项目'),{target:{value:'project-b'}});
    fireEvent.click(screen.getByRole('button',{name:'引用到所选项目'}));
    await waitFor(()=>expect(vi.mocked(studioApi)).toHaveBeenCalledWith('/asset/reference',{sharedAssetId:'shared-photo',targetProjectId:'project-b'}));
    expect(await screen.findByText(/已在目标项目建立独立素材记录/)).toBeInTheDocument();
  });
});
