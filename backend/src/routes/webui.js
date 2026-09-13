// ============================================================
// WEB UI TUNNEL — proxies a browser's HTTP request through the
// farm agent's WebSocket connection to a miner's local web UI,
// which is only reachable on the farm's local network.
//
// Flow: browser → this route → agent (via WebSocket) → miner's
// local IP → response flows back the same path in reverse.
// ============================================================
const express = require('express');
const router  = express.Router();
const agentMgr = require('../services/agentManager');

// Matches every method and every sub-path under /api/webui/:farmId/:ip/...
// Using router.use() with a fixed prefix (not a wildcard route pattern)
// — this is the reliable, version-safe way to capture "everything after
// this point" in Express 4's path matcher. The earlier /*? wildcard
// pattern is unreliable across path-to-regexp versions and may simply
// never match at all, which looks identical to "route doesn't exist".
router.use('/:farmId/:ip', async (req, res) => {
  const { farmId, ip } = req.params;
  // Once mounted this way, req.url is already everything AFTER
  // /:farmId/:ip — exactly the sub-path + querystring to forward
  const minerPath = req.url === '/' ? '/' : req.url;
  console.log(`[WEBUI] ${req.method} tunnel request → farm=${farmId} ip=${ip} path=${minerPath}`);

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

    // Rewrite the miner's own absolute links so they route back through
    // OUR proxy path instead of resolving against this server's own
    // domain (which obviously doesn't have /js/main.js etc.)
    if (contentType.includes('text/html')) {
      let html = bodyBuf.toString('utf8');
      const proxyBase = `/api/webui/${farmId}/${ip}`;

      // <base href> only fixes HTML attributes and relative-path JS calls.
      // Most miner web UIs (Antminer, WhatsMiner) poll their own stats via
      // client-side JS using ABSOLUTE paths like fetch('/cgi-bin/status.cgi')
      // — <base> has no effect on those. Without this shim, those calls hit
      // OUR backend's root instead of the miner, get a 404 HTML page back,
      // and the miner's own JS throws "Unexpected token '<' ... not valid
      // JSON" trying to parse it. Intercepting fetch/XHR here, before any
      // of the miner's own scripts run, redirects those absolute calls
      // through the proxy so they actually reach the miner.
      const interceptShim = '<script>' +
        '(function(){' +
        'var BASE=' + JSON.stringify(proxyBase) + ';' +
        'function fix(u){if(typeof u==="string"&&u.charAt(0)==="/"&&u.indexOf(BASE)!==0){return BASE+u;}return u;}' +
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
        .replace(/(href|src|action)=(["'])\/(?!\/)/gi, `$1=$2${proxyBase}/`)
        .replace(/<head([^>]*)>/i, `<head$1><base href="${proxyBase}/">${interceptShim}`);
      bodyBuf = Buffer.from(html, 'utf8');
    }

    res.status(result.status || 200);
    res.set('Content-Type', contentType);
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
