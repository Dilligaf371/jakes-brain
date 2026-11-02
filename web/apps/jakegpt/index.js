// JakeGPT: private ChatGPT on the PC's Ollama. Two views on one mount:
//   #/jakegpt          conversation list (title, model, relative time; … → delete via sheet; + new chat)
//   #/jakegpt/new      a draft chat: the conversation row is created on the first Send
//   #/jakegpt/<id>     chat view: bubbles, streaming reply with a cursor, composer pinned to the
//                      bottom, Stop aborts the fetch (the server keeps the partial reply), model
//                      picker in the nav bar.
// Streaming: POST /api/jakegpt/conversations/:id/messages answers application/x-ndjson lines
// { delta } … { done, message_id, title } (or { error }); the bubble re-renders through
// kit.renderMarkdownLite as tokens arrive. holdReload while a reply streams and while typing.
import * as kit from '../../kit.js';

const {
  api, el, fmt, toast, haptic, navbar, navButton, emptyState, confirmSheet, actionSheet,
  holdReload, releaseReload, store, icon, renderMarkdownLite, nav,
} = kit;

const HOLD_STREAM = 'jakegpt:stream';
const HOLD_TYPING = 'jakegpt:typing';
const LOADING_HINT_MS = 2_000;     // "Loading model…" after this long with no delta
const HEADERS_TIMEOUT_MS = 125_000; // Ollama answers only once the model is loaded (server idle limit 120 s)
const MODELS_CACHE_MS = 60_000;
const TEXTAREA_MAX_PX = 160;
const AUTO_TITLE_LEN = 40;
const NEAR_BOTTOM_PX = 80;
const desktopInput = window.matchMedia('(hover: hover) and (pointer: fine)');

let app = null;   // { root, sawList, models, modelsAt, listeners }
let view = null;  // the mounted view: { kind: 'list' | 'chat', ..., teardown() }

export default {
  mount(root, ctx) {
    app = { root, sawList: false, models: null, modelsAt: 0, listeners: [] };
    listen(window, 'jakesdata:online', onRefresh);
    listen(window, 'jakesdata:foreground', onRefresh);
    show(ctx.sub);
  },

  route(sub) {
    if (app) show(sub);
  },

  unmount() {
    teardownView();
    if (app) for (const [target, type, fn] of app.listeners) target.removeEventListener(type, fn);
    app = null;
  },
};

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  app.listeners.push([target, type, fn]);
}

function onRefresh() {
  if (view && typeof view.refresh === 'function') view.refresh();
}

function show(sub) {
  const s = String(sub == null ? '' : sub).replace(/^\/+|\/+$/g, '');
  if (!s) return showList();
  if (s === 'new') return showChat(null);
  if (/^\d{1,15}$/.test(s)) return showChat(Number(s));
  nav.replace('#/jakegpt');
  return undefined;
}

function teardownView() {
  if (!view) return;
  try {
    view.teardown();
  } catch (err) {
    console.error('[jakegpt] teardown failed', err);
  }
  view = null;
}

function failureMessage(err, verb = 'do that') {
  if (!err) return `Couldn't ${verb}`;
  if (err.status === 0) return err.message === 'aborted' ? 'Stopped' : "Can't reach the PC";
  return err.message || `Couldn't ${verb}`;
}

function shortModel(name) {
  return String(name || '').replace(/:latest$/, '');
}

// The nav bar slot is narrow: a long name drops its tag ("llama3.1:8b" -> "llama3.1"); the
// picker sheet always shows the full name.
function navModel(name) {
  const s = shortModel(name);
  if (s.length <= 10) return s;
  const base = s.split('/').pop().split(':')[0];
  return base || s;
}

// Same rule as the server (first 40 characters), so the title appears before the reply ends.
function autoTitle(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (line.length <= AUTO_TITLE_LEN) return line;
  return `${line.slice(0, AUTO_TITLE_LEN - 1).trimEnd()}…`;
}

