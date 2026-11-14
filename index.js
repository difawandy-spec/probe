// Feed monitor — observasi murni terhadap API publik.
//
// Yang dicatat: match mana yang sedang dalam jendela tayang, stream apa saja
// yang tersedia (nama feed, id, siteType), host CDN yang dipakai, dan status
// HTTP playlist + segmen pertamanya.
//
// Yang TIDAK dilakukan: tidak membuat token /token-AES(rb-session), tidak
// memalsukan Referer ACL, tidak menyimpan URL yang bisa dipakai memutar.
// Segmen yang terkunci akan tercatat sebagai 401/403 — itu justru datanya.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- konfigurasi
const API = process.env.SB_API || 'https://apis-data10.tcpwe138stya.ru';
const LANGS = 34;
const DIGIT = process.env.SB_DIGIT || 'trd';
// format: "leagueId:seasonId,leagueId:seasonId"
const LEAGUES = (process.env.WATCH_LEAGUES || '5072:24773')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [leagueId, seasonId] = s.split(':');
    return { leagueId, seasonId };
  });
const INTERVAL_SEC = parseInt(process.env.INTERVAL_SEC || '300', 10);
const WINDOW_MIN = parseInt(process.env.WINDOW_MIN || '180', 10); // +- menit dari kickoff
// matchId spesifik yang mau dipantau terus, tanpa perlu tahu leagueId/seasonId
const WATCH_MATCHES = (process.env.WATCH_MATCHES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || ''; // isi kalau mount Railway volume
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ------------------------------------------------------------------ protobuf
function varint(b, i) {
  let r = 0, s = 0;
  while (true) {
    const x = b[i++];
    // Aritmetika biasa, bukan bitwise: 1794651300000 > 2^31 dan akan jadi negatif kalau pakai |=
    r += (x & 0x7f) * 2 ** s;
    s += 7;
    if (!(x & 0x80)) return [r, i];
  }
}

function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let k;
    [k, i] = varint(b, i);
    const f = k >> 3, wt = k & 7;
    if (wt === 0) {
      let v;
      [v, i] = varint(b, i);
      out.push([f, 0, v]);
    } else if (wt === 2) {
      let ln;
      [ln, i] = varint(b, i);
      out.push([f, 2, b.subarray(i, i + ln)]);
      i += ln;
    } else if (wt === 5) {
      out.push([f, 5, null]);
      i += 4;
    } else if (wt === 1) {
      out.push([f, 1, null]);
      i += 8;
    } else break;
  }
  return out;
}

// ---------------------------------------------------------------- http helper
async function req(url, { referer } = {}) {
  const headers = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'id-ID,id;q=0.9' };
  if (referer) headers.Referer = referer;
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body: buf };
  } catch (err) {
    return { status: 0, headers: new Headers(), body: Buffer.alloc(0), error: String(err?.message || err) };
  }
}

const api = (p, q) => req(`${API}${p}?${new URLSearchParams(q)}`, { referer: 'https://example.invalid/' });

// ---------------------------------------------------------------- dekode URL
// API mengirim URL dalam ROT47 + salt 8 karakter di depan. Kita hanya memakai
// ini untuk membaca HOST-nya (buat statistik CDN), bukan untuk memutar.
function rot47(s) {
  let out = '';
  for (const ch of s) {
    const o = ch.charCodeAt(0);
    out += o >= 33 && o <= 126 ? String.fromCharCode(33 + ((o - 33 + 47) % 94)) : ch;
  }
  return out;
}

