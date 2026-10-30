'use strict';

/**
 * A role profile read from a signed SFIA annex (30 Oct 2026).
 *
 * Nick's call: the team's job descriptions carry an "Annex A — SFIA 9 role
 * profile" table, agreed and signed with his line manager. That table IS the
 * target. The job-description reader (perf-profile.propose) asks a model to
 * GUESS levels from prose, and it guessed the Head of Technical Support role
 * flat at L5 while Nick's own matrix said L6 — so a signed annex is read
 * exactly, with no model call:
 *  - a table whose header has Code and Level gives the skills (code, name,
 *    level, and the "basis" column as what the level looks like in this role);
 *  - a table whose header has Attribute and Level gives the five attributes;
 *  - a row that is not a SFIA code or a level 1-7 is REPORTED, never repaired.
 * The SFIA bar wording (what a rating is judged against) is not in the annex.
 * It is taken from an earlier saved profile holding the same code AT THE SAME
 * LEVEL; where none exists the skill is judged on the annex basis and the gap
 * is listed, so Nick can paste the SFIA wording in before saving.
 * Nothing is saved here: the result goes to the same Save step as a proposal.
 */

const sfia = require('./sfia');
const store = require('./perf-store');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/\s+/g, ' ').trim();

/** Tables from mammoth HTML. Pure. */
function tablesFromHtml(html) {
  const out = [];
  for (const t of String(html).match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = [];
    for (const r of t.match(/<tr[\s\S]*?<\/tr>/gi) || []) rows.push((r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(clean));
    if (rows.length) out.push(rows);
  }
  return out;
}

/** Tables from markdown / pipe text. Pure. */
function tablesFromText(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      (cur = cur || []).push(cells);
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

const headIndex = (row, re) => row.findIndex((c) => re.test(c));

/** Skills and attributes from tables. Pure. */
function readTables(tables) {
  const problems = [];
  const skills = [];
  const attributes = {};
  const attrByName = new Map(sfia.ATTRIBUTES.map((a) => [a.name.toLowerCase(), a.key]));
  for (const rows of tables) {
    const h = rows[0].map((c) => c.toLowerCase());
    const iLevel = headIndex(h, /^level\b/);
    if (iLevel < 0) continue;
    const iCode = headIndex(h, /^code\b/);
    const iAttr = headIndex(h, /^attribute\b/);
    if (iCode >= 0) {
      const iName = headIndex(h, /^skill\b/);
      const iBasis = headIndex(h, /basis|in this role|what this level|reason|why/);
      for (const r of rows.slice(1)) {
        const code = String(r[iCode] || '').trim().toUpperCase();
        if (!code) continue;
        const level = Number(String(r[iLevel] || '').match(/\d/)?.[0]);
        if (!sfia.CODE_RE.test(code)) { problems.push(`"${r[iCode]}" is not a SFIA code — row skipped`); continue; }
        if (!(level >= 1 && level <= 7)) { problems.push(`${code} has no level 1-7 ("${r[iLevel]}") — row skipped`); continue; }
        if (skills.some((s) => s.code === code)) { problems.push(`${code} appears twice — the first row was kept`); continue; }
        const basis = iBasis >= 0 ? r[iBasis] : '';
        skills.push({ code, name: (iName >= 0 ? r[iName] : '') || code, level, why: basis || null, inRole: basis || null });
      }
    } else if (iAttr >= 0) {
      const iWhy = headIndex(h, /reason|why|justification|basis/);
      for (const r of rows.slice(1)) {
        const key = attrByName.get(String(r[iAttr] || '').trim().toLowerCase());
        if (!key) continue;
        const level = Number(String(r[iLevel] || '').match(/\d/)?.[0]);
        if (!(level >= 1 && level <= 7)) { problems.push(`${r[iAttr]} has no level 1-7 — not read`); continue; }
        attributes[key] = { level, why: iWhy >= 0 ? r[iWhy] || null : null };
      }
    }
  }
  for (const a of sfia.ATTRIBUTES) if (!attributes[a.key]) problems.push(`${a.name}: no level in the annex — set it before saving`);
  return { skills, attributes, problems };
}

/** SFIA bar wording from earlier saved profiles: same code AND same level only. */
function barsFromHistory() {
  const bars = new Map();
  for (const r of store.allRoles()) {
    for (const s of r.profile?.skills || []) {
      const k = `${s.code}@${s.level}`;
      if (s.bar && !bars.has(k)) bars.set(k, s.bar);
    }
  }
  return bars;
}

async function readAnnex({ text, filename, fileBase64 } = {}) {
  let tables; let sourceText; let from;
  if (typeof text === 'string' && text.trim()) {
    tables = tablesFromText(text); sourceText = text.trim(); from = 'pasted text';
  } else {
    if (!fileBase64 || !filename) throw new Error('Attach the job description (.docx) with its SFIA annex, or paste the annex table');
    const buf = Buffer.from(String(fileBase64).replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) throw new Error('The file is empty');
    if (buf.length > MAX_FILE_BYTES) throw new Error('Files over 8 MB are not accepted');
    const ext = String(filename).toLowerCase().split('.').pop();
    from = filename;
    if (ext === 'docx') {
      const mammoth = require('mammoth');
      tables = tablesFromHtml((await mammoth.convertToHtml({ buffer: buf })).value || '');
      sourceText = ((await mammoth.extractRawText({ buffer: buf })).value || '').replace(/\n{3,}/g, '\n\n').trim();
    } else if (ext === 'md' || ext === 'txt' || ext === 'markdown') {
      sourceText = buf.toString('utf8'); tables = tablesFromText(sourceText);
    } else throw new Error(`.${ext} is not supported for an annex — use the .docx, or paste the table`);
  }
  const { skills, attributes, problems } = readTables(tables);
  if (!skills.length) throw new Error('No SFIA skills table found — the annex needs a table with Code, Skill and Level columns');
  const bars = barsFromHistory();
  const noBar = [];
  for (const s of skills) {
    const b = bars.get(`${s.code}@${s.level}`);
    if (b) s.bar = b; else noBar.push(`${s.code} L${s.level}`);
  }
  if (noBar.length) problems.push(`No SFIA wording held for ${noBar.join(', ')} — these are judged on the annex basis unless you paste SFIA's level text in`);
  const firstLine = (sourceText || '').split('\n').map((l) => l.trim()).find(Boolean) || 'Role';
  // Always "proposed" on import: VANTAGE cannot see a signature, so Nick marks it confirmed himself.
  return {
    profile: {
      title: firstLine.slice(0, 120),
      summary: null,
      attributes, skills, problems,
      confirmation: { state: 'proposed' },
    },
    sourceName: from, sourceText, catalogue: sfia.catalogue() ? 'checked' : 'not-checked', from: 'annex',
  };
}

module.exports = { readAnnex, readTables, tablesFromHtml, tablesFromText };
