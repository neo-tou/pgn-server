#!/usr/bin/env node
/*
  eco_fen_bot_move_by_move.js
  Analyze PGN move-by-move (half-move by half-move) and report parent opening for each cumulative sequence
  up to the first N plies (default 10).

  Dependencies: express, axios, chess.js, cors, minimist
  Install: npm i express axios chess.js cors minimist
*/

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { Chess } = require('chess.js');
const cors = require('cors');

// -------------------------
// Configuration via ENV
// -------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const DEFAULT_MAX_PLIES = parseInt(process.env.DEFAULT_MAX_PLIES || '9999', 10);
const MAX_PLIES_TO_REPORT = parseInt(process.env.MAX_PLIES_TO_REPORT || '10', 10); // how many plies to return for summary
const POST_TIMEOUT = parseFloat(process.env.POST_TIMEOUT || '8');
const POLL_URL = process.env.POLL_URL || '';
const POLL_INTERVAL = parseFloat(process.env.POLL_INTERVAL || '5');
const POLL_AUTH_HEADER = process.env.POLL_AUTH_HEADER || '';
const DEFAULT_CALLBACK_URL = process.env.DEFAULT_CALLBACK_URL || '';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const ECO_FILENAME = process.env.ECO_FILE || 'eco_interpolated.json';

function logInfo(...args) { if (['INFO','DEBUG','WARNING','ERROR'].includes(LOG_LEVEL)) console.log(new Date().toISOString(), 'INFO:', ...args); }
function logDebug(...args) { if (LOG_LEVEL === 'DEBUG') console.log(new Date().toISOString(), 'DEBUG:', ...args); }
function logWarn(...args) { console.warn(new Date().toISOString(), 'WARN:', ...args); }
function logError(...args) { console.error(new Date().toISOString(), 'ERROR:', ...args); }

// -------------------------
// Canonical popularity mapping for very first ply
// -------------------------
const POPULAR_FIRST_MOVES = {
  e4: ["King's Pawn Game", 'Open Game', "King's Gambit", 'Caro-Kann Defense', 'French Defense', 'Sicilian Defense'],
  d4: ['Queen\'s Pawn Game', "Queen's Gambit", 'Indian Defense'],
  c4: ['English Opening'],
  nf3: ['Reti Opening', "King's Knight Opening"],
  f4: ["Bird's Opening"],
  g3: ["King's Fianchetto (or King's Indian Attack)"],
  b3: ["Larsen's Opening"],
  a4: ['Ware Opening'],
};

// -------------------------
// Helpers (tokenize, normalize, name cleaning)
// -------------------------
const MOVE_TOKEN_RE = /\b([NBRQK]?[a-h][1-8]|O-O-O|O-O|[NBRQK]x?[a-h][1-8])\b/i;

function normalizeMoveNumbersLine(s) {
  if (typeof s !== 'string') return s;
  s = s.replace(/(\d+)\.\s*/g, '$1. ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Robust PGN tokenizer (ignores headers, comments, variations, outcomes)
function tokenizePgnMoves(pgnText) {
  let text = pgnText || '';
  if (!text) return [];

  const lines = text.replace(/\r/g, '').split('\n');
  const bodyLines = [];
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) continue; // tag pair header
    bodyLines.push(line);
  }
  let movesPart = bodyLines.join(' ').trim();
  if (!movesPart && text.indexOf('\n\n') !== -1) movesPart = text.split('\n\n')[1] || '';
  movesPart = movesPart.replace(/\s+/g, ' ').trim();
  if (!movesPart) return [];

  const rawTokens = movesPart.split(/\s+/);
  const tokens = [];
  let i = 0;
  while (i < rawTokens.length) {
    let t = rawTokens[i];
    if (!t) { i++; continue; }
    if (t.startsWith('{')) {
      while (i < rawTokens.length && !rawTokens[i].includes('}')) i++;
      i++; continue;
    }
    if (t.startsWith('(')) {
      while (i < rawTokens.length && !rawTokens[i].includes(')')) i++;
      i++; continue;
    }
    if (['1-0','0-1','1/2-1/2','*'].includes(t)) { i++; continue; }
    let cleaned = t.replace(/^\d+\.{1,3}/, '');
    if (cleaned === '') {
      i++;
      if (i < rawTokens.length) {
        cleaned = rawTokens[i].replace(/^\d+\.{1,3}/, '');
      } else break;
    }
    cleaned = cleaned.trim();
    if (cleaned) tokens.push(cleaned);
    i++;
  }
  return tokens;
}

