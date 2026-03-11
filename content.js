// content.js

// ===== 0. page-hook 注入関連 =====
const TIMEDTEXT_EVENT = '__YT_TIMEDTEXT_JSON3_CAPTURE__';
const PAGE_HOOK_ID = '__ytTimedtextPageHook__';

function installPageTimedtextHook() {
  if (document.getElementById(PAGE_HOOK_ID)) return;

  const script = document.createElement('script');
  script.id = PAGE_HOOK_ID;
  script.src = chrome.runtime.getURL('page-hook.js');
  script.onload = () => {
    script.remove();
  };

  (document.head || document.documentElement).appendChild(script);
}

// ===== 1. 説明文整形 =====
function sanitizeDescription(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

// ===== 2. 基本情報 =====
function getVideoId() {
  return new URLSearchParams(location.search).get('v') || null;
}

function getVideoUrl() {
  return location.href;
}

function getVideoInfo() {
  const titleElem = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
  const uploaderElem = document.querySelector('#owner #channel-name a');
  return {
    title: titleElem?.innerText.trim() || document.title.replace(/\s*-\s*YouTube$/, '') || '不明なタイトル',
    uploader: uploaderElem?.innerText.trim() || '不明な投稿者'
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAdShowing() {
  const player =
    document.querySelector('.html5-video-player') ||
    document.getElementById('movie_player');

  if (!player) return false;

  return player.classList.contains('ad-showing');
}

async function waitForAdsToFinish(timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (!isAdShowing()) {
      return true;
    }
    await sleep(300);
  }

  return !isAdShowing();
}

// ===== 3. playerResponse 取得 =====
function tryGetPlayerResponse() {
  const candidates = [
    window.ytInitialPlayerResponse,
    typeof window.ytplayer?.config?.args?.player_response === 'string'
      ? (() => {
          try {
            return JSON.parse(window.ytplayer.config.args.player_response);
          } catch {
            return null;
          }
        })()
      : window.ytplayer?.config?.args?.player_response
  ];

  for (const c of candidates) {
    if (c && typeof c === 'object') return c;
  }

  for (const script of [...document.scripts]) {
    const txt = script.textContent || '';
    if (!txt.includes('ytInitialPlayerResponse')) continue;

    const patterns = [
      /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s,
      /window\["ytInitialPlayerResponse"\]\s*=\s*(\{.+?\})\s*;/s,
      /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s
    ];

    for (const pattern of patterns) {
      const match = txt.match(pattern);
      if (match?.[1]) {
        try {
          return JSON.parse(match[1]);
        } catch {}
      }
    }
  }

  return null;
}

function getDescriptionFromPlayerResponse() {
  const playerResponse = tryGetPlayerResponse();
  return sanitizeDescription(playerResponse?.videoDetails?.shortDescription || '');
}

// ===== 4. 字幕トラック選択 =====
function selectCaptionTrack(tracks, isLive) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;

  let track = tracks.find(t => t.languageCode === 'ja' && t.kind !== 'asr');
  if (track) return track;

  track = tracks.find(t => t.languageCode === 'ja' && t.kind === 'asr');
  if (track) return track;

  if (isLive) {
    track = tracks.find(t => t.kind === 'asr');
    if (track) return track;
  }

  track = tracks.find(t => t.kind !== 'asr');
  if (track) return track;

  return tracks[0];
}

// ===== 5. timedtext 捕捉結果を保持 =====
const bestTimedtextPayloadByVideo = new Map();

function tryParseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getJson3EventCount(text) {
  const json = tryParseJsonSafely(text);
  return Array.isArray(json?.events) ? json.events.length : 0;
}

function scoreTimedtextPayload(payload) {
  const textLen = payload?.text?.length || 0;
  const eventCount = getJson3EventCount(payload?.text || '');
  const hasPot = payload?.url?.includes('pot=');
  const hasJson3 = payload?.url?.includes('fmt=json3');
  const hasAsr = payload?.url?.includes('kind=asr');
  const hasJa = payload?.url?.includes('lang=ja');

  return (
    textLen +
    eventCount * 1000 +
    (hasPot ? 50000 : 0) +
    (hasJson3 ? 10000 : 0) +
    (hasAsr ? 3000 : 0) +
    (hasJa ? 3000 : 0)
  );
}

function rememberBestTimedtextPayload(detail) {
  if (!detail?.videoId || !detail?.text) return;

  if (isAdShowing()) {
    console.log('[timedtext ignored:remember-ad-showing]', {
      videoId: detail.videoId,
      source: detail.source,
      url: detail.url
    });
    return;
  }

  const currentVideoId = getVideoId();
  if (detail.videoId && currentVideoId && detail.videoId !== currentVideoId) {
    console.log('[timedtext ignored:remember-videoId-mismatch]', {
      detailVideoId: detail.videoId,
      currentVideoId,
      source: detail.source,
      url: detail.url
    });
    return;
  }

  const candidate = {
    url: detail.url,
    videoId: detail.videoId,
    source: detail.source,
    contentType: detail.contentType,
    text: detail.text,
    capturedAt: Date.now()
  };

  const prev = bestTimedtextPayloadByVideo.get(detail.videoId);

  if (!prev) {
    bestTimedtextPayloadByVideo.set(detail.videoId, candidate);
    console.log('[timedtext best:init]', {
      videoId: detail.videoId,
      source: detail.source,
      bodyLength: candidate.text.length,
      eventCount: getJson3EventCount(candidate.text)
    });
    return;
  }

  const prevScore = scoreTimedtextPayload(prev);
  const nextScore = scoreTimedtextPayload(candidate);

  if (nextScore > prevScore) {
    bestTimedtextPayloadByVideo.set(detail.videoId, candidate);
    console.log('[timedtext best:update]', {
      videoId: detail.videoId,
      prevBodyLength: prev.text.length,
      nextBodyLength: candidate.text.length,
      prevEventCount: getJson3EventCount(prev.text),
      nextEventCount: getJson3EventCount(candidate.text),
      source: detail.source
    });
  } else {
    console.log('[timedtext ignored:smaller]', {
      videoId: detail.videoId,
      keptBodyLength: prev.text.length,
      ignoredBodyLength: candidate.text.length,
      keptEventCount: getJson3EventCount(prev.text),
      ignoredEventCount: getJson3EventCount(candidate.text),
      source: detail.source
    });
  }
}

function setupTimedtextCaptureListener() {
  if (window.__ytTimedtextCaptureListenerInstalled) return;
  window.__ytTimedtextCaptureListenerInstalled = true;

  window.addEventListener(TIMEDTEXT_EVENT, (ev) => {
    const detail = ev.detail || {};
    if (!detail.text) return;

    if (isAdShowing()) {
      console.log('[timedtext ignored:ad-showing]', {
        source: detail.source,
        videoId: detail.videoId,
        url: detail.url,
        bodyLength: detail.text.length,
        eventCount: getJson3EventCount(detail.text)
      });
      return;
    }

    const currentVideoId = getVideoId();
    if (detail.videoId && currentVideoId && detail.videoId !== currentVideoId) {
      console.log('[timedtext ignored:videoId-mismatch]', {
        source: detail.source,
        detailVideoId: detail.videoId,
        currentVideoId,
        url: detail.url
      });
      return;
    }

    console.log('[timedtext captured]', {
      source: detail.source,
      videoId: detail.videoId,
      url: detail.url,
      bodyLength: detail.text.length,
      eventCount: getJson3EventCount(detail.text)
    });

    rememberBestTimedtextPayload(detail);
  });
}

// ===== 6. 最良の captured json3 を使う =====
function getBestTimedtextPayload(videoId) {
  return bestTimedtextPayloadByVideo.get(videoId) || null;
}

async function waitForBestCapturedTimedtext(videoId, timeoutMs = 12000, minEventCount = 20) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const payload = getBestTimedtextPayload(videoId);
    if (
      payload &&
      payload.text &&
      payload.text.trim() &&
      getJson3EventCount(payload.text) >= minEventCount
    ) {
      return payload;
    }
    await sleep(200);
  }

  return getBestTimedtextPayload(videoId);
}

