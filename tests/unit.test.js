import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, parseReply, systemPrompt } from '../src/lib/prompts.js';
import { downsample, encodeWav, toBase64 } from '../src/lib/wav.js';
import { esc, renderMarkdown, toMarkdownExport } from '../src/lib/format.js';

const session = { mode: 'interview', interviewRole: 'candidate', notes: 'Senior role', docs: [], answerStyle: 'bullets', language: 'English' };

// Same rules the server uses to decide what a request costs (functions/src/logic.js → kindOf).
function kindOf(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return 'text';
  const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content || '') }];
  if (parts.some((p) => p && p.type === 'input_audio')) return 'listen';
  if (parts.some((p) => p && p.type === 'image_url')) return 'screen';
  const text = parts.map((p) => (p && p.text) || '').join(' ');
  if (/^\(Follow-up on an earlier answer\)/.test(text.trim())) return 'followup';
  return 'text';
}

test('each kind of question is charged as the right kind on the server', () => {
  assert.equal(kindOf(buildMessages(session, [], { audioBase64: 'AAAA' })), 'listen');
  assert.equal(kindOf(buildMessages(session, [], { imageBase64: 'AAAA', text: 'what is this' })), 'screen');
  assert.equal(kindOf(buildMessages(session, [], { text: 'hello' })), 'text');
  assert.equal(kindOf(buildMessages(session, [], { refine: { question: 'q', answer: 'a', action: 'summary' } })), 'followup');
});

test('history is sent before the new question', () => {
  const m = buildMessages(session, [{ question: 'Q1', answer: 'A1' }], { text: 'Q2' });
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(m[1].content, '(Earlier question) Q1');
});

test('system prompt carries the interview role, style and reference material', () => {
  const p = systemPrompt({ ...session, docs: [{ kind: 'resume', name: 'CV', text: 'Built X' }] });
  assert.match(p, /presenter is the CANDIDATE/);
  assert.match(p, /2-4 short bullet points/);
  assert.match(p, /Candidate's resume \(the presenter's own\) "CV":\nBuilt X/);
  assert.match(systemPrompt({ mode: 'meeting' }), /No notes or documents were provided/);
});

test('parseReply splits question and answer, spots SKIP, and copes with partial streams', () => {
  assert.deepEqual(parseReply('Q: Why us?\n---\n- Point one'), { question: 'Why us?', answer: '- Point one' });
  assert.deepEqual(parseReply('Q: Why us?\nBecause.'), { question: 'Why us?', answer: 'Because.' });
  assert.equal(parseReply('SKIP').skip, true);
  assert.deepEqual(parseReply('Q: Why u'), { question: 'Why u', answer: '' });
  assert.deepEqual(parseReply('Q: Why us?\n---\n'), { question: 'Why us?', answer: '' });
  assert.deepEqual(parseReply('Just an answer'), { question: '', answer: 'Just an answer' });
});

test('WAV is 16-bit mono PCM with the right header', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 8); // 4 samples × 2 bytes
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32768);
  assert.equal(toBase64(wav).length, Math.ceil(wav.length / 3) * 4);
});

test('downsample turns 48 kHz into 16 kHz', () => {
  const one = new Float32Array(48000).fill(0.25);
  const out = downsample(one, 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[100] - 0.25) < 1e-6);
});

test('answers render safely as HTML', () => {
  assert.equal(esc('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  assert.equal(renderMarkdown('- **One**\n- Two <script>'), '<ul><li><strong>One</strong></li><li>Two &lt;script&gt;</li></ul>');
  assert.equal(renderMarkdown('Hi\n\n1. a'), '<p>Hi</p><ol><li>a</li></ol>');
});

test('export lists every answered question', () => {
  const md = toMarkdownExport({ mode: 'meeting', startedAt: 0, turns: [{ question: 'Q', answer: 'A' }, { question: 'X', answer: '' }] }, { meeting: 'Meeting' });
  assert.match(md, /^# IntervQ · Meeting/);
  assert.match(md, /## Q\n\nA/);
  assert.doesNotMatch(md, /## X/);
});