function buildSequenceString(seqTokens) {
  const parts = [];
  for (let idx = 0; idx < seqTokens.length; idx++) {
    const tok = seqTokens[idx];
    if (idx % 2 === 0) {
      const moveNum = Math.floor(idx / 2) + 1;
      parts.push(`${moveNum}. ${tok}`);
    } else {
      parts.push(tok);
    }
  }
  return normalizeMoveNumbersLine(parts.join(' '));
}

function specificityScore(name) {
  if (!name) return 0;
  const colonCount = (name.match(/:/g) || []).length;
  const commaCount = (name.match(/,/g) || []).length;
  return colonCount * 50 + commaCount * 5 + name.length;
}

// derive path fragments from raw entry name (same as yours)
function buildOpeningPathFromRaw(rawName, firstToken) {
  if (rawName === undefined || rawName === null) rawName = String(rawName || '');
  let s = rawName.trim();
  const path = [];
  if (s.includes(':')) {
    const [beforeColon, afterColon] = s.split(':', 2);
    const before = (beforeColon || '').trim();
    let after = (afterColon || '').replace(/\([^)]*\)/g, ' ');
    after = after.replace(/\b\d+\.+\s*[A-Za-z0-9NBRQK+=#\/\-\.\*]+\b/g, ' ');
    after = after.replace(MOVE_TOKEN_RE, ' ');
    after = after.replace(/\.\.\./g, ' ');
    after = after.replace(/\s+/g, ' ').trim();
    if (after) {
      const afterParts = after.split(',').map(p => p.trim()).filter(Boolean);
      for (const p of afterParts) if (p && !path.includes(p)) path.push(p);
    }
    if (before) {
      const beforeParts = before.split(',').map(p => p.trim()).filter(Boolean);
      for (const p of beforeParts) if (p && !path.includes(p)) path.push(p);
    }
  } else {
    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    for (const p of parts) if (p && !path.includes(p)) path.push(p);
  }

  if (firstToken) {
    const canonList = POPULAR_FIRST_MOVES[firstToken.toLowerCase()];
    if (canonList && canonList.length > 0) {
      const canon = canonList[0];
      if (!path.includes(canon)) path.push(canon);
    }
  }

  const final = [];
  for (const p of path) if (p && !final.includes(p)) final.push(p);
  return final;
}

// -------------------------
// FEN canonicalization & ECO loader
// -------------------------
function canonicalFenFromChessInstance(chessInstance) {
  const fen = chessInstance.fen();
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

function canonicalizeFenString(fen) {
  if (!fen || typeof fen !== 'string') return null;
  fen = fen.trim();
  try {
    return canonicalFenFromChessInstance(new Chess(fen));
  } catch (e) {
    const parts = fen.split(' ');
    if (parts.length >= 4) return parts.slice(0, 4).join(' ');
    return null;
  }
}

function computeFensFromMovesString(moves) {
  const result = [];
  const toks = tokenizePgnMoves(moves);
  if (!toks || toks.length === 0) return result;
  const board = new Chess();
  for (const tok of toks) {
    let ok = false;
    try {
      const mv = board.move(tok, { sloppy: true });
      if (mv) ok = true;
    } catch (e) { ok = false; }
    if (!ok) {
      const uciMatch = tok.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
      if (uciMatch) {
        const moveObj = { from: uciMatch[1].toLowerCase(), to: uciMatch[2].toLowerCase() };
        if (uciMatch[3]) moveObj.promotion = uciMatch[3].toLowerCase();
        try {
          const mv2 = board.move(moveObj);
          if (mv2) ok = true;
        } catch (e) { ok = false; }
      }
    }
    if (!ok) break;
    result.push(canonicalFenFromChessInstance(board));
  }
  return result;
}

function loadOpeningsFromEco(filename) {
  if (!fs.existsSync(filename)) {
    logWarn(`ECO file ${filename} not found; openings list empty`);
    return { openings: [], fenIndex: new Map() };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (e) {
    logWarn(`Failed to load ${filename}: ${e}`);
    return { openings: [], fenIndex: new Map() };
  }

  const openings = [];
  const fenIndex = new Map(); // Map<canonFen, Array<{ent, ply}>>

  function addToIndex(canon, ent, ply) {
    if (!canon) return;
    const arr = fenIndex.get(canon) || [];
    if (!arr.some(r => r.ent === ent && r.ply === ply)) arr.push({ ent, ply });
    fenIndex.set(canon, arr);
  }

  const items = Array.isArray(data) ? data.map((v, i) => [i, v]) : Object.entries(data);
  for (const [k, v] of items) {
    if (!v || typeof v !== 'object') continue;
    const ent = Object.assign({}, v);
    ent._key = (typeof k === 'string') ? k : (ent.eco || ent.name || null);
    const moves = ent.moves;
    if (typeof moves === 'string' && moves.trim()) ent._moves_norm = normalizeMoveNumbersLine(moves.replace(/\s+/g, ' ').trim());
    else ent._moves_norm = null;
    const fenCandidate = ent.fen || ent.position || ent.FEN || (typeof k === 'string' ? k : null);
    ent._fen = canonicalizeFenString(fenCandidate);
    ent._fens_list = [];
    ent._fen_to_ply = {};
    if (ent._moves_norm) {
      const fens = computeFensFromMovesString(ent._moves_norm);
      for (let idx = 0; idx < fens.length; idx++) {
        const ply = idx + 1;
        const fen = fens[idx];
        ent._fens_list.push(fen);
        if (!(fen in ent._fen_to_ply)) ent._fen_to_ply[fen] = ply;
      }
    }
    openings.push(ent);
  }

  for (const ent of openings) {
    if (ent._fen) addToIndex(ent._fen, ent, null);
    for (const [fen, ply] of Object.entries(ent._fen_to_ply || {})) addToIndex(fen, ent, parseInt(ply, 10));
  }

  logInfo(`Loaded ${openings.length} ECO entries; ${fenIndex.size} distinct canonical FEN keys`);
  return { openings, fenIndex };
}

const { openings: OPENINGS, fenIndex: FEN_TO_ENTRIES } = loadOpeningsFromEco(ECO_FILENAME);

// -------------------------
// Token helpers & matching helpers
// -------------------------
function movesTokensFromNorm(movesNorm) {
  if (!movesNorm) return [];
  return tokenizePgnMoves(movesNorm);
}

function isTokenPrefix(prefix, full) {
  if (!prefix || prefix.length === 0) return true;
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== full[i]) return false;
  return true;
}

function entryMatchesBySetFraction(entTokens, playedTokens, thresholdFraction) {
  if (!Array.isArray(entTokens) || entTokens.length === 0) return false;
  if (!Array.isArray(playedTokens) || playedTokens.length === 0) return false;
  let found = 0;
  const playedSet = new Set(playedTokens);
  for (const tok of entTokens) if (playedSet.has(tok)) found++;
  const frac = found / entTokens.length;
  return frac >= (typeof thresholdFraction === 'number' ? thresholdFraction : 1.0);
}

function findMatchedTokensPositions(entTokens, playedTokens) {
  const out = [];
  const lookup = new Map();
  for (let i = 0; i < playedTokens.length; i++) {
    const t = playedTokens[i];
    const arr = lookup.get(t) || [];
    arr.push(i + 1);
    lookup.set(t, arr);
  }
  for (const tok of entTokens) {
    const indices = lookup.get(tok) || [];
    out.push({ token: tok, indices });
  }
  return out;
}

// pick best entry for a FEN (keeps original scoring behavior)
function bestEntryForFen(canon, playedTokensAtPly, fullPlayedTokens, options = {}) {
  const candRefs = FEN_TO_ENTRIES.get(canon) || [];
  if (!candRefs || candRefs.length === 0) return null;
  const playedLen = (playedTokensAtPly && playedTokensAtPly.length) || 0;
  const scored = [];

  for (const ref of candRefs) {
    const ent = ref.ent;
    const rawName = ((ent.name || ent.opening || ent._key) || '').toString().trim();
    const entMovesNorm = ent._moves_norm || '';
    const entTokens = movesTokensFromNorm(entMovesNorm);

    // require sequence prefix match to respect ordering
    const minLen = Math.min(entTokens.length, playedLen);
    let mismatch = false;
    if (minLen > 0) {
      for (let i = 0; i < minLen; i++) if (entTokens[i] !== playedTokensAtPly[i]) { mismatch = true; break; }
      if (mismatch) continue;
    }

    const samePly = (ent._fen_to_ply && ent._fen_to_ply[canon] === playedLen) ? 1 : 0;
    const reachesCanon = (ent._fen_to_ply && ent._fen_to_ply[canon] != null) ? 1 : 0;
    const commonLen = (function () {
      const n = Math.min(entTokens.length, playedTokensAtPly.length);
      for (let i = 0; i < n; i++) if (entTokens[i] !== playedTokensAtPly[i]) return i;
      return n;
    })();
    const entryFullyMatchedByPlay = (entTokens.length <= playedLen) ? 1 : 0;
    const movesLen = entTokens.length;
    const spec = specificityScore(rawName);

    // set-match
    const setThreshold = (options && typeof options.setThreshold === 'number') ? options.setThreshold : 1.0;
    const setMatched = entryMatchesBySetFraction(entTokens, fullPlayedTokens || [], setThreshold) ? 1 : 0;

    let key;
    if (options && options.preferSetMatch) {
      key = [setMatched, samePly, commonLen, entryFullyMatchedByPlay, reachesCanon, -movesLen, spec];
    } else {
      key = [samePly, commonLen, entryFullyMatchedByPlay, reachesCanon, -movesLen, spec, setMatched];
    }

    scored.push({ key, ent, rawName, entTokens, setMatched });
  }

  if (!scored.length) return null;

  scored.sort((a, b) => {
    const A = a.key, B = b.key;
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const av = (typeof A[i] === 'number') ? A[i] : 0;
      const bv = (typeof B[i] === 'number') ? B[i] : 0;
      if (av !== bv) return bv - av;
    }
    return 0;
  });

  const top = scored[0];
  return { ent: top.ent, rawName: top.rawName, entTokens: top.entTokens, setMatched: top.setMatched, key: top.key };
}

// Sequence-prefix matching helper (returns an example entry)
function bestSequenceMatchForTokens(seqTokens) {
  if (!Array.isArray(seqTokens) || seqTokens.length === 0) return null;
  const candidates = [];
  for (const ent of OPENINGS) {
    if (!ent._moves_norm) continue;
    const entTokens = movesTokensFromNorm(ent._moves_norm || '');
    if (!entTokens || entTokens.length < seqTokens.length) continue;
    let ok = true;
    for (let i = 0; i < seqTokens.length; i++) if (entTokens[i] !== seqTokens[i]) { ok = false; break; }
    if (ok) candidates.push(ent);
  }
  if (candidates.length === 0) return null;
  // choose best by raw-name specificity + frequency like earlier
  const rawCounts = new Map();
  const rawToEntries = new Map();
  for (const ent of candidates) {
    const raw = (ent.name || ent.opening || ent._key || '').toString().trim();
    rawCounts.set(raw, (rawCounts.get(raw) || 0) + 1);
    const arr = rawToEntries.get(raw) || [];
    arr.push(ent);
    rawToEntries.set(raw, arr);
  }
  function rawKey(r) { return [specificityScore(r), rawCounts.get(r) || 0]; }
  let bestRaw = null;
  for (const r of rawCounts.keys()) {
    if (!bestRaw) bestRaw = r;
    else {
      const a = rawKey(bestRaw), b = rawKey(r);
      if (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1])) bestRaw = r;
    }
  }
  return (rawToEntries.get(bestRaw) || [candidates[0]])[0];
}