function ensureCaptionsAreEnabled() {
  const captionButton =
    document.querySelector('.ytp-subtitles-button') ||
    document.querySelector('button[aria-keyshortcuts="c"]');

  if (!captionButton) return false;

  const isPressed = captionButton.getAttribute('aria-pressed') === 'true';
  if (!isPressed) {
    captionButton.click();
  }

  return true;
}

async function fetchTranscriptFromCapturedJson(videoId) {
  try {
    const description = getDescriptionFromPlayerResponse();

    const adsFinished = await waitForAdsToFinish(30000);
    if (!adsFinished) {
      throw new Error('広告再生中のため字幕取得を開始できませんでした。広告終了後に再試行してください。');
    }

    const existing = getBestTimedtextPayload(videoId);
    if (existing && existing.text && existing.text.trim()) {
      const existingJson = tryParseJsonSafely(existing.text);
      if (Array.isArray(existingJson?.events) && existingJson.events.length > 20) {
        return {
          success: true,
          json: existingJson,
          description,
          debugUrl: existing.url,
          source: existing.source
        };
      }
    }

    ensureCaptionsAreEnabled();
    const captured = await waitForBestCapturedTimedtext(videoId, 12000, 20);

    if (!captured || !captured.text || !captured.text.trim()) {
      throw new Error('YouTube本体の字幕通信をまだ捕捉できていません。字幕をONにして数秒再生してください。');
    }

    const json = tryParseJsonSafely(captured.text);
    if (!Array.isArray(json?.events) || json.events.length === 0) {
      throw new Error('captured json3 の events が空です');
    }

    return {
      success: true,
      json,
      description,
      debugUrl: captured.url,
      source: captured.source
    };
  } catch (error) {
    console.error('[fetchTranscriptFromCapturedJson] error:', error);
    return {
      success: false,
      error: error.message || String(error)
    };
  }
}

