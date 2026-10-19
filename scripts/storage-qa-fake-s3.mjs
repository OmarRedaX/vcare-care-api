// DEV-ONLY, in-memory, path-style S3 STAND-IN for manual QA (scripts/curl-test-record-attachments.sh and
// scripts/curl-test-verification.sh). It is NOT real S3 and NOT MinIO: no signature verification, no encryption, no durability,
// no versioning, no lifecycle. It implements ONLY the calls lib/storage's S3 adapter makes (src/lib/storage/s3.adapter.ts), and
// validates the POST policy conditions the way S3 does, so the browser-style `curl -F` upload is a faithful rehearsal of the contract.
//
//   POST /<bucket>            multipart/form-data presigned POST: policy decoded; expiration, `eq`, `starts-with` and
//                             `content-length-range` conditions enforced; exact key from the policy; 204 on success
//   HEAD /<bucket>/<key>      Content-Length + ETag (md5), 404 when absent
//                             anonymous GET/HEAD (no signature, no Authorization header) is refused: 403, like a private bucket
//   GET  /<bucket>/<key>      Range: bytes=a-b -> 206 (the adapter's 16-byte read); a presigned GET (X-Amz-Signature in the query) is
//                             checked for X-Amz-Date + X-Amz-Expires and honours response-content-disposition / response-content-type
//   PUT  /<bucket>/<key>      CopyObject: x-amz-copy-source (URL-encoded bucket/key) and x-amz-copy-source-if-match (ETag, else 412);
//                             x-amz-metadata-directive REPLACE + Content-Type stored
//   DELETE /<bucket>/<key>    204 whether or not the key existed (S3 behaviour)
// QA control surface (loopback only; never prints keys to the log):
//   GET /__objects?prefix=p   JSON [{ key, size }] ; GET /__count?prefix=p  -> plain number
//   GET /__calls  number of object-API requests so far (proves a read path never touches storage)
//   GET /__reset              drop every object and fault ; GET /__fail?op=head|range|copy|delete&n=1  fail the next n calls with 500
//   GET /__clock?offsetSeconds=n   shift the clock used for presigned-URL / policy expiry (so expiry can be proven without waiting)
import http from 'node:http';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';

if (process.env.NODE_ENV === 'production') throw new Error('QA fake S3 refuses production');
const port = Number(process.env.FAKE_S3_PORT ?? 9013);
const bucket = process.env.STORAGE_BUCKET ?? 'care-qa-private';
const objects = new Map(); // key -> { body: Buffer, etag, contentType }
const failures = new Map(); // op -> remaining
let clockOffsetMs = 0;
let storageCalls = 0; // requests that reached the object API (not the /__ control surface)
const now = () => Date.now() + clockOffsetMs;

const xml = (res, status, code, message) => {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
};
const etagOf = (buf) => `"${createHash('md5').update(buf).digest('hex')}"`;
const collect = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
const failNow = (op) => { const n = failures.get(op) ?? 0; if (n > 0) { failures.set(op, n - 1); return true; } return false; };

function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    let start = pos + delim.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    start += 2; // CRLF after the boundary line
    const end = buf.indexOf(next, start);
    if (end === -1) break;
    const part = buf.subarray(start, end);
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) break;
    const headers = part.subarray(0, split).toString('utf8');
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    parts.push({ name, isFile: /filename=/i.test(headers), body: part.subarray(split + 4) });
    pos = end + 2;
  }
  return parts;
}