// Choose parent opening name (most general fragment) for a sequence via candidates
function chooseParentForSequence(seqTokens, fenAtPly, firstToken, wholeGameTokens, options = {}) {
  // Assemble candidate entries: prefer FEN-indexed entries at this fen, otherwise sequence-prefix candidates
  let candidates = [];
  const fenCandidates = FEN_TO_ENTRIES.get(fenAtPly) || [];
  if (fenCandidates && fenCandidates.length > 0) {
    candidates = fenCandidates.map(r => r.ent).filter(Boolean);
  } else {
    // sequence prefix candidates
    for (const ent of OPENINGS) {
      if (!ent._moves_norm) continue;
      const entTokens = movesTokensFromNorm(ent._moves_norm || '');
      if (!entTokens || entTokens.length < seqTokens.length) continue;
      let ok = true;
      for (let i = 0; i < seqTokens.length; i++) if (entTokens[i] !== seqTokens[i]) { ok = false; break; }
      if (ok) candidates.push(ent);
    }
  }

  if (!candidates || candidates.length === 0) {
    // fallback for ply 1 using popularity mapping
    if (seqTokens.length === 1 && firstToken) {
      const list = POPULAR_FIRST_MOVES[firstToken.toLowerCase()] || [];
      if (list && list.length) return { parent: list[0], chosenEntry: null, allCandidates: [] };
    }
    return { parent: null, chosenEntry: null, allCandidates: [] };
  }

  // For each candidate derive its "parent fragment" (most general fragment returned by buildOpeningPathFromRaw)
  const parentCounts = new Map();
  const parentSpecs = new Map();
  const examples = new Map();
  for (const ent of candidates) {
    const raw = (ent.name || ent.opening || ent._key || '').toString().trim();
    const path = buildOpeningPathFromRaw(raw, firstToken);
    // buildOpeningPathFromRaw returns fragments where earlier entries are more specific; choose last as most general
    let parent = null;
    if (Array.isArray(path) && path.length > 0) parent = path[path.length - 1];
    else parent = raw || null;
    if (!parent) continue;
    parentCounts.set(parent, (parentCounts.get(parent) || 0) + 1);
    // choose minimal specificity value so tie-breaker favors more general
    const curSpec = parentSpecs.get(parent) || Infinity;
    parentSpecs.set(parent, Math.min(curSpec, specificityScore(parent) || 0));
    if (!examples.has(parent)) examples.set(parent, ent);
  }

  if (parentCounts.size === 0) return { parent: null, chosenEntry: null, allCandidates: candidates };

  // choose highest count; tie-breaker = lower specificityScore (more general)
  let bestParent = null;
  for (const [par, cnt] of parentCounts.entries()) {
    if (!bestParent) bestParent = par;
    else {
      const bestCnt = parentCounts.get(bestParent) || 0;
      if (cnt > bestCnt) bestParent = par;
      else if (cnt === bestCnt) {
        const aSpec = parentSpecs.get(bestParent) || 0;
        const bSpec = parentSpecs.get(par) || 0;
        if (bSpec < aSpec) bestParent = par;
      }
    }
  }

  return { parent: bestParent, chosenEntry: examples.get(bestParent) || null, allCandidates: candidates };
}

