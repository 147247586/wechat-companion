// Lightweight PAD mood state for the private companion.
// PAD = pleasure / arousal / dominance, each 0..1. Mood decays toward 0.5 over 6h,
// per-message movement is capped at 0.12 per axis. This is internal context only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MOOD_HALF_LIFE = 6 * 3600;
const MAX_DELTA = 0.12;
const POSITIVE = /(喜欢|爱你|开心|高兴|哈哈|嘿嘿|贴贴|抱抱|亲亲|想你|好棒|可爱|乖|笑死|舒服|期待|温柔)/u;
const NEGATIVE = /(难过|伤心|烦|累|生气|难受|哭|委屈|讨厌|滚|失眠|崩溃|焦虑|无语|心寒|不想活|绝食)/u;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value)));
const padText = pad => `PAD=(${pad.map(value => value.toFixed(2)).join(',')})`;

function fileFor(root, key) {
  const dir = path.join(root, 'state', 'mood');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16) + '.json');
}

function load(root, key, now) {
  const file = fileFor(root, key);
  let state = { pad: [0.5, 0.5, 0.5], energy: 0.5, at: now, label: '平静' };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first turn */ }
  if (!Array.isArray(state.pad) || state.pad.length !== 3) state.pad = [0.5, 0.5, 0.5];
  state.pad = state.pad.map(value => clamp(value));
  const dt = Math.max(0, now - Number(state.at || now));
  const decay = Math.pow(0.5, dt / MOOD_HALF_LIFE);
  state.pad = state.pad.map(value => clamp(0.5 + (Number(value) - 0.5) * decay));
  state.at = now;
  return { file, state };
}

function labelFor(pad) {
  const [pleasure, arousal] = pad;
  if (pleasure >= 0.62 && arousal >= 0.58) return '有点兴奋';
  if (pleasure >= 0.58) return '心情不错';
  if (pleasure <= 0.36) return '有点低落';
  if (pleasure <= 0.44) return '闷闷的';
  return '平静';
}

export function moodStateContext(root, key, message, now = Date.now()) {
  const { file, state } = load(root, key, now / 1000);
  const text = String(message ?? '');
  const positive = POSITIVE.test(text);
  const negative = NEGATIVE.test(text);
  if (positive) {
    state.pad[0] = clamp(state.pad[0] + Math.min(MAX_DELTA, 0.08));
    state.pad[1] = clamp(state.pad[1] + Math.min(MAX_DELTA, 0.04));
    state.pad[2] = clamp(state.pad[2] + Math.min(MAX_DELTA, 0.03));
    state.energy = clamp(state.energy + 0.03);
  }
  if (negative) {
    state.pad[0] = clamp(state.pad[0] - Math.min(MAX_DELTA, 0.1));
    state.pad[1] = clamp(state.pad[1] + Math.min(MAX_DELTA, 0.06));
    state.pad[2] = clamp(state.pad[2] - Math.min(MAX_DELTA, 0.04));
    state.energy = clamp(state.energy - 0.05);
  }
  const hour = new Date(now).getHours();
  const baseEnergy = hour < 6 ? 0.25 : hour < 9 ? 0.55 : hour < 18 ? 0.7 : hour < 23 ? 0.55 : 0.35;
  state.energy = clamp(state.energy * 0.85 + baseEnergy * 0.15);
  state.label = labelFor(state.pad);
  state.at = now / 1000;
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* state is best-effort */ }
  return [
    '[鱼鱼现在的心情·内部参考]',
    `心情：${state.label}；${padText(state.pad)}，能量=${state.energy.toFixed(2)}。`,
    '这只是语气和状态，不影响事实判断；不要报数值，也不要每轮都说。',
  ].join('\n');
}
