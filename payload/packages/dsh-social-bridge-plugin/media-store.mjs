// Persist real inbound images as media assets and enqueue a caption job.
// Stickers and thumbnails stay out of the long-term memory pipeline.
import fs from 'node:fs';
import path from 'node:path';

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function enqueueImageAsset({ root, chat, image, content, data, sourceQuality = 'original' }) {
  if (!image?.id || image.kind === 'sticker') return null;
  if (!Buffer.isBuffer(data) || !data.length) return null;
  const ext = MIME_EXT[content.mime];
  if (!ext) return null;
  const assets = path.join(root, 'state', 'media-assets');
  const queue = path.join(root, 'state', 'media-queue');
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(queue, { recursive: true });
  const file = path.join(assets, `${content.sha256}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, data);
  const job = {
    chat,
    sha256: content.sha256,
    path: file,
    mime: content.mime,
    imageId: image.id,
    quality: sourceQuality,
    createdAt: Date.now(),
    status: 'queued',
  };
  const name = `${content.sha256}-${Date.now()}.json`;
  fs.writeFileSync(path.join(queue, name), JSON.stringify(job), { mode: 0o600 });
  return job;
}
