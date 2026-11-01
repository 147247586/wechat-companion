import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseAdapter } from '../base-adapter.js';
import { ReverseOneBotServer } from '../../onebot/reverse-ws-server.js';
import { normalizeOneBotEvent } from '../../onebot/normalize.js';

// Local voice reply. The WeChat hook exposes no native voice-send API, so a
// reply whose whole body is `[VOICE:…]` is not sent as text: it is written to
// state/voice-queue/<id>.json and rendered into a real voice bubble by the
// external worker (wechat-voice/voice_queue_watch.py -> voice_bar.py).
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const VOICE_QUEUE_DIR = path.join(PROJECT_ROOT, 'state', 'voice-queue');
const BRIDGE_CONFIG_FILE = path.join(PROJECT_ROOT, 'state', 'bridge-config.json');
const VOICE_TOKEN = /^\s*\[VOICE[:：]\s*([\s\S]+?)\s*\]\s*([\s\S]*)$/;
let voiceSettings = { stamp: -1, value: null };

function voicePolicy() {
  try {
    const stamp = fs.statSync(BRIDGE_CONFIG_FILE).mtimeMs;
    if (stamp !== voiceSettings.stamp) {
      const config = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
      voiceSettings = { stamp, value: config?.platforms?.wechat?.voiceReply ?? config?.wechat?.voiceReply ?? null };
    }
  } catch { voiceSettings = { stamp: -1, value: null }; }
  return voiceSettings.value;
}

function voiceAllowed(kind, target) {
  const policy = voicePolicy();
  if (!policy || policy.enabled !== true) return false;
  const chats = policy.chats;
  if (chats && typeof chats === 'object') {
    const keys = Object.keys(chats);
    if (keys.length && chats[`wechat:${kind}:${target}`] !== true) return false;
  }
  return true;
}

function voiceMaxChars() {
  const max = Number(voicePolicy()?.maxChars);
  return Number.isSafeInteger(max) && max > 0 ? Math.min(400, max) : 80;
}

const VOICE_EMOTIONS = new Set(['日常', '撒娇', '温柔', '傲娇', '晚安', '开心', '委屈', '生气',
  'normal', 'cute', 'gentle', 'tsundere', 'night', 'happy', 'sad', 'angry']);

function voiceToken(content) {
  const match = VOICE_TOKEN.exec(content);
  if (!match) return null;
  const inside = match[1].trim();
  const after = (match[2] || '').trim();
  if (!inside) return null;
  // `[VOICE:撒娇|要说的话]`
  const pipe = /^([^|｜]{1,10})\s*[|｜]\s*([\s\S]+)$/.exec(inside);
  if (pipe && VOICE_EMOTIONS.has(pipe[1].trim())) return { emotion: pipe[1].trim(), speech: pipe[2].trim() };
  // `[VOICE:撒娇]要说的话`
  if (after && VOICE_EMOTIONS.has(inside)) return { emotion: inside, speech: after };
  // legacy `[VOICE:要说的话]`
  return { emotion: '', speech: inside };
}

// ---- 50/50 voice-vs-text ratio gate (per chat, rolling window) ----
const VOICE_RATIO_FILE = path.join(PROJECT_ROOT, 'state', 'voice-ratio.json');
const VOICE_LAST_FILE = path.join(PROJECT_ROOT, 'state', 'voice-last.json');
const VOICE_HEALTH_FILE = path.join(PROJECT_ROOT, 'state', 'voice-health.json');
const VOICE_WINDOW = 6;
const VOICE_HALF = 3;

