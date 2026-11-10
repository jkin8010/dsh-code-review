// Preview harness: boots the *real* plugins/dsh-code-review/client.js against a
// mocked DSH host (module loader, slots, locale, connection.rpc).
//
// URL params:
//   ?view=overview|reviews|detail|projects|architecture|flow|launch|settings
//   ?lang=zh|en        ?theme=dark        ?job=<jobId>
//
// The page exposes window.__PREVIEW__ for the Playwright shooter.

const params = new URLSearchParams(window.location.search);
const view = params.get('view') || 'overview';
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') || 'dark';
const jobParam = params.get('job') || '';
// Test hook: `?engine=delegate` rewrites the fixture's job engines + LLM health
// so the preview smoke test covers all three engine states (ocr/delegate/structural).
const engineOverride = params.get('engine') || '';

const React = window.React;
const ReactDOM = window.ReactDOM;

const errors = [];
window.__ERRORS__ = errors;
window.addEventListener('error', (event) => {
  errors.push(`window.error: ${event.message || ''} ${event.filename || ''}`);
});
window.addEventListener('unhandledrejection', (event) => {
  errors.push(`unhandledrejection: ${event.reason?.message || event.reason}`);
});
const consoleError = console.error.bind(console);
console.error = (...args) => {
  errors.push(`console.error: ${args.map((arg) => (arg && arg.message) || String(arg)).join(' ')}`);
  consoleError(...args);
};
const consoleWarn = console.warn.bind(console);
console.warn = (...args) => {
  consoleWarn(...args);
};

// -- mock locale -------------------------------------------------------------

const localeSubs = new Set();
const registeredLocales = {};
const initialSnapshot = { id: lang, locale: lang };
const locale = {
  getSnapshot: () => initialSnapshot,
  subscribe(fn) {
    localeSubs.add(fn);
    return () => localeSubs.delete(fn);
  },
  register(id, dict) {
    registeredLocales[id] = dict;
    return () => {
      delete registeredLocales[id];
    };
  },
};

// -- mock slots --------------------------------------------------------------

let mainComponent = null;
let sidebarIcon = null;
const slotRecords = [];
const slots = {
  inject(_name, factory) {
    if (typeof factory === 'function') factory();
  },
  register(spec, component) {
    slotRecords.push({ spec, component });
    if (spec && spec.name === 'main') mainComponent = component;
    if (spec && spec.name === 'sidebar.panellist') sidebarIcon = component;
    return () => {};
  },
};

// -- mock connection + rpc ---------------------------------------------------

const { createMockApi } = await import('./mock.js');
const api = createMockApi();
const rpcCalls = [];
let rpcCount = 0;

const connection = {
  rpc: {
    async call(path, method, body) {
      rpcCount += 1;
      rpcCalls.push({ path, method, body, at: Date.now() });
      const delay = rpcCount === 1 ? 180 : 18;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const envelope = api.call(body && body.method, (body && body.payload) || {});
      if (!envelope.ok) {
        return envelope;
      }
      if (engineOverride && envelope.value && typeof envelope.value === 'object') {
        const patch = (value) => {
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value.jobs)) {
            value.jobs.forEach((job) => {
              if (job && typeof job === 'object') job.engine = engineOverride;
            });
          }
          if (value.job && typeof value.job === 'object') value.job.engine = engineOverride;
          if (value.health && value.health.llm) {
            value.health.llm = { ...value.health.llm, state: 'delegate', source: 'dsh', provider: 'dsh' };
          }
          if (value.config && typeof value.config === 'object') {
            value.config.llmConfigured = true;
            value.config.engineMode = 'delegate';
          }
        };
        patch(envelope.value);
      }
      return envelope;
    },
  },
};

// -- mock ctx + module loader ------------------------------------------------

const cleanups = [];
// Stands in for the DSH Client Remote namespace used by the old-Host fallback.
const mockRemote = {
  session: {
    create: async (request) => {
      window.__FIX_CREATE__ = request;
      return { ok: true, value: { sessionId: 'session-fallback-fix' } };
    },
    prompt: async (request) => {
      window.__FIX_PROMPT__ = request;
      return { ok: true, value: { accepted: true } };
    },
  },
};
const mockUiWorkspace = {
  startSession: (workspaceId, options) => {
    window.__START_SESSION__ = { workspaceId, options };
  },
};
const mockWorkspaces = {
  list: {
    getSnapshot: () => ({
      items: [{ workspaceId: 'ws-demo', path: '/Users/jkin/workspace/jkin8010/mopng-api' }],
    }),
  },
  create: async () => ({ workspaceId: 'ws-demo' }),
};
const ctx = {
  connection,
  remote: mockRemote,
  get(name) {
    if (name === 'locale') return locale;
    if (name === 'connection') return connection;
    if (name === 'remote') return mockRemote;
    if (name === 'workspaces') return mockWorkspaces;
    if (name === 'uiWorkspace') return mockUiWorkspace;
    return undefined;
  },
  effect(fn, _label) {
    if (typeof fn === 'function') {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
    }
    return () => {};
  },
  slots,
};

let entry = null;
window.__ModuleLoader__ = {
  load(spec) {
    entry = spec.factory((name) => {
      if (name === 'react') return React;
      throw new Error(`[preview] unexpected require('${name}') — the client must only require react`);
    });
  },
};

function loadClient() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '../../../plugins/dsh-code-review/client.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('[preview] failed to load plugins/dsh-code-review/client.js'));
    document.body.appendChild(script);
  });
}

// -- boot --------------------------------------------------------------------

async function boot() {
  await loadClient();
  if (!entry) throw new Error('[preview] client.js did not call window.__ModuleLoader__.load');
  if (typeof entry.apply !== 'function') throw new Error('[preview] client entry has no apply(ctx)');
  entry.apply(ctx);
  if (!mainComponent) throw new Error("[preview] client did not register the 'main' slot");

  document.documentElement.dataset.theme = theme;
  document.documentElement.setAttribute('data-ds-theme-source', theme);
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
  else document.body.removeAttribute('data-ds-dark-theme');
  document.documentElement.dataset.lang = lang;

  window.__PREVIEW__ = {
    view,
    lang,
    theme,
    jobId: jobParam,
    get ready() {
      return document.documentElement.dataset.previewReady === '1';
    },
    entries: entry.inject || [],
    slotRecords,
    sidebarIcon,
    locale: registeredLocales,
    rpcCalls,
    api,
    get main() {
      return mainComponent;
    },
  };

  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(mainComponent, {
    initialView: view,
    initialLang: lang,
    initialJobId: jobParam,
    initialTheme: theme,
  }));

  // one frame + one macrotask so effects/pollers have run
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.dataset.previewReady = '1';
    });
  });
}

boot().catch((error) => {
  errors.push(`boot: ${error?.message || error}`);
  document.getElementById('root').textContent = `boot failed: ${error?.message || error}`;
});
