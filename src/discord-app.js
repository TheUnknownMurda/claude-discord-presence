'use strict';

/**
 * Read-only lookups against Discord's public application endpoints, used by
 * `doctor` to catch the single most common cause of "my icon doesn't show":
 * a `largeImage` / `smallImage` value that isn't an art-asset key uploaded to
 * the application actually being used.
 *
 * Both endpoints are unauthenticated and return only public information about
 * an application (its name, and the names of its Rich Presence art assets).
 * No token is sent, and nothing is written.
 *
 * Diagnostics must never hang or throw, so every failure (offline, rate limit,
 * unexpected shape) resolves to null and the caller simply skips the check.
 */

const https = require('https');

const API = 'discord.com';
const TIMEOUT_MS = 4000;

/** GETs a JSON endpoint, resolving null on any error/timeout/non-200. */
function getJson(pathname, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const req = https.get(
      {
        host: API,
        path: pathname,
        headers: { 'User-Agent': 'claude-discord-presence (diagnostics)', Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish(null);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 512 * 1024) req.destroy(); // sanity cap
        });
        res.on('end', () => {
          try { finish(JSON.parse(body)); } catch (_) { finish(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

/** The application's public name, or null. */
async function fetchAppName(clientId) {
  const data = await getJson(`/api/v10/applications/${encodeURIComponent(clientId)}/rpc`);
  return data && typeof data.name === 'string' ? data.name : null;
}

/**
 * The art-asset keys uploaded to the application, or null if they couldn't be
 * listed (offline, bad id, …). An empty array means "reachable, none uploaded".
 * @returns {Promise<string[]|null>}
 */
async function fetchAssetKeys(clientId) {
  const data = await getJson(`/api/v9/oauth2/applications/${encodeURIComponent(clientId)}/assets`);
  if (!Array.isArray(data)) return null;
  return data.map((a) => a && a.name).filter((n) => typeof n === 'string');
}

/** True when a configured image value is a URL rather than an asset key. */
function looksLikeUrl(value) {
  return /^(https?|mp):/i.test(String(value || ''));
}

module.exports = { fetchAppName, fetchAssetKeys, looksLikeUrl };
