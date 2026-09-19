import {fireEvent,render,screen} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import {StudioImagePreview} from '../src/desktop/StudioImagePreview';
describe('画布图片放大',()=>{
  it('点击打开原图，切换尺寸并关闭时恢复焦点',()=>{render(<StudioImagePreview url="/api/studio/media/example.png" name="测试分镜"/>);const trigger=screen.getByRole('button',{name:'放大预览：测试分镜'});fireEvent.click(trigger);expect(screen.getByRole('dialog',{name:'图片预览：测试分镜'})).toBeInTheDocument();expect(document.body.style.overflow).toBe('hidden');fireEvent.click(screen.getByRole('button',{name:'查看原始尺寸'}));expect(screen.getByRole('button',{name:'适应窗口'})).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'关闭预览'}));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(trigger).toHaveFocus();expect(document.body.style.overflow).not.toBe('hidden');});
  it('Esc退出，Tab不跑到背景画布',()=>{render(<StudioImagePreview url="/example.png" name="中性图片"/>);fireEvent.click(screen.getByRole('button',{name:/放大预览/}));const close=screen.getByRole('button',{name:'关闭预览'});close.focus();fireEvent.keyDown(document,{key:'Tab'});expect(screen.getByRole('button',{name:'查看原始尺寸'})).toHaveFocus();fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();});
  it('图片失败给出原因，不自动生成或丢弃素材',()=>{render(<StudioImagePreview url="/missing.png" name="错误样本"/>);fireEvent.click(screen.getByRole('button',{name:/放大预览/}));fireEvent.error(screen.getByRole('dialog').querySelector('img')!);expect(screen.getByRole('alert')).toHaveTextContent('原始素材未删除');});
  it('缺少图片URL时没有无效放大按钮',()=>{render(<StudioImagePreview name="缺失样本"/>);expect(screen.getByText('图片文件缺失')).toBeInTheDocument();expect(screen.queryByRole('button')).not.toBeInTheDocument();});
});