// ===== 7. json3 パース =====
function formatSecondsToTimestamp(sec) {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function joinJson3Segs(segs) {
  if (!Array.isArray(segs)) return '';

  return segs
    .map(seg => seg?.utf8 || '')
    .join('')
    .replace(/\r/g, '')
    .replace(/\u200b/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function pushMergedLine(lines, text) {
  const normalized = String(text || '').trim();
  if (!normalized) return;

  if (lines.length === 0) {
    lines.push(normalized);
    return;
  }

  const last = lines[lines.length - 1];

  if (normalized === last) {
    return;
  }

  if (normalized.startsWith(last) && normalized.length > last.length) {
    lines[lines.length - 1] = normalized;
    return;
  }

  lines.push(normalized);
}

function parseJson3Subtitles(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const items = [];

  for (const ev of events) {
    if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') continue;

    const text = joinJson3Segs(ev.segs);
    if (!text) continue;
    if (text === '\n') continue;

    const ts = formatSecondsToTimestamp(ev.tStartMs / 1000);

    if (items.length > 0) {
      const lastItem = items[items.length - 1];

      if (text === lastItem.text) {
        continue;
      }

      if (text.startsWith(lastItem.text) && text.length > lastItem.text.length) {
        lastItem.text = text;
        continue;
      }
    }

    items.push({ ts, text });
  }

  return items
    .map(item => `[${item.ts}]\n${item.text}`)
    .join('\n\n')
    .trim();
}

function parsePlainJson3Subtitles(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const lines = [];

  for (const ev of events) {
    if (!Array.isArray(ev.segs)) continue;

    const text = joinJson3Segs(ev.segs);
    if (!text) continue;
    if (text === '\n') continue;

    pushMergedLine(lines, text);
  }

  return lines.join('\n').trim();
}

// ===== 8. DOM フォールバック =====
async function fallbackToDomSubtitles() {
  await sleep(2500);

  const selectors = [
    '.ytp-caption-segment',
    '.ytp-caption-window-container',
    '.captions-text'
  ];

  for (const sel of selectors) {
    const nodes = [...document.querySelectorAll(sel)];
    const text = nodes.map(n => n.innerText || n.textContent || '').join(' ').trim();
    if (text) return text;
  }

  return '字幕なし';
}

// ===== 9. 通知 =====
function removeNoSubtitlesBox() {
  const b = document.getElementById('noSubtitlesBox');
  if (b) b.remove();
}

function showNoSubtitlesBox(message = '字幕がありません') {
  let b = document.getElementById('noSubtitlesBox');
  if (!b) {
    b = document.createElement('div');
    b.id = 'noSubtitlesBox';
    Object.assign(b.style, {
      position: 'fixed',
      top: '80px',
      right: '20px',
      padding: '10px',
      backgroundColor: '#ffc107',
      color: '#000',
      border: '1px solid #ccc',
      borderRadius: '5px',
      zIndex: '9999',
      maxWidth: '360px',
      whiteSpace: 'pre-wrap',
      lineHeight: '1.4'
    });
    document.body.appendChild(b);
  }
  b.textContent = message;
}

// ===== 10. AI遷移 =====
function openAiSite(getPlain) {
  const url = getPlain
    ? 'https://gemini.google.com/app'
    : 'https://chatgpt.com/';

  window.open(url, '_blank', 'noopener,noreferrer');
}

async function copyTextToClipboard(text) {
  await navigator.clipboard.writeText(text);
}

// ===== 11. ボタン =====
function createSummarizeButtons() {
  if (document.getElementById('chatgptBtn')) return;

  const btn1 = document.createElement('button');
  btn1.id = 'chatgptBtn';
  btn1.textContent = 'ChatGPTで要約';
  Object.assign(btn1.style, {
    position: 'fixed',
    top: '20px',
    right: '20px',
    padding: '10px 14px',
    backgroundColor: '#007bff',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    zIndex: '9999',
    fontSize: '14px'
  });
  document.body.appendChild(btn1);

  const container = document.createElement('div');
  container.id = 'geminiContainer';
  Object.assign(container.style, {
    position: 'fixed',
    top: '20px',
    right: '160px',
    display: 'flex',
    flexDirection: 'column',
    zIndex: '9999'
  });
  document.body.appendChild(container);

  const btn2 = document.createElement('button');
  btn2.id = 'geminiBtn';
  btn2.textContent = 'Geminiで要約';
  Object.assign(btn2.style, {
    padding: '10px 14px',
    backgroundColor: '#28a745',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    marginBottom: '5px',
    fontSize: '14px'
  });
  container.appendChild(btn2);

  async function handler(getPlain, clickedButton) {
    const originalText = clickedButton.textContent;
    const originalDisabled = clickedButton.disabled;

    try {
      clickedButton.disabled = true;
      clickedButton.textContent = '字幕取得中...';

      const vid = getVideoId();
      if (!vid) {
        alert('動画IDが見つかりません');
        return;
      }

      const result = await fetchTranscriptFromCapturedJson(vid);

      let subs = '';
      let desc = '';

      if (result.success) {
        desc = result.description || '';
        subs = getPlain
          ? parsePlainJson3Subtitles(result.json)
          : parseJson3Subtitles(result.json);

        if (!subs || !subs.trim()) {
          console.warn('captured json3 はあるが本文整形結果が空です。DOM フォールバックを試します。');
          subs = await fallbackToDomSubtitles();
        }

        console.log('字幕取得URL(debug):', result.debugUrl);
        console.log('字幕取得source(debug):', result.source);
        console.log('字幕 event count(debug):', Array.isArray(result.json?.events) ? result.json.events.length : 0);
      } else {
        console.warn('captured json3 字幕取得失敗:', result.error);
        subs = await fallbackToDomSubtitles();
      }

      if (!subs || subs === '字幕なし' || !subs.trim()) {
        showNoSubtitlesBox('字幕の取得に失敗しました。\n字幕をONにして2〜3秒再生してから再度試してください。');
        alert('字幕の取得に失敗しました。字幕をONにして数秒再生してから再試行してください。');
        return;
      }

      removeNoSubtitlesBox();

      const info = getVideoInfo();
      const prefix =
        `動画タイトル: ${info.title}\n` +
        `投稿者名: ${info.uploader}\n` +
        `URL: ${getVideoUrl()}\n` +
        (desc ? `\n概要:\n${desc}\n` : '') +
        (
          getPlain
            ? '\n以下の文章を日本語で要約してください:\n\n'
            : '\n以下の字幕を日本語で要約してください。各トピックごとにタイムスタンプを含めてください:\n\n'
        );

      const fullText = prefix + subs;

      clickedButton.textContent = 'コピー中...';
      await copyTextToClipboard(fullText);

      clickedButton.textContent = 'サイトを開いています...';
      openAiSite(getPlain);

      showNoSubtitlesBox('字幕全文をコピーしました。\n新しいタブで生成AIサイトを開きました。');

      setTimeout(() => {
        removeNoSubtitlesBox();
      }, 2500);
    } catch (e) {
      console.error('handler error:', e);
      showNoSubtitlesBox(`処理に失敗しました。\n${e?.message || String(e)}`);
      alert(`処理に失敗しました。\n${e?.message || String(e)}`);
    } finally {
      clickedButton.disabled = originalDisabled;
      clickedButton.textContent = originalText;
    }
  }

  btn1.addEventListener('click', () => handler(false, btn1));
  btn2.addEventListener('click', () => handler(true, btn2));
}

// ===== 12. 動画切替監視 =====
let currentVid = null;

function removeStalePayloadsExcept(activeVideoId) {
  for (const key of [...bestTimedtextPayloadByVideo.keys()]) {
    if (key !== activeVideoId) {
      bestTimedtextPayloadByVideo.delete(key);
    }
  }
}

function removeButtons() {
  const btn1 = document.getElementById('chatgptBtn');
  const container = document.getElementById('geminiContainer');
  if (btn1) btn1.remove();
  if (container) container.remove();
}

function resetForNewVideo() {
  removeNoSubtitlesBox();
  removeButtons();
  createSummarizeButtons();
}

function onVideoChanged() {
  const v = getVideoId();
  if (v && v !== currentVid) {
    currentVid = v;
    removeStalePayloadsExcept(v);
    resetForNewVideo();
  }
}

// ===== 13. 初期化 =====
installPageTimedtextHook();
setupTimedtextCaptureListener();

const initObserver = new MutationObserver(() => {
  if (document.body) {
    initObserver.disconnect();

    const mo = new MutationObserver(() => {
      onVideoChanged();
    });

    mo.observe(document.body, { childList: true, subtree: true });

    ['yt-navigate-finish', 'popstate'].forEach(evt => {
      window.addEventListener(evt, onVideoChanged);
    });

    onVideoChanged();
  }
});

if (document.body) {
  initObserver.disconnect();

  const mo = new MutationObserver(() => {
    onVideoChanged();
  });

  mo.observe(document.body, { childList: true, subtree: true });

  ['yt-navigate-finish', 'popstate'].forEach(evt => {
    window.addEventListener(evt, onVideoChanged);
  });

  onVideoChanged();
} else {
  initObserver.observe(document.documentElement, { childList: true, subtree: true });
}