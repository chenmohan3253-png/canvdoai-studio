import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createPipeServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { mkdir, writeFile, rm } from 'node:fs/promises';

const appData = join(tmpdir(), `canvdoai-mcp-smoke-${randomUUID()}`);
const suffix = createHash('sha256').update(join(appData, 'canvdoai-desktop').toLowerCase()).digest('hex').slice(0, 24);
const pipeName = `\\\\.\\pipe\\canvdoai-mcp-${suffix}`;
const token = 'test-session-token';
const servers = [];
let currentOrigin = '';
let child;

async function startStudio(label) {
  const projects = [], archivedProjects = [], assets = [], tasks = [], canvases = [{id:label,name:label,nodes:[]}];
  const server = createHttpServer(async (request, response) => {
    if (request.headers['x-canvdoai-session'] !== token) {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    let value;
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const input = url.pathname === '/api/studio/asset/upload' ? undefined : JSON.parse(bytes.toString());
      if (url.pathname === '/api/studio/project') {
        value = {id:`project-${label}`,name:input.name};projects.push(value);
      } else if (url.pathname === '/api/studio/project/archive') {
        const index=projects.findIndex(project=>project.id===input.projectId&&project.name===input.projectName);
        if(index<0||input.confirmDelete!==true){response.writeHead(400).end();return;}
        const [project]=projects.splice(index,1);
        archivedProjects.push({id:project.id,name:project.name,canvasCount:canvases.filter(canvas=>canvas.projectId===project.id).length,deletedAt:new Date().toISOString()});
        value={id:project.id,name:project.name};
      } else if (url.pathname === '/api/studio/project/restore') {
        const index=archivedProjects.findIndex(project=>project.id===input.projectId);
        if(index<0||input.confirmRestore!==true){response.writeHead(400).end();return;}
        const [project]=archivedProjects.splice(index,1);value={id:project.id,name:project.name};projects.push(value);
      } else if (url.pathname === '/api/studio/canvas/create') {
        value = {id:`canvas-${label}`,name:input.name,projectId:input.projectId,nodes:[{id:'script-node',position:{x:0,y:0},data:{kind:'textInput',label:'剧本',prompt:'',versions:[]}},{id:'video-node',position:{x:350,y:0},data:{kind:'videoGenerate',label:'视频',prompt:'',model:'wan3_0_prime',resolution:'1080p',aspectRatio:'16:9',duration:5,versions:[]}}],edges:[],revision:1};canvases.push(value);
      } else if (url.pathname === '/api/studio/canvas') {
        value = {...input,revision:input.revision+1};
        const index=canvases.findIndex(canvas=>canvas.id===input.id);if(index<0){response.writeHead(404).end();return;}canvases[index]=value;
      } else if (url.pathname === '/api/studio/canvas/clone') {
        const source=canvases.find(canvas=>canvas.id===input.sourceCanvasId);
        if(!source){response.writeHead(404).end();return;}
        value={...structuredClone(source),id:`clone-${label}`,name:input.name,projectId:input.targetProjectId,revision:1};canvases.push(value);
      } else if (url.pathname === '/api/studio/run') {
        value={id:`task-${label}`,canvasId:input.canvasId,nodeId:input.nodeId,state:'QUEUED',message:'隔离测试任务',completed:0,total:1,createdAt:new Date().toISOString()};tasks.push(value);
      } else if (url.pathname === '/api/studio/asset/upload') {
        const kind=url.searchParams.get('kind'),wave=kind==='audio'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE';
        if (!wave&&bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') {response.writeHead(400).end();return;}
        value={id:`${wave?'audio':'asset'}-${label}`,name:url.searchParams.get('name'),kind,url:'/api/studio/media/test.'+(wave?'wav':'png'),origin:{projectId:url.searchParams.get('projectId')}};assets.push(value);
      }
    }
    if (url.pathname === '/api/studio/state') value = {projects,archivedProjects,canvases:canvases.filter(canvas=>!url.searchParams.has('projectId')||canvas.projectId===url.searchParams.get('projectId')),assets:assets.filter(asset=>!url.searchParams.has('projectId')||asset.origin.projectId===url.searchParams.get('projectId')),tasks};
    if (!value) { response.writeHead(404).end();return; }
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const pending = new Map();
let buffer = '';
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request ${id} timed out`));
    }, 7000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}

const expectedTools=[
  'append_canvas_continuation','extract_video_last_frame','list_projects','create_project','archive_project','restore_project',
  'create_canvas','clone_canvas_to_project','list_assets','list_shared_assets','import_local_asset','update_asset_catalog',
  'promote_asset_to_shared','reference_shared_asset','update_canvas_node','add_canvas_node','connect_canvas_nodes',
  'attach_canvas_asset','get_public_prices','list_canvases','get_canvas','get_task_status','resume_provider_task',
  'unlink_provider_form','get_provider_form_unlink','inspect_provider_submission','get_provider_submission_inspection',
  'prepare_canvas_video_request','get_video_route_limits','run_canvas_node'
];

function assertToolCatalog(response,label) {
  const catalog=response.result?.tools;
  if(!Array.isArray(catalog))throw new Error(`${label} MCP tool catalog unavailable`);
  const actual=catalog.map(tool=>tool.name),duplicates=actual.filter((name,index)=>actual.indexOf(name)!==index);
  if(duplicates.length)throw new Error(`${label} duplicate MCP tools: ${[...new Set(duplicates)].join(',')}`);
  const missing=expectedTools.filter(name=>!actual.includes(name)),unexpected=actual.filter(name=>!expectedTools.includes(name));
  if(actual.length!==expectedTools.length||missing.length||unexpected.length){
    throw new Error(`${label} MCP tool catalog mismatch: count=${actual.length}; missing=${missing.join(',')||'none'}; unexpected=${unexpected.join(',')||'none'}`);
  }
  const byName=new Map(catalog.map(tool=>[tool.name,tool]));
  const schema=(name,required)=>{
    const value=byName.get(name)?.inputSchema;
    if(!value||value.type!=='object'||value.additionalProperties!==false)throw new Error(`${label} ${name} must use a strict object schema`);
    if(JSON.stringify(value.required||[])!==JSON.stringify(required))throw new Error(`${label} ${name} required fields changed: ${JSON.stringify(value.required||[])}`);
    return value;
  };
  schema('append_canvas_continuation',['canvasId','sourceNodeId']);
  schema('extract_video_last_frame',['projectId','assetId']);
  const resume=schema('resume_provider_task',['taskId']);
  if('force' in (resume.properties||{})||'confirmCost' in (resume.properties||{}))throw new Error(`${label} resume_provider_task exposed generation controls`);
  const unlink=schema('unlink_provider_form',['sourceJobId','expectedRefs','confirmUnlink']);
  if(unlink.properties?.confirmUnlink?.const!==true||unlink.properties?.expectedRefs?.minItems!==1||unlink.properties?.expectedRefs?.maxItems!==20||unlink.properties?.expectedRefs?.items?.additionalProperties!==false)throw new Error(`${label} unlink_provider_form confirmation or reference bounds changed`);
  const refRequired=unlink.properties?.expectedRefs?.items?.required||[],roleEnum=unlink.properties?.expectedRefs?.items?.properties?.role?.enum||[];
  if(JSON.stringify(refRequired)!==JSON.stringify(['website_media_id','kind','role'])||JSON.stringify(roleEnum)!==JSON.stringify(['reference','first_frame','last_frame']))throw new Error(`${label} unlink_provider_form reference schema changed`);
  schema('get_provider_form_unlink',['maintenanceJobId']);
  schema('inspect_provider_submission',['sourceJobId']);
  schema('get_provider_submission_inspection',['inspectionId']);
  schema('prepare_canvas_video_request',['canvasId','nodeId']);
  schema('get_video_route_limits',['modelId']);
  const run=schema('run_canvas_node',['canvasId','confirmCost']);
  if(run.properties?.confirmCost?.const!==true)throw new Error(`${label} run_canvas_node lost explicit fee confirmation`);
  return actual;
}

try {
  await mkdir(appData,{recursive:true});
  currentOrigin = await startStudio('before-restart');
  const pipe = createPipeServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (input.includes('\n')) socket.end(JSON.stringify({origin:currentOrigin,token})+'\n');
    });
  });
  pipe.listen(pipeName);
  await once(pipe, 'listening');
  servers.push(pipe);

  child = spawn(process.execPath, ['build/mcp-stdio.cjs'], {
    env:{...process.env,APPDATA:appData},
    stdio:['pipe','pipe','pipe']
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0,newline);
      buffer = buffer.slice(newline+1);
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const initialized = await request(1,'initialize',{protocolVersion:'2025-03-26'});
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  const tools = await request(2,'tools/list');
  const firstCatalog=assertToolCatalog(tools,'initial');

  const first = await request(3,'tools/call',{name:'list_canvases',arguments:{}});
  const firstName = JSON.parse(first.result?.content?.[0]?.text ?? '{}').canvases?.[0]?.name;
  if (firstName !== 'before-restart') throw new Error(`First session failed: ${firstName}`);
  const createdProject = await request(5,'tools/call',{name:'create_project',arguments:{name:'隔离测试项目'}});
  const projectId = JSON.parse(createdProject.result?.content?.[0]?.text ?? '{}').project?.id;
  if (projectId !== 'project-before-restart') throw new Error('MCP project creation failed');
  const createdCanvas = await request(6,'tools/call',{name:'create_canvas',arguments:{projectId,name:'项目内画布',templateId:'blank'}});
  if (JSON.parse(createdCanvas.result?.content?.[0]?.text ?? '{}').canvas?.projectId !== projectId) throw new Error('MCP project-scoped canvas creation failed');
  const projectCanvases = await request(7,'tools/call',{name:'list_canvases',arguments:{projectId}});
  if (JSON.parse(projectCanvases.result?.content?.[0]?.text ?? '{}').canvases?.length !== 1) throw new Error('MCP project filter failed');
  const canvasId=`canvas-before-restart`;
  const continued=await request(24,'tools/call',{name:'append_canvas_continuation',arguments:{canvasId,sourceNodeId:'video-node'}});
  const continuation=JSON.parse(continued.result?.content?.[0]?.text ?? '{}');
  if(continued.result?.isError||continuation.requestSubmitted!==false||!continuation.frameNodeId||!continuation.nextNodeId)throw new Error('MCP continuation construction failed');
  const continuationState=await request(25,'tools/call',{name:'get_canvas',arguments:{canvasId}});
  const continuationDoc=JSON.parse(continuationState.result?.content?.[0]?.text ?? '{}');
  if(!continuationDoc.edges?.some(edge=>edge.source==='video-node'&&edge.target===continuation.frameNodeId&&edge.targetHandle==='input')||!continuationDoc.edges?.some(edge=>edge.source===continuation.frameNodeId&&edge.target===continuation.nextNodeId&&edge.targetHandle==='first_frame')||!continuationDoc.nodes?.some(node=>node.id===continuation.nextNodeId&&node.model==='wan3_0_prime'&&node.prompt===''))throw new Error('MCP continuation chain or model inheritance failed');
  const noGeneration=await request(26,'tools/call',{name:'get_task_status',arguments:{canvasId}});
  if(JSON.parse(noGeneration.result?.content?.[0]?.text ?? '{}').tasks?.length!==0)throw new Error('MCP continuation unexpectedly generated a task');
  const script=await request(8,'tools/call',{name:'update_canvas_node',arguments:{canvasId,nodeId:'script-node',fields:{prompt:'完整剧本：第一镜头在海边。'}}});
  if (script.result?.isError) throw new Error(`MCP script update failed: ${script.result.content?.[0]?.text}`);
  const added=await request(9,'tools/call',{name:'add_canvas_node',arguments:{canvasId,kind:'videoGenerate',fields:{label:'第二镜头',model:'wan-3.0',resolution:'480p',aspectRatio:'9:16',duration:8}}});
  const shotId=JSON.parse(added.result?.content?.[0]?.text ?? '{}').node?.id;
  if (!shotId) throw new Error('MCP shot creation failed');
  const linked=await request(10,'tools/call',{name:'connect_canvas_nodes',arguments:{canvasId,sourceNodeId:'script-node',targetNodeId:shotId,slot:'prompt'}});
  if (linked.result?.isError) throw new Error(`MCP node connection failed: ${linked.result.content?.[0]?.text}`);
  const assetPath=join(appData,'reference.png');await writeFile(assetPath,Buffer.from([137,80,78,71,13,10,26,10,1]));
  const imported=await request(11,'tools/call',{name:'import_local_asset',arguments:{projectId,filePath:assetPath,kind:'image'}});
  const assetId=JSON.parse(imported.result?.content?.[0]?.text ?? '{}').asset?.id;
  if (!assetId) throw new Error(`MCP local import failed: ${imported.result?.content?.[0]?.text}`);
  const wavePath=join(appData,'reference.wav'),wave=Buffer.alloc(46);wave.write('RIFF');wave.writeUInt32LE(38,4);wave.write('WAVE',8);wave.write('fmt ',12);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(8000,24);wave.writeUInt32LE(16000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(2,40);await writeFile(wavePath,wave);
  const importedWave=await request(27,'tools/call',{name:'import_local_asset',arguments:{projectId,filePath:wavePath,kind:'audio'}});
  if(importedWave.result?.isError||JSON.parse(importedWave.result?.content?.[0]?.text??'{}').asset?.kind!=='audio')throw new Error('MCP native WAV import failed');
  const attached=await request(12,'tools/call',{name:'attach_canvas_asset',arguments:{canvasId,assetId,targetNodeId:shotId,slot:'first_frame'}});
  if (attached.result?.isError) throw new Error(`MCP asset attachment failed: ${attached.result.content?.[0]?.text}`);
  const result=await request(13,'tools/call',{name:'get_canvas',arguments:{canvasId}});
  const document=JSON.parse(result.result?.content?.[0]?.text ?? '{}');
  if (!document.nodes?.some(node=>node.id==='script-node'&&node.prompt.includes('完整剧本'))||!document.edges?.some(edge=>edge.target===shotId&&edge.targetHandle==='first_frame')) throw new Error('MCP canvas changes not persisted');
  const prices=await request(14,'tools/call',{name:'get_public_prices',arguments:{}});
  if (JSON.parse(prices.result?.content?.[0]?.text ?? '{}').prices?.length!==11) throw new Error('MCP public price table unavailable');
  const listed=await request(15,'tools/call',{name:'list_assets',arguments:{projectId}});
  if (JSON.parse(listed.result?.content?.[0]?.text ?? '{}').assets?.[0]?.id!==assetId) throw new Error('MCP project asset listing failed');
  const projectList=await request(16,'tools/call',{name:'list_projects',arguments:{}});
  if (!JSON.parse(projectList.result?.content?.[0]?.text ?? '{}').projects?.some(project=>project.id===projectId)) throw new Error('MCP project listing failed');
  const cloned=await request(17,'tools/call',{name:'clone_canvas_to_project',arguments:{sourceCanvasId:canvasId,targetProjectId:projectId,name:'复用镜头'}});
  if (JSON.parse(cloned.result?.content?.[0]?.text ?? '{}').canvas?.id!==`clone-before-restart`) throw new Error('MCP canvas clone failed');
  const unconfirmedRun=await request(18,'tools/call',{name:'run_canvas_node',arguments:{canvasId}});
  if (!unconfirmedRun.result?.isError||!unconfirmedRun.result.content?.[0]?.text?.includes('尚未确认费用')) throw new Error('MCP fee confirmation guard failed');
  const simulatedRun=await request(19,'tools/call',{name:'run_canvas_node',arguments:{canvasId,confirmCost:true}});
  if (!JSON.parse(simulatedRun.result?.content?.[0]?.text ?? '{}').accepted) throw new Error('MCP isolated task submission failed');
  const taskStatus=await request(20,'tools/call',{name:'get_task_status',arguments:{canvasId}});
  if (JSON.parse(taskStatus.result?.content?.[0]?.text ?? '{}').tasks?.[0]?.id!==`task-before-restart`) throw new Error('MCP task status failed');
  const archived=await request(21,'tools/call',{name:'archive_project',arguments:{projectId,projectName:'隔离测试项目',confirmDelete:true}});
  if (JSON.parse(archived.result?.content?.[0]?.text ?? '{}').archived?.id!==projectId) throw new Error('MCP project archive failed');
  const archivedList=await request(22,'tools/call',{name:'list_projects',arguments:{}});
  if (!JSON.parse(archivedList.result?.content?.[0]?.text ?? '{}').archivedProjects?.some(project=>project.id===projectId)) throw new Error('MCP archived project listing failed');
  const restored=await request(23,'tools/call',{name:'restore_project',arguments:{projectId,confirmRestore:true}});
  if (JSON.parse(restored.result?.content?.[0]?.text ?? '{}').project?.id!==projectId) throw new Error('MCP project restore failed');

  currentOrigin = await startStudio('after-restart');
  const second = await request(4,'tools/call',{name:'list_canvases',arguments:{}});
  const secondName = JSON.parse(second.result?.content?.[0]?.text ?? '{}').canvases?.[0]?.name;
  if (secondName !== 'after-restart') throw new Error(`MCP retained a stale session: ${secondName}; ${stderr}`);
  const reconnectedTools=await request(28,'tools/list');
  const secondCatalog=assertToolCatalog(reconnectedTools,'reconnected');
  if(JSON.stringify(secondCatalog)!==JSON.stringify(firstCatalog))throw new Error('MCP tool catalog changed after desktop reconnect');

  console.log(`MCP full smoke passed: ${expectedTools.length} exact tools and critical schemas verified before and after reconnect; legacy operations invoked against an isolated service; desktop session changed without restarting MCP.`);
} finally {
  child?.kill();
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  await rm(appData,{recursive:true,force:true});
}