function voiceRatioLoad() {
  try { return JSON.parse(fs.readFileSync(VOICE_RATIO_FILE, 'utf8')); } catch { return {}; }
}
function voiceRatioCount(kind, target) {
  const list = voiceRatioLoad()[`${kind}:${target}`];
  return Array.isArray(list) ? list.reduce((n, v) => n + (v ? 1 : 0), 0) : 0;
}
function voiceRatioRecord(kind, target, isVoice) {
  const data = voiceRatioLoad();
  const key = `${kind}:${target}`;
  const list = Array.isArray(data[key]) ? data[key] : [];
  list.push(isVoice ? 1 : 0);
  data[key] = list.slice(-VOICE_WINDOW);
  try {
    fs.mkdirSync(path.dirname(VOICE_RATIO_FILE), { recursive: true });
    fs.writeFileSync(VOICE_RATIO_FILE, JSON.stringify(data), { mode: 0o600 });
  } catch {}
  return data[key].reduce((n, v) => n + (v ? 1 : 0), 0);
}
function voiceSafeText(text) {
  const value = String(text ?? '').trim();
  if (value.length < 8 || value.length > 50) return false;
  if (/https?:|www\./i.test(value)) return false;
  if (/[\r\n]/.test(value)) return false;
  if (/^\s*(?:任务|已停止|当前没有|本机|系统)/.test(value)) return false;
  if (/\[[^\]]{1,40}\]/.test(value)) return false;
  return true;
}

function queueVoice({ kind, target, text, emotion, deliveryId }) {
  fs.mkdirSync(VOICE_QUEUE_DIR, { recursive: true });
  const stamp = Date.now();
  const name = `${stamp}-${String(deliveryId || crypto.randomUUID()).slice(0, 12)}.json`;
  const file = path.join(VOICE_QUEUE_DIR, name);
  fs.writeFileSync(file, JSON.stringify({
    kind, target: String(target), text, emotion: emotion || '日常',
    deliveryId: deliveryId ?? '', createdAt: stamp,
  }), { mode: 0o600 });
  return file;
}

function voiceHealthy() {
  try {
    const info = JSON.parse(fs.readFileSync(VOICE_HEALTH_FILE, 'utf8'));
    return info.ok === true && Date.now() - Number(info.at) < 10 * 60 * 1000;
  } catch { return false; }
}

function voiceLastAt() {
  try { return Number(JSON.parse(fs.readFileSync(VOICE_LAST_FILE, 'utf8')).at) || 0; } catch { return 0; }
}

function touchVoiceLast() {
  try {
    fs.mkdirSync(path.dirname(VOICE_LAST_FILE), { recursive: true });
    fs.writeFileSync(VOICE_LAST_FILE, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
  } catch {}
}

// Opt-in automatic voice: the persona can still ask explicitly with `[VOICE:…]`,
// but short, natural chat lines also get a controlled chance of becoming voice.
function autoVoice(kind, target, text, deliveryId) {
  const policy = voicePolicy();
  if (!policy || policy.enabled !== true || !voiceAllowed(kind, target)) return null;
  const value = String(text ?? '').trim();
  const max = voiceMaxChars();
  if (!value || value.length > max) return null;
  if (/[\r\n]|https?:\/\/|www\.|(^|\s)[\[#>*`]/.test(value)) return null;
  let chance = Number(policy.chance);
  if (!Number.isFinite(chance) || chance <= 0) return null;
  if (value.length <= 12) chance = Math.min(1, chance * 1.6);
  else if (value.length >= 40) chance *= 0.5;
  if (Math.random() > chance) return null;
  const minGap = Number(policy.minGapMs ?? 60000);
  if (minGap > 0 && Date.now() - voiceLastAt() < minGap) return null;
  queueVoice({ kind, target, text: value, emotion: '日常', deliveryId });
  touchVoiceLast();
  const count = voiceRatioRecord(kind, target, true);
  return { accepted: true, confirmed: true, delivered: 'voice-queue', mode: 'voice', emotion: '日常', ratio: count };
}

// ---- singing library: `[SING:<track>]` -> pre-rendered song as a voice bubble ----
// The upstream refresh dropped the old singReply patch, so the token used to be
// sent as literal text. This restores it at the transport layer.
const SING_ROOT = path.join(PROJECT_ROOT, 'state', 'sing');
const SING_QUEUE_DIR = path.join(PROJECT_ROOT, 'state', 'sing-queue');
const SING_TITLE_DIR = path.join(SING_ROOT, 'titles');
const SING_ROTATION_FILE = path.join(SING_ROOT, '.rotation.json');
const SING_TOKEN = /^\s*\[SING[:：]\s*([^\]\s]{1,40})\s*\]\s*[。.！!？?]?\s*$/i;
const SING_FALLBACK = '这首还不会，换一首';
let singCache = { stamp: -1, library: null };

function singLibrary() {
  try {
    const stamp = fs.statSync(SING_ROOT).mtimeMs;
    if (stamp !== singCache.stamp) {
      const ids = fs.readdirSync(SING_ROOT)
        .filter((name) => /\.wav$/i.test(name))
        .map((name) => name.replace(/\.wav$/i, ''))
        .sort();
      let meta = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(SING_ROOT, 'tracks.json'), 'utf8').replace(/^\uFEFF/, ''));
        meta = parsed?.tracks ?? {};
      } catch { meta = {}; }
      singCache = { stamp, library: { ids, meta } };
    }
  } catch { singCache = { stamp: -1, library: null }; }
  return singCache.library;
}

