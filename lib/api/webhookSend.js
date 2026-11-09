/**
 * One webhook delivery over https, safe against being pointed at Flizy's own
 * network (SSRF).
 *
 * A platform chooses the URL, so the URL is not trusted:
 * - https only, port 443, no user or password in it;
 * - the host is resolved first, and every address it resolves to must be a
 *   public one: loopback, private, link-local, carrier-grade NAT, multicast,
 *   documentation and reserved ranges are refused, IPv4 and IPv6, including
 *   IPv4 written inside IPv6;
 * - the connection goes to the address that was checked (the request's
 *   lookup is pinned to it), so a second DNS answer cannot swap in another,
 *   while TLS still verifies the certificate against the host name;
 * - no redirect is followed, the whole request is cut off after 10 seconds,
 *   and at most 64 KB of the answer is read.
 *
 * Returns { ok, status, error }; never throws. A 2xx answer is delivered.
 */

const dns = require('dns').promises;
const https = require('https');
const net = require('net');

const TIMEOUT_MS = 10 * 1000;
const MAX_BYTES = 64 * 1024;
const URL_MAX = 2000;

/** Every range a webhook may never reach. */
const BLOCKED = new net.BlockList();
for (const [n, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED.addSubnet(n, p, 'ipv4');
}
for (const [n, p] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  BLOCKED.addSubnet(n, p, 'ipv6');
}

/** True only for an address a webhook may reach. */
function isPublicAddress(address) {
  const ip = String(address || '');
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, 'ipv4');
  if (family === 6) {
    // IPv4 written inside IPv6 (::ffff:10.0.0.1) is judged as the IPv4 it is.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return !BLOCKED.check(mapped[1], 'ipv4');
    if (/^::ffff:/i.test(ip)) return false;
    return !BLOCKED.check(ip, 'ipv6');
  }
  return false;
}

/** The URL, if a webhook may be sent to it; otherwise the reason it may not. */
function checkWebhookUrl(raw) {
  const s = String(raw || '');
  if (!s || s.length > URL_MAX) return { ok: false, error: 'url is empty or too long' };
  let url;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, error: 'url is not valid' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'url must be https' };
  if (url.username || url.password) return { ok: false, error: 'url must not carry a user or password' };
  if (url.port && url.port !== '443') return { ok: false, error: 'url must use port 443' };
  if (!url.hostname) return { ok: false, error: 'url has no host' };
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && !isPublicAddress(literal)) return { ok: false, error: 'url points at a private address' };
  return { ok: true, url, host: literal };
}

/** One public address for the host, or the reason there is none. Every answer must be public. */
async function resolvePublic(host, lookup = dns.lookup) {
  if (net.isIP(host)) return isPublicAddress(host) ? { ok: true, address: host, family: net.isIP(host) } : { ok: false, error: 'private address' };
  let answers;
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: 'host did not resolve' };
  }
  if (!Array.isArray(answers) || answers.length === 0) return { ok: false, error: 'host did not resolve' };
  if (answers.some((a) => !isPublicAddress(a.address))) return { ok: false, error: 'host resolves to a private address' };
  return { ok: true, address: answers[0].address, family: answers[0].family };
}

/**
 * POST body to url with headers. `request` and `resolve` exist for tests
 * only; production always uses https.request and resolvePublic, the public
 * address rule above.
 */
async function sendWebhook({ url, body, headers = {}, request = https.request, resolve = resolvePublic, timeoutMs = TIMEOUT_MS, tls = {} }) {
  const checked = checkWebhookUrl(url);
  if (!checked.ok) return { ok: false, status: null, error: checked.error };
  const target = await resolve(checked.host);
  if (!target.ok) return { ok: false, status: null, error: target.error };
  const address = target.address;

  return new Promise((finish) => {
    let settled = false;
    const done = (out) => {
      if (settled) return;
      settled = true;
      finish(out);
    };
    const req = request(
      {
        // Test-only TLS options (a test CA) come first, so they can never
        // replace the host, port or pinned lookup below.
        ...tls,
        protocol: 'https:',
        hostname: checked.url.hostname,
        port: 443,
        path: `${checked.url.pathname}${checked.url.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'Flizy-Webhooks/1',
        },
        // Pinned: the connection can only go to the address checked above.
        lookup: (_host, opts, cb) => {
          const family = net.isIP(address);
          if (opts && opts.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        },
      },
      (res) => {
        let read = 0;
        res.on('data', (chunk) => {
          read += chunk.length;
          if (read > MAX_BYTES) res.destroy();
        });
        const answered = () => {
          const status = res.statusCode || null;
          done(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: `http ${status}` });
        };
        res.on('end', answered);
        res.on('close', answered);
        res.on('error', answered);
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error('timeout'));
      done({ ok: false, status: null, error: 'timeout' });
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, status: null, error: String(err && err.message ? err.message : err).slice(0, 120) });
    });
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}

module.exports = { sendWebhook, checkWebhookUrl, isPublicAddress, resolvePublic };
