// Conservative send-time cleanup. It removes obvious assistant/customer-service
// boilerplate and collapses repeated question/exclamation marks; it never
// rewrites the persona's wording or removes real questions.

const SERVICE_LINE = [
  /^希望(?:这个回答|以上内容|这些内容|这些信息)?(?:能)?(?:对你|对您)?有(?:所)?帮助[。！!]?$/u,
  /^有什么(?:可以|能)帮(?:您|你)(?:的)?[？?]?$/u,
  /^随时(?:可以)?(?:回来)?找我[。！!]?$/u,
  /^作为(?:一个)?(?:AI|人工智能|语言模型)[，,]?.*$/u,
];

function cleanLine(line) {
  const text = String(line ?? '').replace(/[ \t\u3000]+$/u, '').trim();
  if (!text) return '';
  if (SERVICE_LINE.some(pattern => pattern.test(text))) return '';
  return text.replace(/[?？]{2,}/gu, '？').replace(/[!！]{2,}/gu, '！');
}

export function cleanReplyText(value) {
  const text = String(value ?? '').replace(/\r\n?/gu, '\n');
  const lines = [];
  for (const line of text.split('\n')) {
    const trimmed = String(line).trim();
    if (SERVICE_LINE.some(pattern => pattern.test(trimmed))) continue;
    if (!trimmed) { lines.push(''); continue; }
    lines.push(cleanLine(line));
  }
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}
