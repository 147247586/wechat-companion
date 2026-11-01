import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {boundedTask} from './deadline.mjs';
import {enqueueImageAsset} from './media-store.mjs';

export async function imageBlocks(ctx,root,conversationKey,images,provider,model,{onUnavailable,timeoutMs=25000,signal:parentSignal}={}) {
  if (!Array.isArray(images) || images.length>4) throw new Error('IMAGE_BATCH_LIMIT');
  if (!images.length) return [];
  if (images.some(image=>!/^[a-f0-9]{64}$/.test(image?.id ?? ''))) throw new Error('INVALID_IMAGE_REFERENCE');
  const llm=ctx.get('llm'), attachments=ctx.get('attachments');
  if (!llm || !attachments) throw new Error('NATIVE_IMAGE_SERVICES_UNAVAILABLE');
  const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(parentSignal?[parentSignal]:[])]);
  const unavailableBlock=(image,index,error)=>{
    if(!onUnavailable)throw error;
    // Reject the image itself on binding/integrity/format failures too. Never
    // admit its bytes, and never leave that bad input at the head of the chat.
    const safeCode=/^(?:IMAGE_[A-Z_]+|INVALID_IMAGE_DATA|MODEL_IMAGE_INPUT_UNSUPPORTED)$/.test(error.message)?error.message:'IMAGE_READER_NOT_READY';
    onUnavailable({id:image.id,index,code:error.imageError??(error.name==='TimeoutError'||error.name==='AbortError'?'IMAGE_PROCESS_TIMEOUT':safeCode)});
    return {type:'text',text:`[本轮附图 I${index+1} 读取失败，未提供画面；不要猜测内容。其余成功附图仍可使用。]`};
  };
  let info;
  try{info=await boundedTask(s=>llm.resolveModelInfo(provider,model,s),{timeoutMs,signal});}
  catch(error){return images.map((image,index)=>unavailableBlock(image,index,error));}
  if (!info.inputModalities?.includes('image')) return images.map((image,index)=>unavailableBlock(image,index,new Error('MODEL_IMAGE_INPUT_UNSUPPORTED')));
  const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,''));
  const base=new URL(io.reader_base_url);
  if (base.protocol!=='http:' || base.hostname!=='127.0.0.1' || base.username || base.password || base.pathname!=='/' || base.search || base.hash) throw new Error('IMAGE_READER_LOOPBACK_REQUIRED');
  const blocks=new Array(images.length);let next=0;
  async function prepare(image,index) {
    try {
    return await boundedTask(async taskSignal=>{
    const response=await fetch(base.origin+'/api/v1/images/'+image.id,{headers:{Authorization:'Bearer '+io.reader_token},redirect:'error',signal:taskSignal});
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const error = new Error('IMAGE_READER_NOT_READY');
      if (typeof failure.error === 'string' && /^IMAGE_[A-Z_]{3,80}$/.test(failure.error)) error.imageError = failure.error;
      throw error;
    }
    const content=await response.json();
    if (content.imageId!==image.id || content.conversationKey!==conversationKey) throw new Error('IMAGE_CONVERSATION_MISMATCH');
    if (typeof content.b64!=='string' || content.b64.length>1100000 || !['image/png','image/jpeg','image/webp'].includes(content.mime)) throw new Error('INVALID_IMAGE_DATA');
    const data=Buffer.from(content.b64,'base64');
    if (!data.length || data.length>768*1024 || data.toString('base64')!==content.b64 || crypto.createHash('sha256').update(data).digest('hex')!==content.sha256) throw new Error('IMAGE_INTEGRITY_FAILED');
    try { enqueueImageAsset({ root, chat: conversationKey, image, content, data, sourceQuality: content.sourceQuality }); } catch { /* media indexing must not break chat */ }
    const attachment=await attachments.saveImage({data,mediaType:content.mime,name:'wechat-image-'+image.id.slice(0,12)});
    const block={type:'image',attachment};
    return content.sourceQuality==='thumbnail' ? [
      {type:'text',text:`[附图 I${index+1} 当前仅提供微信本地缩略图，细节和小字可能不清楚；不要把低清画面当作原图或猜测看不清的内容。需要细节时请用户先在电脑微信打开原图，再重新发送图片。]`},block,
    ] : block;
    },{timeoutMs:12000,signal});
    } catch(error) {
      return unavailableBlock(image,index,error);
    }
  }
  await Promise.all(Array.from({length:Math.min(2,images.length)},async()=>{
    while(next<images.length){const index=next++;blocks[index]=await prepare(images[index],index);}
  }));
  return blocks.flat();
}

export function offloadCompletedImages(session,sourceSeqs) {
  const targets=[];
  for (const seq of sourceSeqs) {
    const event=session.eventAt(seq);
    const message=session.deriveEventMessage ? session.deriveEventMessage(event) : event.data;
    const imageIndexes=[];let index=0;
    for (const block of message.content ?? []) if(block.type==='image'){if(!block.offloaded)imageIndexes.push(index);index++;}
    if (imageIndexes.length) targets.push({seq,imageIndexes});
  }
  if(targets.length) session.append('image/offload',{targets});
}

export function offloadCompletedSessionImages(session) {
  // Failed/cancelled vision turns must release their image bytes too. Keeping
  // an invalid attachment active makes every later text request fail again.
  const completed=session.snapshotEvents().findLast(event=>event.type==='turn/end');
  if(!completed)return;
  const seqs=session.surface.nodes.filter(seq=>{
    const event=session.eventAt(seq);
    return seq<completed.seq && event.type==='user/message' && event.data.source?.socialImageIds?.length;
  });
  offloadCompletedImages(session,seqs);
}
