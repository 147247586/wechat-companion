import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.argv[2] || 'D:\\wechatagent\\data\\workspace';
const configFile = path.join(root, 'config', 'plugins.json');
const projectFile = path.join(root, 'config', 'wechatagent.json');
const project = JSON.parse(fs.readFileSync(projectFile, 'utf8').replace(/^\uFEFF/, ''));
const config = fs.existsSync(configFile)
  ? JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''))
  : { version: 1, plugins: {} };
config.version = 1;
config.plugins ||= {};
const whitelist = project?.wechat?.whitelist ?? {};
const chats = [
  ...(whitelist.private ?? []).map(id => 'wechat:private:' + id),
  ...(whitelist.groups ?? []).map(id => 'wechat:group:' + id),
];
const previous = config.plugins['speech-recognition'] ?? {};
config.plugins['speech-recognition'] = {
  enabled: true,
  permissions: ['audio_read'],
  chats,
  settings: {
    ...(previous.settings ?? {}),
    apiProtocol: 'openai-transcriptions',
    endpoint: 'http://127.0.0.1:11231/v1',
    model: 'sensevoice',
    language: 'zh',
    audioFormat: 'wav',
    requestMode: 'multipart',
    fileField: 'file',
    modelField: 'model',
    languageField: 'language',
    responseMode: 'json',
    responsePath: 'text',
    timeoutMs: 20000,
    maxDurationSeconds: 60,
    maxTranscriptChars: 4000,
    cacheResults: true,
  },
  generation: crypto.randomUUID(),
};
fs.mkdirSync(path.dirname(configFile), { recursive: true });
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, chats, plugin: 'speech-recognition' }, null, 2));
