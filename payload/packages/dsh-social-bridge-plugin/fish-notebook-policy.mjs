import crypto from 'node:crypto';
import {allowedConversation} from './conversation-policy.mjs';
import {verifiedAssistantSender} from './assistant-policy.mjs';
export const NOTEBOOK_DEFAULTS=Object.freeze({enabled:false,writeTime:'21:30'});
export const notebookHash=value=>crypto.createHash('sha256').update(value).digest('hex');
export function validateFishNotebook(settings){
  if(settings===undefined)return;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['enabled','writeTime','chats'].includes(k)))throw Error('鱼的记事本设置无效。');
  if(settings.enabled!==undefined&&typeof settings.enabled!=='boolean')throw Error('记事本开关必须为开关值。');
  if(settings.writeTime!==undefined&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.writeTime))throw Error('写日记时间应为 HH:MM。');
  if(settings.chats!==undefined&&(!settings.chats||typeof settings.chats!=='object'||Array.isArray(settings.chats)||Object.entries(settings.chats).some(([key,value])=>!/^wechat:(private|group):[1-9]\d{0,15}$/.test(key)||typeof value!=='boolean')))throw Error('记事本聊天开关无效。');
}
export function fishNotebookEnabled(wechat,key){validateFishNotebook(wechat?.fishNotebook);return allowedConversation(wechat,key)&&wechat.fishNotebook?.enabled===true&&wechat.fishNotebook.chats?.[key]!==false;}
export function notebookDay(now=Date.now()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now),get=name=>parts.find(p=>p.type===name).value;
  return {date:get('year')+'-'+get('month')+'-'+get('day'),time:get('hour')+':'+get('minute')};
}
// Hard rule: only an explicit "让我看看你的日记" request may pull the diary out.
// A bare mention of 日记/记事本/小本本, a comment like "日记写的还不错", or a
// question about writing ("你平时写日记吗") must stay an ordinary chat turn and
// never start the shy/counting/diary flow.
const NOTEBOOK_NOTE='(?:日记|记事本|小本本)';
const NOTEBOOK_VIEW='(?:看看|看一下|看一眼|看一看|看下|瞅瞅|瞅一眼|康康|给我看|让我看|让我瞧瞧|给我瞧瞧|给我瞅瞅|发我|发给我|给我发|分享|念一下|念给我(?:听)?|读一下|读给我(?:听)?|翻翻|翻一下|翻给我|拿出来|晒一下|展示)';
export function isNotebookQuestion(text){
  text=String(text??'').trim();if(text.length>300||/[\r\n]|```|<untrusted_|^[>＞]/.test(text))return false;
  if(/(?:不要|不用|别|不想|不愿)(?:(?:再|给我|让我|去|先|马上|直接)){0,3}(?:看|读|翻|发|分享|给)[^。！？]{0,12}(?:日记|记事本|小本本)/.test(text))return false;
  if(/(?:我的|我写的|她的|他的|别人的|示例|举例|怎么写|帮我写)/.test(text)&&!/(?:你的|鱼的)/.test(text))return false;
  if(!new RegExp(NOTEBOOK_NOTE).test(text))return false;
  return new RegExp(NOTEBOOK_VIEW+'[^。！？,，\\n]{0,10}'+NOTEBOOK_NOTE).test(text)||new RegExp(NOTEBOOK_NOTE+'[^。！？,，\\n]{0,10}'+NOTEBOOK_VIEW).test(text);
}
function notebookViewer(row){const wxid=verifiedAssistantSender(row);return /^[a-f0-9]{64}$/.test(row.sender_key??'')?row.sender_key:wxid?notebookHash('wxid\0'+wxid):row.kind==='private'&&String(row.sender_id)===String(row.conversation_id)?notebookHash('private\0'+row.conversation_id):'';}
const followup=text=>/^(?:(?:那|再|就|还|快|让我|给我|求求你|求你|可以|能不能|要|想|我想|我就|我再|嗯|好嘛|嘛|吧|呀|啊|哎)){0,6}(?:看(?:看|一下|一眼|一回|一次)?|翻(?:翻|一下)?)(?:嘛|吧|呀|啊|啦|呗|好吗|好不好|一次|一下|！|!|？|\?|。|~|～)*$/.test(String(text??'').trim().replace(/^@\S+\s+/,''));
export function notebookQuery(rows,history=[]){
  const row=[...rows].reverse().find(r=>!r.outgoing&&!r.forwardedRecord&&!r.quoteReply&&r.interaction!=='pat'&&String(r.text??'').trim());
  if(!row||row.platform!=='wechat'||!row.message_id&&!row.id)return null;
  const viewer=notebookViewer(row);let question=isNotebookQuestion(row.text);
  if(!question&&viewer&&followup(row.text))for(const prior of [...history].reverse()){
    if(prior.outgoing||String(prior.message_id||prior.id)===String(row.message_id||row.id)||notebookViewer(prior)!==viewer)continue;
    if(!Number.isFinite(row.timestamp)||!Number.isFinite(prior.timestamp)||row.timestamp-prior.timestamp<0||row.timestamp-prior.timestamp>600||prior.forwardedRecord||prior.quoteReply)break;
    if(isNotebookQuestion(prior.text)){question=true;break;}if(!followup(prior.text))break;
  }
  if(!question)return null;
  if(!viewer)return null;return {id:notebookHash(String(row.message_id||row.id)),viewer};
}
