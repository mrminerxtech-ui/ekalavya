// ============================================================
// WEB UI TUNNEL — proxies a browser's HTTP request through the
// farm agent's WebSocket connection to a miner's local web UI,
// which is only reachable on the farm's local network.
//
// Flow: browser → this route → agent (via WebSocket) → miner's
// local IP → response flows back the same path in reverse.
//
// SECURITY: this route is reached via a plain browser navigation
// (window.open), which cannot carry an Authorization header. The
// frontend instead appends the user's JWT as a ?token= query param,
// verified here. A customer account is further restricted to only
// the specific miner(s) assigned to their account (worker.cid) —
// without this check, any logged-in customer (or, before this fix,
// literally anyone with the URL) could reach every machine on every
// farm, not just their own.
// ============================================================
const hideTok = u => String(u || '').replace(/([?&]token=)[^&\s]+/gi, '$1[hidden]');
const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const agentMgr = require('../services/agentManager');
const db       = require('../services/db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

// ── Ownership memo ──────────────────────────────────────────
// A single miner page pulls dozens of sub-resources (JS, CSS, icons,
// cgi polls), and the customer ownership check below reads the whole
// worker list. Re-reading it per resource makes the tunnel crawl, so a
// granted result is remembered briefly.
//
// ONLY grants are cached, never denials: caching a denial would mean
// that after an operator assigns the machine, the customer keeps
// seeing "not assigned to your account" with no obvious cause.
const OWNERSHIP_TTL_MS = 15 * 1000;
const ownershipMemo = new Map(); // "user|farm|ip" -> expiry timestamp

function memoKey(userId, farmId, ip) { return `${userId}|${farmId}|${ip}`; }

function ownershipAllowedRecently(userId, farmId, ip) {
  const until = ownershipMemo.get(memoKey(userId, farmId, ip));
  if (!until) return false;
  if (until < Date.now()) { ownershipMemo.delete(memoKey(userId, farmId, ip)); return false; }
  return true;
}

function rememberOwnershipAllowed(userId, farmId, ip) {
  ownershipMemo.set(memoKey(userId, farmId, ip), Date.now() + OWNERSHIP_TTL_MS);
  // Keep the map from growing without bound on a long-lived process.
  if (ownershipMemo.size > 500) {
    const now = Date.now();
    for (const [k, v] of ownershipMemo) if (v < now) ownershipMemo.delete(k);
  }
}

// Minimal cookie parser — avoids adding the cookie-parser dependency
// just for this one route.
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

// Matches every method and every sub-path under /api/webui/:farmId/:ip/...
// Using router.use() with a fixed prefix (not a wildcard route pattern)
// — this is the reliable, version-safe way to capture "everything after
// this point" in Express 4's path matcher. The earlier /*? wildcard
// pattern is unreliable across path-to-regexp versions and may simply
// never match at all, which looks identical to "route doesn't exist".
// Does this path segment actually name a miner?
const IP_SEGMENT = /^\d{1,3}(?:\.\d{1,3}){3}$/;

router.use('/:farmId/:ip', async (req, res) => {
  let { farmId, ip } = req.params;

  // helmet's default Referrer-Policy is "no-referrer", which stops the
  // browser sending a Referer on ANY request from a tunnelled page — and
  // the parent-relative recovery below depends entirely on the Referer to
  // work out which miner a "../i18n/strings.properties" request belongs
  // to. Without it every such request failed with a 400, the language
  // files never loaded, and the dashboard showed [rate], [network],
  // [pool] instead of real labels. "same-origin" sends the Referer only
  // back to this server, never to any other site.
  res.set('Referrer-Policy', 'same-origin');

  // ── Recover from a parent-relative path that climbed too far ──
  //
  // Miner firmware requests some files with a parent-relative path —
  // the L11's language dictionary asks for "../i18n/strings.properties".
  // On the miner itself that climbs from /dashboard/ back to its root
  // and lands on /i18n/. Through this tunnel the page sits one level
  // shallower, so ".." climbs past the miner altogether and swallows
  // the IP segment: the browser asks for
  //   /api/webui/Farm 3/i18n/strings.properties
  // and this route reads "i18n" as the miner's address. The agent then
  // tries to resolve a host called "i18n" and fails with ENOTFOUND —
  // which surfaced as a 502 on exactly the files the dashboard needs
  // to turn [rate] and [network] into their real names.
  //
  // The Referer still carries the page's true address, so the real
  // miner is recovered from it and the swallowed segment is put back
  // on the front of the path where it belongs.
  let climbedPrefix = '';
  if (!IP_SEGMENT.test(ip)) {
    const ref = req.headers.referer || req.headers.referrer || '';
    const m = String(ref).match(/\/api\/webui\/([^/?#]+)\/(\d{1,3}(?:\.\d{1,3}){3})(?:[/?#]|$)/);
    if (!m) {
      console.warn(`[WEBUI] ✗ 400 cannot resolve miner from segment "${ip}" — no usable Referer (${hideTok(req.url)})`);
      return res.status(400).send(tunnelErrorPage(
        `This page asked for "${ip}${req.url}" using a path that points outside the miner, and there was no Referer to recover the real address from.`));
    }
    // Express has already decoded req.params, but the Referer is raw,
    // so only that needs decoding — and a farm named something like
    // "50% Hydro" makes decodeURIComponent throw on malformed escapes,
    // which must not take the whole request down.
    const safeDecode = s => { try { return decodeURIComponent(s); } catch(e) { return s; } };
    const realFarm = safeDecode(m[1]);
    const realIp   = m[2];

    // One level of climbing eats the IP segment. Two levels eat the
    // farm segment as well, so whichever of the two segments isn't
    // really ours is a folder name that has to go back on the path,
    // in the order it appeared.
    climbedPrefix = '/' + ip;
    if (safeDecode(farmId) !== realFarm) climbedPrefix = '/' + farmId + climbedPrefix;

    farmId = realFarm;
    ip     = realIp;
    console.log(`[WEBUI] ↺ recovered parent-relative request → farm=${farmId} ip=${ip} path=${hideTok(climbedPrefix + req.url)}`);
  }

  // ── Safety net: a tunnel path nested inside a tunnel path ──
  // If a page still carries an older copy of the shim (browser cache), or
  // some other script builds a URL the same broken way, the request
  // arrives as /api/webui/F/ip/api/webui/F/ip/js/x.js. Forwarding that
  // to the miner as-is is a guaranteed 404, so the repeated prefix is
  // dropped here — but only when it names this same miner, so a request
  // can never be quietly re-routed to a different machine.
  {
    const nested = /^\/api\/webui\/([^/?#]+)\/(\d{1,3}(?:\.\d{1,3}){3})(?=[/?#]|$)/;
    let m;
    while ((m = req.url.match(nested)) && m[2] === ip) {
      req.url = req.url.slice(m[0].length) || '/';
    }
  }

  const proxyBase = `/api/webui/${farmId}/${ip}`;

  // ── Auth check ────────────────────────────────────────────
  // The FIRST request (from window.open) carries the token as a
  // query param, since a plain browser navigation can't send a
  // custom header. We verify it once here, then set a short-lived
  // cookie so every subsequent request within the miner's own page
  // (link clicks, its own fetch/XHR calls) carries auth automatically,
  // with no need to rewrite every possible URL pattern.
  //
  // The cookie uses ONE fixed name and path (/api/webui/) shared
  // across every tunnel, rather than one derived from this specific
  // farmId/ip — a farm name containing a space (e.g. "Farm 3") gets
  // URL-encoded differently in the browser's actual request path
  // than in a raw JS string, so a cookie path built from it silently
  // never matches the real outgoing request, and every follow-up
  // resource (JS, CSS, images) fails as unauthenticated even though
  // the person is genuinely logged in. The cookie doesn't need to be
  // tunnel-specific anyway — it only identifies WHO is asking, and
  // authorization for WHICH machine is re-checked fresh below on
  // every single request regardless.
  const cookies    = parseCookies(req.headers.cookie);
  const cookieName = 'ekl_webui_auth';
  const token      = req.query.token || cookies[cookieName];

  let user;
  if (!token) return res.status(401).send(tunnelErrorPage('Not logged in — please open this from inside the app.'));
  try { user = jwt.verify(token, JWT_SECRET); }
  catch(e) { return res.status(401).send(tunnelErrorPage('Your session has expired — please log in again.')); }

  // ── Customer accounts: restrict to only their own assigned machine ──
  //
  // This deliberately checks EVERY worker record at this farm+ip, not
  // just the first match. Machines move between sites and run on DHCP,
  // so more than one record can transiently carry the same farm+ip —
  // and if a stale unassigned record happened to sit earlier in the
  // list, a single-match lookup rejected the customer's own machine.
  //
  // Ids are compared as strings: a customer id that came back from
  // Postgres as a number and from the JWT as a string is the same
  // customer, but !== says otherwise.
  if (user.role === 'customer' && !ownershipAllowedRecently(user.id, farmId, ip)) {
    const all = await db.loadWorkers();
    const sameMachine = all.filter(w => w && w.farm_id === farmId && w.ip === ip);
    // Both ids must actually exist before they're compared. Without the
    // emptiness guard, String(undefined) === String(undefined) is true,
    // so a token missing an id would match every UNASSIGNED machine.
    const hasId = v => v !== null && v !== undefined && String(v).trim() !== '';
    const owned = hasId(user.id)
      ? sameMachine.filter(w => hasId(w.cid) && String(w.cid) === String(user.id))
      : [];

    if (owned.length === 0) {
      // Say precisely why in the log — "not assigned" covers three very
      // different faults and guessing between them wastes a site visit.
      if (sameMachine.length === 0) {
        console.log(`[WEBUI] ✗ DENIED user=${user.id}: no worker record at farm="${farmId}" ip=${ip}. ` +
          `Closest by ip: ${JSON.stringify(all.filter(w => w && w.ip === ip).map(w => ({ farm: w.farm_id, cid: w.cid })))}`);
        return res.status(403).send(tunnelErrorPage(
          'This machine is no longer at the recorded address — ask your operator to rescan the site.'));
      }
      console.log(`[WEBUI] ✗ DENIED user=${user.id} (${typeof user.id}) at farm="${farmId}" ip=${ip}: ` +
        `${sameMachine.length} record(s) here, owned by ` +
        JSON.stringify(sameMachine.map(w => ({ id: w.id, cid: w.cid, cidType: typeof w.cid }))));
      return res.status(403).send(tunnelErrorPage('This machine is not assigned to your account.'));
    }

    if (sameMachine.length > 1) {
      console.warn(`[WEBUI] ⚠ ${sameMachine.length} worker records share farm="${farmId}" ip=${ip} ` +
        `(ids: ${sameMachine.map(w => w.id).join(', ')}) — duplicates need merging.`);
    }

    rememberOwnershipAllowed(user.id, farmId, ip);
  }

  // Re-issue the cookie on every verified request — cheap, and keeps
  // the session alive for as long as the tab stays open and active.
  res.cookie(cookieName, token, { path: '/api/webui/', maxAge: 30 * 60 * 1000, httpOnly: true, sameSite: 'lax' });

  // Once mounted this way, req.url is already everything AFTER
  // /:farmId/:ip — exactly the sub-path + querystring to forward
  // climbedPrefix restores the folder that a parent-relative path had
  // turned into the miner-address segment, so the miner is asked for
  // "/i18n/strings.properties" rather than "/strings.properties".
  //
  // When the climb swallowed BOTH segments and the file name was the last
  // part of the address (Goldshell's "../../img/load.gif" arrives as
  // /api/webui/img/load.gif), nothing is left after the two segments and
  // Express reports the remainder as "/" — which used to be tacked on,
  // asking the miner for "/img/load.gif/" (a 404). The "/" is only kept
  // when the address the browser actually asked for ended in one.
  let rest = req.url;
  if (climbedPrefix && (rest === '/' || rest.startsWith('/?'))) {
    const askedPath = String(req.originalUrl || '').split('?')[0];
    if (!askedPath.endsWith('/')) rest = rest.slice(1);
  }
  const minerPath = climbedPrefix + rest;
  // One miner page is dozens of these. Log the page itself (worth
  // knowing who opened which miner) and keep the rest behind
  // LOG_VERBOSE — failures are logged separately either way.
  const isPageLoad = minerPath === '/' || /\.(html?|cgi)$/i.test(minerPath.split('?')[0]) === false;
  if (process.env.LOG_VERBOSE === '1' || isPageLoad) {
    console.log(`[WEBUI] ${req.method} ${hideTok(minerPath)} → farm=${farmId} ip=${ip} user=${user.id}(${user.role})`);
  }

  const agent = agentMgr.getAgent(farmId);
  if (!agent) {
    console.warn(`[WEBUI] ✗ 502 ${hideTok(req.url)}  — agent "${farmId}" was not connected at this moment`);
    return res.status(502).send(tunnelErrorPage(`Farm agent "${farmId}" is not connected right now.`));
  }

  // Files that never change while a miner runs (scripts, styles, pictures,
  // fonts, language files) are answered from memory when this miner was
  // asked for them in the last hour — no trip to the farm and back.
  const staticKey = (req.method === 'GET' && !req.headers.range) ? staticCacheKey(farmId, ip, minerPath) : null;
  if (staticKey) {
    const hit = staticCacheGet(staticKey);
    if (hit) {
      res.status(200);
      res.set('Content-Type', hit.contentType);
      res.set('Cache-Control', STATIC_BROWSER_CACHE);
      res.set('X-Tunnel-Cache', 'hit');
      return res.send(hit.body);
    }
  }

  // Body — only forward for methods that carry one. Must re-serialize
  // back into whatever format it originally came in as (Express already
  // parsed it into an object) — a miner's login form expects urlencoded
  // "user=root&pass=root", NOT the JSON stringification of that object.
  let bodyToSend = null, bodyEncoding = null;
  const reqContentType = req.headers['content-type'] || '';
  // Anything that isn't JSON or a form (Braiins OS's gRPC-web calls are
  // binary protobuf, application/grpc-web+proto) is left unread by the
  // body parsers, so it was never forwarded and the miner got an empty
  // request. It's read here as raw bytes and passed through untouched.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req._body && typeof req.on === 'function') {
    const raw = await new Promise(resolve => {
      const chunks = []; let n = 0;
      req.on('data', c => { n += c.length; if (n <= 10 * 1024 * 1024) chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(Buffer.alloc(0)));
    });
    if (raw.length) { bodyToSend = raw.toString('base64'); bodyEncoding = 'base64'; }
  }
  if (!bodyToSend && ['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
    if (reqContentType.includes('application/json')) {
      bodyToSend = JSON.stringify(req.body);
    } else if (reqContentType.includes('urlencoded') || !reqContentType) {
      bodyToSend = new URLSearchParams(req.body).toString();
    } else {
      bodyToSend = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }
  }

  // The miner's OWN login session. Braiins OS logs in over /graphql and
  // keeps the session in a cookie (and some firmware sends its own
  // Authorization header instead). Only Content-Type used to be passed
  // on, so the miner accepted the password and then saw the very next
  // request arrive logged out — the login page just came back. Cookies
  // the miner set are now sent back to it (our own tunnel cookie is kept
  // out), and so is any Authorization header the miner's page adds. The
  // agent only falls back to its root/root login when there isn't one.
  const minerCookie = (req.headers.cookie || '').split(';')
    .map(c => c.trim()).filter(c => c && !c.startsWith(cookieName + '=')).join('; ');
  const fwdHeaders = { 'content-type': req.headers['content-type'] || '' };
  if (minerCookie) fwdHeaders.cookie = minerCookie;
  if (req.headers.authorization) fwdHeaders.authorization = req.headers.authorization;
  if (req.headers.accept) fwdHeaders.accept = req.headers.accept;
  // gRPC-web (Braiins OS) request metadata
  ['x-grpc-web', 'x-user-agent', 'grpc-timeout'].forEach(h => { if (req.headers[h]) fwdHeaders[h] = req.headers[h]; });

  try {
    const result = await agentMgr.sendWebuiRequest(
      farmId, ip, req.method, minerPath, fwdHeaders, bodyToSend, bodyEncoding ? { body_encoding: bodyEncoding } : undefined
    );

    // result: { status, headers, body, encoding }
    // Embedded miner web servers are notoriously inconsistent about
    // sending a correct Content-Type header — defaulting a missing one
    // straight to 'text/html' (as this used to do) meant an actual .js
    // file with no clear header silently got treated as HTML instead,
    // so JS-specific fixes below would never even run on it. Using the
    // requested path's own extension as a second signal catches this.
    const declaredType = (result.headers && result.headers['content-type']) || '';
    const pathOnly      = minerPath.split('?')[0].toLowerCase();
    const looksLikeJs   = pathOnly.endsWith('.js');
    // A gRPC-web call (Braiins OS) is binary protobuf whatever the reply's
    // label says — never rewritten as a page, script or stylesheet. (A reply
    // with no Content-Type used to be taken for HTML and "fixed up", which
    // destroys it.)
    const reqIsGrpc     = /^application\/grpc/i.test(reqContentType);
    const isJs          = !reqIsGrpc && (looksLikeJs || declaredType.includes('javascript'));
    const isCss         = !reqIsGrpc && !isJs && (pathOnly.endsWith('.css') || declaredType.includes('text/css'));
    const isHtml        = !reqIsGrpc && !isJs && !isCss && (declaredType.includes('text/html') || (!declaredType && (pathOnly === '/' || pathOnly.endsWith('/') || pathOnly.endsWith('.html'))));

    // Falling back to text/html for ANY file the miner didn't label was
    // actively harmful: helmet sends X-Content-Type-Options: nosniff, and
    // under nosniff a browser flatly refuses to execute a script or apply
    // a stylesheet served as text/html. A miner that omits Content-Type
    // on its language or script files therefore had them silently
    // rejected — the file arrives with status 200, and nothing runs.
    // Deriving the type from the file extension avoids mislabelling.
    const EXT_TYPES = {
      '.js': 'application/javascript', '.mjs': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json',
      '.html': 'text/html', '.htm': 'text/html',
      '.properties': 'text/plain', '.txt': 'text/plain', '.text': 'text/plain',
      '.xml': 'application/xml', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
      '.map': 'application/json',
    };
    const ext = (pathOnly.match(/\.[a-z0-9]+$/) || [''])[0];
    const contentType = (reqIsGrpc && !/grpc/i.test(declaredType)) ? reqContentType.split(';')[0]
      : declaredType
      || EXT_TYPES[ext]
      || (pathOnly === '/' || pathOnly.endsWith('/') ? 'text/html' : 'application/octet-stream');
    let bodyBuf = result.encoding === 'base64'
      ? Buffer.from(result.body || '', 'base64')
      : Buffer.from(result.body || '', 'utf8');
    if (reqIsGrpc && (result.status || 200) === 200) {
      bodyBuf = ensureGrpcWebTrailer(bodyBuf, /grpc-web-text/i.test(contentType), result.headers || {}, minerPath, ip);
    }

    // Make the miner's own links, forms, and scripts work by relying
    // on the browser's NATURAL relative-URL resolution, instead of
    // rewriting every path to a known proxy address. Since this page
    // is served from a URL that already ends in a "folder" for this
    // exact miner (/api/webui/farmId/ip/...), any RELATIVE path the
    // miner's own code uses (no leading slash) already resolves
    // correctly on its own — no rewriting needed at all.
    //
    // The only real problem is ABSOLUTE paths (starting with "/"),
    // which the browser always resolves against the site's root,
    // bypassing our folder entirely. The fix: strip the leading slash,
    // turning "/cgi-bin/foo.cgi" into "cgi-bin/foo.cgi" — now it's
    // relative, and falls into the same folder automatically. This is
    // simpler and more robust than our previous approach (prefixing
    // every path with a known proxy address, plus patching fetch/XHR
    // to do the same) — fewer moving parts, fewer ways to break on a
    // miner firmware we haven't seen yet.
    if (isHtml) {
      let html = bodyBuf.toString('utf8');

      // Safety net for JAVASCRIPT-constructed absolute paths (a script
      // calling fetch('/cgi-bin/foo.cgi') directly, not through an HTML
      // attribute) — same strip-the-slash idea, applied at request time
      // instead of by rewriting the HTML text, since we can't safely
      // rewrite arbitrary JS source without risking breaking it.
      //
      // Also catches a THIRD pattern found in the wild: some libraries
      // (e.g. the jquery.i18n.properties plugin used by some Antminer
      // firmware) load resources by directly creating an element and
      // assigning its .src, bypassing both fetch() and XMLHttpRequest
      // entirely — neither override above ever sees this happen. This
      // patches the property itself so ANY assignment gets fixed, no
      // matter which mechanism sets it.
      // This miner's folder inside the tunnel, e.g. /api/webui/Farm%203/19.3.19.155/
      const tunnelBase = '/api/webui/' + encodeURIComponent(farmId) + '/' + ip + '/';

      // ── Single-page apps (MaraFW and similar) ──────────────────
      // MaraFW's dashboard is a React app that picks which screen to show
      // by reading the address bar. Through the tunnel the address is
      // /api/webui/Farm 3/<ip>/, which matches none of its screens, so it
      // loaded every file correctly and then showed React Router's own
      // "Unexpected Application Error! 404 Not Found".
      //
      // For these pages the address bar is quietly changed to the path the
      // app expects (/, /configuration, …) BEFORE the app starts, and a
      // <base> tag keeps every relative file and API request pointed at
      // the tunnel. The real tunnel folder is kept in this tab's
      // sessionStorage so a reload (which would otherwise hit
      // /configuration on our own server) can find its way back to the
      // same miner — see reloadFallback below. sessionStorage is per tab,
      // so two miners open side by side never get mixed up.
      //
      // Detected by an ES-module <script>, which is how Vite-built apps
      // like MaraFW load (and see Braiins OS below). Stock Antminer and
      // Avalon pages match none of these, so they keep working as before.
      //
      // Braiins OS 26.x is also a single-page app that routes by the
      // address bar (React Router) but is built with webpack, so it has no
      // module script — through the tunnel it showed its own "We couldn't
      // find the page or file you're looking for", and "Go to Homepage"
      // then jumped to /login on our own domain. It's recognised by name,
      // or by the standard create-react-app <noscript> line.
      const isSpa = /<script[^>]+type=["']?module/i.test(html)
        || /braiins/i.test(html)
        || /You need to enable JavaScript to run this app/i.test(html);
      const spaShim = !isSpa ? '' :
        `<base href="${tunnelBase}">` +
        '<script>(function(){' +
        'var B=' + JSON.stringify(tunnelBase) + ';' +
        'try{sessionStorage.setItem("ekl_tunnel_base",B);}catch(e){}' +
        'var dp,dB;try{dp=decodeURIComponent(location.pathname);dB=decodeURIComponent(B);}catch(e){return;}' +
        'if(dp.indexOf(dB)!==0)return;' +
        // The login token only needs to reach the server once; it is
        // dropped from the address bar so it isn't left on screen.
        'var s=new URLSearchParams(location.search);s.delete("token");var q=s.toString();' +
        'history.replaceState(history.state,"",encodeURI("/"+dp.slice(dB.length))+(q?"?"+q:"")+location.hash);' +
        '})();</script>';

      const interceptShim = '<script>' +
        '(function(){' +
        'var B=' + JSON.stringify(tunnelBase) + ',IP=' + JSON.stringify(ip) + ';' +
        // Braiins OS+'s GraphQL client builds its endpoint as
        // `location.origin + "/graphql"` — a fully-qualified absolute
        // URL, not a bare "/graphql" string. That form skipped the
        // leading-slash check entirely and hit our own backend's root
        // ("Cannot POST /graphql" is literally Express's own 404 text,
        // not the miner's — the giveaway that the request never reached
        // the tunnel at all). Stripping window.location.origin off the
        // front first, when present, reduces this case to the same
        // leading-slash fix already handled below.
        //
        // A path that is ALREADY inside the tunnel ("/api/webui/...") is
        // correct as it stands and must be left alone. Antminer dashboards
        // load dashboard.html over XHR and insert it with jQuery .html();
        // jQuery then fetches each <script> in it using the script's fully
        // resolved URL — which already carries the tunnel prefix. Stripping
        // the origin and then the slash turned that into a RELATIVE path,
        // the browser resolved it against the current tunnel folder, and
        // the prefix appeared twice (/api/webui/F/ip/api/webui/F/ip/js/…),
        // so jquery, vue and dashboard.js all 404'd and the page showed raw
        // {{template}} tags.
        //
        // Full addresses are matched on HOST, not on the exact origin
        // string. MaraFW asks for its data at http://<host>/… — correct
        // when the page itself is http://<miner-ip>, but through the tunnel
        // the page is https, the old origin check (https only) let the
        // http address through untouched, and Chrome refused to send it
        // ("blocked: mixed content"), so every panel read "An error
        // occurred". A full address pointing straight at the miner's own
        // IP is brought into the tunnel the same way.
        'function fix(u){' +
        'if(typeof u!=="string")return u;' +
        'if(/^(https?:)?\\/\\//i.test(u)){' +
        'try{var x=new URL(u,window.location.href);' +
        'if(x.host===window.location.host||x.hostname===window.location.hostname||x.hostname===IP){u=x.pathname+x.search+x.hash;}' +
        'else return u;}catch(e){return u;}}' +
        'if(u.indexOf("/api/webui/")===0)return u;' +
        // A path from the miner's root ("/cgi-bin/x", "/api/v1/…") is
        // pointed at this miner's tunnel folder explicitly, rather than
        // made relative. Relative only worked while the page sat at the
        // folder's top level — it went wrong for a page in a subfolder,
        // and for single-page apps whose address bar now reads "/".
        'if(u.charAt(0)==="/"&&u.charAt(1)!=="/"){return B+u.slice(1);}return u;}' +
        // WebSockets. Goldshell's pool page opens
        // ws://<host>:443/mcb/resultpool; from an https page Chrome
        // refuses an insecure ws:// socket by THROWING, which crashed the
        // pool-settings code and left its sections as raw {{…}} text.
        // A socket aimed at this host or the miner is re-pointed at the
        // tunnel over the page's own scheme (wss:// on https), so creating
        // it no longer throws and the rest of the page renders. The socket
        // itself is relayed to the miner through the farm agent
        // (services/webuiSockets.js) — Braiins OS streams its whole
        // dashboard this way.
        'var OWS=window.WebSocket;' +
        'if(OWS){var WS=function(u,p){' +
        'try{var x=new URL(String(u),window.location.href);' +
        'if(/^wss?:$/.test(x.protocol)&&(x.hostname===window.location.hostname||x.hostname===IP)){' +
        'var pth=x.pathname.indexOf("/api/webui/")===0?x.pathname:B+x.pathname.replace(/^\\//,"");' +
        // a socket on another port of the miner (Goldshell uses :443) keeps
        // that port as a hint the backend passes on to the agent
        'var own=x.hostname===window.location.hostname&&x.port===window.location.port;' +
        'var sr=x.search;if(!own&&x.port&&x.port!=="80"&&x.pathname.indexOf("/api/webui/")!==0){sr=(sr?sr+"&":"?")+"__eklport="+x.port;}' +
        'u=(window.location.protocol==="https:"?"wss:":"ws:")+"//"+window.location.host+pth+sr;}}catch(e){}' +
        'return p===undefined?new OWS(u):new OWS(u,p);};' +
        'WS.prototype=OWS.prototype;WS.CONNECTING=0;WS.OPEN=1;WS.CLOSING=2;WS.CLOSED=3;' +
        'window.WebSocket=WS;}' +
        'var oF=window.fetch;' +
        'window.fetch=function(i,init){' +
        'if(typeof i==="string")i=fix(i);' +
        'else if(i&&i.url)i=new Request(fix(i.url),i);' +
        'return oF.call(this,i,init);};' +
        'var oO=XMLHttpRequest.prototype.open;' +
        'XMLHttpRequest.prototype.open=function(m,u){' +
        'arguments[1]=fix(u);' +
        'return oO.apply(this,arguments);};' +
        '["src","href"].forEach(function(p){' +
        '["HTMLScriptElement","HTMLImageElement","HTMLLinkElement"].forEach(function(t){' +
        'var C=window[t]; if(!C) return;' +
        'var proto=C.prototype;' +
        'var d=Object.getOwnPropertyDescriptor(proto,p)||Object.getOwnPropertyDescriptor(HTMLElement.prototype,p);' +
        'if(!d||!d.set) return;' +
        'Object.defineProperty(proto,p,{get:d.get,configurable:true,' +
        'set:function(v){ d.set.call(this, fix(v)); }});' +
        '});});' +
        'var oSA=Element.prototype.setAttribute;' +
        'Element.prototype.setAttribute=function(name,value){' +
        'if((name==="src"||name==="href")&&typeof value==="string") value=fix(value);' +
        'return oSA.call(this,name,value);};' +
        'function fixCss(s){' +
        'return s.replace(/([^a-zA-Z0-9_]|^)url\\((["\']?)\\/(?!\\/)/g, "$1url($2");' +
        '}' +
        'var oCTN=document.createTextNode.bind(document);' +
        'document.createTextNode=function(data){' +
        'if(typeof data==="string"&&data.indexOf("url(")!==-1) data=fixCss(data);' +
        'return oCTN(data);};' +
        '})();' +
        '</script>';

      // Miner firmware is built for a desktop monitor and declares no
      // viewport, so a phone renders it at desktop width and clips it —
      // which is why the dashboard appears cut off with panels running
      // off the side of the screen. Telling the phone to lay the page
      // out at a desktop width and then scale it to fit shows the whole
      // thing instead of a slice of it. Only added when the firmware
      // doesn't set its own viewport, so a miner UI that IS
      // mobile-aware keeps its own behaviour.
      const viewportTag = /<meta[^>]+name=["']?viewport/i.test(html)
        ? ''
        : '<meta name="viewport" content="width=1024, initial-scale=0.35, user-scalable=yes">';

      html = html
        .replace(/(href|src|action)=(["'])\/(?!\/)/gi, '$1=$2')
        // The meta tag repeats the Referrer-Policy header above inside the
        // page itself, so it still applies if a proxy or cache in between
        // ever drops or rewrites the header.
        .replace(/<head([^>]*)>/i, `<head$1><meta name="referrer" content="same-origin">${spaShim}${viewportTag}${interceptShim}`);
      bodyBuf = Buffer.from(html, 'utf8');
    }

    // Same leading-slash problem, but for CSS background-image/font
    // references INSIDE JavaScript — this page's styling is injected
    // by a script at runtime (not a separate .css file), so any
    // absolute-path url(/static/foo.png) baked into that script would
    // otherwise always resolve against our own domain's root instead
    // of the miner. Scoped narrowly to the CSS url(...) syntax only —
    // never touching arbitrary JS strings — since blindly rewriting
    // any string starting with "/" in a JS file risks corrupting
    // unrelated code (regex literals, division, normal text).
    if (isJs) {
      let js = bodyBuf.toString('utf8');
      js = js.replace(/(?<![a-zA-Z0-9_])url\((["']?)\/(?!\/)/g, 'url($1');
      bodyBuf = Buffer.from(js, 'utf8');
    }

    // Same leading-slash problem, but for an ACTUAL .css file — the case
    // above only ever covered url(...) baked into a JS-injected <style>,
    // never a real stylesheet the miner serves as its own file. Braiins
    // OS+ declares its fonts via @font-face { src: url(/static/font/…) }
    // in exactly this kind of file, so every font 404'd against our own
    // backend's root instead of the tunnel folder — the page rendered
    // with its default fallback font and no visible error, which is why
    // this one was easy to miss next to the louder GraphQL failure.
    //
    // Unlike HTML and JS-injected styles, a url() inside a .css FILE
    // resolves relative to the stylesheet's own folder, not the page's.
    // So just stripping the slash (as the first version of this did)
    // turned url(/static/font/x.woff2) in /static/css/734.css into
    // /static/css/static/font/x.woff2, a path that doesn't exist. The
    // miner's app answers unknown paths with its index.html, so the
    // browser received an HTML page labelled as a font ("OTS parsing
    // error: invalid sfntVersion 1008813135" is the bytes "<!DO").
    // Pointing each url() at the full tunnel path works whatever folder
    // the stylesheet lives in.
    if (isCss) {
      const tunnelRoot = '/api/webui/' + encodeURIComponent(farmId) + '/' + ip + '/';
      let css = bodyBuf.toString('utf8');
      css = css.replace(/url\((["']?)\/(?!\/)/g, (_m, q) => 'url(' + q + tunnelRoot);
      bodyBuf = Buffer.from(css, 'utf8');
    }

    // Name every failing file and say WHICH layer refused it. A 502 in
    // the browser console is ambiguous — it can come from this backend
    // (agent not connected) or from the agent (miner refused the
    // connection) — and the console shows neither the reason nor, for
    // a request made by a script, the URL. Without this, diagnosing a
    // page that half-loads means guessing.
    if (result.status && (result.status < 200 || result.status >= 400)) {
      const why = typeof result.body === 'string' ? result.body.slice(0, 160) : '';
      console.warn(`[WEBUI] ✗ ${result.status} ${minerPath}  (farm=${farmId} ip=${ip}) ${why}`);
    }

    res.status(result.status || 200);
    res.set('Content-Type', contentType);

    // Unchanging files: let the browser keep them for an hour, and keep a
    // copy here for the next person (or device) opening this miner. Never
    // a page handed back in place of the file (a login page or the app's
    // index.html answering for a missing script would otherwise stick).
    if (staticKey && (result.status || 200) === 200 && bodyBuf.length && !isHtml
        && !/text\/html/i.test(declaredType) && !/^\s*<(!doctype|html)/i.test(bodyBuf.slice(0, 64).toString('latin1'))
        && !(result.headers && result.headers['set-cookie'])) {
      res.set('Cache-Control', STATIC_BROWSER_CACHE);
      res.set('X-Tunnel-Cache', 'miss');
      staticCachePut(staticKey, contentType, bodyBuf);
    }

    // Cookies the miner sets (its login session) are handed to the
    // browser scoped to THIS miner's tunnel folder: the miner's own
    // Domain is dropped (it names the miner's IP, which the browser would
    // reject) and Path is pinned to /api/webui/<farm>/<ip>/, so two
    // miners open side by side never share or overwrite each other's
    // session, and none of it is sent to the rest of the app.
    const setCookies = result.headers && result.headers['set-cookie'];
    if (setCookies) {
      const cookiePath = '/api/webui/' + encodeURIComponent(farmId) + '/' + ip + '/';
      [].concat(setCookies).filter(Boolean).forEach(c => {
        const parts = String(c).split(';').map(x => x.trim()).filter(Boolean);
        const nameVal = parts.shift();
        if (!nameVal || nameVal.startsWith(cookieName + '=')) return;
        const keep = parts.filter(a => !/^(domain|path)=/i.test(a));
        keep.push('Path=' + cookiePath);
        res.append('Set-Cookie', [nameVal].concat(keep).join('; '));
      });
    }

    // gRPC-web status. A call that fails (or a "trailers-only" reply)
    // carries its result in grpc-status / grpc-message headers; dropping
    // them made the browser report "missing trailer" (Braiins OS: "Miner
    // info: missing trailer") instead of the real result.
    if (result.headers) {
      Object.keys(result.headers).forEach(h => {
        if (/^grpc-/i.test(h) && result.headers[h] != null) res.set(h, String(result.headers[h]));
      });
    }

    // Redirects (e.g. after submitting the miner's own login form)
    // need the same leading-slash strip so the browser follows them
    // back into our tunnel folder instead of escaping to our own
    // domain's root.
    if (result.headers && result.headers.location) {
      let loc = result.headers.location;
      if (loc.startsWith('/') && !loc.startsWith('//')) loc = loc.slice(1);
      res.set('Location', loc);
    }

    res.send(bodyBuf);
  } catch(e) {
    console.warn(`[WEBUI] ✗ 504 ${minerPath}  (farm=${farmId} ip=${ip}) ${e.message}`);
    res.status(504).send(tunnelErrorPage(e.message));
  }
});

// ── Memory of unchanging miner files ────────────────────────────────
// Opening an Antminer's page asks for dozens of small files, and each
// one travels browser → this server → farm PC → miner and all the way
// back, a few at a time; that trip, repeated, is what makes the page
// slow. Scripts, styles, pictures, fonts and language files only change
// with a firmware update, so they are kept here per miner for an hour
// (and the browser is told to keep them for an hour too). Live readings
// (.cgi, API calls, the page itself) are never kept.
const STATIC_EXT = /\.(js|mjs|css|png|jpe?g|gif|ico|svg|webp|woff2?|ttf|otf|eot|properties|map)$/i;
const STATIC_TTL_MS = 60 * 60 * 1000;
const STATIC_MAX_BYTES = 64 * 1024 * 1024, STATIC_MAX_ENTRY = 4 * 1024 * 1024;
const STATIC_BROWSER_CACHE = 'private, max-age=3600';
const staticCache = new Map();   // key -> { contentType, body, at }  (oldest first)
let staticBytes = 0;

function staticCacheKey(farmId, ip, minerPath) {
  const q = String(minerPath || '').indexOf('?');
  const pathOnly = q === -1 ? String(minerPath || '') : minerPath.slice(0, q);
  if (!STATIC_EXT.test(pathOnly)) return null;
  // "?_=1759…" is a page's own "don't cache" stamp — the file is the same
  const query = q === -1 ? '' : minerPath.slice(q + 1).split('&').filter(x => x && !/^_=\d+$/.test(x)).join('&');
  return farmId + '|' + ip + '|' + pathOnly + (query ? '?' + query : '');
}
function staticCacheGet(key) {
  const e = staticCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > STATIC_TTL_MS) { staticCache.delete(key); staticBytes -= e.body.length; return null; }
  return e;
}
function staticCachePut(key, contentType, body) {
  if (!body || body.length > STATIC_MAX_ENTRY) return;
  const old = staticCache.get(key);
  if (old) { staticCache.delete(key); staticBytes -= old.body.length; }
  staticCache.set(key, { contentType, body, at: Date.now() });
  staticBytes += body.length;
  for (const [k, e] of staticCache) {            // over the limit: drop the oldest
    if (staticBytes <= STATIC_MAX_BYTES) break;
    staticCache.delete(k); staticBytes -= e.body.length;
  }
}

// ── gRPC-web replies must end with a "trailer" frame ────────────────
// A gRPC-web reply is a run of frames: 1 flag byte + 4 length bytes +
// data. The last one (flag 0x80) is the trailer and carries grpc-status;
// the page's client refuses a reply without it ("missing trailer" —
// Braiins OS: "Miner info: missing trailer", empty Hashboards). Through
// the tunnel some replies arrive with their message intact but the status
// only in the HTTP headers/trailers, or nowhere. When the frames are
// complete and there is no trailer frame, one is added: from the miner's
// own grpc-status if it sent one, else "0" for a complete message on a
// 200 reply. A reply whose frames are cut short is passed through as it
// is — that really is a broken reply.
const grpcNoted = new Map();
function ensureGrpcWebTrailer(buf, isText, headers, path, ip) {
  let bin = buf;
  if (isText) { try { bin = Buffer.from(buf.toString('latin1').replace(/\s+/g, ''), 'base64'); } catch (e) { return buf; } }
  let off = 0, data = 0, trailer = false;
  while (off < bin.length) {
    if (off + 5 > bin.length) return buf;                       // cut short
    const flag = bin[off], len = bin.readUInt32BE(off + 1);
    if (off + 5 + len > bin.length) return buf;                 // cut short
    if (flag & 0x80) trailer = true; else data++;
    off += 5 + len;
  }
  if (trailer) return buf;
  const hdr = k => { const v = headers[k]; return v == null ? null : String(Array.isArray(v) ? v[0] : v); };
  let status = hdr('grpc-status');
  if (status == null && data > 0) status = '0';
  if (status == null) return buf;                               // nothing to go on
  const msg = hdr('grpc-message');
  const text = Buffer.from('grpc-status:' + status + '\r\n' + (msg ? 'grpc-message:' + msg + '\r\n' : ''), 'utf8');
  const head = Buffer.alloc(5); head[0] = 0x80; head.writeUInt32BE(text.length, 1);
  const out = Buffer.concat([bin, head, text]);
  const key = ip + path, now = Date.now();
  if (!grpcNoted.has(key) || now - grpcNoted.get(key) > 10 * 60 * 1000) {
    grpcNoted.set(key, now); if (grpcNoted.size > 500) grpcNoted.clear();
    console.log(`[WEBUI] grpc ${path} (ip=${ip}): reply had ${data} message(s) and no trailer frame (grpc-status ${hdr('grpc-status') == null ? 'not sent' : hdr('grpc-status')}) — trailer added`);
  }
  return isText ? Buffer.from(out.toString('base64'), 'latin1') : out;
}

function tunnelErrorPage(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>body{background:#0d1b2a;color:#f0f4f8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
    .box{max-width:400px;padding:24px}h1{color:#ff2d55;font-size:20px}p{color:#7a94ac;font-size:14px}</style>
    </head><body><div class="box"><h1>&#9888; Tunnel Error</h1><p>${message}</p>
    <p style="font-size:12px">Check the miner is powered on and the farm agent is connected.</p></div></body></html>`;
}

// ── Reloading a single-page miner app ───────────────────────────
// After the address bar is changed for a single-page app (see isSpa
// above), pressing reload asks OUR server for "/configuration" instead of
// the miner. Only the tab itself knows which miner it was showing (kept
// in sessionStorage), so a browser page request for an unknown path gets
// a tiny page that sends it back into the right tunnel — or, in a tab
// that never opened a miner, a plain "not found".
// Mounted in server.js ahead of everything except the API routes.
function reloadFallback(req, res, next) {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path === '/health') return next();
  const dest = req.headers['sec-fetch-dest'];
  if (dest && dest !== 'document') return next();
  if (!/text\/html/i.test(req.headers.accept || '')) return next();   // API clients, health checks
  res.set('Cache-Control', 'no-store');
  res.status(200).send('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
    '<script>(function(){var b=null;try{b=sessionStorage.getItem("ekl_tunnel_base");}catch(e){}' +
    'if(b&&/^\\/api\\/webui\\/[^/]+\\/\\d{1,3}(\\.\\d{1,3}){3}\\/$/.test(b)){' +
    'location.replace(b+location.pathname.slice(1)+location.search+location.hash);return;}' +
    'document.body.innerHTML="<p style=\\"font-family:sans-serif\\">Page not found. Open the miner again from Ekalavya.</p>";' +
    '})();</script></body></html>');
}

module.exports = router;
module.exports.reloadFallback = reloadFallback;