// GET /api/jakegpt/models, cached a minute. Throws ApiError (503 "Ollama is not running").
async function loadModels(force = false) {
  if (!app) throw new Error('unmounted');
  if (!force && app.models && Date.now() - app.modelsAt < MODELS_CACHE_MS) return app.models;
  const data = await api('/api/jakegpt/models', { timeout: 6000 });
  if (!app) throw new Error('unmounted');
  app.models = { models: Array.isArray(data.models) ? data.models : [], default: data.default || null };
  app.modelsAt = Date.now();
  return app.models;
}

// ---------------------------------------------------------------- list view

function showList() {
  if (view && view.kind === 'list') {
    view.refresh();
    return;
  }
  teardownView();
  app.sawList = true;
  const newChat = () => nav.go('#/jakegpt/new');
  const header = navbar({ title: 'JakeGPT', right: [navButton({ icon: 'plus', label: 'New chat', onClick: newChat })] });
  const list = el('ul', { class: 'card list jakegpt-list', 'aria-label': 'Chats' });
  list.hidden = true;
  const empty = el('div', { class: 'jakegpt-empty' },
    emptyState('No chats yet.'),
    el('button', { class: 'button', type: 'button', text: 'New chat', 'on:click': newChat }));
  empty.hidden = true;
  app.root.replaceChildren(header, el('div', { class: 'app-content' }, list, empty));

  const v = {
    kind: 'list',
    list,
    empty,
    conversations: [],
    loaded: false,
    inflight: false,
    teardown() {},
    async refresh() {
      if (v.inflight) return;
      v.inflight = true;
      try {
        const data = await api('/api/jakegpt/conversations');
        if (view !== v) return;
        v.conversations = Array.isArray(data.conversations) ? data.conversations : [];
        v.loaded = true;
        renderList(v);
      } catch {
        /* keep what is on screen; the banner reports the outage */
      } finally {
        v.inflight = false;
      }
    },
  };
  view = v;
  v.refresh();
}

function renderList(v) {
  v.list.replaceChildren(...v.conversations.map((c) => conversationRow(v, c)));
  v.list.hidden = v.conversations.length === 0;
  v.empty.hidden = !(v.loaded && v.conversations.length === 0);
}

function conversationRow(v, c) {
  const title = c.title || 'New chat';
  const open = el('button', { class: 'jakegpt-row-main', type: 'button', 'on:click': () => nav.go(`#/jakegpt/${c.id}`) },
    el('span', { class: 'jakegpt-row-title', text: title }),
    el('span', { class: 'jakegpt-row-sub', text: `${shortModel(c.model)} · ${fmt.relTime(c.updated_at)}` }));
  const more = el('button', {
    class: 'jakegpt-row-more', type: 'button', 'aria-label': `More for ${title}`, 'on:click': () => deleteFromList(v, c),
  }, icon('more'));
  return el('li', { class: 'jakegpt-row', dataset: { id: c.id } }, open, more);
}

async function deleteFromList(v, c) {
  haptic('light');
  const ok = await confirmSheet({
    title: c.title || 'New chat',
    message: 'Delete this chat and its messages?',
    confirmLabel: 'Delete chat',
    destructive: true,
  });
  if (!ok || view !== v) return;
  const before = v.conversations;
  v.conversations = v.conversations.filter((x) => x.id !== c.id);
  renderList(v);
  try {
    await api(`/api/jakegpt/conversations/${c.id}`, { method: 'DELETE' });
    haptic('success');
  } catch (err) {
    if (view !== v) return;
    if (err && err.status === 404) return; // already gone
    v.conversations = before;
    renderList(v);
    toast(failureMessage(err, 'delete'), { kind: 'error' });
    haptic('error');
  }
}

// ---------------------------------------------------------------- chat view

