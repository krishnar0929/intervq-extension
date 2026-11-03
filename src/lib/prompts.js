// Prompts and reply parsing. Ported from the desktop app (meeting-assist/src/main/openrouter.js) so answers
// read the same in both. Keep the "(Follow-up on an earlier answer)" prefix and the content part types as they
// are: the server uses them to tell a listen / screen / typed / follow-up request apart and charge for it.
const MAX_DOC_CHARS = 150_000; // total across all session documents

export const STYLE = {
  natural:
    'Sound like a real person talking, in plain everyday words: first person, warm and direct, natural phrasing with everyday contractions, and no corporate filler ("leverage", "synergy", "robust", "spearheaded", "delve"). Lead with the point, back it with one concrete specific example, and keep it concise and easy to say out loud. Follow any format instructions below (for example bullet points) while keeping this natural, human wording.',
  bullets: 'Give 2-4 short bullet points (each under 15 words) that I can say out loud, most important first.',
  paragraph: 'Give 2-3 short, conversational sentences that I can say out loud.',
  detailed: 'Start with one direct sentence that answers it, then up to 5 bullet points with specifics.',
};

export const MODES = {
  demo: 'a live product demo',
  presentation: 'a presentation',
  meeting: 'an online meeting',
  general: 'a conversation',
  interview: 'a job interview',
};

export const MODE_LABELS = {
  interview: 'Interview',
  meeting: 'Meeting',
  demo: 'Product demo',
  presentation: 'Presentation',
  general: 'General',
};

export const REFINE = {
  example: 'Keep the answer, and add one short, concrete, relevant example.',
  summary: 'Summarize it in one or two short sentences I can say quickly.',
  detail: 'Give a more detailed answer with specifics, still easy to say out loud.',
  simpler: 'Explain it more simply, in plain words a non-expert would follow.',
  rephrase: 'Say the same thing in a different, natural way.',
};

export const REFINE_LABELS = {
  example: 'Add example',
  summary: 'Summarize',
  detail: 'More detail',
  simpler: 'Simpler',
  rephrase: 'Say it differently',
};

function interviewBlock(session) {
  if (session.mode !== 'interview') return [];
  if (session.interviewRole === 'interviewer') {
    return [
      '',
      'This is a job interview and the presenter is the INTERVIEWER. The clip is usually the candidate answering a question.',
      'After "Q:", put a one-line summary of what the candidate said (or the question they asked).',
      'Then give: one line on how well the answer covers the job requirements (strengths and anything missing or vague),',
      'and 1-2 follow-up questions the interviewer could ask next to dig deeper. Label them "Follow-up:".',
      'If the candidate asked a question about the role or company, suggest an answer from the job requirements and notes instead.',
      'Judge only what was said against the requirements. Never comment on age, gender, ethnicity, religion, disability, family or other personal traits.',
    ];
  }
  return [
    '',
    "This is a job interview and the presenter is the CANDIDATE. The clip is the interviewer's question.",
    'Write the answer in the first person, as the candidate would say it, using their resume and matching it to the job requirements.',
    'For behavioral questions ("tell me about a time…"), use a short situation, task, action, result structure with one real example from the resume.',
    'Never invent jobs, employers, titles, dates, degrees, skills, projects or numbers that are not in the resume or notes.',
    'If the resume has nothing relevant, suggest an honest answer: related experience they do have, and how they would learn or approach it.',
  ];
}

const KIND_LABELS = {
  resume: (s) => (s.interviewRole === 'interviewer' ? "Candidate's resume" : "Candidate's resume (the presenter's own)"),
  requirements: (s) => ({ interview: 'Job requirements', demo: 'Product info', presentation: 'Slides or outline' }[s.mode] || 'Agenda'),
};

function referenceBlock(session) {
  const parts = [];
  const notes = (session.notes || '').trim();
  if (notes) parts.push(`Notes from the presenter:\n${notes}`);
  let budget = MAX_DOC_CHARS;
  const rank = (d) => (d.kind === 'resume' ? 0 : d.kind === 'requirements' ? 1 : 2);
  for (const d of [...(session.docs || [])].sort((a, b) => rank(a) - rank(b))) {
    if (budget <= 0) break;
    const text = String(d.text || '').trim().slice(0, budget);
    if (!text) continue;
    budget -= text.length;
    const label = KIND_LABELS[d.kind] ? KIND_LABELS[d.kind](session) : 'Document';
    parts.push(`${label} "${d.name}":\n${text}`);
  }
  return parts.length ? parts.join('\n\n') : 'No notes or documents were provided.';
}

