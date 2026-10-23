import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chat, image, message, startBridge, startMocks, waitUntil, writeConfig } from './helpers.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);

test('vision: images (also from the replied-to message) go to the model as data URLs; history keeps placeholders', async (t) => {
  const mocks = await startMocks({
    llm: () => chat('看到了'),
    files: {
      '/cat.png': { type: 'application/octet-stream', body: PNG }, // no usable content type: must be sniffed
      '/dog.jpg': { type: 'image/jpeg', body: JPEG },
      '/sticker.png': { type: 'image/png', body: PNG },
      '/big.png': { type: 'image/png', body: Buffer.alloc(4096) },
    },
  });
  t.after(mocks.close);
  // the replied-to message, served by the mock NapCat's get_msg
  mocks.getMsg[99] = {
    message_id: 99,
    user_id: 7,
    sender: { nickname: 'Bob' },
    message: [{ type: 'text', data: { text: '原消息' } }, image(mocks.url('/dog.jpg'))],
  };
  const config = writeConfig(mocks, { group: { reply: 'mention' }, vision: { enabled: true, maxImageMB: 2048 / 1024 / 1024 } });
  await startBridge(t, mocks, config);

  // a normal picture plus a sticker (sub_type 1) that must be skipped
  mocks.send(message('group', ' 这是什么', {
    at: true, id: 1, groupId: 777, extra: [image(mocks.url('/cat.png')), image(mocks.url('/sticker.png'), { sub_type: 1 })],
  }));
  await waitUntil(() => mocks.actions.length === 1);
  assert.deepEqual(mocks.llmCalls[0].messages.at(-1).content, [
    { type: 'text', text: 'Alice(42)：@你 这是什么[图片][表情]' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
  ]);
  assert.ok(!mocks.fileHits.includes('/sticker.png'), 'stickers are skipped');

  mocks.send(message('group', ' 那这张呢', { at: true, id: 2, groupId: 777, extra: [{ type: 'reply', data: { id: '99' } }] }));
  await waitUntil(() => mocks.actions.length === 2);
  const second = mocks.llmCalls[1].messages;
  assert.deepEqual(second.at(-1).content, [
    { type: 'text', text: 'Alice(42)：（回复 Bob：原消息[图片]）@你 那这张呢' },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG.toString('base64')}` } },
  ]);
  assert.deepEqual(second[1], { role: 'user', content: 'Alice(42)：@你 这是什么[图片][表情]' }, 'history keeps text only');

  // over the size limit: the model is told the image failed to load
  mocks.send(message('private', '', { id: 3, extra: [image(mocks.url('/big.png'))] }));
  await waitUntil(() => mocks.actions.length === 3);
  assert.equal(mocks.llmCalls[2].messages.at(-1).content, '[图片]\n（有 1 张图片加载失败）');
});