function showChat(id) {
  if (view && view.kind === 'chat' && view.id === id) return;
  teardownView();
  const root = app.root;
  const modelName = el('span', { class: 'jakegpt-model-name', text: 'Model' });
  const modelBtn = el('button', { class: 'nav-btn jakegpt-model-btn', type: 'button', 'aria-label': 'Choose model' },
    modelName, icon('chevron-down', { size: 18 }));
  const header = navbar({ title: id ? '' : 'New chat', back: true, right: [modelBtn], onBack: backToList });
  const thread = el('div', { class: 'jakegpt-thread', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text' });
  const content = el('div', { class: 'app-content jakegpt-content' }, thread);
  const ta = el('textarea', {
    class: 'jakegpt-ta', rows: '1', placeholder: 'Message', 'aria-label': 'Message', autocomplete: 'off',
    autocapitalize: 'sentences', enterkeyhint: desktopInput.matches ? 'send' : 'enter',
  });
  const sendBtn = el('button', { class: 'jakegpt-send', type: 'button', 'aria-label': 'Send', disabled: true }, icon('send', { size: 22, strokeWidth: 2.6 }));
  const composer = el('div', { class: 'jakegpt-composer' }, el('div', { class: 'jakegpt-composer-inner' }, ta, sendBtn));
  root.replaceChildren(header, content, composer);

  const v = {
    kind: 'chat',
    id,
    conv: null,
    model: null,          // the draft's model (before the conversation exists)
    messages: [],
    stream: null,         // { ctrl, el, md, cursor, text, gotDelta, hintTimer, raf, messageId }
    header, thread, content, ta, sendBtn, composer, modelName,
    timers: [],
    listeners: [],
    pinned: true,         // auto-scroll while the reader stays near the bottom
    refresh() {
      if (v.conv && !v.stream) loadConversation(v, { quiet: true });
    },
    teardown() {
      if (v.stream) stopStream(v, { silent: true });
      for (const t of v.timers) clearTimeout(t);
      for (const [target, type, fn] of v.listeners) target.removeEventListener(type, fn);
      releaseReload(HOLD_TYPING);
      releaseReload(HOLD_STREAM);
    },
  };
  view = v;
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    v.listeners.push([target, type, fn]);
  };

  on(modelBtn, 'click', () => pickModel(v));
  on(sendBtn, 'click', () => (v.stream ? stopStream(v) : send(v)));
  on(ta, 'input', () => {
    autosize(v);
    syncSend(v);
    syncTypingHold(v);
    store.set(draftKey(v), ta.value);
  });
  on(ta, 'focus', () => syncTypingHold(v));
  on(ta, 'blur', () => releaseReload(HOLD_TYPING));
  on(ta, 'keydown', (event) => {
    // Enter sends with a keyboard + mouse; on the phone Enter is a newline and Send is the button.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && desktopInput.matches) {
      event.preventDefault();
      if (!v.stream) send(v);
    }
  });
  const scroller = scrollerOf(v);
  on(scroller, 'scroll', () => {
    v.pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX;
  }, { passive: true });
  // Keep the composer above the on-screen keyboard (the visual viewport shrinks in WKWebView).
  if (window.visualViewport) {
    const place = () => {
      const vv = window.visualViewport;
      const offset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      composer.style.transform = offset ? `translateY(-${offset}px)` : '';
    };
    on(window.visualViewport, 'resize', place);
    on(window.visualViewport, 'scroll', place);
  }

  const draft = store.get(draftKey(v), '');
  if (typeof draft === 'string' && draft) ta.value = draft;
  autosize(v);
  syncSend(v);

  if (id) {
    loadConversation(v);
  } else {
    loadModels().then((m) => {
      if (view !== v) return;
      v.model = m.default;
      renderModel(v);
    }).catch((err) => {
      if (view !== v) return;
      toast(failureMessage(err, 'reach Ollama'), { kind: 'error' });
    });
  }
}

