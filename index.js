// HLS reverse proxy — versi utuh, end-to-end.
//
// Fungsi:
//   GET /iptv.m3u                 daftar channel dalam format M3U (untuk OTT Navigator / VLC)
//   GET /hls?u=<base64url>        proxy playlist & segmen
//   GET /health                   status
//
// Cara kerja: playlist diambil dari upstream, semua URI di dalamnya (varian,
// segmen, key, init segment) ditulis ulang supaya lewat proxy ini. Segmen
// diteruskan apa adanya (byte-per-byte, Range didukung). Jadi klien cukup
// bicara ke satu host, upstream tidak pernah dihubungi langsung.
//
// Sumber diatur lewat env SOURCES, format: "nama|url,nama|url".
// Tanpa SOURCES, dipakai satu contoh HLS publik supaya bisa langsung dites.
const http = require('node:http');

const UA = process.env.UPSTREAM_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_SOURCES = [
  { name: 'Demo Mux', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'Demo BipBop', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8' },
];

const SOURCES = (process.env.SOURCES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [name, url] = s.split('|');
    return { name: name.trim(), url: (url || '').trim() };
  })
  .filter((s) => s.url)
  .map((s, i) => ({ id: 'ch' + (i + 1), ...s }));

const LIST = SOURCES.length ? SOURCES : DEFAULT_SOURCES.map((s, i) => ({ id: 'ch' + (i + 1), ...s }));

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

// Cache kecil untuk playlist: upstream tidak perlu dipanggil tiap 3 detik.
const plCache = new Map(); // url -> { at, body, type }
const PL_TTL_MS = parseInt(process.env.PLAYLIST_TTL_MS || '2000', 10);

function baseUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname.replace(/[^/]*$/, '');
  } catch {
    return u;
  }
}

// Tulis ulang semua URI di dalam playlist supaya lewat proxy.
function rewritePlaylist(body, upstreamUrl, selfOrigin) {
  const proxyFor = (abs) => `${selfOrigin}/hls?u=${b64(abs)}`;
  const base = baseUrl(upstreamUrl);
  const out = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { out.push(''); continue; }

    if (line.startsWith('#')) {
      // URI="..." bisa muncul di EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF
      out.push(line.replace(/URI="([^"]+)"/g, (_m, uri) => {
        let abs;
        try { abs = new URL(uri, upstreamUrl).toString(); } catch { abs = uri; }
        return `URI="${proxyFor(abs)}"`;
      }));
      continue;
    }

    // baris URI biasa (varian atau segmen)
    let abs;
    try { abs = new URL(line, upstreamUrl).toString(); } catch { abs = base + line; }
    out.push(proxyFor(abs));
  }
  return out.join('\n');
}

async function fetchUpstream(target, extraHeaders = {}) {
  const headers = { 'User-Agent': UA, 'Accept': '*/*', ...extraHeaders };
  const res = await fetch(target, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(parseInt(process.env.UPSTREAM_TIMEOUT_MS || '20000', 10)),
  });
  return res;
}

