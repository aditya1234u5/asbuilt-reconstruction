/* GPX import — pure string parsing, no DOM, so it runs in the browser and in
 * Node tests alike. Reads tracks (<trk>/<trkseg>/<trkpt>) and routes
 * (<rte>/<rtept>); waypoints are ignored. Phone and handheld GPS loggers all
 * export this format. */

const attr = (tag, name) => {
  const m = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
};
const inner = (body, name) => {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(body);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
};

function parsePoints(block, tag) {
  const pts = [];
  const re = new RegExp('<' + tag + '\\b([^>]*?)(/>|>([\\s\\S]*?)</' + tag + '>)', 'gi');
  let m;
  while ((m = re.exec(block))) {
    const lat = parseFloat(attr(m[1], 'lat')), lon = parseFloat(attr(m[1], 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const body = m[3] || '';
    const ele = parseFloat(inner(body, 'ele'));
    pts.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, time: inner(body, 'time') });
  }
  return pts;
}

/** @returns {{ tracks: Array<{name:string, kind:'track'|'route', points:Array<{lat,lon,ele,time}>}> }}
 *  Segments of one track are joined in order. */
export function parseGPX(text) {
  if (!/<gpx[\s>]/i.test(text)) throw new Error('This does not look like a GPX file.');
  const tracks = [];
  // Closing tags are optional on purpose: a logger that crashes or loses power
  // leaves a truncated file, and the points recorded so far are still good.
  const END = (name) => `(?:<\\/${name}>|(?=<${name}\\b)|(?![\\s\\S]))`;
  const trkRe = new RegExp(`<trk\\b[^>]*>([\\s\\S]*?)${END('trk')}`, 'gi');
  let m, n = 0;
  while ((m = trkRe.exec(text))) {
    n++;
    const points = [];
    const segRe = new RegExp(`<trkseg\\b[^>]*>([\\s\\S]*?)${END('trkseg')}`, 'gi');
    let sm;
    while ((sm = segRe.exec(m[1]))) points.push(...parsePoints(sm[1], 'trkpt'));
    if (points.length) tracks.push({ name: inner(m[1].replace(/<trkseg[\s\S]*?<\/trkseg>/gi, ''), 'name') || `Track ${n}`, kind: 'track', points });
  }
  const rteRe = new RegExp(`<rte\\b[^>]*>([\\s\\S]*?)${END('rte')}`, 'gi');
  n = 0;
  while ((m = rteRe.exec(text))) {
    n++;
    const points = parsePoints(m[1], 'rtept');
    if (points.length) tracks.push({ name: inner(m[1].replace(/<rtept[\s\S]*?<\/rtept>/gi, ''), 'name') || `Route ${n}`, kind: 'route', points });
  }
  return { tracks };
}

/** [[lon, lat], ...] for projectLine(), dropping consecutive repeats (a logger
 *  that sits still writes the same fix many times). */
export function trackCoordinates(track) {
  const out = [];
  for (const p of track.points) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p.lon || prev[1] !== p.lat) out.push([p.lon, p.lat]);
  }
  return out;
}