// -------------------------
// Main analyzer: move-by-move up to N plies
// -------------------------
function analyzeMoveByMove(pgnText, maxPlies, options = {}) {
  // options: { max_report_plies: number, orderless_matching, orderless_threshold, prefer_set_matches, debug }
  const max_plies = (typeof maxPlies === 'number') ? maxPlies : DEFAULT_MAX_PLIES;
  const tokens = tokenizePgnMoves(pgnText);
  if (!tokens || tokens.length === 0) return { error: 'No moves parsed from PGN', ply_results: [], summary_lines: [] };

  const board = new Chess();
  const fenPerPly = [];
  const seqTokens = [];

  for (let i = 0; i < tokens.length && i < max_plies; i++) {
    const tok = tokens[i];
    let ok = false;
    try {
      const mv = board.move(tok, { sloppy: true });
      if (mv) ok = true;
    } catch (e) { ok = false; }
    if (!ok) {
      const uciMatch = tok.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
      if (uciMatch) {
        const moveObj = { from: uciMatch[1].toLowerCase(), to: uciMatch[2].toLowerCase() };
        if (uciMatch[3]) moveObj.promotion = uciMatch[3].toLowerCase();
        try {
          const mv2 = board.move(moveObj);
          if (mv2) ok = true;
        } catch (e) { ok = false; }
      }
    }
    if (!ok) break;
    seqTokens.push(tok);
    const canon = canonicalFenFromChessInstance(board);
    fenPerPly.push({ ply: i + 1, san: tok, fen: canon, played_tokens: seqTokens.slice() });
  }

  const wholeGameTokens = fenPerPly.map(r => r.san).filter(Boolean);
  const results = [];
  const summaryLines = [];

  const pliesToReport = Math.min(fenPerPly.length, options.max_report_plies || MAX_PLIES_TO_REPORT);

  for (let pi = 0; pi < pliesToReport; pi++) {
    const rec = fenPerPly[pi];
    const seq = rec.played_tokens || [];
    const seqStr = buildSequenceString(seq);
    // choose parent name for this cumulative sequence
    const choice = chooseParentForSequence(seq, rec.fen, tokens[0] || null, wholeGameTokens, options);
    let parentName = choice.parent || null;
    let eco = null;
    let opening_path = [];
    if (choice.chosenEntry) {
      eco = choice.chosenEntry.eco || null;
      opening_path = buildOpeningPathFromRaw((choice.chosenEntry.name || choice.chosenEntry.opening || choice.chosenEntry._key) || '', tokens[0] || null);
    } else if (parentName) {
      opening_path = [parentName];
    } else {
      // fallback: try sequence-match example to provide an opening path and eco
      const seqEnt = bestSequenceMatchForTokens(seq);
      if (seqEnt) {
        eco = seqEnt.eco || null;
        opening_path = buildOpeningPathFromRaw((seqEnt.name || seqEnt.opening || seqEnt._key) || '', tokens[0] || null);
        // choose parent from that opening_path (most general)
        if (opening_path && opening_path.length > 0) parentName = opening_path[opening_path.length - 1];
      }
    }

    // another fallback: for ply 1 use POPULAR_FIRST_MOVES
    if (!parentName && seq.length === 1 && tokens[0]) {
      const pop = POPULAR_FIRST_MOVES[(tokens[0] || '').toLowerCase()] || [];
      if (pop.length > 0) parentName = pop[0];
      if (!opening_path.length && parentName) opening_path = [parentName];
    }

    const res = {
      ply: rec.ply,
      sequence: seqStr,
      sequence_tokens: seq.slice(),
      parent_opening: parentName,
      eco: eco,
      opening_path: opening_path,
      matched_fen: rec.fen
    };

    results.push(res);
    summaryLines.push(`${seqStr} → ${parentName || 'unknown'}` + (eco ? ` (${eco})` : ''));
  }

  return { ply_results: results, summary_lines: summaryLines, total_plies: fenPerPly.length };
}