function decodeStreamField(s) {
  const raw = rot47(s);
  const url = raw.slice(8);
  if (!/^https?:\/\//.test(url)) return null;
  try {
    const u = new URL(url);
    return { host: u.host, scheme: u.protocol.replace(':', ''), path: u.pathname };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- sampling
const samples = [];           // riwayat mentah
const latest = new Map();     // key -> sampel terakhir
const MAX_SAMPLES = 5000;

function pushSample(s) {
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.shift();
  latest.set(`${s.matchId}:${s.streamId}`, s);
  if (DATA_DIR) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(path.join(DATA_DIR, 'samples.jsonl'), JSON.stringify(s) + '\n');
    } catch (e) {
      console.error('append gagal', e.message);
    }
  }
}

async function listMatches({ leagueId, seasonId }) {
  const r = await api('/api/league/match/list', {
    leagueId, seasonId, language: LANGS, sportType: 1, usls: 'rbp',
  });
  if (r.status !== 200 || r.body[0] === 0x3c) return [];
  const matches = [];
  for (const [f, wt, v] of fields(r.body)) {
    if (f !== 10 || wt !== 2) continue;
    for (const [f2, wt2, sub] of fields(v)) {
      if (f2 !== 1 || wt2 !== 2) continue;
      const d = {};
      for (const [k, w, val] of fields(sub)) if (w === 0) d[k] = val;
      if (d[1]) matches.push({ matchId: d[1], matchDate: d[3], status: d[4] });
    }
  }
  return matches;
}

async function streamsOf(matchId) {
  const r = await api('/api/match/detail', {
    matchId, sportType: 1, language: LANGS, usls: 'rbp', digit: DIGIT,
  });
  if (r.status !== 200 || r.body[0] === 0x3c) return [];
  const out = [];
  for (const [f, wt, v] of fields(r.body)) {
    if (f !== 10 || wt !== 2) continue;
    for (const [f2, wt2, sub] of fields(v)) {
      if (f2 !== 2 || wt2 !== 2) continue;
      const s = {};
      for (const [k, w, val] of fields(sub)) {
        if (w === 0) s[k] = val;
        else if (w === 2 && k === 3) s.name = val.toString('utf8');
      }
      out.push({ streamId: s[1], name: s.name, siteType: s[9], fam: s[8], matchId });
    }
  }
  return out;
}

async function probeStream(st) {
  const r = await api('/api/stream/detail', {
    streamId: st.streamId, siteType: st.siteType, matchId: st.matchId,
    sportType: 1, language: LANGS, usls: 'rbp', digit: DIGIT,
  });
  const base = {
    ts: new Date().toISOString(),
    matchId: st.matchId,
    streamId: st.streamId,
    name: st.name,
    siteType: st.siteType,
    apiStatus: r.status,
  };
  if (r.status !== 200) return { ...base, verdict: 'API_HTTP_' + r.status };

  let statusText = '', enc = null;
  for (const [f, wt, v] of fields(r.body)) {
    if (f === 3 && wt === 2) statusText = v.toString('utf8');
    if (f === 10 && wt === 2) {
      for (const [f2, wt2, sub] of fields(v)) {
        if (f2 !== 2 || wt2 !== 2) continue;
        for (const [k, w, val] of fields(sub)) if (k === 4 && w === 2) enc = val.toString('utf8');
      }
    }
  }
  if (!enc) return { ...base, verdict: 'NO_URL', apiMessage: statusText };

  const info = decodeStreamField(enc);
  if (!info) return { ...base, verdict: 'URL_DECODE_FAILED' };

  // Probe playlist (tanpa menyimpan URL lengkap, cuma host + status).
  const url = `http://${info.host}${info.path}`;
  const pl = await req(url, { referer: `http://${info.host}/` });
  const out = { ...base, cdnHost: info.host, playlistStatus: pl.status };

  if (pl.status === 200 && pl.body.subarray(0, 7).toString() === '#EXTM3U') {
    const lines = pl.body.toString('utf8').split('\n').map((l) => l.trim());
    out.segmentsInPlaylist = lines.filter((l) => l && !l.startsWith('#')).length;
    out.targetDuration = lines.find((l) => l.startsWith('#EXT-X-TARGETDURATION'))?.split(':')[1] || null;
    out.encrypted = lines.some((l) => l.startsWith('#EXT-X-KEY'));
    const seg = lines.find((l) => l && !l.startsWith('#'));
    if (seg) {
      const segUrl = new URL(seg, url).toString();
      const sr = await req(segUrl, { referer: url });
      out.segmentStatus = sr.status;
      out.segmentBytes = sr.body.length;
      out.segmentAuth = sr.headers.get('www-authenticate') || null;
      out.verdict = sr.status === 200 && sr.body[0] === 0x47 ? 'PLAYABLE_OPEN' : `SEGMENT_${sr.status}`;
    } else {
      out.verdict = 'PLAYLIST_EMPTY';
    }
  } else if (pl.status === 403) {
    out.verdict = 'CDN_REFERER_ACL';
  } else {
    out.verdict = 'PLAYLIST_' + pl.status;
  }
  return out;
}

async function cycle() {
  const started = Date.now();
  const now = Date.now();
  let checked = 0, streams = 0;

  // 1) matchId yang dipantau eksplisit
  for (const matchId of WATCH_MATCHES) {
    checked++;
    const list = await streamsOf(matchId);
    for (const st of list) {
      streams++;
      pushSample(await probeStream(st));
    }
    if (!list.length) {
      pushSample({ ts: new Date().toISOString(), matchId: Number(matchId), streamId: null, verdict: 'NO_STREAM_IN_MATCH' });
    }
  }

  // 2) penemuan otomatis dari daftar liga
  for (const lg of LEAGUES) {
    const matches = await listMatches(lg);
    const inWindow = matches.filter((m) => m.matchDate && Math.abs(now - m.matchDate) <= WINDOW_MIN * 60 * 1000);
    console.log(`league ${lg.leagueId}: total=${matches.length} inWindow=${inWindow.length}`);

    for (const m of inWindow) {
      checked++;
      const list = await streamsOf(m.matchId);
      for (const st of list) {
        streams++;
        pushSample(await probeStream(st));
      }
      if (!list.length) pushSample({ ts: new Date().toISOString(), matchId: m.matchId, streamId: null, verdict: 'NO_STREAM_IN_MATCH' });
    }
  }
  console.log(`cycle ${(Date.now() - started)}ms | matches=${checked} streams=${streams} samples=${samples.length}`);
}

// --------------------------------------------------------------------- server
const server = http.createServer(async (rq, rs) => {
  const u = new URL(rq.url, 'http://localhost');
  const json = (code, obj) => {
    rs.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    rs.end(JSON.stringify(obj, null, 2));
  };

  if (u.pathname === '/health') return json(200, { ok: true });

  // Cek satu pertandingan saat itu juga, tanpa perlu redeploy.
  // Contoh: /check?matchId=4524895
  if (u.pathname === '/check') {
    const matchId = u.searchParams.get('matchId');
    if (!matchId) return json(400, { error: 'matchId wajib', contoh: '/check?matchId=4524895' });
    try {
      const list = await streamsOf(matchId);
      if (!list.length) {
        return json(200, {
          matchId: Number(matchId), streams: 0,
          verdict: 'NO_STREAM_IN_MATCH',
          arti: 'Pertandingan ini tidak sedang disiarkan (atau belum masuk jendela tayang).',
        });
      }
      const rows = [];
      for (const st of list) rows.push(await probeStream(st));
      return json(200, { matchId: Number(matchId), streams: rows.length, rows });
    } catch (e) {
      return json(500, { error: String(e?.message || e) });
    }
  }

  if (u.pathname === '/') {
    const rows = [...latest.values()].sort((a, b) => (a.matchId - b.matchId) || String(a.streamId).localeCompare(String(b.streamId)));
    return json(200, {
      note: 'Observasi API publik. Segmen yang terkunci tercatat sebagai SEGMENT_401 / CDN_REFERER_ACL, bukan diputar.',
      config: { api: API, leagues: LEAGUES, intervalSec: INTERVAL_SEC, windowMin: WINDOW_MIN },
      samples: samples.length,
      latest: rows,
    });
  }

  if (u.pathname === '/history') {
    const matchId = u.searchParams.get('matchId');
    const rows = matchId ? samples.filter((s) => String(s.matchId) === matchId) : samples;
    return json(200, { count: rows.length, rows: rows.slice(-300) });
  }

  return json(404, { error: 'not found', routes: ['/', '/health', '/history?matchId=', '/check?matchId='] });
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`feed-monitor listening on ${process.env.PORT || 3000} | leagues=${JSON.stringify(LEAGUES)} interval=${INTERVAL_SEC}s`);
});

// jalan sekali di awal, lalu berkala
cycle().catch((e) => console.error('cycle error', e));
setInterval(() => cycle().catch((e) => console.error('cycle error', e)), INTERVAL_SEC * 1000);
