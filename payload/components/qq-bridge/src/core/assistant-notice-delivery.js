import {assistantNotificationText} from './decision-format.js';
import {isSilentAssistantNotification} from '../../../../packages/dsh-social-bridge-plugin/assistant-notifications.mjs';
import {assistantSenderAllowed} from '../../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {conversationWorkMode} from '../../../../packages/dsh-social-bridge-plugin/conversation-policy.mjs';

export function createAssistantNoticeDelivery({adapter,plugin,settingsFor,isReady=()=>true,log=()=>{}}){
  let running=false,stopped=false;
  const ready=()=>!stopped&&isReady()&&adapter.stats.connected&&!!adapter.selfId;
  async function tick(){
    if(running||!ready())return;running=true;
    try{
      if(!await plugin.controllerReady()||!ready())return;
      const data=await plugin.assistantTask(undefined,'notifications',{localControl:true});
      for(const notice of data.notifications??[]){
        if(!ready())break;
        try{
          const w=settingsFor();if(conversationWorkMode(w,notice.key)!=='assistant'||!assistantSenderAllowed(w,notice.key,notice.sender))continue;
          const [platform,kind,target]=notice.key.split(':');if(platform!=='wechat')continue;
          const text=isSilentAssistantNotification(notice)?'':assistantNotificationText(notice);
          if(!text){await plugin.assistantTask(undefined,'notification-ack',{localControl:true,id:notice.id});continue;}
          const receipt=await adapter.sendText({kind,target,text,deliveryId:notice.id});
          const confirmed=receipt?.confirmed===true||receipt?.accepted===true&&receipt?.delivered==='database-confirmed'&&receipt?.response?.data?.receipt==='wechat-server-id';
          if(confirmed){await plugin.assistantTask(undefined,'notification-ack',{localControl:true,id:notice.id});log('[Assistant] notification_delivery=confirmed kind='+notice.kind+' operation='+notice.id.slice(0,12));}
          else log('[Assistant] notification_delivery=unconfirmed operation='+notice.id.slice(0,12));
        }catch(error){log('[Assistant] notification_deferred operation='+String(notice.id??'').slice(0,12)+' code='+(error.code??'unavailable'));}
      }
    }catch(error){log('[Assistant] notification_deferred code='+(error.code??'unavailable'));}
    finally{running=false;}
  }
  return {tick,stop(){stopped=true;}};
}