function nextRotationTrack(ids, kind, target) {
  const list = ids.filter((id) => id !== 'tracks');
  if (!list.length) return '';
  let data = {};
  try { data = JSON.parse(fs.readFileSync(SING_ROTATION_FILE, 'utf8')); } catch { data = {}; }
  const key = `${kind}:${target}`;
  const last = String(data?.[key]?.last ?? '').replace(/\.wav$/i, '');
  const next = list[(list.indexOf(last) + 1) % list.length];
  data[key] = { last: `${next}.wav`, at: Date.now() };
  try { fs.writeFileSync(SING_ROTATION_FILE, JSON.stringify(data)); } catch {}
  return next;
}

function resolveSingTrack(wanted, kind, target) {
  const library = singLibrary();
  if (!library) return '';
  const key = String(wanted).trim().toLowerCase();
  const available = new Set(library.ids);
  if (/^any$/i.test(key)) return nextRotationTrack(library.ids, kind, target);
  if (available.has(key)) return key;
  for (const [id, info] of Object.entries(library.meta ?? {})) {
    if (!available.has(id)) continue;
    if (id.toLowerCase() === key) return id;
    const aliases = Array.isArray(info?.aliases) ? info.aliases : [];
    if (aliases.some((alias) => String(alias).trim().toLowerCase() === key)) return id;
  }
  return '';
}

