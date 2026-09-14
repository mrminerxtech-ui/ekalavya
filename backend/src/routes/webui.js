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
  // cookie scoped to this exact farm+ip path — every subsequent
  // request within the miner's own page (link clicks, its own
  // fetch/XHR calls) then carries auth automatically via that
  // cookie, with no need to rewrite every possible URL pattern.
  const cookies      = parseCookies(req.headers.cookie);
  const cookieName   = 'ekl_webui_' + Buffer.from(proxyBase).toString('base64url').slice(0, 24);
  const token        = req.query.token || cookies[cookieName];

  let user;
  if (!token) return res.status(401).send(tunnelErrorPage('Not logged in — please open this from inside the app.'));
  try { user = jwt.verify(token, JWT_SECRET); }
  catch(e) { return res.status(401).send(tunnelErrorPage('Your session has expired — please log in again.')); }

  // ── Customer accounts: restrict to only their own assigned machine ──
  if (user.role === 'customer') {
    const worker = await db.findWorkerByFarmAndIp(farmId, ip);
    if (!worker || worker.cid !== user.id) {
      console.log(`[WEBUI] ✗ Customer ${user.id} denied access to farm=${farmId} ip=${ip} (not their assigned machine)`);
      return res.status(403).send(tunnelErrorPage('This machine is not assigned to your account.'));
    }
  }

  // Re-issue the cookie on every verified request — cheap, and keeps
  // the session alive for as long as the tab stays open and active.
  res.cookie(cookieName, token, { path: proxyBase, maxAge: 30 * 60 * 1000, httpOnly: true, sameSite: 'lax' });

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
    const contentType = (result.headers && result.headers['content-type']) || 'text/html';
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
    if (contentType.includes('text/html')) {
      let html = bodyBuf.toString('utf8');

      // Safety net for JAVASCRIPT-constructed absolute paths (a script
      // calling fetch('/cgi-bin/foo.cgi') directly, not through an HTML
      // attribute) — same strip-the-slash idea, applied at request time
      // instead of by rewriting the HTML text, since we can't safely
      // rewrite arbitrary JS source without risking breaking it.
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
        '})();' +
        '</script>';

      html = html
        .replace(/(href|src|action)=(["'])\/(?!\/)/gi, '$1=$2')
        .replace(/<head([^>]*)>/i, `<head$1>${interceptShim}`);
      bodyBuf = Buffer.from(html, 'utf8');
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
