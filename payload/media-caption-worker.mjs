// Async image caption worker. Watches state/media-queue, asks local Qwen2.5-VL
// for a short Chinese caption, stores a media asset, and writes one linked memory.
// Runs independently from chat; failures never block a reply.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HistoryStore } from 'file:///D:/wechatagent/data/workspace/packages/dsh-social-bridge-plugin/history-store.mjs';
import { createMemoryEngine } from 'file:///D:/wechatagent/data/workspace/packages/dsh-social-bridge-plugin/memory-engine.mjs';

const ROOT = (() => {
  const index = process.argv.indexOf('--root');
  return path.resolve(index >= 0 ? process.argv[index + 1] : 'D:\\wechatagent\\data\\workspace');
})();
const ONCE = process.argv.includes('--once');
const MODEL = process.env.MEDIA_VLM_MODEL || 'qwen2.5vl:3b';
const QUEUE = path.join(ROOT, 'state', 'media-queue');
const ASSETS = path.join(ROOT, 'state', 'media-assets');
const LOG = path.join(ROOT, 'state', 'media-caption.log');
const LOCK = path.join(ROOT, 'state', 'media-caption-worker.pid');
fs.mkdirSync(QUEUE, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (pid && pid !== process.pid) {
      process.kill(pid, 0);
      console.log('media caption worker already running pid=' + pid);
      process.exit(0);
    }
  } catch { /* stale or missing */ }
  fs.writeFileSync(LOCK, String(process.pid));
  process.on('exit', () => {
    try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ }
  });
}
acquireLock();

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  try { fs.appendFileSync(LOG, text); } catch { /* ignore */ }
  process.stdout.write(text);
}

function findDatabase() {
  const root = path.join(ROOT, 'state', 'chat-history');
  if (!fs.existsSync(root)) return null;
  const files = [];
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name, 'history.sqlite');
    if (fs.existsSync(file)) files.push({ file, at: fs.statSync(file).mtimeMs });
  }
  files.sort((a, b) => b.at - a.at);
  return files[0]?.file ?? null;
}

async function caption(file, quality = 'original') {
  const bytes = fs.readFileSync(file);
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: quality === 'thumbnail'
        ? '这是微信缩略图，细节和小字可能看不清。如果能确定，用中文简洁描述最可能的主体和场景；如果确实无法判断，只输出 UNCERTAIN。不要猜小字，不要编造，40 字以内。'
        : '用中文简洁描述这张图片：主体、场景、画面里能确定的文字。只描述看到的；如果确实无法判断，只输出 UNCERTAIN。不要写成作文，40 字以内。',
      images: [bytes.toString('base64')],
      stream: false,
      options: { temperature: 0.1, num_predict: 120 },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw Error(`VLM_HTTP_${response.status}`);
  const body = await response.json();
  const text = String(body.response || '').replace(/\s+/g, ' ').trim();
  const clean = text.replace(/[。.!！?？,，\s]/g, '');
  const uncertain = !clean || /^(不确定|无法|看不清|不知道|不能确定|uncertain)$/i.test(clean);
  return { text: text.slice(0, 240), uncertain };
}

function isLowConfidence(text) {
  const clean = String(text || '').replace(/[。.!！?？,，\s]/g, '');
  return !clean || clean.length < 4 || /^(不确定|无法|看不清|不知道|不能确定|uncertain)$/i.test(clean);
}

const dbFile = findDatabase();
if (!dbFile) {
  log('no history.sqlite found; worker exits');
  process.exit(1);
}
const scope = path.basename(path.dirname(dbFile));

async function loop() {
  while (true) {
    const files = fs.readdirSync(QUEUE).filter(name => name.endsWith('.json')).sort();
    for (const name of files) {
      const file = path.join(QUEUE, name);
      try {
        const current = new HistoryStore(ROOT, scope);
        const localEngine = createMemoryEngine({ root: ROOT, history: current, generate: async () => { throw Error('not used'); }, log: line => log(line) });
        try {
          const job = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!job.path || !fs.existsSync(job.path)) throw Error('MEDIA_FILE_MISSING');
          const result = await caption(job.path, job.quality);
          const captionText = result.text;
          const now = Date.now() / 1000;
          if (result.uncertain || isLowConfidence(captionText)) {
            current.db.prepare(`INSERT INTO media_assets(chat,kind,sha256,path,mime,width,height,caption,ocr,tags,source_record,created_at,updated_at,status)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'low_confidence')
              ON CONFLICT(chat,sha256) DO UPDATE SET path=excluded.path,mime=excluded.mime,caption=excluded.caption,tags=excluded.tags,updated_at=excluded.updated_at,status='low_confidence'`)
              .run(job.chat, 'image', job.sha256, job.path, job.mime, null, null, '', '', JSON.stringify(['图片']), null, now, now);
            log(`caption low_confidence sha=${job.sha256.slice(0, 12)} text=${captionText.slice(0, 60)} -> asset only, no memory`);
            fs.rmSync(file, { force: true });
            continue;
          }
          current.db.prepare(`INSERT INTO media_assets(chat,kind,sha256,path,mime,width,height,caption,ocr,tags,source_record,created_at,updated_at,status)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'ready')
            ON CONFLICT(chat,sha256) DO UPDATE SET path=excluded.path,mime=excluded.mime,caption=excluded.caption,tags=excluded.tags,updated_at=excluded.updated_at,status='ready'`)
            .run(job.chat, 'image', job.sha256, job.path, job.mime, null, null, captionText, '', JSON.stringify(['图片']), null, now, now);
          const asset = current.db.prepare('SELECT id FROM media_assets WHERE chat=? AND sha256=?').get(job.chat, job.sha256);
          const existingMemory = current.db.prepare('SELECT id FROM memories WHERE media_id=? AND deleted_at IS NULL LIMIT 1').get(asset.id);
          const memoryId = existingMemory?.id ?? localEngine.addMemory(job.chat, {
            text: `图片：${captionText}`,
            kind: 'event', bucket: '事件', base: 2.2, emotion: 0.6,
            tags: ['图片'], mediaId: asset.id,
          }, { source: 'media' });
          try { await localEngine.ensureVectors?.(); } catch { /* vectors can catch up later */ }
          await new Promise(resolve => setTimeout(resolve, 1800));
          log(`caption ok sha=${job.sha256.slice(0, 12)} asset=${asset.id} memory=${memoryId} text=${captionText.slice(0, 80)}`);
          fs.rmSync(file, { force: true });
        } finally { current.close(); }
      } catch (error) {
        // Keep the asset row in a failed state, but remove the queue job so it does
        // not hot-loop; the user can requeue the same sha later.
        log(`caption failed file=${name} error=${String(error?.message ?? error)}`);
        fs.rmSync(file, { force: true });
      }
    }
    if (ONCE) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

loop().catch(error => { log('worker fatal: ' + String(error?.stack || error)); process.exit(1); });
