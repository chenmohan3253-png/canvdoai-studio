import {render,screen,cleanup} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {CanvasTaskStatusNote} from '../src/desktop/CanvasTaskStatusNote';
import type {CanvasTask} from '../src/desktop/canvas-model';
afterEach(cleanup);
it('保留原始失败但同时展示任务创建时间、历史核定及当前可操作说明',()=>{
  const task:CanvasTask={id:'old',canvasId:'canvas',state:'FAILED',message:'HTTP 422: invalid request',completed:0,total:1,createdAt:'2026-11-01T12:00:00Z',statusContext:{source:'saved_task_record',observedAt:'2026-11-02T00:00:00Z',querySubmittedGeneration:false,providerCorrection:{state:'REJECTED',basis:'EXACT_MIGRATION_TASK_ID',correctedAt:'2026-11-01T16:30:00Z',originalAttemptAt:'2026-11-01T12:00:10Z',httpStatus:422},guidance:'这是历史记录，不是本次查询产生的新错误。'}};
  const {container}=render(<CanvasTaskStatusNote task={task}/>);
  expect(screen.getByText('原始失败记录：HTTP 422: invalid request')).toBeInTheDocument();
  expect(screen.getByText('历史状态已核定：REJECTED（提交被拒绝）')).toBeInTheDocument();
  expect(screen.getByText(task.statusContext!.guidance)).toBeInTheDocument();
  expect([...container.querySelectorAll('time')].map(item=>item.dateTime)).toEqual([task.createdAt,task.statusContext!.providerCorrection!.correctedAt]);
});
