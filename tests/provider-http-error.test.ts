// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {ProviderHttpError,parseProviderHttpError,isDefiniteProviderRejection} from '../runtime/provider-http-error';

describe('provider HTTP error evidence',()=>{
  it('keeps HTTP metadata and nested message/detail/errors including the provider limit',async()=>{
    const response=Response.json({error:{message:'validation failed',detail:{field:'prompt',max_length:15000},errors:[{message:'prompt length must be <= 15000',code:'too_long'}]}},{status:422,headers:{'x-request-id':'req-123'}});
    const error=await parseProviderHttpError(response,'https://example.invalid/v1/videos?key=private');
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error.evidence).toEqual({status:422,path:'/v1/videos',requestId:'req-123',message:'validation failed',detail:{field:'prompt',max_length:15000},errors:[{message:'prompt length must be <= 15000',code:'too_long'}]});
    expect(error.message).toContain('15000');expect(error.message).toContain('req-123');expect(error.message).not.toContain('private');
  });
  it('redacts echoed secrets and request values from every retained diagnostic field',async()=>{
    const secret='fixture-secret-1234567890',prompt='PRIVATE user story with multiple lines\nand dialogue';
    const requestBody={model:'fixture-model',prompt,messages:[{content:'private nested message'}]};
    const response=Response.json({message:`invalid prompt ${prompt}; Authorization: Bearer ${secret}`,detail:[{loc:['body','prompt'],msg:'maximum 15000',input:prompt,ctx:{api_key:secret,headers:{Authorization:secret},request:requestBody}}],errors:{message:`echo: private nested message ${secret}`,prompt,trace:'https://example.invalid/result?signature='+secret}},{status:400});
    const error=await parseProviderHttpError(response,'/v1/videos',{secrets:[secret],requestBody});
    const saved=JSON.stringify(error.evidence);
    for(const value of [secret,prompt,'private nested message','fixture-model']){expect(saved).not.toContain(value);expect(error.message).not.toContain(value);}
    expect(saved).toContain('[REDACTED]');expect(error.message).toContain('15000');
    expect(error.detail).toMatchObject([{loc:['body','prompt'],msg:'maximum 15000',input:'[REDACTED]'}]);
  });
  it('redacts credential-shaped strings even without an explicit secret list',async()=>{
    const error=await parseProviderHttpError(new Response('Bad Bearer fixture-token-12345; api_key=fixture-key-12345; sk-fixturecredential123456',{status:401}),'/v1/videos');
    expect(error.message).not.toContain('fixture');expect(error.message).toContain('[REDACTED]');
  });
  it('supports top-level validation detail and body request ID without a message',async()=>{
    const error=await parseProviderHttpError(Response.json({detail:[{type:'string_too_long',loc:['body','prompt'],msg:'max 15000',input:'private prompt'}],request_id:'request-42'},{status:422}),'/v1/video-jobs');
    expect(error.message).toContain('max 15000');expect(error.requestId).toBe('request-42');expect(error.message).not.toContain('private prompt');
  });
  it('removes URL-encoded credentials from paths and diagnostics',async()=>{
    const secret='fixture/key+private=12345',encoded=encodeURIComponent(secret);
    const error=await parseProviderHttpError(Response.json({message:'bad '+encoded,detail:{message:'limit 15000'},errors:[{message:'bad credential '+encoded}]},{status:403}),'/v1/'+encoded,{secrets:[secret]});
    expect(JSON.stringify(error.evidence)).not.toContain(encoded);expect(error.message).not.toContain(secret);expect(error.message).toContain('limit 15000');
  });
  it('removes truncated request echoes while keeping surrounding validation limits',async()=>{
    const prompt='Unique confidential screenplay opening line with private dialogue and secret scene notes '.repeat(10);
    const excerpt=prompt.slice(13,91);
    const response=Response.json({message:`prompt is too long; input excerpt: ${excerpt}...; maximum 15000`,errors:[{message:'invalid',input_value:excerpt}]},{status:422});
    const error=await parseProviderHttpError(response,'/v1/videos',{requestBody:{prompt}});
    expect(error.message).not.toContain(excerpt);expect(error.message).not.toContain('confidential screenplay');expect(error.message).toContain('15000');
    expect(JSON.stringify(error.errors)).not.toContain(excerpt);
  });
  it('redacts credential assignments inside diagnostic JSON strings without a known secret list',async()=>{
    const error=await parseProviderHttpError(Response.json({message:'invalid config: {"api_key":"fixture-unknown-private"}',detail:'{"password":"fixture-private-password"}'},{status:400}),'/v1/videos');
    expect(error.message).not.toContain('fixture-unknown-private');expect(error.message).not.toContain('fixture-private-password');
  });
  it('redacts multipart prompt echoes and never needs to inspect uploaded files',async()=>{
    const prompt='private multipart image-edit prompt fixture';
    const form=new FormData();form.set('prompt',prompt);form.set('image',new Blob(['fixture binary data']),'fixture.png');
    const error=await parseProviderHttpError(Response.json({message:`invalid prompt ${prompt}`,detail:{message:'limit 15000'}},{status:422}),'/images/edits',{requestBody:form});
    expect(error.message).not.toContain(prompt);expect(error.message).toContain('15000');
  });
  it.each(['<html><body>private reflected form</body></html>','{"message":"private incomplete'])('does not retain HTML or malformed JSON bodies',async body=>{
    const error=await parseProviderHttpError(new Response(body,{status:502}),'/v1/videos');
    expect(error.status).toBe(502);expect(error.message).not.toContain('private');
  });
  it('bounds oversized responses and cancels further body reads',async()=>{
    let canceled=false;
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('private '.repeat(10000)));},cancel(){canceled=true;}});
    const error=await parseProviderHttpError(new Response(stream,{status:413}),'/v1/videos');
    expect(canceled).toBe(true);expect(error.message.length).toBeLessThan(300);expect(error.message).not.toContain('private');
  });
  it('retains the HTTP rejection even when its body cannot be read',async()=>{
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.error(Error('connection lost'));}});
    const error=await parseProviderHttpError(new Response(stream,{status:400}),'/v1/videos');
    expect(error.status).toBe(400);expect(isDefiniteProviderRejection(error)).toBe(true);
  });
  it('keeps HTTP status when a response body is already locked',async()=>{
    const response=new Response('error',{status:401});const reader=response.body!.getReader();
    try{expect((await parseProviderHttpError(response,'/v1/videos')).status).toBe(401);}finally{reader.releaseLock();}
  });
  it('never identifies a plain message or an ambiguous status as a definite refusal',()=>{
    expect(isDefiniteProviderRejection(Error('HTTP 400'))).toBe(false);
    for(const status of [200,408,409,429,500,502,503,504])expect(isDefiniteProviderRejection(new ProviderHttpError({status,path:'/v1/videos',message:'error'}))).toBe(false);
  });
});