function draftKey(v) {
  return `jakegpt.draft.${v.id || 'new'}`;
}

function scrollerOf(v) {
  return v.content.closest('.applayer') || document.getElementById('app') || document.scrollingElement;
}

// ‹ Back: history.back() lands on the list when it was shown in this session; a deep link
// (or a reload inside a chat) has no list behind it, so swap the entry instead.
function backToList() {
  if (app && app.sawList) nav.back();
  else nav.replace('#/jakegpt');
}

async function loadConversation(v, { quiet = false } = {}) {
  try {
    const data = await api(`/api/jakegpt/conversations/${v.id}`);
    if (view !== v || v.stream) return;
    v.conv = data.conversation;
    v.messages = Array.isArray(data.messages) ? data.messages : [];
    renderTitle(v);
    renderModel(v);
    renderMessages(v);
    scrollToBottom(v, true);
  } catch (err) {
    if (view !== v) return;
    if (err && err.status === 404) {
      toast('That chat is gone');
      nav.replace('#/jakegpt');
      return;
    }
    if (!quiet) toast(failureMessage(err, 'load the chat'), { kind: 'error' });
  }
}

function renderTitle(v) {
  v.header.setTitle(v.conv ? (v.conv.title || 'New chat') : 'New chat');
}

function renderModel(v) {
  const name = v.conv ? v.conv.model : v.model;
  v.modelName.textContent = name ? navModel(name) : 'Model';
  v.modelName.title = name ? shortModel(name) : '';
  v.modelName.classList.toggle('muted', !name);
}

function renderMessages(v) {
  v.thread.replaceChildren(...v.messages.map((m) => messageNode(m)));
}

function messageNode(m) {
  if (m.role === 'user') {
    return el('div', { class: 'jakegpt-msg user' }, el('div', { class: 'jakegpt-bubble', text: m.content }));
  }
  if (m.role === 'system') {
    return el('div', { class: 'jakegpt-msg system' }, el('div', { class: 'jakegpt-system', text: m.content }));
  }
  return el('div', { class: 'jakegpt-msg assistant' }, el('div', { class: 'md jakegpt-md', html: renderMarkdownLite(m.content) }));
}