function queueSing({ kind, target, id, deliveryId, withTitle }) {
  fs.mkdirSync(SING_QUEUE_DIR, { recursive: true });
  const stamp = Date.now();
  const titleRef = withTitle ? path.join(SING_TITLE_DIR, `${target}.png`) : '';
  const file = path.join(SING_QUEUE_DIR, `${stamp}-${String(deliveryId || crypto.randomUUID()).slice(0, 12)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    kind, target: String(target), name: id, wav: path.join(SING_ROOT, `${id}.wav`),
    ...(titleRef ? { titleRef } : {}), deliveryId: deliveryId ?? '', createdAt: stamp,
  }), { mode: 0o600 });
  return file;
}

export class WechatOneBotAdapter extends BaseAdapter {
  constructor(config = {}, log = () => {}) {
    super('wechat', { mention: true });
    this.log = log;
    this.server = new ReverseOneBotServer(config.server ?? {});
    this.recentOutgoing = new Map();
    this.recentIncoming = new Map();
    this.antiLoopTtlMs = Math.max(1000, Number(config.antiLoopTtlMs) || 60000);
    this.server.on('open', () => { this.stats.connected = true; this.emit('open'); });
    this.server.on('close', () => { this.stats.connected = false; this.emit('close'); });
    this.server.on('error', (error) => { this.stats.errors++; this.emit('error', error); });
    this.server.on('invalid', (kind) => { this.stats.errors++; this.log(`[WeChat] ${kind}`); });
    this.server.on('event', (event) => this.#receive(event));
  }

  #fingerprint(kind, target, content) {
    return crypto.createHash('sha256').update(JSON.stringify([kind, String(target), String(content).trim()])).digest('hex');
  }

  #prune(now) {
    for (const cache of [this.recentOutgoing, this.recentIncoming]) {
      for (const [key, expires] of cache) if (expires <= now) cache.delete(key);
      while (cache.size > 1000) cache.delete(cache.keys().next().value);
    }
  }

  #receive(event) {
    if (event?.post_type === 'meta_event') {if(event.self_id)this.selfId=String(event.self_id);this.emit('meta', event); return; }
    const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
    if (!message) return;
    if (!['text','image','file','record'].includes(message.message_type)||message.message_type==='record'&&!message.voice||message.message_type==='file'&&!message.files.length || message.message_type === 'image' && !message.images.length) { this.log(`[WeChat] unsupported_message_type=${message.message_type}`); return; }
    if (!message.text && message.message_type !== 'record') return;
    const now = Date.now(); this.#prune(now);
    const fingerprintContent = message.message_type === 'record' ? '[voice:' + message.voice.id + ']' : message.text;
    const key = this.#fingerprint(message.kind, message.conversation_id, fingerprintContent);
    const selfId = message.self_id;
    if(selfId)this.selfId=selfId;
    if (selfId && (message.sender_id === selfId || String(event.user_id ?? '') === selfId)) return;
    if (this.recentOutgoing.has(key)) return;
    const incomingKey = `${message.message_id}:${key}`;
    if (this.recentIncoming.has(incomingKey)) return;
    this.recentIncoming.set(incomingKey, now + this.antiLoopTtlMs);
    this.stats.messages++; this.emit('message', message);
  }

  async start() { await this.server.start(); }
  async stop() { await this.server.stop(); }
  async sendText({ kind, target, text, deliveryId, source, contextId, allowAutoVoice = true }) {
    if (kind !== 'private' && kind !== 'group') throw new TypeError('invalid WeChat kind');
    let content = String(text ?? '').trim();
    if (!content) throw new TypeError('empty WeChat message');
    const id = Number(target);
    // Only synthetic numeric IDs resolved by the WeChat I/O service are accepted.
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('WeChat target must be a synthetic integer ID');
    // `[SING:…]` from the persona: queue the pre-rendered song as a voice bubble.
    const sing = SING_TOKEN.exec(content);
    if (sing) {
      const track = resolveSingTrack(sing[1], kind, id);
      const titleOk = fs.existsSync(path.join(SING_TITLE_DIR, `${id}.png`));
      if (!track || (kind === 'group' && !titleOk)) {
        content = SING_FALLBACK; // unknown song / no chat title reference: degrade to text
      } else {
        queueSing({ kind, target: id, id: track, deliveryId, withTitle: titleOk });
        this.#prune(Date.now());
        this.recentOutgoing.set(this.#fingerprint(kind, id, `[SING:${track}]`), Date.now() + this.antiLoopTtlMs);
        this.stats.sends++;
        this.log(`[WeChat] sing_queued track=${track} operation=${String(deliveryId ?? '').slice(0, 12)}`);
        return { accepted: true, confirmed: true, delivered: 'sing-queue', mode: 'sing', name: track };
      }
    }
    // `[VOICE:情绪]要说的话` from the persona: queue a native voice bubble with
    // the emotion mapped to a Breeze voice-direction instruction.
    const voice = voiceToken(content);
    if (voice !== null) {
      const speech = voice.speech.slice(0, voiceMaxChars());
      if (!speech) throw new TypeError('empty WeChat voice message');
      const ratio = voiceRatioCount(kind, id);
      if (voiceAllowed(kind, id) && ratio < VOICE_HALF) {
        queueVoice({ kind, target: id, text: speech, emotion: voice.emotion, deliveryId });
        const count = voiceRatioRecord(kind, id, true);
        this.#prune(Date.now());
        this.recentOutgoing.set(this.#fingerprint(kind, id, speech), Date.now() + this.antiLoopTtlMs);
        this.stats.sends++;
        this.log(`[WeChat] voice_queued emotion=${voice.emotion || '日常'} chars=${speech.length} ratio=${count}/${VOICE_WINDOW} operation=${String(deliveryId ?? '').slice(0, 12)}`);
        return { accepted: true, confirmed: true, delivered: 'voice-queue', mode: 'voice', emotion: voice.emotion || '日常' };
      }
      content = speech; // voice disabled for this chat / ratio cap: degrade to plain text
    }
    if (allowAutoVoice && voice === null) {
      const automatic = autoVoice(kind, id, content, deliveryId);
      if (automatic) {
        this.#prune(Date.now());
        this.recentOutgoing.set(this.#fingerprint(kind, id, content), Date.now() + this.antiLoopTtlMs);
        this.stats.sends++;
        this.log(`[WeChat] voice_auto_queued chars=${content.length} ratio=${automatic.ratio}/${VOICE_WINDOW} operation=${String(deliveryId ?? '').slice(0, 12)}`);
        return automatic;
      }
    }
    // Floor is disabled: voice is only used when the model explicitly asks for it.
    voiceRatioRecord(kind, id, false);
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = { [kind === 'group' ? 'group_id' : 'user_id']: id,
      message: [{ type: 'text', data: { text: content } }],...(deliveryId?{wechatagent_delivery_id:deliveryId}:{}),
      ...(source==='proactive'?{wechatagent_source:'proactive',wechatagent_context_id:contextId}:{}) };
    let result;
    try{result=await this.server.action(action,params);}
    catch(error){
      if(error.code!=='TEXT_DELIVERY_UNCONFIRMED'||error.data?.attempted!==true)throw error;
      this.#prune(Date.now());this.recentOutgoing.set(this.#fingerprint(kind,id,content),Date.now()+this.antiLoopTtlMs);
      this.log(`[WeChat] text_delivery_unconfirmed operation=${String(deliveryId??'').slice(0,12)}`);
      return {accepted:false,attempted:true,confirmed:false,delivered:'unconfirmed',deliveryId};
    }
    // The I/O service acknowledges only after a new matching server receipt.
    if (result.data?.receipt !== 'wechat-server-id') throw new Error('WeChat send response has no verified server receipt');
    this.#prune(Date.now());
    this.recentOutgoing.set(this.#fingerprint(kind, id, content), Date.now() + this.antiLoopTtlMs);
    this.stats.sends++; return { accepted: true, confirmed: true, response: result, delivered: 'database-confirmed' };
  }
  async stickerChoices({kind,target,query}){
    const result=await this.server.action('get_sticker_list',{kind,target:String(target),...(typeof query==='string'&&query.trim()?{query:query.slice(0,500)}:{})});
    return result.data?.enabled?(result.data.stickers??[]):[];
  }
  async sendSticker({kind,target,id,deliveryId,receiptOnly=false,deferReceipt=false,deadlineAt,abandon=false}){
    if(!['private','group'].includes(kind)||!/^[a-f0-9]{64}$/.test(id))throw new TypeError('invalid sticker target');
    let result;
    try{result=await this.server.action(kind==='group'?'send_group_msg':'send_private_msg',{
      [kind==='group'?'group_id':'user_id']:Number(target),message:[{type:'wechat_sticker',data:{id}}],...(deliveryId?{wechatagent_delivery_id:deliveryId}:{}),...(receiptOnly?{wechatagent_receipt_only:true}:{}),...(deferReceipt?{wechatagent_defer_receipt:true}:{}),...(abandon?{wechatagent_abandon_delivery:true}:{}),...(deadlineAt!==undefined?{wechatagent_deadline_at:deadlineAt}:{})});}
    catch(error){
      if(error.code!=='STICKER_DELIVERY_UNCONFIRMED'||error.data?.attempted!==true)throw error;
      this.log(`[WeChat] sticker_delivery_unconfirmed operation=${String(deliveryId??'').slice(0,12)}`);
      return {accepted:false,attempted:true,delivered:'unconfirmed',deliveryId};
    }
    if(abandon&&result.data?.released===true)return result.data;
    if(result.data?.receipt!=='wechat-server-id'||result.data?.media_type!=='wechat-sticker')throw new Error('Sticker send has no server receipt');
    this.stats.sends++;return result;
  }
  async stickerLabels({kind,target,ids}){return (await this.server.action('get_sticker_labels',{kind,target:String(target),ids})).data?.labels??[];}
  async saveStickerLabels({kind,target,labels}){return this.server.action('save_sticker_labels',{kind,target:String(target),labels});}
  async sendPrivateMessage(target, text) { return this.sendText({ kind: 'private', target, text }); }
  async sendGroupMessage(target, text) { return this.sendText({ kind: 'group', target, text }); }
  async reply() { throw new Error('unsupported_capability: nativeReply'); }
  getCapabilities() { return this.capabilities; }
}

