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
router.use('/:farmId/:ip', async (req, res) => {
  const { farmId, ip } = req.params;
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
  const minerPath = req.url === '/' ? '/' : req.url;
  console.log(`[WEBUI] ${req.method} tunnel request → farm=${farmId} ip=${ip} path=${minerPath} user=${user.id}(${user.role})`);

  const agent = agentMgr.getAgent(farmId);
  if (!agent) {
    return res.status(502).send(tunnelErrorPage(`Farm agent "${farmId}" is not connected right now.`));
  }

  // Body — only forward for methods that carry one. Must re-serialize
  // back into whatever format it originally came in as (Express already
  // parsed it into an object) — a miner's login form expects urlencoded
  // "user=root&pass=root", NOT the JSON stringification of that object.
  let bodyToSend = null;
  const reqContentType = req.headers['content-type'] || '';
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
    if (reqContentType.includes('application/json')) {
      bodyToSend = JSON.stringify(req.body);
    } else if (reqContentType.includes('urlencoded') || !reqContentType) {
      bodyToSend = new URLSearchParams(req.body).toString();
    } else {
      bodyToSend = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }
  }

  try {
    const result = await agentMgr.sendWebuiRequest(
      farmId, ip, req.method, minerPath,
      { 'content-type': req.headers['content-type'] || '' },
      bodyToSend
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
    const isJs          = looksLikeJs || declaredType.includes('javascript');
    const isHtml        = !isJs && (declaredType.includes('text/html') || (!declaredType && (pathOnly === '/' || pathOnly.endsWith('/') || pathOnly.endsWith('.html'))));
    const contentType   = declaredType || (isJs ? 'application/javascript' : 'text/html');
    let bodyBuf = result.encoding === 'base64'
      ? Buffer.from(result.body || '', 'base64')
      : Buffer.from(result.body || '', 'utf8');

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
      const interceptShim = '<script>' +
        '(function(){' +
        'function fix(u){if(typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"){return u.slice(1);}return u;}' +
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

      html = html
        .replace(/(href|src|action)=(["'])\/(?!\/)/gi, '$1=$2')
        .replace(/<head([^>]*)>/i, `<head$1>${interceptShim}`);
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

    res.status(result.status || 200);
    res.set('Content-Type', contentType);

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
    res.status(504).send(tunnelErrorPage(e.message));
  }
});

function tunnelErrorPage(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <style>body{background:#0d1b2a;color:#f0f4f8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
    .box{max-width:400px;padding:24px}h1{color:#ff2d55;font-size:20px}p{color:#7a94ac;font-size:14px}</style>
    </head><body><div class="box"><h1>&#9888; Tunnel Error</h1><p>${message}</p>
    <p style="font-size:12px">Check the miner is powered on and the farm agent is connected.</p></div></body></html>`;
}

module.exports = router;
