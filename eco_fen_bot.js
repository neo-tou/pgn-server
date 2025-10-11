#!/usr/bin/env node
// per_move_openings.js
// Usage: node per_move_openings.js '<PGN string here>'   (or edit the examplePGN variable)

const axios = require('axios');
const { Chess } = require('chess.js');

const LICHESS_EXPLORER = 'https://explorer.lichess.ovh/lichess'; // public explorer endpoint

async function queryLichessByFen(fen) {
  try {
    const url = `${LICHESS_EXPLORER}?fen=${encodeURIComponent(fen)}`;
    const resp = await axios.get(url, { timeout: 5000 });
    // Response shape: { opening: { eco, name, ply }, moves: [...] } (may be null)
    return resp.data || null;
  } catch (err) {
    // console.warn('Lichess query failed', err && err.message);
    return null;
  }
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
  return parts.join(' ');
}

async function perMoveOpeningsFromPgn(pgn, maxMoves = 10) {
  // maxMoves = number of full moves to report (i.e. 10 => up to 20 plies)
  const tokens = (function tokenize(pgnText) {
    // Basic tokenizer; assumes moves are after header. This matches what chess.js accepts for moves,
    // but we'll use chess.js to play moves from move SAN tokens extracted by a simple split of PGN moves.
    const body = pgnText.replace(/\r/g, ' ').split('\n').filter(l => !/^\s*\[.*\]\s*$/.test(l)).join(' ');
    const raw = body.replace(/\s+/g,' ').trim();
    if (!raw) return [];
    // remove result at end
    const cleaned = raw.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, '').trim();
    const toks = cleaned.split(/\s+/).map(t => t.replace(/^\d+\.{1,3}/,'')).filter(Boolean);
    return toks;
  })(pgn);

  if (!tokens || tokens.length === 0) {
    console.error('No moves found in PGN');
    return [];
  }

  const board = new Chess();
  const results = [];
  const seqTokens = [];

  const maxPlies = Math.min(tokens.length, maxMoves * 2);
  for (let i = 0; i < maxPlies; i++) {
    const san = tokens[i];
    // try to make move (sloppy allowed)
    let ok = false;
    try {
      const mv = board.move(san, { sloppy: true });
      if (mv) ok = true;
    } catch (e) { ok = false; }
    if (!ok) {
      // try UCI style fallback (e.g. e2e4)
      const uciMatch = san.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
      if (uciMatch) {
        const moveObj = { from: uciMatch[1].toLowerCase(), to: uciMatch[2].toLowerCase() };
        if (uciMatch[3]) moveObj.promotion = uciMatch[3].toLowerCase();
        try {
          const mv2 = board.move(moveObj);
          if (mv2) ok = true;
        } catch (e2) { ok = false; }
      }
    }
    if (!ok) break; // stop if move invalid

    seqTokens.push(san);
    const fen = board.fen(); // full FEN
    // lichess explorer expects FEN + move counter etc; it accepts normal FEN strings but often their endpoint
    // expects "piece placement side.castling enpassant halfmove fullmove". We'll pass the full FEN.
    // Many explorer endpoints accept just the FEN; if not, canonicalize with board.fen() as above.

    // Query lichess for this position
    // Note: to reduce queries, you could skip queries for intermediate plies and only query for each full move
    const lich = await queryLichessByFen(fen);

    const seqStr = buildSequenceString(seqTokens);
    let openingName = null;
    let eco = null;

    if (lich && lich.opening && lich.opening.name) {
      openingName = lich.opening.name;
      eco = lich.opening.eco || null;
    } else {
      // no opening info from lichess: fall back to sensible generic label
      if (seqTokens.length === 1) {
        openingName = `${seqTokens[0]} (first move)`; // placeholder
      } else {
        openingName = null;
      }
    }

    results.push({
      ply: seqTokens.length,
      sequence: seqStr,
      opening: openingName,
      eco
    });
  }

  return results;
}

// Example usage:
async function main() {
  const examplePGN = `1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Nxe4 5. d4 Nd6 6. Bxc6 dxc6 7. dxe5 Nf5 8. Qxd8+ Kxd8 9. Nc3 Ke8 10. Rd1 Be7`;
  const pgn = process.argv[2] || examplePGN;
  const res = await perMoveOpeningsFromPgn(pgn, 10);
  for (const r of res) {
    const ecoStr = r.eco ? ` (${r.eco})` : '';
    console.log(`${r.sequence} → ${r.opening || 'unknown'}${ecoStr}`);
  }
}

if (require.main === module) main();
