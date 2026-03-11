// page-hook.js
(() => {
  'use strict';

  if (window.__ytTimedtextHookInstalled) return;
  window.__ytTimedtextHookInstalled = true;

  const EVENT_NAME = '__YT_TIMEDTEXT_JSON3_CAPTURE__';

  function emit(payload) {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload }));
    } catch (e) {
      console.warn('[ytTimedtextHook] emit failed', e);
    }
  }

  function isTimedtextUrl(url) {
    try {
      return String(url || '').includes('/api/timedtext');
    } catch {
      return false;
    }
  }

  function parseVideoIdFromUrl(urlString) {
    try {
      const u = new URL(urlString, location.origin);
      return u.searchParams.get('v');
    } catch {
      return null;
    }
  }

  function shouldCapture(urlString, text, contentType) {
    if (!isTimedtextUrl(urlString)) return false;
    if (!text || !text.trim()) return false;
    if (!String(urlString).includes('fmt=json3')) return false;
    if (!String(contentType || '').includes('application/json')) return false;
    return true;
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url;

    const res = await originalFetch.apply(this, args);

    if (isTimedtextUrl(url)) {
      try {
        const cloned = res.clone();
        const text = await cloned.text();
        const contentType = cloned.headers.get('content-type') || '';

        if (shouldCapture(url, text, contentType)) {
          emit({
            source: 'fetch',
            url,
            videoId: parseVideoIdFromUrl(url),
            contentType,
            text
          });
        }
      } catch (e) {
        console.warn('[ytTimedtextHook] fetch capture failed', e);
      }
    }

    return res;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytTimedtextMeta = { method, url };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const meta = this.__ytTimedtextMeta;

    if (meta && isTimedtextUrl(meta.url)) {
      this.addEventListener('load', function () {
        try {
          const text = this.responseText || '';
          const contentType = this.getResponseHeader('content-type') || '';

          if (shouldCapture(meta.url, text, contentType)) {
            emit({
              source: 'xhr',
              url: meta.url,
              videoId: parseVideoIdFromUrl(meta.url),
              contentType,
              text
            });
          }
        } catch (e) {
          console.warn('[ytTimedtextHook] xhr capture failed', e);
        }
      });
    }

    return originalSend.apply(this, args);
  };

  console.log('[page-hook] loaded');
})();