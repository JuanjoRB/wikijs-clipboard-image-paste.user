// ==UserScript==
// @name         Wiki.js Clipboard Image Paste
// @namespace    local.wikijs.clipboard-image-paste
// @version      1.0.0
// @description  Upload clipboard images to Wiki.js and insert them into Markdown or Visual Editor pages.
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /**
   * Wiki.js clipboard image paste helper
   * ------------------------------------
   *
   * What this script does:
   * 1. Intercepts image paste events, such as macOS screenshots copied with
   *    Cmd + Shift + Ctrl + 4.
   * 2. Uploads the image to Wiki.js through the same internal endpoint used by
   *    the native asset manager: POST /u.
   * 3. Inserts the uploaded image into the active editor:
   *    - Markdown editor: inserts Markdown through CodeMirror.
   *    - Visual Editor: simulates a real HTML paste so CKEditor updates its
   *      internal document model correctly.
   *
   * Notes:
   * - This depends on Wiki.js v2 internal behavior and may need adjustment after
   *   Wiki.js upgrades.
   * - The script automatically reuses the Wiki.js Authorization header when it
   *   sees normal Wiki.js requests. If needed, it falls back to the `jwt` cookie.
   */

  const DEBUG = true;

  // Root asset folder in Wiki.js. Change this if your asset manager uploads to a
  // different folder ID.
  const ASSET_FOLDER_ID = 0;

  // Public URL prefix for uploaded assets.
  //
  // For root assets, Wiki.js commonly serves files as:
  //   /filename.png
  //
  // If your Wiki.js instance serves assets under a different prefix, update this
  // value, for example:
  //   const ASSET_URL_PREFIX = '/assets';
  const ASSET_URL_PREFIX = '';

  let capturedBearer = null;

  function log(...args) {
    if (DEBUG) {
      console.log('[WikiPaste]', ...args);
    }
  }

  function warn(...args) {
    if (DEBUG) {
      console.warn('[WikiPaste]', ...args);
    }
  }

  /**
   * Store the Authorization header used by Wiki.js itself.
   *
   * The native Wiki.js UI sends uploads with:
   *   Authorization: Bearer <jwt>
   *
   * Tampermonkey requests need to send the same header, otherwise /u may return
   * 403 even when the user is logged in.
   */
  function captureAuthHeader(value, source) {
    if (!value) return;

    const header = String(value);

    if (header.startsWith('Bearer ')) {
      capturedBearer = header;
      log(`Captured Authorization from ${source}: Bearer <redacted>`);
    }
  }

  /**
   * Patch fetch() so we can capture Wiki.js Authorization headers from normal
   * application requests.
   */
  const originalFetch = window.fetch;

  window.fetch = function (input, init = {}) {
    try {
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          captureAuthHeader(init.headers.get('Authorization'), 'fetch Headers');
        } else if (Array.isArray(init.headers)) {
          const pair = init.headers.find(
            ([key]) => String(key).toLowerCase() === 'authorization'
          );

          if (pair) {
            captureAuthHeader(pair[1], 'fetch array headers');
          }
        } else {
          captureAuthHeader(
            init.headers.Authorization || init.headers.authorization,
            'fetch object headers'
          );
        }
      }
    } catch (err) {
      warn('fetch Authorization capture failed:', err);
    }

    return originalFetch.apply(this, arguments);
  };

  /**
   * Patch XMLHttpRequest so we can capture Authorization headers from clients
   * such as Axios, which Wiki.js may use internally.
   */
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function () {
    this.__wikiPasteUrl = arguments[1];
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === 'authorization') {
      captureAuthHeader(value, `XHR ${this.__wikiPasteUrl || ''}`);
    }

    return originalSetRequestHeader.apply(this, arguments);
  };

  function getCookie(name) {
    const escapedName = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
    const match = document.cookie.match(
      new RegExp('(?:^|; )' + escapedName + '=([^;]*)')
    );

    return match ? decodeURIComponent(match[1]) : null;
  }

  function getBearerToken() {
    if (capturedBearer) {
      return capturedBearer;
    }

    const jwt = getCookie('jwt');

    if (jwt) {
      log('Using jwt cookie as Authorization fallback');
      return `Bearer ${jwt}`;
    }

    return null;
  }

  function buildTimestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');

    return (
      `${now.getFullYear()}` +
      `${pad(now.getMonth() + 1)}` +
      `${pad(now.getDate())}-` +
      `${pad(now.getHours())}` +
      `${pad(now.getMinutes())}` +
      `${pad(now.getSeconds())}`
    );
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function buildAssetUrl(fileName) {
    const cleanPrefix = ASSET_URL_PREFIX.replace(/\/$/, '');
    return `${cleanPrefix}/${encodeURIComponent(fileName)}`;
  }

    async function sha256Hex(blob) {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = [...new Uint8Array(hashBuffer)];

    return hashArray
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  async function assetExists(url) {
    try {
      const response = await originalFetch(url, {
        method: 'HEAD',
        credentials: 'include',
        cache: 'no-store'
      });

      if (response.ok) {
        log('Asset already exists:', url);
        return true;
      }

      // Some static/file handlers do not support HEAD correctly.
      // If HEAD fails with 405, try a small GET fallback.
      if (response.status === 405) {
        const getResponse = await originalFetch(url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store'
        });

        log('GET fallback asset check:', {
          url,
          status: getResponse.status
        });

        return getResponse.ok;
      }

      log('Asset does not exist yet:', {
        url,
        status: response.status
      });

      return false;
    } catch (err) {
      warn('Asset existence check failed. Will upload anyway:', err);
      return false;
    }
  }

  async function buildDeterministicImageFile(blob) {
    const hash = await sha256Hex(blob);
    const shortHash = hash.slice(0, 16);
    const extension = getImageExtension(blob.type);
    const fileName = `pasted-image-${shortHash}.${extension}`;

    return new File([blob], fileName, { type: blob.type });
  }

  /**
   * Find the active CodeMirror instance used by the Wiki.js Markdown editor.
   */
  function getFocusedCodeMirror() {
    const focused = document.querySelector('.CodeMirror-focused');

    if (focused?.CodeMirror) {
      return focused.CodeMirror;
    }

    const instances = [...document.querySelectorAll('.CodeMirror')]
      .map((element) => element.CodeMirror)
      .filter(Boolean);

    log('CodeMirror instances found:', instances.length);

    return instances[0] || null;
  }

  /**
   * Insert Markdown in the Markdown editor.
   */
  function insertIntoMarkdown(markdown) {
    const cm = getFocusedCodeMirror();

    if (cm && typeof cm.replaceSelection === 'function') {
      log('Inserting with CodeMirror replaceSelection');

      cm.focus();
      cm.replaceSelection(markdown);

      // Trigger events in case the surrounding Vue component needs them.
      const wrapper = cm.getWrapperElement?.();
      wrapper?.dispatchEvent(new Event('input', { bubbles: true }));
      wrapper?.dispatchEvent(new Event('change', { bubbles: true }));

      return true;
    }

    const textarea =
      document.activeElement?.tagName === 'TEXTAREA'
        ? document.activeElement
        : document.querySelector('textarea');

    if (textarea) {
      log('Inserting with textarea fallback');

      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;

      textarea.value =
        textarea.value.slice(0, start) +
        markdown +
        textarea.value.slice(end);

      textarea.selectionStart = textarea.selectionEnd = start + markdown.length;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.focus();

      return true;
    }

    return false;
  }

  /**
   * Find the editable element used by Wiki.js Visual Editor.
   *
   * Wiki.js Visual Editor is based on CKEditor. CKEditor does not reliably update
   * its internal model when HTML is inserted with document.execCommand(), so the
   * script uses a synthetic paste event instead.
   */
  function getVisualEditable() {
    return (
      document.querySelector('.ck-editor__editable.ck-focused') ||
      document.querySelector('.ck-content.ck-focused') ||
      document.querySelector('.ck-editor__editable[contenteditable="true"]') ||
      document.querySelector('.ck-content[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"]:focus') ||
      document.activeElement?.closest?.('[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  /**
   * Simulate a real HTML paste into CKEditor.
   *
   * This is the key step for Visual Editor support. CKEditor needs the paste
   * pipeline so it can convert the pasted HTML into its internal document model.
   */
  function pasteHtmlIntoVisualEditor(html, plainText) {
    const editable = getVisualEditable();

    if (!editable) {
      log('No CKEditor/contenteditable target found');
      return false;
    }

    log('Pasting HTML into visual editor target:', editable);

    editable.focus();

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/html', html);
    dataTransfer.setData('text/plain', plainText || html);

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    });

    const result = editable.dispatchEvent(pasteEvent);

    log('Synthetic paste dispatched. result:', result);

    editable.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        data: null
      })
    );

    editable.dispatchEvent(new Event('change', { bubbles: true }));

    return true;
  }

  function insertIntoVisual(html, plainText) {
    if (pasteHtmlIntoVisualEditor(html, plainText)) {
      return true;
    }

    const editable = getVisualEditable();

    if (!editable) {
      log('No visual editor target found');
      return false;
    }

    // Last-resort fallback. This may visually insert HTML, but CKEditor may not
    // always save it correctly because it bypasses the CKEditor paste pipeline.
    editable.focus();

    const ok = document.execCommand('insertHTML', false, html);

    editable.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertHTML',
        data: null
      })
    );

    editable.dispatchEvent(new Event('change', { bubbles: true }));

    return ok;
  }

  function insertImage(fileName, url) {
    const markdown = `\n![${fileName}](${url})\n`;

    // CKEditor handles images best when pasted as a figure with class="image",
    // which matches the structure used by the native image tool.
    const html = `
      <figure class="image">
        <img src="${url}" alt="${escapeHtml(fileName)}">
      </figure>
    `;

    log('Attempting editor insertion', {
      fileName,
      url,
      hasCodeMirror: Boolean(document.querySelector('.CodeMirror')),
      hasFocusedCodeMirror: Boolean(document.querySelector('.CodeMirror-focused')),
      hasTextarea: Boolean(document.querySelector('textarea')),
      hasVisualEditable: Boolean(getVisualEditable()),
      activeElement: document.activeElement
    });

    if (document.querySelector('.CodeMirror-focused') || document.querySelector('.CodeMirror')) {
      if (insertIntoMarkdown(markdown)) {
        return true;
      }
    }

    if (getVisualEditable()) {
      if (insertIntoVisual(html, fileName)) {
        return true;
      }
    }

    document.execCommand('insertText', false, markdown);
    return true;
  }

  /**
   * Upload the image through Wiki.js' internal asset upload endpoint.
   */
  async function uploadToWikiJs(file) {
    const bearer = getBearerToken();

    const form = new FormData();
    form.append('mediaUpload', JSON.stringify({ folderId: ASSET_FOLDER_ID }));
    form.append('mediaUpload', file, file.name);

    const headers = {
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    };

    if (bearer) {
      headers.Authorization = bearer;
    }

    log('Uploading image to /u', {
      fileName: file.name,
      type: file.type,
      size: file.size,
      folderId: ASSET_FOLDER_ID,
      hasAuthorization: Boolean(headers.Authorization)
    });

    const response = await originalFetch('/u', {
      method: 'POST',
      body: form,
      credentials: 'include',
      headers
    });

    const text = await response.text().catch(() => '');

    log('Upload status:', response.status);
    log('Upload response:', text);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return text;
  }

  function showToast(message) {
    log(message);

    const toast = document.createElement('div');

    toast.textContent = message;
    toast.style.position = 'fixed';
    toast.style.right = '20px';
    toast.style.bottom = '20px';
    toast.style.zIndex = '999999';
    toast.style.background = 'rgba(0,0,0,0.85)';
    toast.style.color = 'white';
    toast.style.padding = '10px 14px';
    toast.style.borderRadius = '8px';
    toast.style.fontSize = '13px';
    toast.style.fontFamily = 'system-ui, sans-serif';

    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 2500);
  }

  function getImageExtension(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';

    return 'png';
  }

  function installPasteHandler() {
    document.addEventListener(
      'paste',
      async function (event) {
        const items = event.clipboardData?.items;
        if (!items) return;

        const imageItem = [...items].find((item) => item.type.startsWith('image/'));
        if (!imageItem) return;

        event.preventDefault();
        event.stopPropagation();

        const blob = imageItem.getAsFile();
        if (!blob) return;

        const file = await buildDeterministicImageFile(blob);
        const fileName = file.name;
        const url = buildAssetUrl(fileName);

        try {
          if (await assetExists(url)) {
            showToast(`Using existing ${fileName}`);
          } else {
            showToast(`Uploading ${fileName}...`);
            await uploadToWikiJs(file);
          }

          const inserted = insertImage(fileName, url);

          showToast(inserted ? `Inserted ${fileName}` : 'Asset OK, insert failed');
        } catch (err) {
          console.error('[WikiPaste] Failed:', err);

          showToast(`Wiki.js paste failed: ${err.message}`);
          alert(`Wiki.js paste failed:\n${err.message}`);
        }
      },
      true
    );

    log('Paste handler installed on', location.href);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installPasteHandler);
  } else {
    installPasteHandler();
  }
})();