// A reply still being typed has an open ``` more often than not: close it for the render so
// the code block does not flash as plain text until the fence arrives.
function renderPartial(md, text, cursor) {
  let src = text;
  const fences = (src.match(/```/g) || []).length;
  if (fences % 2) src += '\n```';
  // A list whose next marker ("-", "*", "3.") has just arrived would otherwise fall back to
  // plain lines until the item's first word lands: pad it so it stays a list.
  src = src.replace(/(^|\n)([-*]|\d+[.)])$/, '$1$2 ');
  md.innerHTML = renderMarkdownLite(src);
  if (cursor) placeCursor(md, cursor);
}

function placeCursor(md, cursor) {
  let host = md.lastElementChild;
  if (host && (host.tagName === 'UL' || host.tagName === 'OL')) host = host.lastElementChild || host;
  if (!host || host.tagName === 'PRE') host = md;
  host.append(cursor);
}

function scrollToBottom(v, force = false) {
  if (!force && !v.pinned) return;
  const scroller = scrollerOf(v);
  scroller.scrollTop = scroller.scrollHeight;
  v.pinned = true;
}

function autosize(v) {
  const ta = v.ta;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, TEXTAREA_MAX_PX)}px`;
  ta.style.overflowY = ta.scrollHeight > TEXTAREA_MAX_PX ? 'auto' : 'hidden';
  const h = v.composer.offsetHeight;
  if (h !== v.composerH) {
    v.content.style.setProperty('--jakegpt-composer-h', `${h}px`);
    // A taller composer covers the last line unless the thread follows it down.
    if (v.composerH !== undefined && v.pinned) scrollToBottom(v, true);
    v.composerH = h;
  }
}

// Send while idle (disabled when the field is empty); Stop while a reply streams.
function syncSend(v) {
  const btn = v.sendBtn;
  if (v.stream) {
    btn.classList.add('stop');
    btn.disabled = false;
    btn.setAttribute('aria-label', 'Stop');
    btn.replaceChildren(icon('stop', { size: 18, strokeWidth: 2.6 }));
  } else {
    btn.classList.remove('stop');
    btn.disabled = v.ta.value.trim().length === 0;
    btn.setAttribute('aria-label', 'Send');
    btn.replaceChildren(icon('send', { size: 22, strokeWidth: 2.6 }));
  }
}

function syncTypingHold(v) {
  if (document.activeElement === v.ta && v.ta.value.trim()) holdReload(HOLD_TYPING);
  else releaseReload(HOLD_TYPING);
}

async function pickModel(v) {
  let models;
  try {
    models = await loadModels(true);
  } catch (err) {
    if (view !== v) return;
    toast(failureMessage(err, 'list models'), { kind: 'error' });
    return;
  }
  if (view !== v) return;
  const current = v.conv ? v.conv.model : v.model;
  const actions = models.models.map((m) => ({
    label: m.size ? `${m.name} · ${fmt.bytes(m.size)}` : m.name,
    value: m.name,
    selected: m.name === current,
  }));
  if (!actions.length) {
    toast('Ollama has no chat models yet');
    return;
  }
  const value = await actionSheet({ title: 'Model', actions });
  if (!value || view !== v || value === current) return;
  if (!v.conv) {
    v.model = value;
    renderModel(v);
    return;
  }
  const before = v.conv.model;
  v.conv.model = value;
  renderModel(v);
  try {
    const data = await api(`/api/jakegpt/conversations/${v.id}`, { method: 'PATCH', body: { model: value } });
    if (view === v && data && data.conversation) v.conv = data.conversation;
  } catch (err) {
    if (view !== v) return;
    v.conv.model = before;
    renderModel(v);
    toast(failureMessage(err, 'change the model'), { kind: 'error' });
  }
}

// ---------------------------------------------------------------- sending + streaming

async function send(v) {
  const text = v.ta.value.trim();
  if (!text || v.stream) return;
  haptic('light');
  v.ta.value = '';
  store.del(draftKey(v));
  autosize(v);
  syncSend(v);
  releaseReload(HOLD_TYPING);

  const giveBack = () => {
    if (view !== v) return;
    if (!v.ta.value) {
      v.ta.value = text;
      store.set(draftKey(v), text);
    }
    autosize(v);
    syncSend(v);
  };

  // A draft becomes a real conversation on its first message.
  let createdNow = false;
  if (!v.conv) {
    try {
      const data = await api('/api/jakegpt/conversations', { method: 'POST', body: v.model ? { model: v.model } : {} });
      if (view !== v) return;
      v.conv = data.conversation;
      v.id = v.conv.id;
      createdNow = true;
      store.del('jakegpt.draft.new');
      nav.replace(`#/jakegpt/${v.id}`); // route() sees this view already shows that id
      renderModel(v);
    } catch (err) {
      if (view !== v) return;
      giveBack();
      toast(failureMessage(err, 'start the chat'), { kind: 'error' });
      haptic('error');
      return;
    }
  }

  const prevTitle = v.conv.title;
  const userMsg = { id: null, role: 'user', content: text, created_at: new Date().toISOString() };
  const userEl = messageNode(userMsg);
  v.messages.push(userMsg);
  const md = el('div', { class: 'md jakegpt-md' });
  const cursor = el('span', { class: 'jakegpt-cursor', 'aria-hidden': 'true' });
  const asstEl = el('div', { class: 'jakegpt-msg assistant streaming' }, md);
  md.append(cursor);
  v.thread.append(userEl, asstEl);
  if (!v.conv.title) {
    v.conv.title = autoTitle(text);
    renderTitle(v);
  }
  scrollToBottom(v, true);

  const ctrl = new AbortController();
  const s = { ctrl, el: asstEl, md, cursor, text: '', gotDelta: false, hintTimer: 0, raf: 0, messageId: null, serverError: null };
  v.stream = s;
  holdReload(HOLD_STREAM);
  syncSend(v);
  s.hintTimer = setTimeout(() => {
    if (v.stream === s && !s.gotDelta) {
      md.replaceChildren(el('p', { class: 'jakegpt-hint', text: 'Loading model…' }), cursor);
    }
  }, LOADING_HINT_MS);

  let res;
  try {
    res = await api(`/api/jakegpt/conversations/${v.id}/messages`, {
      method: 'POST', body: { content: text }, raw: true, timeout: HEADERS_TIMEOUT_MS, signal: ctrl.signal,
    });
  } catch (err) {
    // Nothing streamed. The server rolled the user message back (a 4xx/5xx answer), so hand
    // the text back; a Stop (aborted) or a lost connection keeps what was sent.
    if (view !== v) return;
    endStream(v, s);
    asstEl.remove();
    const aborted = err && err.status === 0 && err.message === 'aborted';
    if (!aborted) {
      userEl.remove();
      v.messages = v.messages.filter((m) => m !== userMsg);
      v.conv.title = prevTitle;
      renderTitle(v);
      giveBack();
      toast(failureMessage(err, 'send'), { kind: 'error' });
      haptic('error');
      if (createdNow && err.status) {
        // The row exists but is empty: drop it and go back to being a draft.
        api(`/api/jakegpt/conversations/${v.id}`, { method: 'DELETE' }).catch(() => {});
        v.conv = null;
        v.id = null;
        renderModel(v);
        nav.replace('#/jakegpt/new');
      }
    }
    return;
  }

  const handleLine = (line) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof obj.delta === 'string' && obj.delta) {
      s.text += obj.delta;
      if (!s.gotDelta) {
        s.gotDelta = true;
        clearTimeout(s.hintTimer);
      }
      scheduleRender(v, s);
    }
    if (obj.done) {
      s.messageId = obj.message_id || null;
      if (obj.title && v.conv) {
        v.conv.title = obj.title;
        renderTitle(v);
      }
    }
    if (obj.error) s.serverError = String(obj.error);
  };

  let lost = false;
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
  } catch {
    lost = !ctrl.signal.aborted; // an abort is the Stop button; anything else is the connection
  }
  if (view !== v || v.stream !== s) return;

  // Finalise the bubble with whatever arrived.
  endStream(v, s);
  cancelAnimationFrame(s.raf);
  if (s.text) {
    md.innerHTML = renderMarkdownLite(s.text);
    asstEl.classList.remove('streaming');
    v.messages.push({ id: s.messageId, role: 'assistant', content: s.text, created_at: new Date().toISOString() });
  } else {
    asstEl.remove();
  }
  if (s.serverError) toast(s.serverError, { kind: 'error' });
  else if (lost) toast('Connection lost — the reply may be incomplete', { kind: 'error' });
  else if (ctrl.signal.aborted) toast('Stopped');
  else haptic('success');
  scrollToBottom(v);
}

function scheduleRender(v, s) {
  if (s.raf) return;
  s.raf = requestAnimationFrame(() => {
    s.raf = 0;
    if (v.stream !== s) return;
    renderPartial(s.md, s.text, s.cursor);
    scrollToBottom(v);
  });
}

function endStream(v, s) {
  clearTimeout(s.hintTimer);
  if (v.stream === s) v.stream = null;
  releaseReload(HOLD_STREAM);
  if (view === v) syncSend(v);
}

// Stop: abort the fetch; the server saves what it had received so far.
function stopStream(v, { silent = false } = {}) {
  const s = v.stream;
  if (!s) return;
  if (!silent) haptic('light');
  s.ctrl.abort();
  if (silent) endStream(v, s);
}
