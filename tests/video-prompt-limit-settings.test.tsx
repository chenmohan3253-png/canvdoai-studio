import {useState} from 'react';
import {describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {VideoPromptLimitSettings} from '../src/desktop/VideoPromptLimitSettings';

const base='https://video.example.test';
function Fixture({baseUrl=base,initial='{}',disabled=false,onChange=vi.fn()}:{baseUrl?:string;initial?:string;disabled?:boolean;onChange?:(value:string)=>void}){
  const [value,setValue]=useState(initial);
  return <VideoPromptLimitSettings baseUrl={baseUrl} value={value} disabled={disabled} onChange={next=>{setValue(next);onChange(next);}}/>;
}

describe('已确认视频提示词上限设置',()=>{
  it('编辑当前地址和模型，保留其他地址的配置，并允许恢复目录值',()=>{
    const onChange=vi.fn(),other='https://other.example.test';
    render(<Fixture initial={JSON.stringify({[other]:{other:8000}})} onChange={onChange}/>);
    fireEvent.change(screen.getByLabelText('上限对应的模型 ID'),{target:{value:'seedance-2.0:standard'}});
    fireEvent.change(screen.getByLabelText('已确认的最大字符数'),{target:{value:'15000'}});
    fireEvent.click(screen.getByRole('button',{name:'添加或更新已确认上限'}));
    expect(JSON.parse(onChange.mock.calls[0][0])).toEqual({[other]:{other:8000},[base]:{'seedance-2.0:standard':15000}});
    fireEvent.click(screen.getByRole('button',{name:'编辑 seedance-2.0:standard 的上限'}));
    expect(screen.getByLabelText('已确认的最大字符数')).toHaveValue(15000);
    fireEvent.click(screen.getByRole('button',{name:'恢复 seedance-2.0:standard 的目录上限'}));
    expect(JSON.parse(onChange.mock.calls[1][0])).toEqual({[other]:{other:8000}});
  });

  it.each(['0','-1','1.5','100001'])('不接受非法上限 %s',value=>{
    const onChange=vi.fn();render(<Fixture onChange={onChange}/>);
    fireEvent.change(screen.getByLabelText('上限对应的模型 ID'),{target:{value:'test-model'}});
    fireEvent.change(screen.getByLabelText('已确认的最大字符数'),{target:{value}});
    fireEvent.click(screen.getByRole('button',{name:'添加或更新已确认上限'}));
    expect(screen.getByRole('alert')).toHaveTextContent('整数');expect(onChange).not.toHaveBeenCalled();
  });

  it('切换接口地址清空待编辑项，不把先前地址的确认带到新地址',()=>{
    const {rerender}=render(<Fixture initial={JSON.stringify({[base]:{custom:15000}})}/>);
    fireEvent.click(screen.getByRole('button',{name:'编辑 custom 的上限'}));
    rerender(<Fixture baseUrl="https://new.example.test"/>);
    expect(screen.getByLabelText('上限对应的模型 ID')).toHaveValue('');
    expect(screen.getByLabelText('已确认的最大字符数')).toHaveValue(null);
    expect(screen.queryByRole('button',{name:'恢复 custom 的目录上限'})).not.toBeInTheDocument();
  });

  it('正在保存或浏览器预览时禁止修改',()=>{
    render(<Fixture disabled initial={JSON.stringify({[base]:{custom:15000}})}/>);
    expect(screen.getByLabelText('上限对应的模型 ID')).toBeDisabled();
    expect(screen.getByRole('button',{name:'添加或更新已确认上限'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'恢复 custom 的目录上限'})).toBeDisabled();
  });
});
