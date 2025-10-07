#!/usr/bin/env node
/*
  eco_fen_bot.js

  Node.js translation of the provided Python "ECO FEN-match opening-check bot".
  Features preserved:
   - loads ECO JSON file and indexes intermediate canonical FENs (ply aware)
   - canonical FEN (first 4 fields) handling
   - sequence (token-prefix) fallback analyzer
   - FEN-first analyzer preferring entries whose move-seq is a prefix and which reach the FEN at same ply
   - London heuristic soft override
   - Express endpoints: /health, /debug_openings, /analyze
   - optional poll loop mode

  Notes:
   - Intended to run with Node >= 14
   - Dependencies: express, axios, chess.js
   - Install: npm i express axios chess.js

  Usage examples:
   - node eco_fen_bot.js --serve
   - node eco_fen_bot.js --pgn-file sample.pgn
   - INPUT environment variable may contain a JSON object similar to the Python implementation

  Environment variables supported (defaults shown):
   PORT=8080
   DEFAULT_MAX_PLIES=9999
   POST_TIMEOUT=8
   POLL_URL=""
   POLL_INTERVAL=5
   POLL_AUTH_HEADER=""
   DEFAULT_CALLBACK_URL=""
   LOG_LEVEL=info
   ECO_FILE=eco_interpolated.json
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

function tokenizePgnMoves(pgnText) {
  let text = pgnText || '';
  if (!text) return [];
  let movesPart = text;
  if (text.indexOf('\n\n') !== -1) {
    movesPart = text.split('\n\n')[1];
  }
  movesPart = movesPart.replace(/\r/g, ' ').replace(/\n/g, ' ').trim();
  if (!movesPart) return [];
  const rawTokens = movesPart.split(/\s+/);
  const tokens = [];
  let i = 0;
  while (i < rawTokens.length) {
    let t = rawTokens[i];
    if (!t) { i++; continue; }
    // skip comments {...}
    if (t.startsWith('{')) {
      while (i < rawTokens.length && !rawTokens[i].includes('}')) i++;
      i++;
      continue;
    }
    // skip variations (...)
    if (t.startsWith('(')) {
      while (i < rawTokens.length && !rawTokens[i].includes(')')) i++;
      i++;
      continue;
    }
    // skip outcomes
    if (['1-0', '0-1', '1/2-1/2', '*'].includes(t)) { i++; continue; }
    // strip move numbers like "1." or "1..."
    let cleaned = t.replace(/^\d+\.{1,3}/, '');
    if (cleaned === '') {
      i++;
      if (i < rawTokens.length) {
        const nextTok = rawTokens[i];
        cleaned = nextTok.replace(/^\d+\.{1,3}/, '');
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
  const seq = parts.join(' ');
  return normalizeMoveNumbersLine(seq);
}

function specificityScore(name) {
  if (!name) return 0;
  const colonCount = (name.match(/:/g) || []).length;
  const commaCount = (name.match(/,/g) || []).length;
  return colonCount * 50 + commaCount * 5 + name.length;
}

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
  // chess.js fen -> we return first 4 fields
  const fen = chessInstance.fen();
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

function canonicalizeFenString(fen) {
  if (!fen || typeof fen !== 'string') return null;
  fen = fen.trim();
  try {
    const c = new Chess(fen);
    // if fen invalid chess.js will reset to starting position but throw? it doesn't throw; check validity
    // We'll check that fen has piece placement component
    if (!fen.split(' ')[0]) return null;
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
    // try SAN
    try {
      const mv = board.move(tok, { sloppy: true });
      if (mv) ok = true;
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      // try interpret as UCI 'e2e4' or 'e7e8q'
      const uciMatch = tok.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
      if (uciMatch) {
        const from = uciMatch[1];
        const to = uciMatch[2];
        const prom = uciMatch[3];
        const moveObj = { from: from.toLowerCase(), to: to.toLowerCase() };
        if (prom) moveObj.promotion = prom.toLowerCase();
        try {
          const mv2 = board.move(moveObj);
          if (mv2) ok = true;
        } catch (e) {
          ok = false;
        }
      }
    }
    if (!ok) break; // stop on unparseable move
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
    // avoid duplicates (same ent & same ply)
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

  // build fen_index
  for (const ent of openings) {
    if (ent._fen) addToIndex(ent._fen, ent, null);
    for (const [fen, ply] of Object.entries(ent._fen_to_ply || {})) addToIndex(fen, ent, ply);
  }

  logInfo(`Loaded ${openings.length} ECO entries; ${fenIndex.size} distinct canonical FEN keys`);
  return { openings, fenIndex };
}

const { openings: OPENINGS, fenIndex: FEN_TO_ENTRIES } = loadOpeningsFromEco(ECO_FILENAME);

// -------------------------
// Token helpers
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

// -------------------------
// Sequence fallback analyzer
// -------------------------
function analyzeBySequence(pgnText, maxPlies) {
  const max_plies = (typeof maxPlies === 'number') ? maxPlies : DEFAULT_MAX_PLIES;
  const tokens = tokenizePgnMoves(pgnText);
  if (!tokens || tokens.length === 0) return { error: 'No moves parsed from PGN', opening_path: [], book_moves: [], plies_analyzed: 0 };
  let candidates = OPENINGS.filter(o => typeof o._moves_norm === 'string' && o._moves_norm);
  const seqTokens = [];
  let lastCandidatesSnapshot = candidates.slice();
  let pliesDone = 0;
  // pre-tokenize candidate move lists for faster prefix checks
  let candTokensMap = {};
  for (let i = 0; i < candidates.length; i++) candTokensMap[i] = movesTokensFromNorm(candidates[i]._moves_norm);

  for (let plyIndex = 0; plyIndex < tokens.length && plyIndex < max_plies; plyIndex++) {
    const tok = tokens[plyIndex];
    seqTokens.push(tok);
    const newCands = [];
    for (let i = 0; i < candidates.length; i++) {
      const o = candidates[i];
      const otoks = candTokensMap[i] || movesTokensFromNorm(o._moves_norm);
      if (isTokenPrefix(seqTokens, otoks)) newCands.push(o);
    }
    if (newCands.length > 0) {
      candidates = newCands;
      lastCandidatesSnapshot = candidates.slice();
      // rebuild candTokensMap for reduced set
      candTokensMap = {};
      for (let i = 0; i < candidates.length; i++) candTokensMap[i] = movesTokensFromNorm(candidates[i]._moves_norm);
    } else {
      break;
    }
    pliesDone = plyIndex + 1;
  }
  const working = (lastCandidatesSnapshot && lastCandidatesSnapshot.length > 0) ? lastCandidatesSnapshot : candidates;
  if (!working || working.length === 0) return { opening_path: [], opening: null, book_moves: [], plies_analyzed: pliesDone, max_plies: max_plies };
  const rawCounts = new Map();
  const rawToEntries = new Map();
  for (const ent of working) {
    const raw = (ent.name || ent.opening || ent._key || '').toString().trim();
    rawCounts.set(raw, (rawCounts.get(raw) || 0) + 1);
    const arr = rawToEntries.get(raw) || [];
    arr.push(ent);
    rawToEntries.set(raw, arr);
  }
  function rawKey(r) {
    return [specificityScore(r), rawCounts.get(r) || 0];
  }
  // pick best raw by custom key
  let bestRaw = null;
  for (const r of rawCounts.keys()) {
    if (!bestRaw) bestRaw = r;
    else {
      const a = rawKey(bestRaw), b = rawKey(r);
      if (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1])) bestRaw = r;
    }
  }
  const firstToken = tokens[0] || null;
  const openingPath = buildOpeningPathFromRaw(bestRaw, firstToken);
  const exampleEnt = (rawToEntries.get(bestRaw) || [working[0]])[0];
  const ecoCode = exampleEnt.eco;
  return {
    opening_path: openingPath,
    opening: { eco: ecoCode, name: openingPath[0] || null },
    book_moves: exampleEnt._moves_norm || [],
    plies_analyzed: pliesDone,
    max_plies: max_plies,
  };
}

// -------------------------
// FEN-based analyzer
// -------------------------
function analyzeByFen(pgnText, maxPlies, requireFenOnly = false, debug = false) {
  const max_plies = (typeof maxPlies === 'number') ? maxPlies : DEFAULT_MAX_PLIES;
  const tokens = tokenizePgnMoves(pgnText);
  if (!tokens || tokens.length === 0) return { error: 'No moves parsed from PGN', opening_path: [], book_moves: [], plies_analyzed: 0 };

  // play the game and record FENs + seq strings
  const board = new Chess();
  const fenPerPly = [];
  const seqTokens = [];
  let pliesDone = 0;

  for (let plyIndex = 0; plyIndex < tokens.length && plyIndex < max_plies; plyIndex++) {
    const tok = tokens[plyIndex];
    let ok = false;
    try {
      const mv = board.move(tok, { sloppy: true });
      if (mv) ok = true;
    } catch (e) { ok = false; }
    if (!ok) {
      const uciMatch = tok.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
      if (uciMatch) {
        const from = uciMatch[1];
        const to = uciMatch[2];
        const prom = uciMatch[3];
        const moveObj = { from: from.toLowerCase(), to: to.toLowerCase() };
        if (prom) moveObj.promotion = prom.toLowerCase();
        try {
          const mv2 = board.move(moveObj);
          if (mv2) ok = true;
        } catch (e) { ok = false; }
      }
    }
    if (!ok) break;
    seqTokens.push(tok);
    const canon = canonicalFenFromChessInstance(board);
    fenPerPly.push({ ply: plyIndex + 1, san: tok, fen: canon, played_tokens: seqTokens.slice() });
    pliesDone = plyIndex + 1;
  }

  function commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return n;
  }

  // search from deepest ply -> shallowest
  let bestOut = null;
  for (let ri = fenPerPly.length - 1; ri >= 0; ri--) {
    const record = fenPerPly[ri];
    const ply = record.ply;
    const canon = record.fen;
    const playedTokensAtPly = record.played_tokens;
    const playedLen = playedTokensAtPly.length;

    const candRefs = FEN_TO_ENTRIES.get(canon) || [];
    if (!candRefs || candRefs.length === 0) continue;

    const scored = [];
    const debugCands = [];

    for (const ref of candRefs) {
      const ent = ref.ent;
      const entPly = ref.ply; // may be null
      const rawName = ((ent.name || ent.opening || ent._key) || '').toString().trim();
      const entMovesNorm = ent._moves_norm || '';
      const entTokens = movesTokensFromNorm(entMovesNorm);

      const minLen = Math.min(entTokens.length, playedLen);
      if (minLen === 0) {
        // accept but deprioritize
      } else {
        let mismatch = false;
        for (let i = 0; i < minLen; i++) if (entTokens[i] !== playedTokensAtPly[i]) { mismatch = true; break; }
        if (mismatch) continue; // reject
      }

      const samePly = (ent._fen_to_ply && ent._fen_to_ply[canon] === ply) ? 1 : 0;
      const reachesCanon = (ent._fen_to_ply && ent._fen_to_ply[canon] != null) ? 1 : 0;
      const commonLen = commonPrefixLen(entTokens, playedTokensAtPly);
      const entryFullyMatchedByPlay = (entTokens.length <= playedLen) ? 1 : 0;
      const movesLen = entTokens.length;
      const spec = specificityScore(rawName);

      // key order: samePly, reachesCanon, commonLen, entryFullyMatchedByPlay, movesLen, spec
      const key = [samePly, reachesCanon, commonLen, entryFullyMatchedByPlay, movesLen, spec];
      scored.push({ key, ent, entPly, rawName });
      debugCands.push({ raw: rawName, ply: entPly, ent_len: movesLen, common_len: commonLen, same_ply: samePly });
    }

    if (debug && debugCands.length > 0) {
      bestOut = bestOut || {};
      bestOut.debug_candidates_by_ply = bestOut.debug_candidates_by_ply || [];
      bestOut.debug_candidates_by_ply.push({ ply, fen: canon, candidates: debugCands });
    }

    if (!scored || scored.length === 0) continue;

    // choose best by key (descending lexicographic)
    scored.sort((a, b) => {
      const A = a.key, B = b.key;
      for (let i = 0; i < Math.max(A.length, B.length); i++) {
        const av = A[i] || 0, bv = B[i] || 0;
        if (av !== bv) return bv - av; // descending
      }
      return 0;
    });

    const chosen = scored[0].ent;
    const chosenRaw = scored[0].rawName;
    const ecoCode = chosen.eco;
    const openingPath = buildOpeningPathFromRaw(chosenRaw, tokens[0] || null);
    const out = {
      opening_path: openingPath,
      opening: { eco: ecoCode, name: openingPath[0] || null },
      book_moves: chosen._moves_norm || [],
      matched_fen: canon,
      plies_analyzed: ply,
      max_plies: max_plies,
    };
    if (debug) {
      out.debug = out.debug || {};
      out.debug.fen_per_ply = fenPerPly;
      out.debug.scored_top_key = scored[0].key;
      out.debug.candidates_count_at_ply = scored.length;
      if (bestOut && bestOut.debug_candidates_by_ply) out.debug.debug_candidates_by_ply = bestOut.debug_candidates_by_ply;
    }
    return out;
  }

  // No FEN-based match found
  if (requireFenOnly) {
    const out = { opening_path: [], opening: null, book_moves: [], matched_fen: null, plies_analyzed: pliesDone, max_plies: max_plies, error: 'no_fen_match' };
    if (debug) out.debug = { fen_per_ply: fenPerPly };
    return out;
  }

  const seq = analyzeBySequence(pgnText, max_plies);
  seq.matched_fen = null;
  if (debug) seq.debug = { fen_per_ply: fenPerPly };

  // ---------- London detection heuristic (applied on fallback sequence result) ----------
  function detectLondonFromTokens(tokensList, lookaheadPlies = 16) {
    const bf4Re = /^([Bb].{0,2}f4|Bf4)\b/i; // sloppy
    const c4Re = /^(c4|cxd4|cxd5)\b/i;
    const e3Re = /^e3\b/i;
    const c3Re = /^c3\b/i;
    const details = { found_bf4_ply: null, had_c4_before: false, had_e3_before: false, had_c3_before: false };
    const maxIndex = Math.min(tokensList.length, lookaheadPlies);
    for (let i = 0; i < maxIndex; i++) {
      const tok = tokensList[i];
      if (i % 2 === 0) {
        if (bf4Re.test(tok)) {
          details.found_bf4_ply = i + 1;
          for (let j = 0; j < i; j++) {
            if (j % 2 === 0) {
              if (c4Re.test(tokensList[j])) details.had_c4_before = true;
              if (e3Re.test(tokensList[j])) details.had_e3_before = true;
              if (c3Re.test(tokensList[j])) details.had_c3_before = true;
            }
          }
          break;
        }
      }
    }
    let isLondon = false;
    if (details.found_bf4_ply !== null && !details.had_c4_before) {
      if (details.had_e3_before || details.had_c3_before) isLondon = true;
      else if (details.found_bf4_ply <= 6) isLondon = true;
    }
    return { is_london: isLondon, details };
  }

  const londonCheck = detectLondonFromTokens(tokens, 16);
  if (londonCheck.is_london) {
    const londonCandidates = [];
    for (const e of OPENINGS) {
      const nm = ((e.name || e.opening || '') + '').toLowerCase();
      if (nm.includes('london')) {
        for (const f of fenPerPly) {
          if (e._fen_to_ply && e._fen_to_ply[f.fen] != null) londonCandidates.push([e, f.ply]);
        }
      }
    }
    if (londonCandidates.length > 0) {
      londonCandidates.sort((a, b) => (a[1] || 9999) - (b[1] || 9999));
      const chosen = londonCandidates[0][0];
      const matchedPly = londonCandidates[0][1];
      const rawName = ((chosen.name || chosen.opening || chosen._key) || '').toString().trim();
      const openingPath = buildOpeningPathFromRaw(rawName, tokens[0] || null);
      const out = { opening_path: openingPath, opening: { eco: chosen.eco, name: openingPath[0] || null }, book_moves: chosen._moves_norm || [], matched_fen: chosen._fen || null, plies_analyzed: matchedPly || pliesDone, max_plies: max_plies };
      if (debug) out.debug = { fen_per_ply: fenPerPly, london_details: londonCheck.details };
      return out;
    }

    // otherwise synthesize London on top of fallback seq result
    const synthPath = ['London System'];
    if (seq.opening_path) {
      for (const p of seq.opening_path) if (!synthPath.includes(p)) synthPath.push(p);
    }
    seq.opening_path = synthPath;
    seq.opening = { eco: (seq.opening && seq.opening.eco), name: synthPath[0] };
    seq.matched_fen = null;
    if (debug) seq.debug = { fen_per_ply: fenPerPly, london_details: londonCheck.details };
    return seq;
  }

  return seq;
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

  app.use(cors());          // allow all origins (dev). Replace with options to restrict if you want.
app.options('*', cors()); // respond to preflight

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/debug_openings', (req, res) => {
    const sample = [];
    let count = 0;
    for (const [fen, arr] of Array.from(FEN_TO_ENTRIES.entries()).slice(0, 12)) {
      const entry = arr[0].ent;
      sample.push({ fen, name: entry.name, eco: entry.eco, _key: entry._key });
      count++;
    }
    res.json({ count: OPENINGS.length, fen_index_size: FEN_TO_ENTRIES.size, sample });
  });

  app.post('/analyze', async (req, res) => {
    const data = req.body || {};
    const pgn = data.pgn;
    const maxPlies = parseInt(data.max_plies || DEFAULT_MAX_PLIES, 10);
    const callback = data.callback_url || data.callback || DEFAULT_CALLBACK_URL;
    const requireFenOnly = !!data.require_fen_only;
    const debug = !!data.debug;

    if (!pgn || typeof pgn !== 'string' || !pgn.trim()) return res.status(400).json({ error: 'No PGN provided (send JSON: {"pgn":"1. e4 e5 ..."})' });

    try {
      const out = analyzeByFen(pgn.trim(), maxPlies, requireFenOnly, debug);
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
// Poll loop
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
        const out = analyzeByFen(pgn, max_plies);
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

// -------------------------
// Main entry
// -------------------------
async function main(argv) {
  const args = require('minimist')(argv || process.argv.slice(2), { boolean: ['serve', 'poll'], string: ['pgn-file'] });

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
      const require_fen_only = !!inputData.require_fen_only;
      const debug = !!inputData.debug;
      if (!pgn) { logError("INPUT provided but no 'pgn' field"); process.exit(1); }
      const out = analyzeByFen(pgn, max_plies, require_fen_only, debug);
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
    const _sig = require('signals') || null; // optional
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
      const out = analyzeByFen(pgnText, max_plies, !!args['require-fen-only'], !!args.debug);
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
    const out = analyzeByFen(stdin, max_plies, !!args['require-fen-only'], !!args.debug);
    console.log(JSON.stringify(out, null, 2));
  } catch (exc) {
    logError('Error parsing/analyzing PGN:', exc && exc.message);
    process.exit(1);
  }
}

if (require.main === module) main();

// End of file