// -------------------------
// POST helper
// -------------------------
async function postResultToServer(callbackUrl, payload, timeout) {
  timeout = timeout || POST_TIMEOUT * 1000;
  if (!callbackUrl) return { error: 'no callback_url provided' };
  try {
    const resp = await axios.post(callbackUrl, payload, { timeout });
    return { status_code: resp.status, response_text: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data) };
  } catch (err) {
    logError('Failed to POST results to callback', callbackUrl, err && err.message);
    return { error: err && err.message };
  }
}

// -------------------------
// Express app
// -------------------------
function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cors());
  app.options('*', cors());

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/debug_openings', (req, res) => {
    const sample = [];
    for (const [fen, arr] of Array.from(FEN_TO_ENTRIES.entries()).slice(0, 12)) {
      const entry = arr[0].ent;
      sample.push({ fen, name: entry.name, eco: entry.eco, _key: entry._key });
    }
    res.json({ count: OPENINGS.length, fen_index_size: FEN_TO_ENTRIES.size, sample });
  });

  app.post('/analyze', async (req, res) => {
    const data = req.body || {};
    const pgn = data.pgn;
    const maxPlies = parseInt(data.max_plies || DEFAULT_MAX_PLIES, 10);
    const callback = data.callback_url || data.callback || DEFAULT_CALLBACK_URL;
    const debug = !!data.debug;
    const maxReport = parseInt(data.max_report_plies || MAX_PLIES_TO_REPORT, 10);

    if (!pgn || typeof pgn !== 'string' || !pgn.trim()) return res.status(400).json({ error: 'No PGN provided (send JSON: {"pgn":"1. e4 e5 ..."})' });

    try {
      const out = analyzeMoveByMove(pgn.trim(), maxPlies, { max_report_plies: maxReport, debug });
      out._options = { max_report_plies: maxReport };
      if (callback) {
        const postInfo = await postResultToServer(callback, out);
        out._post_result = postInfo;
      }
      return res.json(out);
    } catch (exc) {
      logError('Failed to analyze PGN:', exc && exc.message);
      return res.status(500).json({ error: String(exc) });
    }
  });

  return app;
}

