import {describe,expect,it} from 'vitest';
import {topologicalOrder,validateGraph} from '../src/desktop/canvas-model';
import {createWorkflowDocument,WORKFLOW_TEMPLATES} from '../src/desktop/workflow-templates';

describe('内置工作流模板',()=>{
  it('每个模板都能生成可执行且无环的画布',()=>{
    for(const template of WORKFLOW_TEMPLATES){
      const doc=createWorkflowDocument({id:`canvas-${template.id}`,name:template.name,projectId:'local',templateId:template.id,preferredVideoModel:{id:'test-video',resolution:'720p',aspectRatio:'9:16',duration:5}});
      expect(validateGraph(doc,[]),template.name).toBeUndefined();
      expect(topologicalOrder(doc),template.name).toHaveLength(doc.nodes.length);
      if(template.id!=='blank'){
        expect(doc.nodes.some(node=>node.data.kind==='videoGenerate')).toBe(true);
        expect(doc.nodes.some(node=>node.data.kind==='output')).toBe(true);
        expect(doc.edges.length).toBeGreaterThan(0);
        expect(doc.nodes.filter(node=>node.data.kind==='videoGenerate').every(node=>node.data.model==='test-video')).toBe(true);
      }
    }
  });

  it('重复创建模板不会复用节点或连线ID',()=>{
    const first=createWorkflowDocument({id:'first',name:'A',projectId:'local',templateId:'professional-drama'});
    const second=createWorkflowDocument({id:'second',name:'B',projectId:'local',templateId:'professional-drama'});
    const firstIds=new Set([...first.nodes.map(node=>node.id),...first.edges.map(edge=>edge.id)]);
    expect([...second.nodes.map(node=>node.id),...second.edges.map(edge=>edge.id)].some(id=>firstIds.has(id))).toBe(false);
  });
});