function isPlaylist(url, contentType) {
  return /\.m3u8?(\?|$)/i.test(url) || /mpegurl/i.test(contentType || '');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Railway (dan mayoritas platform) terminasi TLS di depan, jadi skema asli
  // harus dibaca dari x-forwarded-proto — kalau tidak, URL di M3U jadi http://.
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const origin = `${proto}://${req.headers.host || 'localhost'}`;

  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', ...extra });
    res.end(body);
  };

  if (url.pathname === '/health') {
    return send(200, 'application/json', JSON.stringify({ ok: true, sources: LIST.length, uptime: process.uptime() }));
  }

  // Daftar channel untuk IPTV player
  if (url.pathname === '/iptv.m3u') {
    const lines = ['#EXTM3U'];
    for (const ch of LIST) {
      lines.push(`#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" group-title="Proxy",${ch.name}`);
      lines.push(`${origin}/hls?u=${b64(ch.url)}`);
    }
    return send(200, 'audio/x-mpegurl', lines.join('\n') + '\n');
  }

  if (url.pathname === '/hls') {
    const target = url.searchParams.get('u');
    if (!target) return send(400, 'application/json', JSON.stringify({ error: 'parameter u wajib' }));

    let upstream;
    try { upstream = unb64(target); } catch { return send(400, 'application/json', JSON.stringify({ error: 'parameter u bukan base64url valid' })); }
    if (!/^https?:\/\//i.test(upstream)) return send(400, 'application/json', JSON.stringify({ error: 'u harus http(s)' }));

    try {
      // ---- playlist ----
      if (isPlaylist(upstream, '')) {
        const cached = plCache.get(upstream);
        if (cached && Date.now() - cached.at < PL_TTL_MS) {
          return send(200, 'application/vnd.apple.mpegurl', cached.body, { 'x-proxy-cache': 'HIT' });
        }
        const up = await fetchUpstream(upstream);
        const text = await up.text();
        if (!up.ok) {
          return send(up.status, 'text/plain', `upstream ${up.status}: ${text.slice(0, 200)}`);
        }
            const body = rewritePlaylist(text, upstream, origin);
        plCache.set(upstream, { at: Date.now(), body });
        if (plCache.size > 200) plCache.delete(plCache.keys().next().value);
        return send(200, 'application/vnd.apple.mpegurl', body, { 'x-proxy-cache': 'MISS' });
      }

      // ---- segmen / key / init (byte passthrough, Range didukung) ----
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      const up = await fetchUpstream(upstream, headers);

      const passthrough = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = up.headers.get(h);
        if (v) passthrough[h] = v;
      }
      passthrough['access-control-allow-origin'] = '*';
      passthrough['cache-control'] = 'public, max-age=60';

      res.writeHead(up.status, passthrough);
      if (!up.body) return res.end();
      for await (const chunk of up.body) res.write(chunk);
      return res.end();
    } catch (err) {
      return send(502, 'application/json', JSON.stringify({ error: 'upstream gagal', detail: String(err?.message || err), upstream }));
    }
  }

  if (url.pathname === '/inspect') {
    // Periksa satu URL m3u8 yang SUDAH kamu punya: sehat atau tidak, berapa
    // varian, ada enkripsi atau tidak, dan segmen pertamanya tembus atau 401.
    // Tidak mengambil URL dari mana pun — inputnya dari kamu.
    const raw = url.searchParams.get('u');
    if (!raw) return send(400, 'application/json', JSON.stringify({ error: 'parameter u wajib', contoh: '/inspect?u=https://host/master.m3u8' }));
    let target = raw;
    if (!/^https?:\/\//i.test(target)) {
      try { const d = unb64(raw); if (/^https?:\/\//i.test(d)) target = d; } catch { /* biarkan */ }
    }
    if (!/^https?:\/\//i.test(target)) return send(400, 'application/json', JSON.stringify({ error: 'u harus URL http(s)' }));

    const report = { input: target, checkedAt: new Date().toISOString() };
    try {
      const up = await fetchUpstream(target);
      const ct = up.headers.get('content-type') || '';
      const buf = Buffer.from(await up.arrayBuffer());
      const head = buf.subarray(0, 1).toString();
      report.httpStatus = up.status;
      report.contentType = ct;
      report.bytes = buf.length;

      if (head === '<') {
        report.kind = 'html';
        report.verdict = 'BUKAN_PLAYLIST';
        report.note = 'Yang dibalas halaman HTML (mis. halaman web atau error CDN), bukan m3u8.';
        return send(200, 'application/json', JSON.stringify(report, null, 2));
      }

      if (!buf.subarray(0, 7).toString().startsWith('#EXTM3U')) {
        report.kind = 'binary';
        report.verdict = buf[0] === 0x47 ? 'SEGMEN_TS' : 'BUKAN_PLAYLIST';
        report.note = 'Isinya media, bukan playlist. Pakai URL master/media m3u8.';
        return send(200, 'application/json', JSON.stringify(report, null, 2));
      }

      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const variants = lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF')).map((l) => {
        const bw = /BANDWIDTH=(\d+)/.exec(l)?.[1];
        const res = /RESOLUTION=([0-9x]+)/.exec(l)?.[1];
        const name = /NAME="([^"]+)"/.exec(l)?.[1];
        return { bandwidth: bw ? Number(bw) : null, resolution: res || null, name: name || null };
      });
      const segs = lines.filter((l) => l && !l.startsWith('#'));
      const keyLines = lines.filter((l) => l.startsWith('#EXT-X-KEY'));
      report.kind = variants.length ? 'master' : 'media';
      report.variants = variants.length;
      report.variantList = variants;
      report.encryption = keyLines.length ? keyLines.map((l) => /METHOD=([A-Z0-9-]+)/.exec(l)?.[1] || 'UNKNOWN') : 'none';
      report.targetDuration = Number(/TARGETDURATION:(\d+)/.exec(text)?.[1] || 0) || null;

      if (report.kind === 'media') {
        report.segmentsInPlaylist = segs.length;
        const first = segs[0];
        if (first) {
          let segUrl;
          try { segUrl = new URL(first, target).toString(); } catch { segUrl = first; }
          const sr = await fetchUpstream(segUrl, { Range: 'bytes=0-2047' });
          const sb = Buffer.from(await sr.arrayBuffer());
          report.firstSegment = {
            httpStatus: sr.status,
            contentType: sr.headers.get('content-type'),
            bytes: sb.length,
            tsSync: sb[0] === 0x47,
            wwwAuthenticate: sr.headers.get('www-authenticate') || null,
          };
          if ((sr.status === 200 || sr.status === 206) && sb[0] === 0x47) report.verdict = 'PLAYABLE';
          else if (sr.status === 401 || sr.status === 403) report.verdict = `SEGMEN_TERKUNCI_${sr.status}`;
          else report.verdict = `SEGMEN_HTTP_${sr.status}`;
        } else {
          report.verdict = 'PLAYLIST_KOSONG';
        }
      } else {
        report.verdict = 'MASTER_OK_PILIH_VARIAN';
      }

      report.proxyLink = `${origin}/hls?u=${b64(target)}`;
      return send(200, 'application/json', JSON.stringify(report, null, 2));
    } catch (err) {
      report.verdict = 'ERROR';
      report.error = String(err?.message || err);
      return send(502, 'application/json', JSON.stringify(report, null, 2));
    }
  }

  return send(404, 'application/json', JSON.stringify({
    error: 'not found',
    routes: ['/iptv.m3u', '/hls?u=<base64url>', '/inspect?u=<url>', '/health'],
  }));
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`hls-proxy listening on ${port} | channels=${LIST.length}`);
  for (const ch of LIST) console.log(`  ${ch.id}  ${ch.name}  ${ch.url}`);
});
