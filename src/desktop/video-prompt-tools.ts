export const VIDEO_PROMPT_SUFFIX = '\n生成原生声音；所有指定台词需实际说出。画面不要生成字幕、文字或水印。';

export interface VideoPromptUsage {
  content:string;
  submitted:string;
  used:number;
  limit:number;
  overBy:number;
  contentBudget:number;
}

export function composeVideoPromptContent(prompt:string,upstreamText:string[]=[]){
  return [prompt,...upstreamText].map(value=>value.trim()).filter(Boolean).join('\n\n');
}

export function videoPromptUsage(prompt:string,upstreamText:string[],limit=5000):VideoPromptUsage{
  const content=composeVideoPromptContent(prompt,upstreamText);
  const submitted=content+VIDEO_PROMPT_SUFFIX;
  const safeLimit=Math.max(1,Math.floor(limit)||5000);
  return {content,submitted,used:submitted.length,limit:safeLimit,overBy:Math.max(0,submitted.length-safeLimit),contentBudget:Math.max(1,safeLimit-VIDEO_PROMPT_SUFFIX.length)};
}

const platformDuplicatePatterns=[
  /生成原生声音[；;，,。\s]*/g,
  /所有指定台词需实际说出[；;，,。\s]*/g,
  /画面(?:中)?不要生成字幕、?文字或水印[；;，,。\s]*/g,
  /(?:不要|禁止)(?:生成|出现)?字幕、?文字(?:和|或)水印[；;，,。\s]*/g,
];

/** Only removes formatting noise, exact duplicates and constraints already appended by the app. */
export function compactVideoPromptSafely(source:string){
  let normalized=source.replace(/\r\n?/g,'\n').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  for(const pattern of platformDuplicatePatterns)normalized=normalized.replace(pattern,'');
  const seen=new Set<string>();
  const lines=normalized.split('\n').map(line=>line.trim()).filter(Boolean).filter(line=>{
    const key=line.replace(/[\s，。；：、,.!！?？;:]/g,'');
    if(!key||seen.has(key))return false;seen.add(key);return true;
  });
  return lines.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}

function promptUnits(source:string){
  const units:string[]=[];
  for(const line of source.replace(/\r\n?/g,'\n').split('\n').map(value=>value.trim()).filter(Boolean)){
    const sentences=line.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map(value=>value.trim()).filter(Boolean)??[line];
    units.push(...sentences);
  }
  return units;
}

/** Lossless ordered packing: every source character is retained, apart from normalized surrounding whitespace. */
export function splitVideoPrompt(source:string,maxContentChars:number){
  const limit=Math.max(80,Math.floor(maxContentChars));
  const units=promptUnits(source),chunks:string[]=[];let current='';
  const push=()=>{if(current.trim())chunks.push(current.trim());current='';};
  for(const unit of units){
    if(unit.length>limit){
      push();
      for(let offset=0;offset<unit.length;offset+=limit)chunks.push(unit.slice(offset,offset+limit).trim());
      continue;
    }
    const candidate=current?`${current}\n${unit}`:unit;
    if(candidate.length>limit)push();
    current=current?`${current}\n${unit}`:unit;
  }
  push();return chunks.filter(Boolean);
}
