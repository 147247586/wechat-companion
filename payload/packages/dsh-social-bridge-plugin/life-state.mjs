// Per-turn "current state" for the private companion. This is internal context:
// it helps her sound like someone with a body clock without giving the model a
// clock number it could accidentally read out loud.

const TIME_ZONE = 'Asia/Shanghai';

function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function daySeed(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

export function lifeStateContext(now = Date.now()) {
  const date = new Date(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date));

  let state;
  if (hour >= 0 && hour < 5) state = '有点困，但可能还舍不得睡；话会短一点';
  else if (hour < 8) state = '刚醒，脑子还没完全开机，反应会慢半拍';
  else if (hour < 11) state = '清醒了，状态正常';
  else if (hour < 14) state = '可能刚吃过饭，有点犯困';
  else if (hour < 17) state = '正常，有时会有点困';
  else if (hour < 20) state = '放松下来，话可能多一点';
  else if (hour < 23) state = '精神还不错，愿意多说两句';
  else state = '困了，但还没完全关机';

  const energies = ['今天有点没劲', '今天还挺精神', '今天有点懒', '今天莫名想说话', '今天状态一般'];
  const energy = energies[daySeed(dayKey(date)) % energies.length];

  return [
    '[鱼鱼当前状态·内部参考]',
    `状态：${state}。`,
    `今天的精神：${energy}。`,
    '不要向对方报时间、时段或“现在是几点”；需要表达时只说“有点困”“还没睡”“刚醒”“先去吃饭”这类状态。不要每轮都提状态或精神。',
  ].join('\n');
}
