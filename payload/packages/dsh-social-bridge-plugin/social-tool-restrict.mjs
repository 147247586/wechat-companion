const {withoutSocialTools,canonicalSocialTools,withoutDshIdentity}=await import(new URL('./social-tool-policy.mjs'+new URL(import.meta.url).search,import.meta.url));
import { WEB_READER_POLICY } from './web-reader-policy.mjs';
import {MODEL_SEARCH_POLICY} from './model-search.mjs';
import {FILE_TRANSFER_POLICY} from './file-transfers.mjs';
import {ASSISTANT_ACCESS} from './assistant-policy.mjs';
import {DSH_ACCESS_POLICY} from './dsh-access.mjs';
import {MEME_LIBRARY_POLICY} from './meme-library-policy.mjs';
import {MEMBER_MEMORY_POLICY} from './member-memory-policy.mjs';
import {HISTORY_POLICY} from './history-policy.mjs';
import {MEMORY_TOOL_POLICY} from './memory-engine.mjs';
export const name = 'social-tool-restrict';
export const inject = ['tools'];
export function apply(ctx) {
  const marker=Symbol.for('wechatagent.scoped-tool-guard.v1');if(Object.hasOwn(ctx,marker))return;Object.defineProperty(ctx,marker,{value:true,configurable:true});
  ctx.tools.presentAs?.('native'); // Visibility and execution use the same live per-chat authorization below.
  const policies = agent => [Symbol.for('wechatagent.extension-tools.v1'),WEB_READER_POLICY,MODEL_SEARCH_POLICY,DSH_ACCESS_POLICY,FILE_TRANSFER_POLICY,MEME_LIBRARY_POLICY,MEMBER_MEMORY_POLICY,HISTORY_POLICY,MEMORY_TOOL_POLICY]
    .map(symbol => agent?.ctx?.[symbol] ?? ctx[symbol]).filter(Boolean);
  const assistantAllowed=agent=>{try{return agent?.ctx?.[ASSISTANT_ACCESS]?.()!==false;}catch{return false;}};
  ctx.tools.guard(exec => assistantAllowed(exec?.agent)&&policies(exec?.agent).some(policy => policy.check(exec?.name)) ? undefined : '微信群友会话不允许调用未授权工具');
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const original = withoutDshIdentity(await next()), assembly=original.sections?.some(section=>section.name==='dsh-expression:companion')?{...original,sections:original.sections.filter(section=>section.name!=='dsh-expression:companion')}:original, names = new Set(assistantAllowed(context?.scope)?policies(context?.scope).flatMap(policy => [...policy.names()]):[]);
    return names.size ? { ...assembly, tools: canonicalSocialTools(assembly.tools.filter(tool => names.has(tool.name)).map(({deferLoading,...tool})=>tool)) } : withoutSocialTools(assembly);
  }, { prepend: true });
}