function customInstructions(session) {
  const text = (session.instructions || '').trim();
  if (!text) return [];
  return [
    '',
    "The presenter's own instructions for how to write answers. Follow them; they take priority over the answer style above:",
    '<<<',
    text,
    '>>>',
    'Whatever those instructions say, keep the "Q: ... --- ..." reply format and never invent facts that are not in the reference material.',
    '',
  ];
}

export function systemPrompt(session) {
  const where = MODES[session.mode] || MODES.meeting;
  return [
    `You are IntervQ. You quietly help a presenter during ${where} held in their web browser.`,
    "The presenter tapped a key to capture what another participant said in the meeting tab. You will receive that audio clip, a typed question, or a screenshot of the tab.",
    'Work out what the participant is asking or needs, then suggest what the presenter should say back.',
    '',
    'Reply in exactly this format:',
    'Q: <the question or request, in one short line, as you understood it>',
    '---',
    '<the suggested answer>',
    '',
    `Answer style: ${STYLE[session.answerStyle] || STYLE.natural}`,
    ...interviewBlock(session),
    ...customInstructions(session),
    `Write the answer in ${session.language || 'English'}. Write plainly, the way a person talks. No preamble.`,
    'Never invent prices, numbers, dates, roadmap promises, or commitments that are not in the reference material below.',
    'If the answer depends on facts you do not have, say what is generally true and suggest offering to follow up with specifics.',
    'If the clip has no clear question, put a one-line summary of what they said after "Q:" and suggest a useful response.',
    'If an audio clip has no spoken words at all (silence, typing, clicks, music or background noise), reply with exactly the word SKIP and nothing else.',
    'If there are words but they are too unclear to follow, write "Q: (couldn\'t make out the question)" and suggest a polite clarifying question.',
    'A typed question can be about anything, not only the session topic: answer it directly and helpfully, in the same format.',
    "For a screenshot, explain or answer about what is on screen, using the presenter's typed note if there is one.",
    '',
    'Reference material:',
    referenceBlock(session),
  ].join('\n');
}

// input: { audioBase64 } | { text } | { imageBase64, text? } | { refine: { question, answer, action } }
export function buildMessages(session, history, input) {
  const messages = [{ role: 'system', content: systemPrompt(session) }];
  for (const turn of history) {
    messages.push({ role: 'user', content: `(Earlier question) ${turn.question}` });
    messages.push({ role: 'assistant', content: turn.answer });
  }
  if (input.refine) {
    const r = input.refine;
    messages.push({
      role: 'user',
      content:
        `(Follow-up on an earlier answer)\nQuestion: ${r.question || '(not captured)'}\n` +
        `Your earlier answer:\n${r.answer}\n\nNow: ${REFINE[r.action]} Keep the "Q:" line as the same question.`,
    });
  } else if (input.imageBase64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: input.text ? `(Screenshot) ${input.text}` : '(Screenshot) What should I say about this?' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.imageBase64}` } },
      ],
    });
  } else if (input.text) {
    messages.push({ role: 'user', content: `(Typed question) ${input.text}` });
  } else {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Here is the audio clip from the call.' },
        { type: 'input_audio', input_audio: { data: input.audioBase64, format: 'wav' } },
      ],
    });
  }
  return messages;
}

// Splits "Q: ...\n---\nanswer" into its parts. Tolerant of models that skip the divider, and of a reply that is
// still streaming in.
export function parseReply(text) {
  const t = String(text || '');
  if (/^\s*SKIP\b/i.test(t) && t.trim().length < 40) return { skip: true, question: '', answer: '' };
  const m = t.match(/^\s*Q:\s*(.*?)\s*(?:\n\s*-{3,}\s*\n|\n)([\s\S]*)$/);
  if (!m) {
    // Still on the "Q:" line.
    const q = t.match(/^\s*Q:\s*(.*)$/);
    if (q) return { question: q[1].trim(), answer: '' };
    return { question: '', answer: t.trim() };
  }
  return { question: m[1].trim(), answer: m[2].replace(/^\s*-{3,}\s*\n/, '').trim() };
}
