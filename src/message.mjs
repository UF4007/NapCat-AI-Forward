// Turning OneBot 11 message segments (NapCat's default "array" format) into text and images.

// Shop faces carry emoji_id; picture sub_type 0 is a normal picture, anything else is a sticker kind.
const isSticker = (d) => d.emoji_id != null || (d.sub_type != null && Number(d.sub_type) !== 0);

const PLACEHOLDERS = { face: '[表情]', record: '[语音]', video: '[视频]', file: '[文件]', forward: '[聊天记录]', json: '[卡片]' };

// Text as the model should read it: mentions become "@你"/"@name", media become placeholders.
export function render(segments, selfId) {
  return segments.map((s) => {
    const d = s.data || {};
    switch (s.type) {
      case 'text':
        return d.text || '';
      case 'at':
        if (String(d.qq) === String(selfId)) return '@你';
        return d.qq === 'all' ? '@全体成员' : `@${d.name || d.qq}`;
      case 'image':
        return isSticker(d) ? d.summary || '[表情]' : '[图片]';
      case 'reply':
        return '';
      default:
        return PLACEHOLDERS[s.type] || '';
    }
  }).join('').trim();
}

// Only the typed text, for recognising commands such as /reset.
export const plainText = (segments) => segments.filter((s) => s.type === 'text').map((s) => s.data.text || '').join('').trim();

export const isMentioned = (segments, selfId) => segments.some((s) => s.type === 'at' && String(s.data.qq) === String(selfId));

export const replyId = (segments) => segments.find((s) => s.type === 'reply')?.data.id;

export const imageUrls = (segments, { stickers }) =>
  segments.filter((s) => s.type === 'image' && s.data.url && (stickers || !isSticker(s.data))).map((s) => s.data.url);

function sniffImageType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

// QQ image links expire and are often unreachable from model providers, so send the bytes as a data URL.
export async function downloadImage(url, maxBytes) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (Number(r.headers.get('content-length') || 0) > maxBytes) throw new Error('image too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('image too large');
  const type = (r.headers.get('content-type') || '').split(';')[0].trim();
  return `data:${type.startsWith('image/') ? type : sniffImageType(buf)};base64,${buf.toString('base64')}`;
}
