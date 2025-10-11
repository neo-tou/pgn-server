#!/usr/bin/env node
/*
  eco_fen_bot.js - rewritten with "walk-up" hierarchical path and orderless matching,
  plus per-ply progressive opening summary.

  Usage / notes: same as original. New POST /analyze options:
    - orderless_matching: boolean (default false)
    - orderless_threshold: number between 0 and 1 (default 1.0)
    - prefer_set_matches: boolean (default false)

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

// Robust PGN moves tokenizer: strips tag-pair header lines and then extracts moves.
// This fixes PGNs without blank line after headers.
function tokenizePgnMoves(pgnText) {
  let text = pgnText || '';
  if (!text) return [];

  // Normalize line endings and split into lines
  const lines = text.replace(/\r/g, '').split('\n');

  // Remove tag-pair header lines like: [Event "Foo"] and blank lines at top
  const bodyLines = [];
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) continue; // skip tag-pair header
    bodyLines.push(line);
  }

  // Join remaining lines into a single moves string
  let movesPart = bodyLines.join(' ').trim();

  // Fallback: if nothing left and original contains a blank-line separator, keep old behaviour
  if (!movesPart && text.indexOf('\n\n') !== -1) {
    movesPart = text.split('\n\n')[1] || '';
  }

  movesPart = movesPart.replace(/\s+/g, ' ').trim();
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
    // skip variations (... )
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
  const fen = chessInstance.fen();
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

function canonicalizeFenString(fen) {
  if (!fen || typeof fen !== 'string') return null;
  fen = fen.trim();
  try {
    const c = new Chess(fen);
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
// New helpers for orderless matching and "which moves led to entry"
// -------------------------
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
    arr.push(i + 1); // 1-based token index
    lookup.set(t, arr);
  }
  for (const tok of entTokens) {
    const indices = lookup.get(tok) || [];
    out.push({ token: tok, indices });
  }
  return out;
}

function movesForPly(fenPerPly, ply) {
  if (!Array.isArray(fenPerPly) || fenPerPly.length === 0) return [];
  if (!ply || ply < 1) return [];
  const rec = fenPerPly[ply - 1];
  if (!rec) return [];
  return rec.played_tokens ? rec.played_tokens.slice() : [];
}

// ---------- helper: best entry selection for a canonical FEN ----------
function bestEntryForFen(canon, playedTokensAtPly, fullPlayedTokens, options = {}) {
  // options: { preferSetMatch: boolean, setThreshold: 1.0 }
  const candRefs = FEN_TO_ENTRIES.get(canon) || [];
  if (!candRefs || candRefs.length === 0) return null;
  const playedLen = (playedTokensAtPly && playedTokensAtPly.length) || 0;
  const scored = [];

  for (const ref of candRefs) {
    const ent = ref.ent;
    const entPly = ref.ply;
    const rawName = ((ent.name || ent.opening || ent._key) || '').toString().trim();
    const entMovesNorm = ent._moves_norm || '';
    const entTokens = movesTokensFromNorm(entMovesNorm);

    // prefix check vs played tokens at this ply
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

    // orderless/set-match metric
    const setThreshold = (options && typeof options.setThreshold === 'number') ? options.setThreshold : 1.0;
    const setMatched = entryMatchesBySetFraction(entTokens, fullPlayedTokens || [], setThreshold) ? 1 : 0;

    // build scoring key; if preferSetMatch, weight setMatched higher
    let key;
    if (options && options.preferSetMatch) {
      key = [setMatched, samePly, reachesCanon, commonLen, entryFullyMatchedByPlay, -movesLen, spec];
    } else {
      key = [samePly, reachesCanon, commonLen, entryFullyMatchedByPlay, -movesLen, spec, setMatched];
    }

    scored.push({ key, ent, entPly, rawName, entTokens, setMatched });
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

  return { ent: scored[0].ent, key: scored[0].key, rawName: scored[0].rawName, entPly: scored[0].entPly, entTokens: scored[0].entTokens, setMatched: scored[0].setMatched };
}

// -------------------------
// Sequence fallback helper (for per-ply sequence-only matching)
// -------------------------
function bestSequenceMatchForTokens(seqTokens) {
  // seqTokens: array like ['e4'] or ['e4','e5','Nf3', ...]
  if (!Array.isArray(seqTokens) || seqTokens.length === 0) return null;

  const candidates = [];
  for (const ent of OPENINGS) {
    if (!ent._moves_norm) continue;
    const entTokens = movesTokensFromNorm(ent._moves_norm || '');
    if (!entTokens || entTokens.length === 0) continue;
    // check whether seqTokens is a prefix of entTokens
    if (entTokens.length < seqTokens.length) continue;
    let ok = true;
    for (let i = 0; i < seqTokens.length; i++) {
      if (entTokens[i] !== seqTokens[i]) { ok = false; break; }
    }
    if (ok) candidates.push(ent);
  }

  if (candidates.length === 0) return null;

  // pick best raw as in analyzeBySequence (specificity + count)
  const rawCounts = new Map();
  const rawToEntries = new Map();
  for (const ent of candidates) {
    const raw = (ent.name || ent.opening || ent._key || '').toString().trim();
    rawCounts.set(raw, (rawCounts.get(raw) || 0) + 1);
    const arr = rawToEntries.get(raw) || [];
    arr.push(ent);
    rawToEntries.set(raw, arr);
  }
  function rawKey(r) {
    return [specificityScore(r), rawCounts.get(r) || 0];
  }
  let bestRaw = null;
  for (const r of rawCounts.keys()) {
    if (!bestRaw) bestRaw = r;
    else {
      const a = rawKey(bestRaw), b = rawKey(r);
      if (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1])) bestRaw = r;
    }
  }
  const exampleEnt = (rawToEntries.get(bestRaw) || [candidates[0]])[0];
  return exampleEnt || null;
}

// -------------------------
// Sequence fallback analyzer (original)
// -------------------------
function analyzeBySequence(pgnText, maxPlies) {
  const max_plies = (typeof maxPlies === 'number') ? maxPlies : DEFAULT_MAX_PLIES;
  const tokens = tokenizePgnMoves(pgnText);
  if (!tokens || tokens.length === 0) return { error: 'No moves parsed from PGN', opening_path: [], book_moves: [], plies_analyzed: 0 };
  let candidates = OPENINGS.filter(o => typeof o._moves_norm === 'string' && o._moves_norm);
  const seqTokens = [];
  let lastCandidatesSnapshot = candidates.slice();
  let pliesDone = 0;
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
// FEN-based analyzer with walk-up, per_level, orderless matching, and per-ply summary
// -------------------------
function analyzeByFen(pgnText, maxPlies, requireFenOnly = false, debug = false, opts = {}) {
  // opts: { orderless_matching: bool, orderless_threshold: number, prefer_set_matches: bool }
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

  // fallback early if no FENs parsed (tokenizer or malformed PGN)
  if (fenPerPly.length === 0) {
    if (requireFenOnly) {
      const out = { opening_path: [], opening: null, book_moves: [], matched_fen: null, plies_analyzed: 0, max_plies: max_plies, error: 'no_fens_parsed' };
      if (debug) out.debug = { fen_per_ply: fenPerPly };
      return out;
    } else {
      // return sequence fallback (full-game)
      const seq = analyzeBySequence(pgnText, max_plies);
      seq.matched_fen = null;
      if (debug) seq.debug = { fen_per_ply: fenPerPly, note: 'no_fens_parsed' };
      return seq;
    }
  }

  function commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return n;
  }

  // prepare whole-game tokens array for orderless set checks
  const wholeGameTokens = fenPerPly.map(r => r.san).filter(Boolean);

  // Build per-ply summary (progressive mapping)
  const per_ply = [];
  const ply_progression = []; // human-readable strings

  for (let i = 0; i < fenPerPly.length; i++) {
    const rec = fenPerPly[i];
    const ply = rec.ply;
    const seqTokensAtPly = rec.played_tokens || [];
    const seqStr = buildSequenceString(seqTokensAtPly);
    let chosenName = null;
    let chosenEco = null;
    let chosenPath = [];
    let chosen_raw = null;

    // Try FEN-based exact or best match first
    const bestByFen = bestEntryForFen(rec.fen, seqTokensAtPly, wholeGameTokens, {
      preferSetMatch: !!opts.prefer_set_matches,
      setThreshold: (typeof opts.orderless_threshold === 'number') ? opts.orderless_threshold : 1.0
    });

    if (bestByFen && bestByFen.ent) {
      chosen_raw = bestByFen.rawName;
      chosenEco = bestByFen.ent.eco || null;
      chosenPath = buildOpeningPathFromRaw(chosen_raw, tokens[0] || null);
      chosenName = chosenPath[0] || (bestByFen.ent.name || bestByFen.ent.opening || bestByFen.ent._key);
    } else {
      // Fallback to sequence-only matching for this ply
      const seqMatchEnt = bestSequenceMatchForTokens(seqTokensAtPly);
      if (seqMatchEnt) {
        chosen_raw = (seqMatchEnt.name || seqMatchEnt.opening || seqMatchEnt._key || '').toString().trim();
        chosenEco = seqMatchEnt.eco || null;
        chosenPath = buildOpeningPathFromRaw(chosen_raw, tokens[0] || null);
        chosenName = chosenPath[0] || seqMatchEnt.name || seqMatchEnt.opening || seqMatchEnt._key;
      } else {
        // Last resort: use POPULAR_FIRST_MOVES for single first ply white move
        if (seqTokensAtPly.length === 1) {
          const first = (seqTokensAtPly[0] || '').toLowerCase();
          const list = POPULAR_FIRST_MOVES[first];
          if (list && list.length) {
            chosenName = list[0];
            chosenPath = [chosenName];
          }
        }
      }
    }

    per_ply.push({
      ply,
      sequence: seqStr,
      sequence_tokens: seqTokensAtPly.slice(),
      opening: chosenName,
      eco: chosenEco,
      opening_path: chosenPath,
      matched_fen: rec.fen
    });

    // human-readable
    const human = `${seqStr} → ${chosenName || 'unknown'}` + (chosenEco ? ` (${chosenEco})` : '');
    ply_progression.push(human);
  }

  // search from deepest ply -> shallowest for the primary "matched opening" using your walk-up logic
  let bestOut = null;
  for (let ri = fenPerPly.length - 1; ri >= 0; ri--) {
    const record = fenPerPly[ri];
    const ply = record.ply;
    const canon = record.fen;
    const playedTokensAtPly = record.played_tokens;
    const playedLen = playedTokensAtPly.length;

    const candRefs = FEN_TO_ENTRIES.get(canon) || [];
    if (!candRefs || candRefs.length === 0) continue;

    const entryChoice = bestEntryForFen(canon, playedTokensAtPly, wholeGameTokens, {
      preferSetMatch: !!opts.prefer_set_matches,
      setThreshold: (typeof opts.orderless_threshold === 'number') ? opts.orderless_threshold : 1.0
    });

    if (!entryChoice || !entryChoice.ent) continue;

    const chosen = entryChoice.ent;
    const chosenRaw = entryChoice.rawName;
    const ecoCode = chosen.eco;
    const matchedPly = entryChoice.entPly || ply;

    // Build hierarchical opening info by walking up from matchedPly -> 1 and picking best match at each ply
    const pathList = [];
    const seen = new Set();
    const per_level = [];

    for (let p = matchedPly; p >= 1; p--) {
      const rec = fenPerPly[p - 1];
      if (!rec || !rec.fen) continue;
      const canonAtPly = rec.fen;
      const tokensAtPly = rec.played_tokens || [];
      const best = bestEntryForFen(canonAtPly, tokensAtPly, wholeGameTokens, {
        preferSetMatch: !!opts.prefer_set_matches,
        setThreshold: (typeof opts.orderless_threshold === 'number') ? opts.orderless_threshold : 1.0
      });

      const level = { ply: p, fen: canonAtPly, chosen: null, chosen_raw: null, eco: null, moves_leading: tokensAtPly.slice(), matched_by_set: false, matched_tokens: [], matched_tokens_positions: [] };

      if (best && best.ent) {
        const ent = best.ent;
        const entTokens = best.entTokens || movesTokensFromNorm(ent._moves_norm || '');
        level.chosen = { _key: ent._key, name: ent.name || ent.opening || ent._key, eco: ent.eco || null };
        level.chosen_raw = best.rawName;
        level.eco = ent.eco || null;

        // which moves (ordered) led to this match
        level.moves_leading = movesForPly(fenPerPly, p);

        // orderless matching metadata vs whole game
        const containsAll = entryMatchesBySetFraction(entTokens, wholeGameTokens, (typeof opts.orderless_threshold === 'number' ? opts.orderless_threshold : 1.0));
        level.matched_by_set = containsAll;
        level.matched_tokens = entTokens.slice(0, Math.min(entTokens.length, 64));
        level.matched_tokens_positions = findMatchedTokensPositions(entTokens, wholeGameTokens);

        if (best.rawName && !seen.has(best.rawName)) { pathList.push(best.rawName); seen.add(best.rawName); }
      } else {
        const altRefs = FEN_TO_ENTRIES.get(canonAtPly) || [];
        if (altRefs.length > 0) {
          const alt = altRefs[0].ent;
          const altName = ((alt.name || alt.opening || alt._key) || '').toString().trim();
          level.chosen = { _key: alt._key, name: alt.name || alt.opening || alt._key, eco: alt.eco || null };
          level.chosen_raw = altName;
          level.eco = alt.eco || null;
          level.moves_leading = movesForPly(fenPerPly, p);
          if (altName && !seen.has(altName)) { pathList.push(altName); seen.add(altName); }
        }
      }

      per_level.push(level);
    }

    // Flatten the collected raw names into a human-friendly opening_path using your existing function
    let openingPath;
    if (pathList.length > 0) {
      const flat = [];
      for (const raw of pathList) {
        const frag = buildOpeningPathFromRaw(raw, tokens[0] || null);
        for (const pName of frag) if (!flat.includes(pName)) flat.push(pName);
      }
      openingPath = flat;
    } else {
      openingPath = buildOpeningPathFromRaw(chosenRaw, tokens[0] || null);
    }

    const out = {
      opening_path: openingPath,
      opening: { eco: ecoCode, name: openingPath[0] || null },
      book_moves: chosen._moves_norm || chosen.moves || [],
      matched_fen: canon,
      plies_analyzed: matchedPly,
      max_plies: max_plies,
      per_level: per_level,
      per_ply: per_ply,
      ply_progression: ply_progression
    };

    if (debug) {
      out.debug = out.debug || {};
      out.debug.fen_per_ply = fenPerPly;
      out.debug.chosen_key = entryChoice.key;
    }
    return out;
  }

  // No FEN-based top-level match found: fallback to sequence analyzer but keep per-ply progression
  if (requireFenOnly) {
    const out = { opening_path: [], opening: null, book_moves: [], matched_fen: null, plies_analyzed: pliesDone, max_plies: max_plies, error: 'no_fen_match', per_ply: per_ply, ply_progression: ply_progression };
    if (debug) out.debug = { fen_per_ply: fenPerPly };
    return out;
  }

  const seq = analyzeBySequence(pgnText, max_plies);
  seq.matched_fen = null;
  seq.per_ply = per_ply;
  seq.ply_progression = ply_progression;
  if (debug) seq.debug = { fen_per_ply: fenPerPly };
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
    const requireFenOnly = !!data.require_fen_only;
    const debug = !!data.debug;

    // new options
    const orderless_matching = !!data.orderless_matching;
    const orderless_threshold = (typeof data.orderless_threshold === 'number') ? Math.max(0, Math.min(1, data.orderless_threshold)) : 1.0;
    const prefer_set_matches = !!data.prefer_set_matches;

    if (!pgn || typeof pgn !== 'string' || !pgn.trim()) return res.status(400).json({ error: 'No PGN provided (send JSON: {"pgn":"1. e4 e5 ..."})' });

    try {
      const out = analyzeByFen(pgn.trim(), maxPlies, requireFenOnly, debug, { orderless_matching, orderless_threshold, prefer_set_matches });
      // annotate with options used
      out._options = { orderless_matching, orderless_threshold, prefer_set_matches };
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
      const orderless_matching = !!inputData.orderless_matching;
      const orderless_threshold = (typeof inputData.orderless_threshold === 'number') ? Math.max(0, Math.min(1, inputData.orderless_threshold)) : 1.0;
      const prefer_set_matches = !!inputData.prefer_set_matches;
      if (!pgn) { logError("INPUT provided but no 'pgn' field"); process.exit(1); }
      const out = analyzeByFen(pgn, max_plies, require_fen_only, debug, { orderless_matching, orderless_threshold, prefer_set_matches });
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
