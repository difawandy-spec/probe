// Reachability probe: dipakai untuk mengukur apakah IP datacenter (Railway)
// masih bisa memanggil API + origin playlist. TIDAK ada token signer di sini.
// Semua endpoint yang dipanggil memang publik (tanpa auth).
import http from 'node:http';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TARGETS = [
  {
    label: 'egress-ip',
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    kind: 'text',
  },
  {
    label: 'api-match-count',
    url: 'https://apis-data10.tcpwe138stya.ru/api/match/count',
    kind: 'pb',
  },
  {
    label: 'api-match-detail',
    url: 'https://apis-data10.tcpwe138stya.ru/api/match/detail?matchId=4510687&sportType=1&language=34&usls=rbp&digit=trd',
    kind: 'pb',
  },
  {
    label: 'api-stream-detail',
    url: 'https://apis-data10.tcpwe138stya.ru/api/stream/detail?streamId=944719&siteType=2001&matchId=4510687&sportType=1&language=34&usls=rbp&digit=trd',
    kind: 'pb',
  },
  {
    label: 'playlist-head',
    url: 'http://play.10xstm2.top/hedy/sx_944719/index.m3u8',
    kind: 'text',
  },
  {
    // Ambil segmen .ts pertama dari playlist di atas. Ini penentu: kalau 401,
    // playlist saja tidak cukup untuk memutar apa pun.
    label: 'segment-head',
    url: 'http://play.10xstm2.top/hedy/sx_944719/index.m3u8',
    kind: 'segment',
  },
];

// Ambil string ASCII yang kelihatan dari body protobuf (status/error), tanpa decode penuh.
function asciiHints(buf) {
  const s = buf.toString('latin1');
  const hits = s.match(/[\x20-\x7e]{4,}/g) || [];
  return hits.slice(0, 4);
}

async function probe(t) {
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(20000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const first = buf.subarray(0, 1).toString();
    const out = {
      label: t.label,
      url: t.url,
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: buf.length,
      ms: Date.now() - started,
      verdict: '',
      hints: [],
    };

    if (t.kind === 'text' && t.label === 'egress-ip') {
      const m = buf.toString('utf8').match(/^ip=(.*)$/m);
      out.verdict = 'egress: ' + (m ? m[1].trim() : 'unknown');
      return out;
    }

    if (first === '<') {
      const html = buf.toString('utf8');
      out.verdict = /Just a moment|challenge-platform|cf-challenge/i.test(html)
        ? 'BLOCKED_BY_CLOUDFLARE_CHALLENGE'
        : 'HTML_RESPONSE_UNEXPECTED';
      out.hints = [html.match(/<title>(.*?)<\/title>/i)?.[1] || ''];
      return out;
    }

    if (t.label === 'playlist-head') {
      const txt = buf.toString('utf8');
      out.verdict = txt.startsWith('#EXTM3U') ? 'PLAYLIST_OK' : 'NOT_A_PLAYLIST';
      out.hints = txt.split('\n').slice(0, 4);
      return out;
    }

    if (t.kind === 'segment') {
      // res di sini adalah playlist; ambil segmen pertama lalu coba unduh.
      const txt = buf.toString('utf8');
      const seg = txt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (!seg) {
        out.verdict = 'PLAYLIST_EMPTY';
        return out;
      }
      const segUrl = new URL(seg, t.url).toString();
      const segRes = await fetch(segUrl, {
        headers: { 'User-Agent': UA, 'Referer': t.url, 'Accept': '*/*' },
        signal: AbortSignal.timeout(20000),
      });
      const segBuf = Buffer.from(await segRes.arrayBuffer());
      out.url = segUrl;
      out.status = segRes.status;
      out.contentType = segRes.headers.get('content-type');
      out.bytes = segBuf.length;
      out.hints = [
        'www-authenticate: ' + (segRes.headers.get('www-authenticate') || '-'),
        'first bytes: ' + segBuf.subarray(0, 8).toString('hex'),
      ];
      if (segRes.status === 200 && segBuf[0] === 0x47) out.verdict = 'SEGMENT_OK_TS_STREAM';
      else if (segRes.status === 200) out.verdict = 'SEGMENT_200_BUT_NOT_TS';
      else if (segRes.status === 401) out.verdict = 'SEGMENT_401_NEEDS_AUTH';
      else out.verdict = 'SEGMENT_HTTP_' + segRes.status;
      return out;
    }

    out.verdict = 'PROTOBUF_OK';
    out.hints = asciiHints(buf);
    return out;
  } catch (err) {
    return { label: t.label, url: t.url, status: 0, verdict: 'ERROR', error: String(err && err.message || err) };
  }
}

const server = http.createServer(async (req, res) => {
  const results = [];
  for (const t of TARGETS) results.push(await probe(t));

  const body = {
    checkedAt: new Date().toISOString(),
    note: 'PLAYLIST_OK cuma berarti m3u8-nya kebaca. Segmen .ts tetap 401 tanpa token — probe ini tidak menguji itu.',
    results,
  };
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`probe listening on ${port}`));