function checkPolicy(policy, fields, size) {
  if (Date.parse(policy.expiration) < now()) return 'Invalid according to Policy: Policy expired.';
  for (const cond of policy.conditions) {
    if (Array.isArray(cond)) {
      const [op, a, b] = cond;
      if (op === 'content-length-range') {
        if (size < a) return 'Your proposed upload is smaller than the minimum allowed size';
        if (size > b) return 'Your proposed upload exceeds the maximum allowed size';
        continue;
      }
      const field = String(a).replace(/^\$/, '').toLowerCase();
      const value = fields.get(field);
      if (op === 'eq' && value !== b) return `Invalid according to Policy: Policy Condition failed: ${field}`;
      if (op === 'starts-with' && !(value ?? '').startsWith(b)) return `Invalid according to Policy: Policy Condition failed: ${field}`;
    } else {
      for (const [k, v] of Object.entries(cond)) {
        if (fields.get(k.toLowerCase()) !== v && !(k === 'bucket' && v === bucket)) return `Invalid according to Policy: Policy Condition failed: ${k}`;
      }
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  try {
    if (url.pathname.startsWith('/__')) {
      if (url.pathname === '/__objects') {
        const p = url.searchParams.get('prefix') ?? '';
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify([...objects].filter(([k]) => k.startsWith(p)).map(([key, o]) => ({ key, size: o.body.length }))));
      }
      if (url.pathname === '/__count') {
        const p = url.searchParams.get('prefix') ?? '';
        res.writeHead(200, { 'content-type': 'text/plain' });
        return void res.end(String([...objects.keys()].filter((k) => k.startsWith(p)).length));
      }
      if (url.pathname === '/__calls') { res.writeHead(200, { 'content-type': 'text/plain' }); return void res.end(String(storageCalls)); }
      if (url.pathname === '/__reset') { objects.clear(); failures.clear(); clockOffsetMs = 0; storageCalls = 0; res.writeHead(200).end('ok'); return; }
      if (url.pathname === '/__fail') { failures.set(url.searchParams.get('op') ?? '', Number(url.searchParams.get('n') ?? 1)); res.writeHead(200).end('ok'); return; }
      if (url.pathname === '/__clock') { clockOffsetMs = Number(url.searchParams.get('offsetSeconds') ?? 0) * 1000; res.writeHead(200).end('ok'); return; }
      res.writeHead(404).end(); return;
    }
    storageCalls += 1;
    const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segs[0] !== bucket) return xml(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
    const key = segs.slice(1).join('/');

    // ---- presigned POST (browser upload) ----
    if (req.method === 'POST' && key === '') {
      const ctype = req.headers['content-type'] ?? '';
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
      if (!ctype.startsWith('multipart/form-data') || !boundary) return xml(res, 400, 'MalformedPOSTRequest', 'The body of your POST request is not well-formed multipart/form-data.');
      const parts = parseMultipart(await collect(req), boundary[1] ?? boundary[2]);
      const filePart = parts.find((p) => p.isFile);
      if (!filePart) return xml(res, 400, 'InvalidArgument', 'POST requires exactly one file upload per request.');
      const fields = new Map(parts.filter((p) => !p.isFile && p.name).map((p) => [p.name.toLowerCase(), p.body.toString('utf8')]));
      const rawPolicy = fields.get('policy');
      if (!rawPolicy) return xml(res, 403, 'AccessDenied', 'Access Denied: missing policy');
      let policy;
      try { policy = JSON.parse(Buffer.from(rawPolicy, 'base64').toString('utf8')); } catch { return xml(res, 400, 'InvalidPolicyDocument', 'Invalid Policy'); }
      const problem = checkPolicy(policy, fields, filePart.body.length);
      if (problem) {
        const code = problem.includes('exceeds') ? 'EntityTooLarge' : problem.includes('smaller') ? 'EntityTooSmall' : 'AccessDenied';
        return xml(res, code === 'AccessDenied' ? 403 : 400, code, problem);
      }
      const objectKey = fields.get('key');
      objects.set(objectKey, { body: Buffer.from(filePart.body), etag: etagOf(filePart.body), contentType: fields.get('content-type') ?? 'binary/octet-stream' });
      res.writeHead(204, { etag: objects.get(objectKey).etag });
      return void res.end();
    }

    // ---- CopyObject ----
    if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
      await collect(req);
      if (failNow('copy')) return xml(res, 500, 'InternalError', 'injected');
      const src = decodeURIComponent(String(req.headers['x-amz-copy-source'])).replace(/^\//, '');
      const slash = src.indexOf('/');
      const srcBucket = src.slice(0, slash); const srcKey = src.slice(slash + 1);
      const obj = srcBucket === bucket ? objects.get(srcKey) : undefined;
      if (!obj) return xml(res, 404, 'NoSuchKey', 'The specified key does not exist.');
      const ifMatch = req.headers['x-amz-copy-source-if-match'];
      if (ifMatch && ifMatch !== obj.etag) return xml(res, 412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
      const contentType = req.headers['x-amz-metadata-directive'] === 'REPLACE' ? String(req.headers['content-type'] ?? obj.contentType) : obj.contentType;
      objects.set(key, { body: Buffer.from(obj.body), etag: obj.etag, contentType });
      res.writeHead(200, { 'content-type': 'application/xml' });
      return void res.end(`<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>${obj.etag}</ETag><LastModified>${new Date(now()).toISOString()}</LastModified></CopyObjectResult>`);
    }

    if (req.method === 'DELETE') {
      if (failNow('delete')) return xml(res, 500, 'InternalError', 'injected');
      objects.delete(key);
      res.writeHead(204); return void res.end();
    }

    if (req.method === 'HEAD' || req.method === 'GET') {
      const isRange = Boolean(req.headers.range);
      if (failNow(req.method === 'HEAD' ? 'head' : isRange ? 'range' : 'get')) return xml(res, 500, 'InternalError', 'injected');
      const signed = url.searchParams.has('X-Amz-Signature');
      // a private bucket refuses anonymous reads (no signature in the query, no Authorization header): 403 like S3 / MinIO
      if (!signed && !req.headers.authorization) {
        if (req.method === 'HEAD') { res.writeHead(403); return void res.end(); }
        return xml(res, 403, 'AccessDenied', 'Access Denied');
      }
      if (signed) {
        const date = url.searchParams.get('X-Amz-Date') ?? '';
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
        const issued = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
        const ttl = Number(url.searchParams.get('X-Amz-Expires') ?? 0) * 1000;
        if (!m || now() > issued + ttl) return xml(res, 403, 'AccessDenied', 'Request has expired');
      }
      const obj = objects.get(key);
      if (!obj) {
        if (req.method === 'HEAD') { res.writeHead(404); return void res.end(); }
        return xml(res, 404, 'NoSuchKey', 'The specified key does not exist.');
      }
      const headers = { etag: obj.etag, 'content-type': url.searchParams.get('response-content-type') ?? obj.contentType, 'accept-ranges': 'bytes' };
      if (url.searchParams.get('response-content-disposition')) headers['content-disposition'] = url.searchParams.get('response-content-disposition');
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range) {
        const a = Number(range[1]); const b = Math.min(range[2] === '' ? obj.body.length - 1 : Number(range[2]), obj.body.length - 1);
        if (a >= obj.body.length) return xml(res, 416, 'InvalidRange', 'The requested range is not satisfiable');
        const slice = obj.body.subarray(a, b + 1);
        res.writeHead(206, { ...headers, 'content-length': slice.length, 'content-range': `bytes ${a}-${b}/${obj.body.length}` });
        return void res.end(req.method === 'HEAD' ? undefined : slice);
      }
      res.writeHead(200, { ...headers, 'content-length': obj.body.length });
      return void res.end(req.method === 'HEAD' ? undefined : obj.body);
    }
    res.writeHead(405).end();
  } catch (error) {
    // never print keys or bodies
    console.error(JSON.stringify({ level: 'error', message: 'fake_s3_internal', name: error?.name }));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ message: 'fake_s3_listening', port, bucket })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
