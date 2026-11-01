import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const workspace = process.argv[2] || 'D:\\wechatagent\\data\\workspace';
const tokenFile = path.join(workspace, 'state', 'social-dsh-token.txt');
const report = { workspace, checks: {} };

function check(name, value, detail = '') {
  report.checks[name] = { ok: Boolean(value), detail };
}
function readToken() {
  try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; }
}

const token = readToken();
check('dsh_token', Boolean(token));
if (token) {
  try {
    const res = await fetch('http://127.0.0.1:11230/health', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
    check('dsh_health', res.ok, String(res.status));
  } catch (error) { check('dsh_health', false, String(error.message)); }
}

const bridgeLog = path.join(workspace, 'state', 'logs', 'bridge.stdout.log');
if (fs.existsSync(bridgeLog)) {
  const text = fs.readFileSync(bridgeLog, 'utf8');
  check('bridge_log', /OneBot adapter connected|DSH\] connection=ready/.test(text));
} else check('bridge_log', false, bridgeLog);

const readerConfig = path.join(workspace, 'state', 'wechat-io-config.json');
check('reader_config', fs.existsSync(readerConfig));

const historyRoot = path.join(workspace, 'state', 'chat-history');
let dbFile = null;
if (fs.existsSync(historyRoot)) {
  const files = fs.readdirSync(historyRoot)
    .map(name => path.join(historyRoot, name, 'history.sqlite'))
    .filter(file => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  dbFile = files[0] || null;
}
check('history_database', Boolean(dbFile), dbFile || '');
if (dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    report.memories = Number(db.prepare("SELECT count(*) n FROM memories WHERE kind!='handoff' AND deleted_at IS NULL").get()?.n || 0);
    report.media = Number(db.prepare('SELECT count(*) n FROM media_assets').get()?.n || 0);
    check('memories', report.memories > 0, String(report.memories));
    check('media_assets', report.media >= 0, String(report.media));
  } catch (error) {
    check('database_schema', false, String(error.message));
  } finally { db.close(); }
}

const workerLock = path.join(workspace, 'state', 'media-caption-worker.pid');
report.image_worker = fs.existsSync(workerLock) ? fs.readFileSync(workerLock, 'utf8').trim() : '';
check('image_worker', Boolean(report.image_worker), report.image_worker);

const panelStateFile = path.join(workspace, 'memory-galaxy', 'state.json');
if (fs.existsSync(panelStateFile)) {
  try {
    const state = JSON.parse(fs.readFileSync(panelStateFile, 'utf8'));
    const res = await fetch('http://127.0.0.1:8188/api/health', { signal: AbortSignal.timeout(5000) });
    check('panel', res.ok, String(res.status));
    report.panel_token_present = Boolean(state.token);
  } catch { check('panel', false); }
} else check('panel', false, 'state.json missing');

const hookRoot = path.join(workspace, 'state', 'hook');
const hook = fs.existsSync(hookRoot) ? fs.readdirSync(hookRoot).find(name => name.startsWith('wechat-')) || '' : '';
report.hook = hook;
check('hook', Boolean(hook), hook);

const pluginsFile = path.join(workspace, 'config', 'plugins.json');
let speech = null;
if (fs.existsSync(pluginsFile)) {
  try {
    speech = JSON.parse(fs.readFileSync(pluginsFile, 'utf8')).plugins?.['speech-recognition'] ?? null;
  } catch {}
}
const speechEnabled = speech?.enabled === true && (speech.permissions ?? []).includes('audio_read') && (speech.chats === null || (speech.chats ?? []).length > 0);
check('speech_plugin', speechEnabled, speech?.settings?.endpoint ?? 'missing');

let asrOk = false;
try {
  const res = await fetch('http://127.0.0.1:11231/health', { signal: AbortSignal.timeout(5000) });
  const body = await res.json();
  asrOk = res.ok && body?.service === 'local-asr';
  check('local_asr', asrOk, body?.model ?? '');
} catch { check('local_asr', false); }

const voiceIndex = path.join(workspace, 'state', 'voices', 'index.json');
let voiceCount = 0;
if (fs.existsSync(voiceIndex)) {
  try { voiceCount = Object.keys(JSON.parse(fs.readFileSync(voiceIndex, 'utf8')).entries ?? {}).length; } catch {}
}
report.voice_refs = voiceCount;
check('voice_refs', voiceCount >= 0, String(voiceCount));
report.inbound_voice = speechEnabled && asrOk ? 'ready' : 'not_ready';
check('inbound_voice', speechEnabled && asrOk, report.inbound_voice);

const voiceConfig = process.env.WECHAT_VOICE_CONFIG || '';
const voiceRef = process.env.WECHAT_VOICE_REF || '';
if (voiceConfig) check('voice_config', fs.existsSync(voiceConfig));
if (voiceRef) check('voice_reference', fs.existsSync(voiceRef));

console.log(JSON.stringify(report, null, 2));
const failed = Object.entries(report.checks).filter(([, item]) => !item.ok).map(([name]) => name);
process.exitCode = failed.length ? 1 : 0;