// -------------------------
// Poll / CLI / main
// -------------------------
async function pollLoop(pollUrl, pollInterval, stopSignal) {
  const headers = POLL_AUTH_HEADER ? { Authorization: POLL_AUTH_HEADER } : {};
  logInfo(`Starting poll loop: ${pollUrl} (interval=${pollInterval}s)`);
  while (!stopSignal.stopped) {
    try {
      const resp = await axios.get(pollUrl, { headers, timeout: 10000 });
      if (resp.status === 204 || resp.status === 404) { await sleep(pollInterval * 1000); continue; }
      if (resp.status !== 200) { logWarn('Poll returned status', resp.status); await sleep(pollInterval * 1000); continue; }
      const job = resp.data;
      if (!job) { logWarn('Poll returned empty job'); await sleep(pollInterval * 1000); continue; }
      const pgn = job.pgn;
      if (!pgn) { logWarn("Poll returned job without 'pgn'; ignoring"); await sleep(pollInterval * 1000); continue; }
      const max_plies = parseInt(job.max_plies || DEFAULT_MAX_PLIES, 10);
      const callback = job.callback_url || job.callback || DEFAULT_CALLBACK_URL;
      logInfo('Got job from poll: max_plies=', max_plies, 'callback=', !!callback);
      try {
        const out = analyzeMoveByMove(pgn, max_plies, { max_report_plies: MAX_PLIES_TO_REPORT });
        if (callback) {
          const postInfo = await postResultToServer(callback, out);
          logInfo('Posted results to callback:', postInfo);
        }
      } catch (err) {
        logError('Failed to analyze job:', err && err.message);
        if (callback) await postResultToServer(callback, { error: String(err) });
      }
    } catch (err) {
      logError('Poll request failed:', err && err.message);
      await sleep(pollInterval * 1000);
      continue;
    }
    await sleep(pollInterval * 1000);
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main(argv) {
  const args = require('minimist')(argv || process.argv.slice(2), { boolean: ['serve','poll'], string: ['pgn-file'] });

  const inputEnv = process.env.INPUT;

  if (!inputEnv && !args.serve && !args.poll && !args['pgn-file']) {
    logInfo('No INPUT provided and no mode flags set — exiting immediately.');
    process.exit(0);
  }

  if (inputEnv) {
    try {
      const inputData = JSON.parse(inputEnv);
      const pgn = inputData.pgn;
      const max_plies = parseInt(inputData.max_plies || DEFAULT_MAX_PLIES, 10);
      const callback = inputData.callback_url || inputData.callback || DEFAULT_CALLBACK_URL;
      const debug = !!inputData.debug;
      const maxReport = parseInt(inputData.max_report_plies || MAX_PLIES_TO_REPORT, 10);
      if (!pgn) { logError("INPUT provided but no 'pgn' field"); process.exit(1); }
      const out = analyzeMoveByMove(pgn, max_plies, { max_report_plies: maxReport, debug });
      if (callback) {
        const postInfo = await postResultToServer(callback, out);
        out._post_result = postInfo;
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    } catch (exc) {
      logError('Failed to process INPUT:', exc && exc.message);
      process.exit(1);
    }
  }

  if (args.serve) {
    const app = createApp();
    const host = '0.0.0.0';
    logInfo(`Starting server on ${host}:${PORT}`);
    app.listen(PORT, host, () => logInfo(`Server running on http://${host}:${PORT}`));
    return;
  }

  if (args.poll) {
    if (!POLL_URL) { logError('POLL_URL not set; cannot start poll mode'); process.exit(2); }
    const stopSignal = { stopped: false };
    process.on('SIGINT', () => { logInfo('Received SIGINT: stopping poll loop'); stopSignal.stopped = true; });
    process.on('SIGTERM', () => { logInfo('Received SIGTERM: stopping poll loop'); stopSignal.stopped = true; });
    try {
      await pollLoop(POLL_URL, POLL_INTERVAL, stopSignal);
    } catch (e) {
      logError('Poll loop terminated unexpectedly', e && e.message);
    }
    return;
  }

  if (args['pgn-file']) {
    let pgnText = '';
    try { pgnText = fs.readFileSync(args['pgn-file'], 'utf8'); } catch (e) { logError('Failed to read pgn file', e && e.message); process.exit(1); }
    if (!pgnText.trim()) { logError('No PGN provided'); process.exit(1); }
    const max_plies = args['max-plies'] || DEFAULT_MAX_PLIES;
    try {
      const out = analyzeMoveByMove(pgnText, max_plies, { max_report_plies: MAX_PLIES_TO_REPORT });
      console.log(JSON.stringify(out, null, 2));
    } catch (exc) {
      logError('Error parsing/analyzing PGN:', exc && exc.message);
      process.exit(1);
    }
    return;
  }

  // fallback: read PGN from stdin
  logInfo('Reading PGN from stdin (paste then Ctrl-D / Ctrl-Z+Enter)');
  const stdin = fs.readFileSync(0, 'utf8');
  if (!stdin.trim()) { logError('No PGN provided'); process.exit(1); }
  const max_plies = args['max-plies'] || DEFAULT_MAX_PLIES;
  try {
    const out = analyzeMoveByMove(stdin, max_plies, { max_report_plies: MAX_PLIES_TO_REPORT });
    console.log(JSON.stringify(out, null, 2));
  } catch (exc) {
    logError('Error parsing/analyzing PGN:', exc && exc.message);
    process.exit(1);
  }
}

if (require.main === module) main();

