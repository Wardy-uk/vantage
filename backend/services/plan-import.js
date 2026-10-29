'use strict';

/**
 * A document becomes a plan (29 Oct 2026).
 *
 * Nick's rule: the model PROPOSES and he edits before anything is written. So
 * `propose()` reads the document, asks once, validates the answer and returns
 * it — it writes nothing. `plans.createPlan()` is the only writer, and it runs
 * on his Save.
 *
 * Owners and due dates are taken only where the document STATES them; an
 * unstated one is null, never inferred. A truncated or unreadable answer is
 * refused whole rather than half-kept — a plan missing its back half looks
 * complete.
 *
 * The original file is never stored: Word and PDF are reduced to text here, and
 * the text (not the file) is saved beside the register as the source note.
 */

const openrouter = require('./openrouter');

const MAX_TEXT = 60_000;      // characters sent to the model
const MAX_ACTIONS = 150;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

async function textFromPdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = ''; let lastY = null; const lines = [];
    for (const item of tc.items) {
      const y = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== lastY) { lines.push(line); line = ''; }
      line += item.str + (item.hasEOL ? '\n' : '');
      lastY = y;
    }
    lines.push(line);
    pages.push(lines.join('\n'));
  }
  return pages.join('\n\n');
}

async function textFromDocx(buf) {
  const mammoth = require('mammoth');
  const r = await mammoth.extractRawText({ buffer: buf });
  return r.value || '';
}

/** Text from whatever was uploaded. Refuses a format it cannot read rather than sending bytes to a model. */
async function extractText({ text, filename, fileBase64 } = {}) {
  if (typeof text === 'string' && text.trim()) return { text: text.trim(), from: 'pasted text' };
  if (!fileBase64 || !filename) throw new Error('Paste text or attach a .docx, .pdf, .md or .txt file');
  const buf = Buffer.from(String(fileBase64).replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw new Error('The file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new Error('Files over 8 MB are not accepted');
  const ext = String(filename).toLowerCase().split('.').pop();
  let out;
  if (ext === 'pdf') out = await textFromPdf(buf);
  else if (ext === 'docx') out = await textFromDocx(buf);
  else if (ext === 'md' || ext === 'txt' || ext === 'markdown') out = buf.toString('utf8');
  else throw new Error(`.${ext} files are not supported — use .docx, .pdf, .md or .txt`);
  out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!out) throw new Error('No text could be read from that file (a scanned PDF has no text layer)');
  return { text: out, from: filename };
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? v : null);

/** Validate the model's JSON. Pure. Bad rows are dropped AND reported. */
function parseProposal(raw) {
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {
    throw new Error('The model\'s answer was not readable JSON — nothing proposed. Try again.');
  }
  if (!j || !Array.isArray(j.sections)) throw new Error('The model\'s answer had no sections — nothing proposed. Try again.');
  const problems = [];
  let count = 0;
  const sections = [];
  for (const s of j.sections) {
    const title = str(s?.title, 120) || 'Actions';
    const actions = [];
    for (const a of Array.isArray(s?.actions) ? s.actions : []) {
      const action = str(a?.action, 300);
      if (!action) { problems.push(`a row in "${title}" had no action text and was dropped`); continue; }
      if (count >= MAX_ACTIONS) { problems.push(`more than ${MAX_ACTIONS} actions — the rest were dropped`); break; }
      const due = a?.due == null || a.due === '' ? null : isoDate(a.due);
      if (a?.due && !due) problems.push(`"${action.slice(0, 40)}": due "${a.due}" was not a date and was left blank`);
      actions.push({ action, owner: str(a?.owner, 80) || null, due, notes: str(a?.notes, 200) || null });
      count += 1;
    }
    sections.push({ title, actions });
  }
  if (!count) throw new Error('No actions were found in the document.');
  return { name: str(j.name, 80) || null, summary: str(j.summary, 400) || null, sections, problems };
}

const PROMPT = `You turn a document into an action plan register. Answer ONLY with JSON:
{"name": "short plan name", "summary": "one sentence", "sections": [{"title": "...", "actions": [{"action": "...", "owner": null, "due": null, "notes": null}]}]}

RULES
- An action is something someone must DO. Not findings, background or opinions.
- Keep the document's own grouping as sections (phases, workstreams, headings). One section is fine.
- Write each action as a short imperative, faithful to the document's wording.
- owner: ONLY a person or team the document names for that action. Otherwise null. Never guess.
- due: ONLY a date the document states for that action, as YYYY-MM-DD. Relative or vague timing ("30 days", "Q4") goes in notes, not due. Otherwise null.
- notes: optional, short, only what the document says.
- Do not invent actions. Do not merge distinct actions.`;

/** Read a document and propose a plan. Writes nothing. */
async function propose(input = {}) {
  if (!openrouter.isConfigured()) throw new Error('No OpenRouter key — cannot read the document');
  const { text, from } = await extractText(input);
  const truncated = text.length > MAX_TEXT;
  const sent = truncated ? text.slice(0, MAX_TEXT) : text;
  const reply = await openrouter.complete([
    { role: 'system', content: PROMPT },
    { role: 'user', content: `DOCUMENT (${from}${truncated ? `, first ${MAX_TEXT} of ${text.length} characters` : ''}):\n\n${sent}` },
  ], { temperature: 0.2, maxTokens: 8000, json: true, callType: 'plan_import' });
  const proposal = parseProposal(reply.text);
  if (truncated) proposal.problems.unshift(`The document was ${text.length} characters; only the first ${MAX_TEXT} were read. Actions in the rest are missing.`);
  return { ...proposal, from, sourceText: text, truncated };
}

module.exports = { propose, extractText, parseProposal, MAX_TEXT, MAX_ACTIONS };
