window.__ModuleLoader__.load({
  id: '@jkin8010/dsh-code-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // =====================================================================
    // 1. 常量 / 字典
    // =====================================================================

    const PLUGIN_VERSION = '0.8.0';
    const ENDPOINT = 'code-review';
    const PANEL_ID = 'code-review';
    const PANEL_ORDER = 24;
    const PANEL_LABEL = '代码评审中心';

    const POLL_FALLBACK_MS = 2000;
    const RETRY_MIN_MS = 1000;
    const RETRY_MAX_MS = 15000;
    const FLASH_MS = 1800;

    const SEVERITIES = ['critical', 'high', 'medium', 'low'];
    const SEV_META = {
      critical: { label: '严重', color: 'var(--danger)', soft: 'rgba(255,93,108,.13)' },
      high: { label: '高', color: 'var(--high)', soft: 'rgba(255,143,77,.13)' },
      medium: { label: '中', color: 'var(--medium)', soft: 'rgba(255,209,102,.12)' },
      low: { label: '低', color: 'var(--low)', soft: 'rgba(110,168,254,.13)' },
    };
    const CATEGORY_LABEL = {
      bug: '缺陷', security: '安全', performance: '性能', maintainability: '可维护性',
      test: '测试', style: '风格', documentation: '文档', other: '其他',
    };
    const CATEGORIES = Object.keys(CATEGORY_LABEL);
    const TYPE_META = {
      workspace: { label: '当前改动', short: '改动', hint: 'staged + unstaged + untracked', color: 'var(--accent)' },
      commit: { label: '单次提交', short: '提交', hint: 'ocr review --commit <sha>', color: 'var(--low)' },
      range: { label: '分支对比', short: '对比', hint: 'merge-base 语义 -from/-to', color: 'var(--purple)' },
      architecture: { label: '项目架构', short: '架构', hint: '模块依赖图 / 环 / 热点', color: 'var(--medium)' },
      module: { label: '代码模块', short: '模块', hint: '指定目录或文件', color: 'var(--warn-soft)' },
      flow: { label: '信息流', short: '信息流', hint: '入口 → 服务 → 数据', color: 'var(--accent-2-soft)' },
    };
    const STATUS_META = {
      queued: { label: '排队中', color: 'var(--muted)' },
      running: { label: '评审中', color: 'var(--accent)' },
      completed: { label: '已完成', color: 'var(--success)' },
      failed: { label: '失败', color: 'var(--danger)' },
      cancelled: { label: '已取消', color: 'var(--medium)' },
    };
    const STAGE_LABEL = {
      resolve: '解析项目', plan: '选取文件', structure: '结构分析',
      ai: 'AI 评审', merge: '汇总去重', report: '生成报告',
    };
    const TABS = [
      { key: 'overview', label: '总览', icon: 'grid' },
      { key: 'reviews', label: '评审', icon: 'list' },
      { key: 'projects', label: '项目', icon: 'folder' },
      { key: 'architecture', label: '架构', icon: 'graph' },
      { key: 'flow', label: '信息流', icon: 'flow' },
    ];
    // 三引擎：ocr（OCR CLI + LLM）/ delegate（OCR 选文件 + DSH 当前会话模型）/ structural（离线结构分析）
    const ENGINE_META = {
      ocr: { label: 'ocr', color: 'var(--accent)', soft: 'rgba(53,224,200,.1)', border: 'rgba(53,224,200,.22)' },
      delegate: { label: 'delegate', color: 'var(--accent-2-soft)', soft: 'rgba(124,199,255,.1)', border: 'rgba(124,199,255,.26)' },
      structural: { label: 'structural', color: 'var(--purple)', soft: 'rgba(185,166,255,.1)', border: 'rgba(185,166,255,.24)' },
    };
    // delegate 的评审由 DSH 当前会话模型执行。
    const ENGINE_SUBTITLE = {
      ocr: 'OCR + LLM 综合评审',
      delegate: 'OCR 选文件 + DSH 模型评审',
      structural: 'structural 引擎：离线结构分析',
    };
    const HEAT_LEVELS = ['var(--panel-2)', 'var(--accent-bg)', 'var(--accent-bg)', 'var(--accent-deep)', 'var(--accent)'];
    const HEAT_EMPTY = 'var(--code-bg)';
    const LEVEL_ORDER = ['low', 'medium', 'high', 'critical'];

    // UI 文案固定中文；locale/zh.json、locale/en.json 只提供 meta。
    const dict = {
      meta: {
        title: PANEL_LABEL,
        description: '基于 open-code-review 的代码评审工作台：多维评审、实时进度、GitHub 风格热力图与问题追踪。',
      },
    };

    const pickTitle = () => {
      const meta = dict && dict.meta;
      return (meta && meta.title) || PANEL_LABEL;
    };

    // =====================================================================
    // 2. 工具函数
    // =====================================================================

    const str = (value, fallback) => (value == null || value === '' ? (fallback == null ? '' : fallback) : String(value));
    const num = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : (fallback == null ? 0 : fallback);
    };
    const arr = (value) => (Array.isArray(value) ? value : []);
    const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const ratio = (a, b) => (num(b) > 0 ? clamp(num(a) / num(b), 0, 1) : 0);
    const percent = (a, b) => Math.round(ratio(a, b) * 100);

    function fmtInt(value) {
      const n = Math.round(num(value));
      return n.toLocaleString('en-US');
    }

    function fmtCompact(value) {
      const n = num(value);
      if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
      if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
      return fmtInt(n);
    }

    function fmtMs(ms) {
      const value = num(ms);
      if (value <= 0) return '—';
      if (value < 1000) return `${Math.round(value)}ms`;
      if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
      if (value < 3600000) {
        const minutes = Math.floor(value / 60000);
        const seconds = Math.round((value % 60000) / 1000);
        return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
      }
      return `${Math.floor(value / 3600000)}小时`;
    }

    function parseTs(value) {
      const ts = Date.parse(str(value));
      return Number.isFinite(ts) ? ts : 0;
    }

    function fmtAgo(value, reference) {
      const ts = typeof value === 'number' ? value : parseTs(value);
      if (!ts) return '—';
      const diff = Math.max(0, (reference || Date.now()) - ts);
      if (diff < 1000) return '刚刚';
      if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
      if (diff < 30 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
      return `${Math.floor(diff / (30 * 86400000))} 个月前`;
    }

    const pad2 = (n) => String(n).padStart(2, '0');

    function fmtClock(value) {
      const ts = typeof value === 'number' ? value : parseTs(value);
      if (!ts) return '—';
      const date = new Date(ts);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function fmtStamp(value) {
      const ts = typeof value === 'number' ? value : parseTs(value);
      if (!ts) return '—';
      const date = new Date(ts);
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function fmtDayMonth(value) {
      const ts = typeof value === 'number' ? value : parseTs(value);
      if (!ts) return '—';
      const date = new Date(ts);
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    function dayKeyOf(ts) {
      const date = new Date(ts);
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    function parseDayKey(key) {
      const parts = str(key).split('-').map(Number);
      if (parts.length < 3 || !parts.every(Number.isFinite)) return 0;
      return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0).getTime();
    }

    function weekdayOfKey(key) {
      const ts = parseDayKey(key);
      return ts ? new Date(ts).getDay() : 0;
    }

    function monthOfKey(key) {
      const ts = parseDayKey(key);
      return ts ? new Date(ts).getMonth() + 1 : 0;
    }

    function heatLevel(value, max) {
      const v = num(value);
      if (v <= 0) return 0;
      const m = Math.max(1, num(max, 1));
      if (v <= m * 0.25) return 1;
      if (v <= m * 0.5) return 2;
      if (v <= m * 0.78) return 3;
      return 4;
    }

    function errorText(error) {
      if (!error) return '未知错误';
      if (typeof error === 'string') return error;
      return str(error.message || error.code || error.stack, '未知错误');
    }

    function unwrapEnvelope(value, accept) {
      let current = value;
      for (let depth = 0; depth < 4; depth += 1) {
        if (current == null || typeof current !== 'object') return null;
        if (accept(current)) return current;
        if (current.value !== undefined) { current = current.value; continue; }
        if (current.result !== undefined) { current = current.result; continue; }
        if (current.data !== undefined) { current = current.data; continue; }
        return null;
      }
      return null;
    }

    async function copyToClipboard(text) {
      const value = str(text);
      if (!value) return false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {
        /* 落回 textarea 方案 */
      }
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    function severityCounts(findings) {
      const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
      arr(findings).forEach((finding) => {
        const key = SEVERITIES.includes(finding && finding.severity) ? finding.severity : 'low';
        counts[key] += 1;
        counts.total += 1;
      });
      return counts;
    }

    function sortFindings(list) {
      return arr(list).slice().sort((a, b) => {
        const rankA = SEVERITIES.indexOf(a && a.severity);
        const rankB = SEVERITIES.indexOf(b && b.severity);
        if (rankA !== rankB) return rankA - rankB;
        const pathA = str(a && a.path);
        const pathB = str(b && b.path);
        if (pathA !== pathB) return pathA.localeCompare(pathB);
        return num(a && a.startLine) - num(b && b.startLine);
      });
    }

    function jobFiles(job) {
      const plan = obj(job && job.plan);
      return arr(plan.files);
    }

    function jobFailures(job) {
      const stages = arr(job && job.stages);
      return stages.filter((stage) => str(stage.status) === 'failed').length;
    }

    // =====================================================================
    // 3. hooks
    // =====================================================================

    const ToastCtx = React.createContext(() => {});

    function useToast() {
      return React.useContext(ToastCtx);
    }

    function useCountUp(target, duration) {
      const [display, setDisplay] = React.useState(0);
      const fromRef = React.useRef(0);
      const rafRef = React.useRef(0);
      React.useEffect(() => {
        const to = num(target);
        const from = fromRef.current;
        if (from === to) {
          setDisplay(to);
          return undefined;
        }
        const span = duration == null ? 760 : duration;
        const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const step = () => {
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          const progress = clamp((now - started) / span, 0, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          const value = from + (to - from) * eased;
          fromRef.current = value;
          setDisplay(value);
          if (progress < 1) rafRef.current = requestAnimationFrame(step);
          else fromRef.current = to;
        };
        rafRef.current = requestAnimationFrame(step);
        return () => cancelAnimationFrame(rafRef.current);
      }, [target, duration]);
      return display;
    }

    function useNow(intervalMs) {
      const [now, setNow] = React.useState(Date.now());
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs || 1000);
        return () => clearInterval(timer);
      }, [intervalMs]);
      return now;
    }

    function useRpc(connection) {
      return React.useCallback(async (method, payload) => {
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          throw new Error('DSH connection is not ready');
        }
        const envelope = await connection.rpc.call('/api', ENDPOINT, { method, payload: payload || {} }, undefined);
        if (envelope && envelope.ok === false) {
          throw new Error(errorText(obj(envelope.error).message || envelope.error));
        }
        return envelope;
      }, [connection]);
    }

    /**
     * snapshot 轮询：成功按 pollSeconds*1000，失败退避（1s → 15s），
     * 失败期间保留最后一份好数据，link.ok=false 时 HUD 显示降级提示。
     */
    function useSnapshotPolling(connection, pollMs) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [link, setLink] = React.useState({ ok: true, error: '', failures: 0, retryMs: 0, lastOkAt: 0, tick: 0 });
      const rpc = useRpc(connection);
      const aliveRef = React.useRef(true);
      const inFlightRef = React.useRef(false);
      const failuresRef = React.useRef(0);
      const pendingRef = React.useRef(null);
      const snapshotRef = React.useRef(null);

      const accept = React.useCallback((candidate) => (
        candidate && typeof candidate === 'object'
        && (candidate.version != null || candidate.generatedAt != null || candidate.config || candidate.overview || candidate.health)
      ), []);

      const apply = React.useCallback((next) => {
        snapshotRef.current = next;
        setSnapshot(next);
      }, []);

      const fetchOnce = React.useCallback(async () => {
        if (!aliveRef.current || inFlightRef.current) return null;
        inFlightRef.current = true;
        try {
          const envelope = await rpc('snapshot', {});
          if (!aliveRef.current) return null;
          const next = unwrapEnvelope(envelope, accept);
          if (!next) throw new Error('snapshot 响应无法识别');
          failuresRef.current = 0;
          apply(next);
          setLink((current) => ({
            ok: true, error: '', failures: 0, retryMs: 0,
            lastOkAt: Date.now(), tick: current.tick + 1,
          }));
          return next;
        } catch (error) {
          failuresRef.current += 1;
          const retryMs = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * Math.pow(2, failuresRef.current - 1));
          setLink((current) => ({
            ok: false,
            error: errorText(error),
            failures: failuresRef.current,
            retryMs,
            lastOkAt: current.lastOkAt,
            tick: current.tick + 1,
          }));
          return null;
        } finally {
          inFlightRef.current = false;
        }
      }, [rpc, accept, apply]);

      const retryNow = React.useCallback(() => {
        failuresRef.current = 0;
        setLink((current) => ({ ...current, ok: true, error: '' }));
        void fetchOnce();
      }, [fetchOnce]);

      React.useEffect(() => {
        aliveRef.current = true;
        let interval = null;
        let retry = null;
        let disposed = false;
        const period = Math.max(1000, num(pollMs, POLL_FALLBACK_MS));

        const schedule = () => {
          if (disposed) return;
          if (interval) { clearInterval(interval); interval = null; }
          if (retry) { clearTimeout(retry); retry = null; }
          if (failuresRef.current === 0) {
            interval = setInterval(() => { void fetchOnce(); }, period);
          } else {
            const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * Math.pow(2, failuresRef.current - 1));
            retry = setTimeout(() => { void fetchOnce(); }, delay);
          }
        };

        void fetchOnce().then(() => schedule());

        return () => {
          disposed = true;
          aliveRef.current = false;
          if (interval) clearInterval(interval);
          if (retry) clearTimeout(retry);
        };
        // 仅依赖连接与轮询周期；fetchOnce 内部引用的都是 ref/callback。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [connection, pollMs]);

      return { snapshot, link, retryNow, fetchOnce, snapshotRef, pendingRef };
    }

    function useDetailLoader(connection, detailId, reloadToken = 0) {
      const rpc = useRpc(connection);
      const [detail, setDetail] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState('');
      const requestRef = React.useRef(0);

      React.useEffect(() => {
        if (!detailId) {
          setDetail(null);
          setLoading(false);
          setError('');
          return undefined;
        }
        const requestId = requestRef.current + 1;
        requestRef.current = requestId;
        let alive = true;
        setLoading(true);
        setError('');
        rpc('job', { id: detailId, includeFindings: true })
          .then((envelope) => {
            if (!alive || requestRef.current !== requestId) return;
            const payload = unwrapEnvelope(envelope, (candidate) => candidate && (candidate.job || candidate.findings));
            if (!payload) throw new Error('评审详情响应无法识别');
            setDetail(payload);
          })
          .catch((err) => {
            if (!alive || requestRef.current !== requestId) return;
            setError(errorText(err));
          })
          .finally(() => {
            if (!alive || requestRef.current !== requestId) return;
            setLoading(false);
          });
        return () => { alive = false; };
      }, [detailId, rpc, reloadToken]);

      return { detail, loading, error };
    }

    function useGraphLoader(connection, kind, projectId) {
      const rpc = useRpc(connection);
      const [state, setState] = React.useState({ data: null, loading: false, error: '' });

      React.useEffect(() => {
        if (!kind) return undefined;
        let alive = true;
        setState((current) => ({ data: current.data, loading: true, error: '' }));
        rpc('graph', { kind, projectId: projectId || undefined })
          .then((envelope) => {
            if (!alive) return;
            const payload = unwrapEnvelope(envelope, (candidate) => candidate && (candidate.graph || candidate.findings || candidate.summary));
            if (!payload) throw new Error('图谱响应无法识别');
            setState({ data: payload, loading: false, error: '' });
          })
          .catch((err) => {
            if (!alive) return;
            setState({ data: null, loading: false, error: errorText(err) });
          });
        return () => { alive = false; };
      }, [kind, projectId, rpc]);

      return state;
    }

    // =====================================================================
    // 4. 图标（内联 SVG，禁止第三方图标库）
    // =====================================================================

    const ICON_PATHS = {
      shield: [
        ['path', { d: 'M12 2.8 20.2 6.6v6.1c0 4.5-3.3 7.8-8.2 9.1-4.9-1.3-8.2-4.6-8.2-9.1V6.6Z' }],
        ['path', { d: 'M8.6 12.1l2.5 2.5 4.4-4.9' }],
        ['path', { d: 'M4.4 9.2h15.2M4.4 14.6h15.2', opacity: 0.34 }],
      ],
      grid: [
        ['rect', { x: 3.6, y: 3.6, width: 7, height: 7, rx: 1.6 }],
        ['rect', { x: 13.4, y: 3.6, width: 7, height: 7, rx: 1.6 }],
        ['rect', { x: 3.6, y: 13.4, width: 7, height: 7, rx: 1.6 }],
        ['rect', { x: 13.4, y: 13.4, width: 7, height: 7, rx: 1.6 }],
      ],
      list: [
        ['path', { d: 'M8.5 6.2h11M8.5 12h11M8.5 17.8h11' }],
        ['circle', { cx: 4.6, cy: 6.2, r: 1.1 }],
        ['circle', { cx: 4.6, cy: 12, r: 1.1 }],
        ['circle', { cx: 4.6, cy: 17.8, r: 1.1 }],
      ],
      folder: [
        ['path', { d: 'M3.4 7.6A1.6 1.6 0 0 1 5 6h4.1l2.1 2.6h7.8A1.6 1.6 0 0 1 20.6 10.2v7.2A1.6 1.6 0 0 1 19 19H5a1.6 1.6 0 0 1-1.6-1.6Z' }],
      ],
      graph: [
        ['circle', { cx: 12, cy: 5.2, r: 2.3 }],
        ['circle', { cx: 5, cy: 18.2, r: 2.3 }],
        ['circle', { cx: 19, cy: 18.2, r: 2.3 }],
        ['path', { d: 'M10.7 7.2 6.2 16.2M13.3 7.2l4.5 9M7.3 18.2h9.4' }],
      ],
      flow: [
        ['rect', { x: 2.8, y: 8.4, width: 5.4, height: 7.2, rx: 1.5 }],
        ['rect', { x: 15.8, y: 4.2, width: 5.4, height: 6, rx: 1.5 }],
        ['rect', { x: 15.8, y: 13.8, width: 5.4, height: 6, rx: 1.5 }],
        ['path', { d: 'M8.2 12h3.4M11.6 12V7.2h4.2M11.6 12v4.8h4.2' }],
      ],
      gear: [
        ['circle', { cx: 12, cy: 12, r: 3.1 }],
        ['path', { d: 'M12 2.9v2.3M12 18.8v2.3M2.9 12h2.3M18.8 12h2.3M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6' }],
      ],
      plus: [['path', { d: 'M12 4.8v14.4M4.8 12h14.4' }]],
      close: [['path', { d: 'M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8' }]],
      arrowLeft: [['path', { d: 'M11 5.6 4.6 12l6.4 6.4M4.8 12h14.4' }]],
      refresh: [['path', { d: 'M19.6 12a7.6 7.6 0 1 1-2.2-5.4M19.8 4.2v4.6h-4.6' }]],
      search: [
        ['circle', { cx: 11, cy: 11, r: 6.4 }],
        ['path', { d: 'M15.8 15.8 20.6 20.6' }],
      ],
      chevronDown: [['path', { d: 'M6.4 9.4 12 15l5.6-5.6' }]],
      chevronRight: [['path', { d: 'M9.4 6.4 15 12l-5.6 5.6' }]],
      check: [['path', { d: 'M5 12.4 9.4 16.8 19 6.6' }]],
      clock: [
        ['circle', { cx: 12, cy: 12, r: 8.2 }],
        ['path', { d: 'M12 7.6V12l3.2 2.1' }],
      ],
      file: [
        ['path', { d: 'M6.2 3.6h6.6l5 5V19a1.4 1.4 0 0 1-1.4 1.4H6.2A1.4 1.4 0 0 1 4.8 19V5A1.4 1.4 0 0 1 6.2 3.6Z' }],
        ['path', { d: 'M12.8 3.6v5.2h5.2' }],
      ],
      alert: [
        ['path', { d: 'M12 3.9 21 20.1H3Z' }],
        ['path', { d: 'M12 9.6v4.9M12 17.6v.1' }],
      ],
      play: [['path', { d: 'M8.4 5.4v13.2L18.6 12Z' }]],
      trash: [
        ['path', { d: 'M4.6 7h14.8M9.2 7V4.4h5.6V7M6.4 7l.8 13h9.6l.8-13M10 11v5.6M14 11v5.6' }],
      ],
      zap: [['path', { d: 'M13.2 2.8 5.4 13.4h5.2L10.6 21l7.9-10.6h-5.3Z' }]],
      copy: [
        ['rect', { x: 8.2, y: 8.2, width: 11.4, height: 11.4, rx: 1.8 }],
        ['path', { d: 'M15.8 8.2V5.4A1.8 1.8 0 0 0 14 3.6H5.4A1.8 1.8 0 0 0 3.6 5.4V14a1.8 1.8 0 0 0 1.8 1.8h2.8' }],
      ],
      ban: [
        ['circle', { cx: 12, cy: 12, r: 8.2 }],
        ['path', { d: 'M6.4 6.4 17.6 17.6' }],
      ],
      external: [
        ['path', { d: 'M14 3.6h6.4V10M20.4 3.6l-8.8 8.8' }],
        ['path', { d: 'M18.2 14.2v5A1.4 1.4 0 0 1 16.8 20.6H4.6a1.4 1.4 0 0 1-1.4-1.4V7.4A1.4 1.4 0 0 1 4.6 6h5' }],
      ],
      dot: [['circle', { cx: 12, cy: 12, r: 2.6, fill: 'currentColor', stroke: 'none' }]],
    };

    function Icon(props) {
      const spec = props || {};
      const paths = ICON_PATHS[str(spec.name)] || ICON_PATHS.dot;
      const size = num(spec.size, 15);
      return h('svg', {
        className: `cr-icon ${str(spec.className)}`,
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: num(spec.weight, 1.7),
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: spec.style,
      }, paths.map((entry, index) => h(entry[0], {
        key: `${str(spec.name)}-${index}`,
        ...entry[1],
        fill: entry[1].fill || 'none',
        stroke: entry[1].stroke || 'currentColor',
      })));
    }

    // =====================================================================
    // 5. 样式（单文件，作用域限制在 .cr-app 内）
    // =====================================================================

    const css = `
.cr-app{--bg:#080c14;--panel:#0d1420;--panel-2:#101a28;--line:rgba(255,255,255,.07);
  --line-strong:rgba(255,255,255,.12);--text:#eef4fb;--muted:#dde6f2;--faint:#c6d2e1;
  --accent:#35e0c8;--accent-soft:#8ff3e4;--accent-deep:#1f9785;--accent-bg:rgba(53,224,200,.12);
  --accent-2:#6ea8fe;--accent-2-soft:#7cc7ff;
  --success:#3ddc97;--danger:#ff5d6c;--danger-soft:#ff9aa4;--high:#ff8f4d;--medium:#ffd166;--low:#6ea8fe;
  --purple:#b9a6ff;--warn-soft:#ffe0a1;
  --surface-faint:rgba(255,255,255,.006);--surface-soft:rgba(255,255,255,.025);--surface:rgba(255,255,255,.03);
  --surface-2:rgba(255,255,255,.05);--surface-3:rgba(255,255,255,.07);--hover:rgba(255,255,255,.085);
  --code-bg:#0a1018;--overlay:rgba(9,14,23,.97);--overlay-soft:var(--overlay-soft);--hud-from:rgba(13,20,32,.94);--hud-to:rgba(9,14,22,.74);--hud-soft:rgba(8,12,20,.6);--on-accent:#03120f;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  position:relative;height:100%;width:100%;display:flex;flex-direction:column;overflow:hidden;
  color:var(--text);font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  background:radial-gradient(1100px 520px at 10% -12%,rgba(53,224,200,.10),transparent 62%),
    radial-gradient(920px 480px at 94% -6%,rgba(110,168,254,.09),transparent 60%),var(--bg);}
.cr-app[data-cr-theme="light"]{--bg:#f5f7fb;--panel:#ffffff;--panel-2:#eef2f8;--line:rgba(15,23,42,.10);
  --line-strong:rgba(15,23,42,.18);--text:#0f172a;--muted:#475569;--faint:#64748b;
  --accent:#0e9382;--accent-soft:#0f766e;--accent-deep:#0b6b5f;--accent-bg:rgba(14,147,130,.10);
  --accent-2:#2563eb;--accent-2-soft:#1d4ed8;
  --success:#0f9d6b;--danger:#c81e3a;--danger-soft:#b4233c;--high:#c2410c;--medium:#a16207;--low:#2563eb;
  --purple:#6d4aff;--warn-soft:#92400e;
  --surface-faint:rgba(15,23,42,.015);--surface-soft:rgba(15,23,42,.03);--surface:rgba(15,23,42,.045);
  --surface-2:rgba(15,23,42,.06);--surface-3:rgba(15,23,42,.08);--hover:rgba(15,23,42,.10);
  --code-bg:#f1f5f9;--overlay:rgba(255,255,255,.98);--overlay-soft:rgba(255,255,255,.98);--hud-from:rgba(255,255,255,.94);--hud-to:rgba(255,255,255,.86);--hud-soft:rgba(248,250,252,.9);--on-accent:#ffffff;
  background:radial-gradient(1100px 520px at 10% -12%,rgba(14,147,130,.09),transparent 62%),
    radial-gradient(920px 480px at 94% -6%,rgba(37,99,235,.07),transparent 60%),var(--bg);}
.cr-app *{box-sizing:border-box}
.cr-app button{font-family:inherit}
.cr-mono{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.1px}
.cr-muted{color:var(--muted)}
.cr-faint{color:var(--faint)}
.cr-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.cr-icon{display:block;flex:0 0 auto}

/* ---------- HUD ---------- */
.cr-hud{flex:0 0 auto;display:flex;align-items:center;gap:14px;height:66px;padding:0 20px;
  border-bottom:1px solid var(--line);background:linear-gradient(180deg,var(--hud-from),var(--hud-to));
  backdrop-filter:blur(16px);z-index:6}
.cr-brand{display:flex;align-items:center;gap:11px;min-width:250px}
.cr-brand-mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;color:var(--accent);
  background:linear-gradient(150deg,rgba(53,224,200,.20),rgba(53,224,200,.03));
  border:1px solid rgba(53,224,200,.34);box-shadow:inset 0 0 18px rgba(53,224,200,.13),0 10px 26px -18px rgba(53,224,200,.7)}
.cr-brand-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.cr-brand-title{font-size:15.5px;font-weight:650;letter-spacing:.5px;white-space:nowrap}
.cr-brand-sub{font-family:var(--mono);font-size:10px;letter-spacing:1.9px;color:var(--faint);text-transform:uppercase;white-space:nowrap}
.cr-hud-mid{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.cr-picker{position:relative;display:flex;align-items:center;gap:8px;height:32px;padding:0 10px 0 11px;border-radius:10px;
  border:1px solid var(--line);background:var(--surface)}
.cr-picker:hover{border-color:var(--line-strong)}
.cr-picker-icon{color:var(--accent);display:grid;place-items:center}
.cr-picker select{appearance:none;-webkit-appearance:none;background:transparent;border:0;outline:none;color:var(--text);
  font-size:13.5px;font-weight:620;max-width:186px;padding-right:16px;cursor:pointer}
.cr-picker select option{background:var(--panel);color:var(--text)}
.cr-picker-caret{position:absolute;right:7px;color:var(--muted);pointer-events:none}
.cr-health{display:flex;align-items:center;gap:6px}
.cr-health-chip{display:inline-flex;align-items:center;gap:6px;height:27px;padding:0 9px;border-radius:8px;
  border:1px solid var(--line);background:var(--surface-soft);font-size:11.5px;color:var(--muted);white-space:nowrap}
.cr-health-chip b{font-weight:600;color:var(--muted);font-family:var(--mono);font-size:11px}
.cr-health-chip.is-bad{border-color:rgba(255,93,108,.3);background:rgba(255,93,108,.08);color:var(--danger-soft)}
.cr-health-chip.is-warn{border-color:rgba(255,209,102,.26);background:rgba(255,209,102,.07);color:var(--warn-soft)}
.cr-hud-right{margin-left:auto;display:flex;align-items:center;gap:9px}
.cr-poll{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--muted);white-space:nowrap}
.cr-poll.is-bad{color:var(--danger-soft)}
.cr-poll b{font-family:var(--mono);color:var(--muted);font-size:11px;font-weight:600}
.cr-dot{width:6px;height:6px;border-radius:50%;background:var(--muted);flex:0 0 auto}
.cr-dot.is-live{box-shadow:0 0 0 0 rgba(53,224,200,.6);animation:crPulse 1.9s ease-out infinite}
.cr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:31px;padding:0 12px;border-radius:9px;
  border:1px solid var(--line);background:var(--surface-2);color:var(--muted);font-size:13px;font-weight:620;
  cursor:pointer;white-space:nowrap;transition:background .16s ease,border-color .16s ease,transform .16s ease,filter .16s ease}
.cr-btn:hover{background:var(--hover);border-color:var(--line-strong)}
.cr-btn:active{transform:translateY(1px)}
.cr-btn.is-primary{background:linear-gradient(180deg,var(--accent-soft),var(--accent));color:var(--on-accent);border-color:rgba(53,224,200,.68);
  box-shadow:0 8px 22px -12px rgba(53,224,200,.9)}
.cr-btn.is-primary:hover{filter:brightness(1.07);background:linear-gradient(180deg,var(--accent-soft),var(--accent))}
.cr-btn.is-ghost{background:transparent}
.cr-btn.is-danger{color:var(--danger-soft);border-color:rgba(255,93,108,.3);background:rgba(255,93,108,.08)}
.cr-btn.is-danger:hover{background:rgba(255,93,108,.15)}
.cr-btn.is-sm{height:26px;padding:0 9px;font-size:12px;border-radius:8px}
.cr-btn:disabled{opacity:.45;cursor:not-allowed}
.cr-icon-btn{width:31px;height:31px;display:grid;place-items:center;border-radius:9px;border:1px solid var(--line);
  background:var(--surface);color:var(--muted);cursor:pointer;transition:background .16s ease,color .16s ease}
.cr-icon-btn:hover{background:var(--hover);color:var(--text)}

/* ---------- tabs ---------- */
.cr-tabs{flex:0 0 auto;display:flex;align-items:center;gap:4px;height:47px;padding:0 20px;
  border-bottom:1px solid var(--line);background:var(--hud-soft)}
.cr-tab{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 13px;border-radius:9px;border:1px solid transparent;
  background:transparent;color:var(--muted);font-size:13.5px;font-weight:640;cursor:pointer;
  transition:color .16s ease,background .16s ease,border-color .16s ease}
.cr-tab:hover{color:var(--muted);background:var(--surface-2)}
.cr-tab.is-active{color:var(--accent);background:rgba(53,224,200,.1);border-color:rgba(53,224,200,.28);
  box-shadow:inset 0 0 18px rgba(53,224,200,.08)}
.cr-tab-count{font-family:var(--mono);font-size:10.5px;padding:1px 5px;border-radius:5px;background:var(--surface-3);color:var(--muted)}
.cr-tab.is-active .cr-tab-count{background:rgba(53,224,200,.18);color:var(--accent-soft)}
.cr-tabs-right{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:12.5px;color:var(--muted);font-weight:500}
.cr-kbd{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:10.5px;color:var(--muted);
  border:1px solid var(--line);border-bottom-color:rgba(255,255,255,.16);border-radius:5px;padding:1px 5px;background:var(--surface)}
.cr-vsep{width:1px;height:16px;background:var(--line)}

/* ---------- body / scroll ---------- */
.cr-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 20px 26px;scrollbar-gutter:stable}
.cr-body.is-flush{padding:0}
.cr-stack{display:flex;flex-direction:column;gap:14px}
.cr-grid-2{display:grid;grid-template-columns:minmax(0,1.32fr) minmax(0,1fr);gap:14px;align-items:start}
.cr-grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}

/* ---------- cards ---------- */
.cr-card{position:relative;border:1px solid var(--line);border-radius:14px;background:
  linear-gradient(180deg,var(--surface),var(--surface-faint)),var(--panel);
  box-shadow:0 20px 44px -38px rgba(0,0,0,.95);min-width:0;overflow:hidden}
.cr-card.is-glow{border-color:rgba(53,224,200,.2)}
.cr-card-head{display:flex;align-items:flex-start;gap:10px;padding:12px 14px 10px}
.cr-card-title{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:660;letter-spacing:.2px;min-width:0}
.cr-card-sub{font-size:12.5px;color:var(--muted);margin-top:3px;font-weight:500}
.cr-card-right{margin-left:auto;display:flex;align-items:center;gap:7px;flex:0 0 auto}
.cr-card-body{padding:0 14px 14px}
.cr-card-body.is-tight{padding:0 10px 10px}
.cr-card-foot{padding:9px 14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--faint);display:flex;align-items:center;gap:8px}

/* ---------- badges / pills ---------- */
.cr-badge{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 6px;border-radius:5px;font-size:11px;
  font-weight:640;letter-spacing:.2px;border:1px solid transparent;white-space:nowrap;line-height:1}
.cr-badge .cr-icon{opacity:.9}
.cr-status{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:6px;font-size:11px;
  font-weight:640;border:1px solid var(--line);background:var(--surface);color:var(--muted);white-space:nowrap}
.cr-sev-bar{display:flex;height:5px;border-radius:99px;overflow:hidden;background:var(--surface-3);gap:1px}
.cr-sev-bar i{display:block;height:100%}
.cr-dotlist{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.cr-dot-item{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);font-family:var(--mono)}
.cr-dot-item i{width:5px;height:5px;border-radius:50%;display:block}

/* ---------- stat cards ---------- */
.cr-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.cr-stat{position:relative;padding:12px 14px 11px;border-radius:14px;border:1px solid var(--line);overflow:hidden;
  background:linear-gradient(180deg,var(--surface-2),var(--surface-faint)),var(--code-bg)}
.cr-stat::after{content:'';position:absolute;left:12px;right:12px;bottom:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(53,224,200,.45),transparent);opacity:.55}
.cr-stat-head{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);letter-spacing:.3px}
.cr-stat-head .cr-icon{color:var(--faint)}
.cr-stat-value{display:flex;align-items:baseline;gap:4px;margin-top:7px;font-family:var(--mono);
  font-size:25px;font-weight:660;letter-spacing:-.6px;line-height:1.1}
.cr-stat-unit{font-family:system-ui,sans-serif;font-size:11.5px;color:var(--faint);font-weight:500;letter-spacing:0}
.cr-stat-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:6px;min-height:19px}
.cr-stat-note{font-size:12px;color:var(--text);line-height:1.45;font-weight:500}
.cr-spark{display:block;overflow:visible}

/* ---------- heatmap ---------- */
.cr-heat{display:flex;gap:16px}
.cr-heat-main{flex:1 1 auto;min-width:0;overflow:hidden}
.cr-heat-metrics{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--line);background:var(--surface-soft)}
.cr-seg{border:0;background:transparent;color:var(--muted);font-size:11.5px;font-weight:620;height:21px;padding:0 8px;border-radius:6px;cursor:pointer;white-space:nowrap}
.cr-seg:hover{color:var(--muted)}
.cr-seg.is-active{background:rgba(53,224,200,.16);color:var(--accent-soft)}
.cr-heat-body{display:flex;gap:14px;align-items:flex-start}
.cr-heat-scroll{flex:1 1 auto;min-width:0;overflow:hidden}
.cr-heat-months{position:relative;height:13px;margin-left:21px}
.cr-heat-month{position:absolute;top:0;font-size:10.5px;color:var(--faint);font-family:var(--mono);letter-spacing:.3px;white-space:nowrap}
.cr-heat-gridwrap{display:flex;gap:6px}
.cr-heat-weekdays{display:grid;grid-template-rows:repeat(7,10px);gap:2px;width:15px;padding-top:0}
.cr-heat-weekday{font-size:9.5px;color:var(--faint);line-height:10px;text-align:right;font-family:var(--mono)}
.cr-heat-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,10px);grid-auto-columns:10px;gap:2px}
.cr-heat-cell{width:10px;height:10px;border-radius:2px;background:var(--heat-0,var(--panel-2));
  border:1px solid var(--surface-2);
  animation:crCellIn .34s cubic-bezier(.2,.8,.3,1) both;cursor:default;transition:box-shadow .12s ease,transform .12s ease}
.cr-heat-cell.is-empty{background:transparent;border-color:transparent;animation:none}
.cr-heat-cell:hover{box-shadow:0 0 0 1.5px rgba(255,255,255,.55);transform:translateY(-.5px)}
.cr-heat-cell.is-today{box-shadow:0 0 0 1.2px rgba(53,224,200,.75)}
.cr-heat-legend{display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--faint)}
.cr-heat-legend i{width:9px;height:9px;border-radius:2px;display:block}
.cr-heat-side{flex:0 0 190px;border-left:1px solid var(--line);padding-left:14px;display:flex;flex-direction:column;gap:5px;justify-content:center}
.cr-heat-side-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.cr-heat-side-k{font-size:11.5px;color:var(--faint);letter-spacing:.4px;white-space:nowrap}
.cr-heat-side-v{font-family:var(--mono);font-size:14px;font-weight:640;color:var(--text);white-space:nowrap}
.cr-heat-side-v small{font-size:10.5px;color:var(--faint);font-weight:500;margin-left:1px}
.cr-heat-foot{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:9px;padding-top:8px;border-top:1px dashed var(--surface-3)}
.cr-heat-foot-text{font-size:11.5px;color:var(--faint);font-family:var(--mono);white-space:nowrap}
.cr-tooltip{position:fixed;z-index:90;pointer-events:none;min-width:132px;padding:8px 10px;border-radius:9px;
  border:1px solid var(--line-strong);background:var(--overlay);box-shadow:0 18px 40px -22px #000;
  font-size:11.5px;color:var(--muted);line-height:1.6;animation:crFade .1s ease}
.cr-tooltip b{color:var(--text);font-family:var(--mono);font-size:11.5px}
.cr-tooltip .cr-tt-head{font-size:11.5px;color:var(--text);font-weight:620;margin-bottom:3px;display:flex;justify-content:space-between;gap:10px}
.cr-tt-row{display:flex;justify-content:space-between;gap:12px}
.cr-tt-row span:last-child{color:var(--muted);font-family:var(--mono)}

/* ---------- queue ---------- */
.cr-queue{display:flex;flex-direction:column;gap:9px}
.cr-queue-card{position:relative;border:1px solid var(--line);border-radius:12px;padding:10px 12px 11px;cursor:pointer;
  background:linear-gradient(180deg,var(--surface),var(--surface-faint)),var(--code-bg);
  transition:border-color .16s ease,transform .16s ease,background .16s ease}
.cr-queue-card:hover{border-color:rgba(53,224,200,.36);transform:translateY(-1px)}
.cr-queue-card.is-running{border-color:rgba(53,224,200,.3);background:
  linear-gradient(180deg,rgba(53,224,200,.075),rgba(53,224,200,.006)),var(--code-bg);
  box-shadow:inset 0 1px 0 rgba(53,224,200,.16)}
.cr-queue-card.is-queued{border-style:dashed;border-color:rgba(255,255,255,.13)}
.cr-queue-top{display:flex;align-items:center;gap:7px;min-width:0}
.cr-queue-title{font-size:13.5px;font-weight:640;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-queue-meta{display:flex;align-items:center;gap:8px;margin-top:4px;font-size:12px;color:var(--muted);font-weight:500;font-family:var(--mono)}
.cr-progress{height:5px;border-radius:99px;background:var(--surface-3);overflow:hidden;margin-top:8px}
.cr-progress-fill{height:100%;border-radius:99px;position:relative;overflow:hidden;
  background:linear-gradient(90deg,var(--accent-deep),var(--accent));transition:width .7s cubic-bezier(.2,.8,.2,1)}
.cr-progress-fill::after{content:'';position:absolute;inset:0;opacity:.55;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);animation:crFlow 1.9s linear infinite}
.cr-queue-foot{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--muted)}
.cr-act{display:flex;flex-direction:column;gap:3px;margin-top:8px;padding-top:7px;border-top:1px dashed var(--hover)}
.cr-act-line{display:flex;gap:7px;font-size:12px;color:var(--muted);line-height:1.5}
.cr-act-ts{font-family:var(--mono);color:var(--faint);flex:0 0 auto;font-size:11px;padding-top:1px}
.cr-act-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------- rows / lists ---------- */
.cr-list{display:flex;flex-direction:column;gap:2px}
.cr-row{display:grid;align-items:center;gap:10px;padding:8px 9px;border-radius:9px;border:1px solid transparent;
  cursor:pointer;transition:background .14s ease,border-color .14s ease;min-width:0}
.cr-row:hover{background:var(--surface-2);border-color:var(--surface-3)}
.cr-row.is-flash{animation:crFlash 1.8s ease}
.cr-row-title{font-size:12.5px;font-weight:620;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.5}
.cr-row-sub{font-size:12px;color:var(--muted);margin-top:3px;font-weight:500;display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden;white-space:nowrap}
.cr-row-sub .cr-mono{font-size:10.5px}
.cr-row-num{font-family:var(--mono);font-size:11.5px;color:var(--muted);text-align:right}
.cr-empty{padding:26px 14px;text-align:center;color:var(--faint);font-size:13.5px;display:flex;flex-direction:column;align-items:center;gap:8px}
.cr-empty-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;color:var(--faint);
  border:1px dashed rgba(255,255,255,.14);background:var(--surface-soft)}

/* ---------- activity timeline ---------- */
.cr-timeline{position:relative;display:flex;flex-direction:column;gap:0;padding-left:4px}
.cr-tl-item{position:relative;display:flex;gap:10px;padding:6px 0 6px 14px;border-left:1px solid var(--hover)}
.cr-tl-item:first-child{border-left-color:rgba(53,224,200,.3)}
.cr-tl-dot{position:absolute;left:-3.5px;top:12px;width:6px;height:6px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 3px var(--panel)}
.cr-tl-body{min-width:0;display:flex;flex-direction:column;gap:2px}
.cr-tl-text{font-size:12px;color:var(--muted);line-height:1.45}
.cr-tl-meta{font-size:11.5px;color:var(--faint);font-family:var(--mono);display:flex;gap:7px;align-items:center}
.cr-tl-item.is-new .cr-tl-text{animation:crFlashText 2.2s ease}
.cr-tl-item.is-new .cr-tl-dot{background:var(--accent);box-shadow:0 0 0 3px rgba(53,224,200,.16)}

/* ---------- projects ---------- */
.cr-projects{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.cr-project{position:relative;border:1px solid var(--line);border-radius:13px;padding:12px 13px;display:flex;flex-direction:column;background:
  linear-gradient(180deg,var(--surface),var(--surface-faint)),var(--code-bg);cursor:pointer;min-width:0;
  transition:border-color .16s ease,transform .16s ease}
.cr-project:hover{border-color:rgba(53,224,200,.34);transform:translateY(-1px)}
.cr-project.is-active{border-color:rgba(53,224,200,.5);box-shadow:inset 0 0 0 1px rgba(53,224,200,.16),0 18px 40px -30px rgba(53,224,200,.6)}
.cr-project-name{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:660;min-width:0}
.cr-project-path{font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-project-meta{display:flex;flex-wrap:nowrap;gap:5px;margin-top:8px;overflow:hidden}
.cr-mini-label{display:flex;align-items:center;justify-content:space-between;margin-top:9px;font-size:10.5px;color:var(--faint)}
.cr-mini-heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(2,5px);grid-auto-columns:5px;gap:2px;margin-top:5px;justify-content:start}
.cr-mini-cell{width:5px;height:5px;border-radius:1px;background:var(--panel-2);border:1px solid var(--surface-2)}
.cr-project-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:8px;
  border-top:1px solid var(--line);font-size:10.5px;color:var(--faint);font-family:var(--mono)}

/* ---------- detail ---------- */
.cr-detail{display:grid;grid-template-columns:minmax(0,1fr) 316px;gap:14px;align-items:start}
.cr-detail-main{min-width:0;display:flex;flex-direction:column;gap:12px}
.cr-detail-side{position:sticky;top:0;display:flex;flex-direction:column;gap:11px}
.cr-back{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--muted);
  font-size:12px;font-weight:620;cursor:pointer;padding:0;margin-bottom:2px}
.cr-back:hover{color:var(--accent)}
.cr-detail-title{font-size:17px;font-weight:680;letter-spacing:.2px;line-height:1.35;margin:6px 0 0}
.cr-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px}
.cr-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:7px;border:1px solid var(--line);
  background:var(--surface);font-size:11px;color:var(--muted);white-space:nowrap}
.cr-chip b{color:var(--muted);font-family:var(--mono);font-size:11px;font-weight:600}
.cr-stages{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}
.cr-stage{position:relative;border:1px solid var(--line);border-radius:9px;padding:7px 8px 8px;background:var(--surface-soft);min-width:0}
.cr-stage.is-done{border-color:rgba(61,220,151,.28);background:rgba(61,220,151,.055)}
.cr-stage.is-running{border-color:rgba(53,224,200,.42);background:rgba(53,224,200,.075);box-shadow:inset 0 0 14px rgba(53,224,200,.08)}
.cr-stage.is-failed{border-color:rgba(255,93,108,.38);background:rgba(255,93,108,.07)}
.cr-stage.is-skipped{opacity:.5;border-style:dashed}
.cr-stage-top{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--muted)}
.cr-stage-label{font-size:11.5px;font-weight:620;color:var(--muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-stage-detail{font-size:10px;color:var(--faint);margin-top:2px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-finding{position:relative;border:1px solid var(--line);border-radius:12px;background:
  linear-gradient(180deg,rgba(255,255,255,.024),rgba(255,255,255,.003)),var(--code-bg);overflow:hidden}
.cr-finding::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--sev,var(--low));opacity:.85}
.cr-finding-head{display:flex;align-items:flex-start;gap:8px;padding:10px 12px 6px 13px;flex-wrap:wrap}
.cr-finding-title{font-size:13.5px;font-weight:640;line-height:1.45;min-width:0;flex:1 1 240px;color:var(--text)}
.cr-finding-file{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:11px;color:var(--accent-2-soft);
  background:rgba(110,168,254,.09);border:1px solid rgba(110,168,254,.18);border-radius:5px;padding:2px 6px;margin-top:6px}
.cr-finding-body{padding:2px 13px 12px 13px;color:var(--muted);font-size:12.5px;line-height:1.68}
.cr-finding-tools{display:flex;align-items:center;gap:7px;margin-left:auto}
.cr-diff{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:9px;background:var(--code-bg)}
.cr-diff-pane{min-width:0;display:flex;flex-direction:column}
.cr-diff-pane + .cr-diff-pane{border-left:1px solid var(--line)}
.cr-diff-pane.is-new{background:linear-gradient(180deg,rgba(53,224,200,.045),rgba(53,224,200,.008))}
.cr-diff-pane.is-old{background:linear-gradient(180deg,rgba(255,93,108,.045),rgba(255,93,108,.006))}
.cr-diff-label{display:flex;align-items:center;gap:6px;padding:5px 9px;font-size:10.5px;letter-spacing:.5px;color:var(--muted);
  border-bottom:1px solid var(--line);background:var(--surface-soft);font-weight:640}
.cr-diff-pane.is-new .cr-diff-label{color:var(--accent-soft)}
.cr-diff-pane.is-old .cr-diff-label{color:var(--danger-soft)}
.cr-code{max-height:216px;overflow:auto;padding:6px 0}
.cr-code-line{display:flex;gap:8px;padding:0 8px;font-family:var(--mono);font-size:11.5px;line-height:1.72;white-space:pre}
.cr-code-no{flex:0 0 26px;text-align:right;color:var(--muted);user-select:none}
.cr-code-tx{white-space:pre-wrap;word-break:break-word;color:var(--muted)}
.cr-diff-pane.is-old .cr-code-line{background:rgba(255,93,108,.05)}
.cr-diff-pane.is-new .cr-code-line{background:rgba(53,224,200,.05)}
.cr-thinking{margin-top:8px;font-size:11.5px;color:var(--muted);border-left:2px solid rgba(110,168,254,.35);
  padding:2px 0 2px 9px;font-style:italic;line-height:1.6}
.cr-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cr-toolbar-grow{flex:1 1 auto;min-width:0}
.cr-search{position:relative;display:flex;align-items:center;min-width:170px}
.cr-search .cr-icon{position:absolute;left:9px;color:var(--faint);pointer-events:none}
.cr-search input{width:100%;height:30px;padding:0 10px 0 29px;border-radius:9px;border:1px solid var(--line);
  background:var(--surface);color:var(--text);font-size:12.5px;outline:none}
.cr-search input::placeholder,.cr-input::placeholder,textarea.cr-input::placeholder{color:var(--muted);opacity:1}
.cr-search input:focus{border-color:rgba(53,224,200,.42);box-shadow:0 0 0 3px rgba(53,224,200,.1)}
.cr-select{position:relative;display:inline-flex;align-items:center}
.cr-select select{appearance:none;-webkit-appearance:none;height:32px;padding:0 26px 0 10px;border-radius:9px;
  border:1px solid var(--line);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;outline:none;cursor:pointer}
.cr-select select:focus{border-color:rgba(53,224,200,.42)}
.cr-select select option{background:var(--panel)}
.cr-select .cr-icon{position:absolute;right:7px;color:var(--muted);pointer-events:none}
.cr-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.cr-label{font-size:13px;color:var(--text);font-weight:660;letter-spacing:.15px;display:flex;align-items:center;gap:5px}
.cr-input{height:32px;border-radius:8px;border:1px solid var(--line);background:var(--surface);
  color:var(--text);font-size:13px;padding:0 10px;outline:none;width:100%}
.cr-input:focus{border-color:rgba(53,224,200,.42);box-shadow:0 0 0 3px rgba(53,224,200,.1)}
textarea.cr-input{height:auto;min-height:62px;padding:8px 10px;line-height:1.6;resize:vertical;font-family:inherit}
.cr-hint{font-size:12.5px;color:var(--muted);line-height:1.6}
.cr-kv{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11.5px}
.cr-kv + .cr-kv{margin-top:6px}
.cr-kv span:first-child{color:var(--text);flex:0 0 auto}
.cr-kv span:last-child{color:var(--muted);font-family:var(--mono);font-size:11px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-side-block{border-top:1px dashed var(--hover);padding-top:10px;margin-top:10px}
.cr-side-title{font-size:11.5px;color:var(--muted);letter-spacing:.6px;font-weight:640;margin-bottom:7px}
.cr-file-row{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--muted);padding:3px 0;min-width:0}
.cr-file-row .cr-mono{font-size:10.5px;color:var(--faint);margin-left:auto}
.cr-coverage{height:6px;border-radius:99px;background:var(--surface-3);overflow:hidden;display:flex}
.cr-coverage i{display:block;height:100%}

/* ---------- graphs ---------- */
.cr-graph-wrap{display:grid;grid-template-columns:minmax(0,1fr) 322px;gap:14px;align-items:start}
.cr-graph-canvas{position:relative;border:1px solid var(--line);border-radius:16px;overflow:hidden;
  background:radial-gradient(circle at 50% 40%,rgba(53,224,200,.055),transparent 62%),var(--code-bg);
  height:500px;min-height:400px}
.cr-graph-svg{width:100%;height:100%;display:block}
.cr-graph-node{cursor:pointer}
.cr-graph-node text{font-size:12px;font-weight:600;fill:var(--muted);pointer-events:none}
.cr-graph-node .cr-graph-sub{font-size:10.5px;fill:var(--muted);font-weight:500;font-family:ui-monospace,Menlo,monospace}
.cr-graph-node circle.cr-node-halo{opacity:.16;transition:opacity .16s ease}
.cr-graph-node:hover circle.cr-node-halo{opacity:.34}
.cr-graph-node.is-dim{opacity:.32}
.cr-graph-node.is-active circle.cr-node-core{stroke:#fff;stroke-width:1.6}
.cr-graph-canvas-legend{position:absolute;left:14px;bottom:12px;display:flex;align-items:center;gap:12px;
  font-size:10.5px;color:var(--faint);background:var(--hud-soft);border:1px solid var(--line);
  border-radius:8px;padding:5px 9px;backdrop-filter:blur(8px)}
.cr-graph-canvas-legend i{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:4px}
.cr-graph-canvas-hint{position:absolute;right:14px;bottom:12px;font-size:10.5px;color:var(--faint);
  background:var(--hud-soft);border:1px solid var(--line);border-radius:7px;padding:4px 8px}
.cr-metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cr-metric{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--surface-soft)}
.cr-metric-k{font-size:10.5px;color:var(--faint);letter-spacing:.3px}
.cr-metric-v{font-family:var(--mono);font-size:18px;font-weight:660;margin-top:2px}
.cr-metric-v small{font-size:10.5px;color:var(--faint);font-weight:500;margin-left:2px}
.cr-table{width:100%;border-collapse:collapse;font-size:11.5px}
.cr-table th{text-align:left;font-weight:620;color:var(--faint);font-size:10.5px;letter-spacing:.4px;
  padding:0 8px 6px;border-bottom:1px solid var(--line);white-space:nowrap;cursor:pointer;user-select:none}
.cr-table td{padding:6px 8px;border-bottom:1px solid var(--surface-2);color:var(--muted);white-space:nowrap}
.cr-table tr:hover td{background:var(--surface)}
.cr-table td.cr-num{font-family:var(--mono);text-align:right;color:var(--muted)}
.cr-table tr.is-active td{background:rgba(53,224,200,.07)}
.cr-risk-bar{height:4px;border-radius:99px;background:var(--surface-3);overflow:hidden;min-width:44px}
.cr-risk-bar i{display:block;height:100%;border-radius:99px}

/* ---------- modal / drawer / toast ---------- */
.cr-overlay{position:fixed;inset:0;z-index:60;background:rgba(4,7,12,.66);backdrop-filter:blur(7px);
  display:flex;align-items:center;justify-content:center;padding:26px;animation:crFade .16s ease}
.cr-modal{width:min(940px,100%);max-height:min(86vh,880px);display:flex;flex-direction:column;border-radius:18px;
  border:1px solid rgba(255,255,255,.11);background:linear-gradient(180deg,var(--code-bg),var(--code-bg));
  box-shadow:0 46px 110px -40px #000,inset 0 1px 0 var(--surface-2);overflow:hidden;animation:crPop .18s cubic-bezier(.2,.9,.3,1)}
.cr-modal-head{display:flex;align-items:flex-start;gap:12px;padding:16px 20px 13px;border-bottom:1px solid var(--line)}
.cr-modal-title{font-size:15px;font-weight:680;letter-spacing:.2px}
.cr-modal-sub{font-size:13px;color:var(--text);margin-top:3px;font-weight:500}
.cr-modal-body{padding:16px 20px 6px;overflow:auto;min-height:0}
.cr-modal-foot{display:flex;align-items:center;gap:10px;padding:13px 20px;border-top:1px solid var(--line);background:var(--hud-soft)}
.cr-modal-foot .cr-grow{flex:1 1 auto}
.cr-type-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.cr-type-card{position:relative;text-align:left;border:1px solid var(--line);border-radius:11px;padding:10px 11px;
  background:var(--surface-soft);cursor:pointer;transition:border-color .15s ease,background .15s ease;min-width:0;
  /* buttons do not inherit text color: without this the card title falls back to the UA button color (near-black in the DSH shell) */
  color:var(--text);font-family:inherit}
.cr-type-card:hover{border-color:rgba(255,255,255,.18)}
.cr-type-card.is-active{border-color:rgba(53,224,200,.5);background:rgba(53,224,200,.08);
  box-shadow:inset 0 0 0 1px rgba(53,224,200,.12)}
.cr-type-card-top{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:660}
.cr-type-card-hint{font-size:12px;color:var(--text);margin-top:4px;font-family:var(--mono);line-height:1.55;font-weight:500}
.cr-type-card-badge{position:absolute;right:8px;top:8px;font-size:9.5px;color:var(--accent-soft);background:rgba(53,224,200,.14);
  border:1px solid rgba(53,224,200,.3);border-radius:4px;padding:1px 4px}
.cr-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.cr-form-grid.cols-3{grid-template-columns:1fr 1fr 1fr}
.cr-checks{display:flex;flex-wrap:wrap;gap:5px}
.cr-check{display:inline-flex;align-items:center;gap:5px;height:25px;padding:0 8px;border-radius:7px;border:1px solid var(--line);
  background:var(--surface-soft);font-size:11.5px;color:var(--muted);cursor:pointer;font-family:var(--mono)}
.cr-check.is-on{border-color:rgba(53,224,200,.42);background:rgba(53,224,200,.1);color:var(--accent-soft)}
.cr-drawer{position:fixed;top:0;right:0;bottom:0;width:min(430px,94vw);z-index:70;display:flex;flex-direction:column;
  background:linear-gradient(180deg,var(--code-bg),var(--code-bg));border-left:1px solid var(--line-strong);
  box-shadow:-50px 0 100px -50px #000;animation:crSlide .2s cubic-bezier(.2,.9,.3,1)}
.cr-drawer-head{display:flex;align-items:center;gap:10px;padding:15px 18px;border-bottom:1px solid var(--line)}
.cr-drawer-body{flex:1 1 auto;overflow:auto;padding:14px 18px 26px}
.cr-drawer-section + .cr-drawer-section{margin-top:16px;border-top:1px dashed var(--hover);padding-top:13px}
.cr-drawer-title{font-size:11.5px;font-weight:640;letter-spacing:.6px;color:var(--muted);display:flex;align-items:center;gap:6px}
.cr-toasts{position:fixed;right:18px;bottom:18px;z-index:100;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.cr-toast{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;border:1px solid var(--line-strong);
  background:var(--overlay-soft);box-shadow:0 20px 46px -24px #000;font-size:12.5px;color:var(--text);
  animation:crToast .2s cubic-bezier(.2,.9,.3,1)}
.cr-toast.is-success{border-color:rgba(61,220,151,.34)}
.cr-toast.is-error{border-color:rgba(255,93,108,.38)}
.cr-toast.is-warn{border-color:rgba(255,209,102,.32)}

/* ---------- skeleton / states ---------- */
.cr-skeleton{position:relative;overflow:hidden;background:var(--surface-2);border-radius:7px}
.cr-skeleton::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,var(--hover),transparent);animation:crShimmer 1.5s ease-in-out infinite}
.cr-booting{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--muted)}
.cr-boot-mark{width:62px;height:62px;border-radius:18px;display:grid;place-items:center;color:var(--accent);
  border:1px solid rgba(53,224,200,.3);background:rgba(53,224,200,.07);animation:crBreathe 2.4s ease-in-out infinite}
.cr-boot-text{font-size:13px;letter-spacing:.4px}
.cr-boot-sub{font-size:11px;color:var(--faint);font-family:var(--mono);letter-spacing:1.2px}
.cr-banner{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:10px;font-size:12px;line-height:1.5;
  border:1px solid rgba(255,209,102,.3);background:rgba(255,209,102,.07);color:var(--warn-soft)}
.cr-banner.is-error{border-color:rgba(255,93,108,.34);background:rgba(255,93,108,.08);color:var(--danger-soft)}
.cr-banner.is-info{border-color:rgba(110,168,254,.28);background:rgba(110,168,254,.07);color:var(--accent-2-soft)}
.cr-bullet{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.8;flex:0 0 auto}

@keyframes crPulse{0%{box-shadow:0 0 0 0 rgba(53,224,200,.55)}70%{box-shadow:0 0 0 7px rgba(53,224,200,0)}100%{box-shadow:0 0 0 0 rgba(53,224,200,0)}}
@keyframes crFlow{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@keyframes crCellIn{from{opacity:0;transform:scale(.62)}to{opacity:1;transform:scale(1)}}
@keyframes crFade{from{opacity:0}to{opacity:1}}
@keyframes crPop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
@keyframes crSlide{from{transform:translateX(30px);opacity:.2}to{transform:none;opacity:1}}
@keyframes crToast{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes crShimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@keyframes crBreathe{0%,100%{box-shadow:0 0 0 0 rgba(53,224,200,.16)}50%{box-shadow:0 0 34px 4px rgba(53,224,200,.14)}}
@keyframes crFlash{0%{background:rgba(53,224,200,.16)}100%{background:transparent}}
@keyframes crFlashText{0%{color:var(--accent-soft)}100%{color:var(--muted)}}
`;

    // =====================================================================
    // 6. 基础组件
    // =====================================================================

    function Card(props) {
      const spec = props || {};
      const className = ['cr-card', spec.className || ''].filter(Boolean).join(' ');
      return h('section', { className, style: spec.style, 'data-card': spec.cardId || undefined },
        spec.title || spec.right ? h('div', { className: 'cr-card-head' },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'cr-card-title' },
              spec.icon ? h(Icon, { name: spec.icon, size: 14, style: { color: spec.iconColor || 'var(--accent)' } }) : null,
              h('span', { className: 'cr-ellipsis' }, spec.title)),
            spec.subtitle ? h('div', { className: 'cr-card-sub' }, spec.subtitle) : null),
          spec.right ? h('div', { className: 'cr-card-right' }, spec.right) : null) : null,
        h('div', { className: spec.bodyClassName || 'cr-card-body' }, spec.children));
    }

    function Badge(props) {
      const spec = props || {};
      const color = spec.color || 'var(--muted)';
      return h('span', {
        className: ['cr-badge', spec.className || ''].filter(Boolean).join(' '),
        style: {
          color,
          background: spec.soft || 'var(--surface-2)',
          borderColor: spec.border || 'transparent',
          ...spec.style,
        },
        title: spec.title,
      }, spec.children);
    }

    function TypeBadge(props) {
      const type = str(props && props.type);
      const meta = TYPE_META[type] || { label: type || '未知', color: 'var(--muted)' };
      return h(Badge, {
        color: meta.color,
        border: `${meta.color}44`,
        soft: `${meta.color}14`,
        children: [h(Icon, { key: 'icon', name: type === 'flow' ? 'flow' : type === 'architecture' ? 'graph' : type === 'commit' ? 'list' : type === 'range' ? 'graph' : type === 'module' ? 'folder' : 'file', size: 10 }),
          h('span', { key: 'label' }, meta.label)],
      });
    }

    function StatusPill(props) {
      const status = str(props && props.status, 'queued');
      const meta = STATUS_META[status] || { label: status, color: 'var(--muted)' };
      return h('span', { className: 'cr-status', style: { color: meta.color, borderColor: `${meta.color}33`, background: `${meta.color}12` } },
        h('i', { className: 'cr-dot', style: { background: meta.color } }),
        h('span', null, meta.label));
    }

    function SevBadge(props) {
      const severity = str(props && props.severity, 'low');
      const meta = SEV_META[severity] || SEV_META.low;
      return h(Badge, {
        color: meta.color,
        soft: meta.soft,
        border: `${meta.color}3d`,
        children: [h('i', { key: 'd', className: 'cr-dot', style: { background: meta.color } }, null),
          h('span', { key: 'v' }, meta.label)],
      });
    }

    function CategoryBadge(props) {
      const category = str(props && props.category, 'other');
      return h(Badge, {
        color: 'var(--muted)',
        soft: 'var(--surface-2)',
        border: 'var(--hover)',
        children: CATEGORY_LABEL[category] || category,
      });
    }

    function SeverityBar(props) {
      const counts = obj(props && props.counts);
      const total = num(counts.total, SEVERITIES.reduce((sum, key) => sum + num(counts[key]), 0));
      const height = num(props && props.height, 5);
      if (!total) {
        return h('div', { className: 'cr-sev-bar', style: { height, width: props && props.width } },
          h('i', { style: { width: '100%', background: 'var(--hover)' } }));
      }
      return h('div', { className: 'cr-sev-bar', style: { height, width: props && props.width } },
        SEVERITIES.map((key) => {
          const value = num(counts[key]);
          if (!value) return null;
          return h('i', {
            key,
            title: `${SEV_META[key].label} ${value}`,
            style: { width: `${(value / total) * 100}%`, background: SEV_META[key].color, minWidth: value ? 2 : 0 },
          });
        }));
    }

    function SeverityDots(props) {
      const counts = obj(props && props.counts);
      return h('div', { className: 'cr-dotlist' },
        SEVERITIES.map((key) => h('span', { key, className: 'cr-dot-item', title: SEV_META[key].label },
          h('i', { style: { background: SEV_META[key].color } }),
          h('span', null, num(counts[key])))));
    }

    function Sparkline(props) {
      const spec = props || {};
      const values = arr(spec.values).map((value) => num(value));
      const width = num(spec.width, 72);
      const height = num(spec.height, 22);
      const color = spec.color || 'var(--accent)';
      if (values.length < 2) {
        return h('svg', { className: 'cr-spark', width, height, viewBox: `0 0 ${width} ${height}` },
          h('line', { x1: 0, y1: height - 2, x2: width, y2: height - 2, stroke: 'rgba(255,255,255,.1)', strokeWidth: 1 }));
      }
      const max = Math.max.apply(null, values.concat([1]));
      const min = Math.min.apply(null, values);
      const span = Math.max(1, max - min);
      const step = width / (values.length - 1);
      const points = values.map((value, index) => {
        const y = height - 2 - ((value - min) / span) * (height - 6);
        return [index * step, clamp(y, 1.5, height - 1.5)];
      });
      const line = points.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(' ');
      const area = `${line} L${width},${height} L0,${height} Z`;
      const last = points[points.length - 1];
      return h('svg', { className: 'cr-spark', width, height, viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' },
        h('path', { d: area, fill: color, opacity: 0.1 }),
        h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.4, strokeLinejoin: 'round', strokeLinecap: 'round', opacity: 0.9 }),
        spec.dot === false ? null : h('circle', { cx: last[0], cy: last[1], r: 1.8, fill: color }));
    }

    function ProgressBar(props) {
      const value = clamp(num(props && props.value), 0, 1);
      return h('div', { className: 'cr-progress', style: props && props.style },
        h('div', { className: 'cr-progress-fill', style: { width: `${Math.max(2, value * 100)}%`, background: props && props.color ? props.color : undefined } }));
    }

    const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

    function heatCellsFromDays(days) {
      const list = arr(days);
      if (!list.length) return [];
      const padStart = weekdayOfKey(list[0].date);
      const total = list.length;
      const cellCount = Math.ceil((padStart + total) / 7) * 7;
      const cells = [];
      for (let index = 0; index < cellCount; index += 1) {
        const dayIndex = index - padStart;
        cells.push({
          index,
          week: Math.floor(index / 7),
          day: dayIndex >= 0 && dayIndex < total ? list[dayIndex] : null,
        });
      }
      return cells;
    }

    function MiniHeatmap(props) {
      const spec = props || {};
      const days = arr(spec.days);
      let values = [];
      if (days.length) {
        values = days.slice(-90).map((day) => num(day.commits) + num(day.reviews) * 2);
      } else {
        values = arr(spec.spark).map((value) => num(value)).slice(-90);
      }
      const CELLS = 90;
      const padded = values.slice(-CELLS);
      while (padded.length < CELLS) padded.unshift(0);
      const max = Math.max.apply(null, padded.concat([1]));
      const alpha = ['', '3d', '66', '99', 'ff'];
      return h('div', { className: 'cr-mini-heat', 'data-mini-heat': '1' }, padded.map((value, index) => {
        const level = heatLevel(value, max);
        const color = level === 0 ? 'var(--panel-2)' : `var(--accent)${alpha[level]}`;
        return h('i', {
          key: index,
          className: 'cr-mini-cell',
          title: level ? `${value}` : '',
          style: { background: color },
        });
      }));
    }

    function HeatmapGrid(props) {
      const spec = props || {};
      const metric = spec.metric || 'commits';
      const days = arr(spec.days);
      const cells = heatCellsFromDays(days);
      const values = days.map((day) => num(day[metric]));
      const max = Math.max.apply(null, values.concat([1]));
      const todayKey = dayKeyOf(Date.now());
      const months = [];
      let lastMonth = -1;
      cells.forEach((cell) => {
        if (!cell.day) return;
        const month = monthOfKey(cell.day.date);
        if (month !== lastMonth) {
          lastMonth = month;
          months.push({ week: cell.week, label: `${month}月` });
        }
      });
      return h('div', null,
        h('div', { className: 'cr-heat-months' },
          months.map((month, index) => h('span', {
            key: `${month.label}-${index}`,
            className: 'cr-heat-month',
            style: { left: `${month.week * 12}px` },
          }, month.label))),
        h('div', { className: 'cr-heat-gridwrap' },
          h('div', { className: 'cr-heat-weekdays' },
            [0, 1, 2, 3, 4, 5, 6].map((weekday) => h('div', { key: weekday, className: 'cr-heat-weekday' },
              weekday === 1 ? '一' : weekday === 3 ? '三' : weekday === 5 ? '五' : ''))),
          h('div', { className: 'cr-heat-grid' },
            cells.map((cell) => {
              if (!cell.day) return h('i', { key: `e-${cell.index}`, className: 'cr-heat-cell is-empty' });
              const value = num(cell.day[metric]);
              const level = heatLevel(value, max);
              const isToday = cell.day.date === todayKey;
              return h('i', {
                key: cell.day.date,
                'data-hm-cell': '1',
                'data-date': cell.day.date,
                'data-level': level,
                className: `cr-heat-cell${isToday ? ' is-today' : ''}`,
                style: {
                  background: level === 0 ? HEAT_LEVELS[0] : HEAT_LEVELS[level],
                  animationDelay: `${Math.min(430, cell.index * 1.15)}ms`,
                },
                onMouseEnter: (event) => spec.onHover && spec.onHover(cell.day, event),
                onMouseLeave: () => spec.onLeave && spec.onLeave(),
              });
            }))));
    }

    function HeatmapLegend() {
      return h('div', { className: 'cr-heat-legend' },
        h('span', null, '少'),
        HEAT_LEVELS.map((color, index) => h('i', { key: index, style: { background: color } })),
        h('span', null, '多'));
    }

    function Tooltip(props) {
      const spec = props || {};
      if (!spec.day) return null;
      const day = spec.day;
      const style = {
        left: `${clamp(num(spec.x), 14, (window.innerWidth || 1440) - 160)}px`,
        top: `${clamp(num(spec.y), 14, (window.innerHeight || 1000) - 130)}px`,
        transform: 'translate(-50%, -108%)',
      };
      return h('div', { className: 'cr-tooltip', style },
        h('div', { className: 'cr-tt-head' },
          h('span', null, str(day.date)),
          h('span', { style: { color: 'var(--faint)', fontWeight: 500 } }, `周${WEEKDAY_LABEL[weekdayOfKey(day.date)]}`)),
        h('div', { className: 'cr-tt-row' }, h('span', null, '提交'), h('span', null, num(day.commits))),
        h('div', { className: 'cr-tt-row' }, h('span', null, '增删'), h('span', null, `+${fmtInt(day.insertions)} -${fmtInt(day.deletions)}`)),
        h('div', { className: 'cr-tt-row' }, h('span', null, '评审'), h('span', null, num(day.reviews))),
        h('div', { className: 'cr-tt-row' }, h('span', null, '问题'), h('span', null, num(day.findings))));
    }

    function CopyButton(props) {
      const spec = props || {};
      const [copied, setCopied] = React.useState(false);
      const timerRef = React.useRef(null);
      React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
      const onCopy = async (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        const ok = await copyToClipboard(spec.text);
        if (ok) {
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), 1600);
          if (spec.onCopied) spec.onCopied();
        } else if (spec.onFailed) {
          spec.onFailed();
        }
      };
      return h('button', {
        type: 'button',
        className: `cr-btn is-sm${spec.primary ? ' is-primary' : ''}`,
        onClick: onCopy,
        title: spec.title || '复制',
      },
      h(Icon, { name: copied ? 'check' : 'copy', size: 11 }),
      h('span', null, copied ? '已复制' : (spec.label || '复制')));
    }

    function CodePane(props) {
      const spec = props || {};
      const code = str(spec.code);
      const lines = code ? code.split('\n') : [];
      const startLine = num(spec.startLine, 1);
      return h('div', { className: `cr-diff-pane ${spec.tone === 'new' ? 'is-new' : 'is-old'}` },
        h('div', { className: 'cr-diff-label' }, h(Icon, { name: spec.tone === 'new' ? 'check' : 'close', size: 10 }), spec.label),
        h('div', { className: 'cr-code' },
          lines.length
            ? lines.map((line, index) => h('div', { key: index, className: 'cr-code-line' },
              h('span', { className: 'cr-code-no' }, startLine + index),
              h('span', { className: 'cr-code-tx' }, line || ' ')))
            : h('div', { className: 'cr-code-line' },
              h('span', { className: 'cr-code-no' }, '—'),
              h('span', { className: 'cr-code-tx', style: { color: 'var(--faint)' } }, '（无代码片段）'))));
    }

    function DiffPair(props) {
      const spec = props || {};
      const existing = str(spec.existingCode);
      const suggestion = str(spec.suggestionCode);
      if (!existing && !suggestion) return null;
      if (!suggestion) {
        return h('div', { className: 'cr-diff', style: { gridTemplateColumns: '1fr' } },
          h(CodePane, { tone: 'old', label: '现有代码', code: existing, startLine: spec.startLine }));
      }
      return h('div', { className: 'cr-diff' },
        h(CodePane, { tone: 'old', label: '现有代码', code: existing || '（未提供）', startLine: spec.startLine }),
        h(CodePane, { tone: 'new', label: '建议代码', code: suggestion, startLine: spec.startLine }));
    }

    function KV(props) {
      const spec = props || {};
      return h('div', { className: 'cr-kv', title: spec.title || str(spec.value) },
        h('span', null, spec.label),
        h('span', null, spec.value == null || spec.value === '' ? '—' : spec.value));
    }

    function Skeleton(props) {
      const spec = props || {};
      return h('div', { className: 'cr-skeleton', style: { width: spec.width || '100%', height: spec.height || 10, borderRadius: spec.radius || 6, ...spec.style } });
    }

    function EmptyState(props) {
      const spec = props || {};
      return h('div', { className: 'cr-empty' },
        h('div', { className: 'cr-empty-icon' }, h(Icon, { name: spec.icon || 'file', size: 18 })),
        h('span', null, spec.text || '暂无数据'),
        spec.hint ? h('span', { style: { fontSize: 10, color: 'var(--faint)', maxWidth: 260 } }, spec.hint) : null);
    }

    function Banner(props) {
      const spec = props || {};
      const tone = spec.tone || 'warn';
      return h('div', { className: `cr-banner${tone === 'error' ? ' is-error' : tone === 'info' ? ' is-info' : ''}` },
        h(Icon, { name: tone === 'error' ? 'alert' : tone === 'info' ? 'zap' : 'alert', size: 13 }),
        h('span', { style: { minWidth: 0 } }, spec.children),
        spec.right ? h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } }, spec.right) : null);
    }

    function SearchInput(props) {
      const spec = props || {};
      return h('div', { className: 'cr-search', style: spec.style },
        h(Icon, { name: 'search', size: 12 }),
        h('input', {
          value: spec.value || '',
          placeholder: spec.placeholder || '搜索',
          onChange: (event) => spec.onChange && spec.onChange(event.target.value),
          spellCheck: false,
        }));
    }

    function SelectField(props) {
      const spec = props || {};
      const options = arr(spec.options);
      return h('div', { className: 'cr-select', style: spec.style },
        h('select', {
          value: spec.value,
          onChange: (event) => spec.onChange && spec.onChange(event.target.value),
          title: spec.title,
        }, options.map((option) => {
          const value = typeof option === 'string' ? option : option.value;
          const label = typeof option === 'string' ? option : option.label;
          return h('option', { key: str(value), value }, label);
        })),
        h(Icon, { name: 'chevronDown', size: 12 }));
    }

    function Segmented(props) {
      const spec = props || {};
      return h('div', { className: 'cr-heat-metrics', style: spec.style },
        arr(spec.options).map((option) => h('button', {
          key: str(option.value),
          type: 'button',
          className: `cr-seg${spec.value === option.value ? ' is-active' : ''}`,
          onClick: () => spec.onChange && spec.onChange(option.value),
        }, option.label)));
    }

    function FolderBrowserDialog(props) {
      const spec = props || {};
      const rpc = useRpc(spec.connection);
      const [state, setState] = React.useState({
        loading: false, error: '', path: '', parent: null, entries: [], roots: [], at: 0,
      });
      const load = React.useCallback(async (nextPath) => {
        setState((current) => ({ ...current, loading: true, error: '' }));
        try {
          const envelope = await rpc('project.browse', nextPath ? { path: nextPath } : {});
          const payload = unwrapEnvelope(envelope, (value) => Boolean(value && Array.isArray(value.entries)));
          if (!payload) throw new Error('目录列表返回异常');
          setState({
            loading: false,
            error: '',
            path: str(payload.path),
            parent: payload.parent ? str(payload.parent) : null,
            entries: arr(payload.entries),
            roots: arr(payload.roots),
            at: Date.now(),
          });
        } catch (cause) {
          const message = errorText(cause);
          const hint = /invalid server-response|未知方法/i.test(message)
            ? '（Host 可能仍是旧版本，请重启 DSH 后再试）'
            : '';
          setState((current) => ({ ...current, loading: false, error: `${message}${hint}` }));
        }
      }, [rpc]);
      React.useEffect(() => {
        if (spec.open) void load(spec.startPath || '');
      }, [spec.open, spec.startPath]);
      if (!spec.open) return null;
      return h(Modal, {
        open: true,
        onClose: spec.onClose,
        title: '选择项目文件夹',
        subtitle: '浏览目录，进入目标文件夹后点「选择此文件夹」；也可以返回手动输入路径',
        footer: [
          h('span', { key: 'path', className: 'cr-grow cr-hint' }, state.path || ''),
          h('button', { key: 'cancel', type: 'button', className: 'cr-btn is-ghost', onClick: spec.onClose }, '取消'),
          h('button', {
            key: 'pick', type: 'button', className: 'cr-btn is-primary',
            disabled: state.loading || !state.path,
            onClick: () => spec.onPick && spec.onPick(state.path),
          }, h(Icon, { name: 'check', size: 12 }), '选择此文件夹'),
        ],
        children: [
          arr(state.roots).length ? h('div', { key: 'roots', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
            arr(state.roots).map((root) => h('button', {
              key: root.path, type: 'button', className: 'cr-btn is-sm',
              onClick: () => void load(root.path),
            }, h(Icon, { name: 'folder', size: 11 }), str(root.name)))) : null,
          h('div', { key: 'nav', style: { display: 'flex', gap: 6, marginBottom: 10 } },
            h('button', {
              type: 'button', className: 'cr-btn is-sm', disabled: !state.parent || state.loading,
              onClick: () => state.parent && void load(state.parent),
            }, h(Icon, { name: 'arrowLeft', size: 11 }), '上一级'),
            h('input', { className: 'cr-input', value: state.path, readOnly: true, style: { flex: '1 1 auto', minWidth: 0 } })),
          state.error ? h('div', { key: 'error', className: 'cr-hint', style: { color: 'var(--danger-soft)', marginBottom: 8 } }, state.error) : null,
          h('div', {
            key: 'list',
            style: { maxHeight: 268, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10, background: 'rgba(255,255,255,.015)' },
          },
          state.loading
            ? h('div', { className: 'cr-hint', style: { padding: 12 } }, '加载中…')
            : (arr(state.entries).length
              ? arr(state.entries).map((entry) => h('button', {
                key: str(entry.path),
                type: 'button',
                'data-dir-entry': str(entry.name),
                style: {
                  display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 10px',
                  border: 0, borderBottom: '1px solid var(--surface-2)', background: 'transparent',
                  color: entry.hidden ? 'var(--muted)' : 'var(--text)', cursor: 'pointer', fontSize: 12, textAlign: 'left',
                },
                onClick: () => void load(entry.path),
              }, h(Icon, { name: 'folder', size: 12 }), h('span', { className: 'cr-ellipsis' }, str(entry.name))))
              : h('div', { className: 'cr-hint', style: { padding: 12 } }, '没有子目录，可直接选择当前文件夹'))),
        ],
      });
    }

    function AddProjectDialog(props) {
      const spec = props || {};
      const [path, setPath] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [picking, setPicking] = React.useState(false);
      const [browseOpen, setBrowseOpen] = React.useState(false);
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        if (spec.open) {
          setPath('');
          setError('');
          setBusy(false);
          setPicking(false);
          setBrowseOpen(false);
        }
      }, [spec.open]);
      if (!spec.open) return null;
      const submit = async () => {
        const value = path.trim();
        if (!value) {
          setError('请填写项目目录的绝对路径');
          return;
        }
        setBusy(true);
        setError('');
        try {
          await spec.onSubmit(value);
        } catch (cause) {
          setError(errorText(cause));
          setBusy(false);
        }
      };
      return h(React.Fragment, null, h(Modal, {
        open: spec.open,
        onClose: busy ? null : spec.onClose,
        title: '添加项目',
        subtitle: '可直接输入路径，也可用系统文件夹对话框选择；添加后会持久化并出现在项目列表与新建评审里',
        footer: [
          h('span', { key: 'hint', className: 'cr-grow cr-hint' }, '支持 Git 仓库或普通目录 · 已评审项目与 DSH 工作区会自动出现'),
          h('button', { key: 'cancel', type: 'button', className: 'cr-btn is-ghost', onClick: spec.onClose, disabled: busy }, '取消'),
          h('button', { key: 'ok', type: 'button', className: 'cr-btn is-primary', onClick: submit, disabled: busy },
            h(Icon, { name: busy ? 'clock' : 'plus', size: 12 }), busy ? '添加中…' : '添加项目'),
        ],
        children: [
          h('div', { key: 'path', className: 'cr-field' },
            h('span', { className: 'cr-label' }, h(Icon, { name: 'folder', size: 11 }), '项目路径'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'stretch' } },
              h('input', {
                className: 'cr-input',
                value: path,
                autoFocus: true,
                placeholder: '/Users/you/workspace/project',
                style: { flex: '1 1 auto', minWidth: 0 },
                onChange: (event) => setPath(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
                disabled: busy || picking,
              }),
              h('button', {
                type: 'button', className: 'cr-btn is-sm', style: { flex: '0 0 auto', height: 32 },
                onClick: () => setBrowseOpen(true), disabled: busy,
                title: '浏览文件夹并选择',
              }, h(Icon, { name: 'folder', size: 12 }), '浏览文件夹…'))),
          error ? h('div', { key: 'error', className: 'cr-hint', style: { color: 'var(--danger-soft)', marginTop: 8 } }, error) : null,
        ],
      }), h(FolderBrowserDialog, {
        open: browseOpen,
        startPath: path,
        connection: spec.connection,
        onClose: () => setBrowseOpen(false),
        onPick: (value) => {
          setPath(value);
          setBrowseOpen(false);
        },
      }));
    }

    function ToastStack(props) {
      const list = arr(props && props.toasts);
      return h('div', { className: 'cr-toasts' }, list.map((toast) => h('div', {
        key: toast.id,
        className: `cr-toast${toast.tone === 'success' ? ' is-success' : toast.tone === 'error' ? ' is-error' : toast.tone === 'warn' ? ' is-warn' : ''}`,
      },
      h(Icon, { name: toast.tone === 'success' ? 'check' : toast.tone === 'error' ? 'alert' : 'zap', size: 13 }),
      h('span', null, toast.text))));
    }

    function Modal(props) {
      const spec = props || {};
      if (!spec.open) return null;
      return h('div', {
        className: 'cr-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget && spec.onClose) spec.onClose(); },
      },
      h('div', { className: 'cr-modal', role: 'dialog' },
        h('div', { className: 'cr-modal-head' },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'cr-modal-title' }, spec.title),
            spec.subtitle ? h('div', { className: 'cr-modal-sub' }, spec.subtitle) : null),
          h('button', { type: 'button', className: 'cr-icon-btn', style: { marginLeft: 'auto' }, onClick: spec.onClose, title: '关闭' },
            h(Icon, { name: 'close', size: 14 }))),
        h('div', { className: 'cr-modal-body' }, spec.children),
        spec.footer ? h('div', { className: 'cr-modal-foot' }, spec.footer) : null));
    }

    function Drawer(props) {
      const spec = props || {};
      if (!spec.open) return null;
      return h('div', null,
        h('div', {
          className: 'cr-overlay',
          style: { zIndex: 69, padding: 0, background: 'rgba(4,7,12,.5)' },
          onMouseDown: (event) => { if (event.target === event.currentTarget && spec.onClose) spec.onClose(); },
        }),
        h('aside', { className: 'cr-drawer', role: 'dialog' },
          h('div', { className: 'cr-drawer-head' },
            h(Icon, { name: 'gear', size: 15, style: { color: 'var(--accent)' } }),
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontSize: 13, fontWeight: 660 } }, spec.title || '设置'),
              h('div', { className: 'cr-card-sub' }, spec.subtitle || '只读配置来自 Host')),
            h('button', { type: 'button', className: 'cr-icon-btn', style: { marginLeft: 'auto' }, onClick: spec.onClose, title: '关闭' },
              h(Icon, { name: 'close', size: 14 }))),
          h('div', { className: 'cr-drawer-body' }, spec.children)));
    }

    function PlaceholderCard(props) {
      const spec = props || {};
      return h(Card, { title: spec.title, subtitle: spec.subtitle },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(Skeleton, { width: '100%', height: 10 }),
          h(Skeleton, { width: '78%', height: 10 }),
          h(Skeleton, { width: '92%', height: 10 })));
    }

    // =====================================================================
    // 7. 总览视图
    // =====================================================================

    function StatCard(props) {
      const spec = props || {};
      const display = useCountUp(num(spec.value), 820);
      return h('article', { className: 'cr-stat', 'data-stat': spec.statKey },
        h('div', { className: 'cr-stat-head' },
          h(Icon, { name: spec.icon || 'dot', size: 12 }),
          h('span', null, spec.label)),
        h('div', { className: 'cr-stat-value' },
          h('span', null, fmtInt(Math.round(display))),
          spec.unit ? h('span', { className: 'cr-stat-unit' }, spec.unit) : null),
        h('div', { className: 'cr-stat-foot' },
          h('span', { className: 'cr-stat-note' }, spec.note),
          spec.sevBar
            ? h(SeverityBar, { counts: spec.sevCounts, width: 70, height: 5 })
            : spec.spark && spec.spark.length > 1
              ? h(Sparkline, { values: spec.spark, color: spec.color, width: 66, height: 20 })
              : spec.live
                ? h('span', { className: 'cr-dot is-live', style: { background: spec.color } })
                : null));
    }

    function StatsCards(props) {
      const snapshot = obj(props && props.snapshot);
      const overview = obj(snapshot.overview);
      const findings = obj(overview.findings);
      const days = arr(obj(snapshot.stats).days);
      const last14 = days.slice(-14);
      const reviewSpark = last14.map((day) => num(day.reviews));
      const findingSpark = last14.map((day) => num(day.findings));
      const running = num(overview.running);
      const queued = num(overview.queued);
      const cards = [
        {
          statKey: 'reviews-total', label: 'Review 总数', icon: 'shield', value: num(overview.reviewsTotal),
          unit: '次', color: 'var(--accent)', spark: reviewSpark,
          note: `成功率 ${Math.round(num(overview.successRate) * 100)}%`,
        },
        {
          statKey: 'reviews-7d', label: '近 7 天', icon: 'zap', value: num(overview.reviews7d),
          unit: '次', color: 'var(--low)', spark: reviewSpark.slice(-7),
          note: `今日 ${num(overview.reviewsToday)} 次`,
        },
        {
          statKey: 'running', label: '进行中', icon: 'clock', value: running + queued,
          unit: '个', color: 'var(--medium)', live: running > 0,
          note: `运行 ${running} · 排队 ${queued}`,
        },
        {
          statKey: 'findings', label: '问题总数', icon: 'alert', value: num(findings.total),
          unit: '条', color: 'var(--danger)', sevBar: true, sevCounts: findings,
          note: `严重 ${num(findings.critical)} · 高危 ${num(findings.high)}`,
        },
        {
          statKey: 'files', label: '已审文件', icon: 'file', value: num(overview.filesReviewed),
          unit: '个', color: 'var(--purple)',
          note: `累计 ${fmtCompact(num(overview.tokens))} tokens`,
        },
        {
          statKey: 'modules', label: '覆盖模块', icon: 'graph', value: num(overview.modulesCovered),
          unit: '个', color: 'var(--success)',
          note: `${num(overview.projectsCount)} 个项目`,
        },
      ];
      return h('div', { className: 'cr-stats' }, cards.map((card) => h(StatCard, { key: card.statKey, ...card })));
    }

    const HEAT_METRIC_LABEL = { commits: '提交', reviews: '评审', findings: '问题' };

    function HeatmapPanel(props) {
      const snapshot = obj(props && props.snapshot);
      const heatmap = obj(obj(snapshot.stats).heatmap);
      const days = arr(heatmap.days);
      const [metric, setMetric] = React.useState('commits');
      const [hover, setHover] = React.useState(null);
      const maxByMetric = React.useMemo(() => {
        const result = { commits: 1, reviews: 1, findings: 1 };
        days.forEach((day) => {
          result.commits = Math.max(result.commits, num(day.commits));
          result.reviews = Math.max(result.reviews, num(day.reviews));
          result.findings = Math.max(result.findings, num(day.findings));
        });
        return result;
      }, [days]);
      const totalReviews = num(heatmap.totalReviews, days.reduce((sum, day) => sum + num(day.reviews), 0));
      const totalFindings = num(heatmap.totalFindings, days.reduce((sum, day) => sum + num(day.findings), 0));
      const streaks = obj(heatmap.streaks);
      const busiest = obj(heatmap.busiest);
      const yearLabel = str(heatmap.from).slice(0, 4) === str(heatmap.to).slice(0, 4)
        ? str(heatmap.to).slice(0, 4)
        : `${str(heatmap.from).slice(0, 4)}–${str(heatmap.to).slice(0, 4)}`;
      const totalsByMetric = {
        commits: { value: fmtInt(heatmap.totalCommits), label: `提交 · +${fmtCompact(heatmap.totalInsertions)} / -${fmtCompact(heatmap.totalDeletions)}` },
        reviews: { value: fmtInt(totalReviews), label: '评审次数（近一年）' },
        findings: { value: fmtInt(totalFindings), label: '问题条数（近一年）' },
      };
      return h(Card, {
        title: '提交热力图',
        icon: 'grid',
        subtitle: `${yearLabel} · 活跃 ${num(heatmap.activeDays)} 天`,
        right: [
          h(Segmented, {
            key: 'seg',
            value: metric,
            onChange: setMetric,
            options: Object.keys(HEAT_METRIC_LABEL).map((key) => ({ value: key, label: HEAT_METRIC_LABEL[key] })),
          }),
          h(Badge, { key: 'total', color: 'var(--accent-soft)', soft: 'rgba(53,224,200,.1)', border: 'rgba(53,224,200,.22)', children: `${fmtInt(totalsByMetric[metric].value)} ${HEAT_METRIC_LABEL[metric]}` }),
        ],
        children: h('div', { className: 'cr-heat' },
          h('div', { className: 'cr-heat-main' },
            h('div', { className: 'cr-heat-body' },
              h('div', { className: 'cr-heat-scroll' },
                h(HeatmapGrid, {
                  days,
                  metric,
                  max: maxByMetric[metric],
                  onHover: (day, event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setHover({ day, x: rect.left + rect.width / 2, y: rect.top });
                  },
                  onLeave: () => setHover(null),
                })),
              h('div', { className: 'cr-heat-side' },
                h('div', { className: 'cr-heat-side-row' },
                  h('span', { className: 'cr-heat-side-k' }, '当前连续'),
                  h('span', { className: 'cr-heat-side-v' }, fmtInt(streaks.current), h('small', null, ' 天'))),
                h('div', { className: 'cr-heat-side-row' },
                  h('span', { className: 'cr-heat-side-k' }, '最长连续'),
                  h('span', { className: 'cr-heat-side-v' }, fmtInt(streaks.longest), h('small', null, ' 天'))),
                h('div', { className: 'cr-heat-side-row' },
                  h('span', { className: 'cr-heat-side-k' }, '最忙一天'),
                  h('span', { className: 'cr-heat-side-v', style: { fontSize: 12 } }, `${fmtDayMonth(busiest.date)} · ${num(busiest.commits)} 次`)),
                h('div', { className: 'cr-heat-side-row' },
                  h('span', { className: 'cr-heat-side-k' }, '活跃天数'),
                  h('span', { className: 'cr-heat-side-v' }, fmtInt(heatmap.activeDays), h('small', null, ' 天'))))),
            h('div', { className: 'cr-heat-foot' },
              h(HeatmapLegend),
              h('span', { className: 'cr-heat-foot-text' },
                `${fmtInt(heatmap.totalCommits)} 提交 · +${fmtCompact(heatmap.totalInsertions)} / -${fmtCompact(heatmap.totalDeletions)} · ${fmtInt(totalReviews)} 评审 · ${fmtInt(totalFindings)} 问题`))),
          hover ? h(Tooltip, { day: hover.day, x: hover.x, y: hover.y }) : null)});
    }

    function elapsedOf(job, now) {
      const status = str(job && job.status);
      if (job && job.durationMs != null && status !== 'running') return num(job.durationMs);
      const startedAt = parseTs(job && job.startedAt) || parseTs(job && job.createdAt);
      if (!startedAt) return 0;
      return Math.max(0, (now || Date.now()) - startedAt);
    }

    function QueueCard(props) {
      const spec = props || {};
      const job = obj(spec.job);
      const status = str(job.status, 'queued');
      const running = status === 'running';
      const now = useNow(1000);
      const stages = arr(job.stages);
      const currentStage = stages.find((stage) => str(stage.status) === 'running')
        || stages.find((stage) => str(stage.status) === 'pending')
        || obj(job.stage);
      const progress = clamp(num(job.progress), 0, 1);
      const activity = arr(job.activity).slice(-3).reverse();
      return h('div', {
        className: `cr-queue-card ${running ? 'is-running' : 'is-queued'}`,
        onClick: () => spec.onOpen && spec.onOpen(job.id),
        role: 'button',
        'data-job-row': job.id,
      },
      h('div', { className: 'cr-queue-top' },
        running
          ? h('span', { className: 'cr-dot is-live', style: { background: 'var(--accent)' } })
          : h('span', { className: 'cr-dot', style: { background: 'var(--muted)' } }),
        h('span', { className: 'cr-queue-title' }, str(job.title, '评审任务')),
        h(TypeBadge, { type: job.type }),
        h('span', { style: { marginLeft: 'auto' } }, h(StatusPill, { status }))),
      h('div', { className: 'cr-queue-meta' },
        h('span', null, str(job.projectName, '—')),
        h('span', null, '·'),
        h('span', null, engineMeta(job.engine).label),
        h('span', null, '·'),
        h('span', null, running ? `已耗时 ${fmtMs(elapsedOf(job, now))}` : `已等待 ${fmtMs(elapsedOf(job, now))}`)),
      h('div', { style: { marginTop: 8 } },
        h(ProgressBar, { value: progress, color: running ? undefined : 'linear-gradient(90deg,var(--faint),var(--muted))' })),
      h('div', { className: 'cr-queue-foot' },
        h(Icon, { name: running ? 'play' : 'clock', size: 11, style: { color: running ? 'var(--accent)' : 'var(--faint)' } }),
        h('span', { style: { color: running ? 'var(--accent-soft)' : 'var(--muted)', fontWeight: 620 } },
          running ? str(currentStage.label || STAGE_LABEL[str(currentStage.key)], str(STAGE_LABEL[str(obj(job.stage).key)], '准备中')) : '等待空闲槽位'),
        h('span', { style: { marginLeft: 'auto', fontFamily: 'var(--mono)' } },
          `${Math.round(progress * 100)}% · 阶段 ${num(obj(job.stage).index)}/${num(obj(job.stage).total, 6)}`)),
      activity.length ? h('div', { className: 'cr-act' }, activity.map((event, index) => h('div', { key: index, className: 'cr-act-line' },
        h('span', { className: 'cr-act-ts' }, fmtClock(event.ts)),
        h('span', { className: 'cr-act-text', style: { color: str(event.level) === 'error' ? 'var(--danger-soft)' : str(event.level) === 'success' ? 'var(--accent-soft)' : undefined } }, str(event.text))))) : null);
    }

    function LiveQueue(props) {
      const snapshot = obj(props && props.snapshot);
      const jobs = arr(snapshot.jobs);
      const running = jobs.filter((job) => str(job.status) === 'running');
      const queued = jobs.filter((job) => str(job.status) === 'queued');
      const list = running.concat(queued);
      return h(Card, {
        title: '实时评审队列',
        icon: 'zap',
        subtitle: running.length ? 'OCR 子进程正在评审' : '当前空闲',
        right: h(StatusPill, { status: running.length ? 'running' : 'completed' }),
        bodyClassName: 'cr-card-body',
        children: list.length
          ? h('div', { className: 'cr-queue' }, list.map((job) => h(QueueCard, { key: job.id, job, onOpen: props && props.onOpenJob })))
          : h(EmptyState, { icon: 'zap', text: '没有进行中的评审', hint: '新任务会出现在这里，并显示阶段进度与实时动态' }),
      });
    }

    const KIND_COLOR = { review: 'var(--accent)', finding: 'var(--high)', project: 'var(--purple)', system: 'var(--low)' };

    function RecentReviews(props) {
      const snapshot = obj(props && props.snapshot);
      const jobs = arr(snapshot.jobs).filter((job) => ['completed', 'failed', 'cancelled'].includes(str(job.status)));
      const list = jobs.slice(0, 6);
      const now = Date.now();
      return h(Card, {
        title: '最近评审',
        icon: 'list',
        subtitle: '按时间倒序 · 点击查看详情',
        right: h('span', { className: 'cr-faint', style: { fontSize: 10, fontFamily: 'var(--mono)' } }, `${jobs.length} 条`),
        bodyClassName: 'cr-card-body is-tight',
        children: list.length
          ? h('div', { className: 'cr-list' }, list.map((job) => {
            const counts = obj(obj(job.counts).bySeverity);
            return h('div', {
              key: job.id,
              className: 'cr-row',
              style: { gridTemplateColumns: '66px minmax(0,1fr) 64px', padding: '10px 9px' },
              onClick: () => props && props.onOpenJob && props.onOpenJob(job.id),
              'data-job-row': job.id,
            },
            h(TypeBadge, { type: job.type }),
            h('div', { style: { minWidth: 0, overflow: 'hidden' } },
              h('div', { className: 'cr-row-title' }, str(job.title)),
              h('div', { className: 'cr-row-sub' },
                h('span', { className: 'cr-ellipsis', style: { maxWidth: 94 } }, str(job.projectName)),
                h('span', null, '·'),
                h('span', { className: 'cr-mono' }, `${num(obj(job.counts).filesReviewed)} 文件`),
                h('span', null, '·'),
                h('span', { style: { color: num(counts.critical) ? 'var(--danger-soft)' : num(counts.high) ? 'var(--high)' : 'var(--faint)' } }, `${num(obj(job.counts).findings)} 问题`),
                counts.critical ? h('i', { style: { width: 5, height: 5, borderRadius: '50%', background: 'var(--danger)', flex: '0 0 auto' } }) : null,
                h('span', { style: { marginLeft: 'auto', color: 'var(--faint)', fontFamily: 'var(--mono)', fontSize: 9.5 } }, fmtAgo(job.finishedAt || job.createdAt, now)))),
            h('span', { style: { display: 'flex', justifyContent: 'flex-end' } }, h(StatusPill, { status: job.status })));
          }))
          : h(EmptyState, { icon: 'list', text: '还没有完成的评审' }),
      });
    }

    function RecentProjects(props) {
      const snapshot = obj(props && props.snapshot);
      const recent = arr(obj(snapshot.stats).recentProjects);
      const projects = arr(snapshot.projects);
      const current = obj(snapshot.project);
      const list = (recent.length ? recent : projects).slice(0, 4);
      return h(Card, {
        title: '最近项目',
        icon: 'folder',
        subtitle: 'mini 热力图 · 点击切换当前项目',
        bodyClassName: 'cr-card-body is-tight',
        children: list.length ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 } },
          list.map((entry) => {
            const project = projects.find((item) => str(item.id) === str(entry.projectId)) || {};
            const heatmap = obj(project.heatmap);
            const active = str(project.id) === str(current.id);
            const health = str(entry.health, 'ok');
            return h('div', {
              key: str(entry.projectId || entry.name),
              className: `cr-project${active ? ' is-active' : ''}`,
              style: { padding: '10px 11px' },
              onClick: () => props && props.onSwitchProject && props.onSwitchProject(entry.projectId || project.id),
              'data-project-card': str(entry.projectId || entry.name),
            },
            h('div', { className: 'cr-project-name' },
              h('span', { style: { color: active ? 'var(--accent)' : 'var(--faint)' } }, h(Icon, { name: 'folder', size: 12 })),
              h('span', { className: 'cr-ellipsis' }, str(entry.name || project.name)),
              health === 'dirty' ? h('span', { className: 'cr-dot', style: { background: 'var(--medium)' }, title: '有未提交改动' }) : null),
            h('div', { className: 'cr-project-path' }, str(project.branch, '—'), ' · ', str(project.head, '').slice(0, 7)),
            h(MiniHeatmap, { spark: heatmap.spark, days: heatmap.days && heatmap.days.length <= 120 ? heatmap.days : null }),
            h('div', { className: 'cr-project-foot', style: { marginTop: 6, paddingTop: 6 } },
              h('span', null, fmtAgo(entry.lastAt, Date.now())),
              h('span', { style: { color: num(entry.findings) > 0 ? 'var(--danger-soft)' : 'var(--faint)' } }, `${num(entry.findings)} 问题`)));
          }))
          : h(EmptyState, { icon: 'folder', text: '未发现项目', hint: '在设置里配置项目根目录' }),
      });
    }

    function engineKey(engine) {
      const key = str(engine);
      return ENGINE_META[key] ? key : 'ocr';
    }

    function engineMeta(engine) {
      return ENGINE_META[engineKey(engine)];
    }

    function EngineBadge(props) {
      const spec = props || {};
      const meta = engineMeta(spec.engine);
      return h(Badge, {
        color: meta.color,
        soft: meta.soft,
        border: meta.border,
        title: ENGINE_SUBTITLE[engineKey(spec.engine)],
        children: meta.label,
      });
    }

    function riskColor(risk) {
      const key = str(risk, 'low');
      if (key === 'critical') return 'var(--danger)';
      if (key === 'high') return 'var(--high)';
      if (key === 'medium') return 'var(--medium)';
      return 'var(--low)';
    }

    function HotModules(props) {
      const snapshot = obj(props && props.snapshot);
      const modules = arr(obj(snapshot.stats).topModules).slice(0, 7);
      const maxFindings = Math.max(1, ...modules.map((entry) => num(entry.findings)));
      return h(Card, {
        title: '热点模块',
        icon: 'graph',
        subtitle: '按问题与评审密度排序',
        bodyClassName: 'cr-card-body is-tight',
        children: modules.length
          ? h('div', { className: 'cr-list' }, modules.map((entry, index) => {
            const color = riskColor(entry.risk);
            return h('div', {
              key: `${str(entry.projectId)}-${str(entry.module)}-${index}`,
              className: 'cr-row',
              style: { gridTemplateColumns: 'minmax(0,1fr) 62px 52px' },
              onClick: () => props && props.onOpenModule && props.onOpenModule(entry),
            },
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'cr-row-title', style: { fontFamily: 'var(--mono)', fontSize: 11 } }, str(entry.module)),
              h('div', { className: 'cr-row-sub' },
                h('span', null, str(entry.projectName, '—')),
                h('span', null, '·'),
                h('span', null, `${num(entry.count)} 次评审`)),
              h('div', { className: 'cr-risk-bar', style: { marginTop: 5 } },
                h('i', { style: { width: `${percent(num(entry.findings), maxFindings)}%`, background: color } }))),
            h('span', { className: 'cr-row-num', style: { color } }, `${num(entry.findings)} 问题`),
            h('span', { style: { fontFamily: 'var(--mono)', fontSize: 9, color, textAlign: 'right' } }, str(entry.risk)));
          }))
          : h(EmptyState, { icon: 'graph', text: '暂无模块统计' }),
      });
    }

    function ActivityFeed(props) {
      const snapshot = obj(props && props.snapshot);
      const events = arr(snapshot.activity).slice(0, 8);
      const firstId = events.length ? str(events[0].id) : '';
      const prevFirstRef = React.useRef('');
      const [flashId, setFlashId] = React.useState('');
      React.useEffect(() => {
        if (firstId && prevFirstRef.current && firstId !== prevFirstRef.current) {
          setFlashId(firstId);
          const timer = setTimeout(() => setFlashId(''), FLASH_MS);
          return () => clearTimeout(timer);
        }
        prevFirstRef.current = firstId;
        return undefined;
      }, [firstId]);
      const now = Date.now();
      return h(Card, {
        title: '动态',
        icon: 'zap',
        subtitle: '评审 · 问题 · 系统事件',
        right: h('span', { className: 'cr-faint', style: { fontSize: 9.5 } }, `${events.length} 条`),
        bodyClassName: 'cr-card-body is-tight',
        children: events.length
          ? h('div', { className: 'cr-timeline' }, events.map((event) => {
            const color = KIND_COLOR[str(event.kind)] || 'var(--low)';
            const level = str(event.level);
            return h('div', {
              key: str(event.id),
              className: `cr-tl-item${flashId && str(event.id) === flashId ? ' is-new' : ''}`,
              onClick: () => event.jobId && props && props.onOpenJob && props.onOpenJob(event.jobId),
              style: { cursor: event.jobId ? 'pointer' : 'default' },
            },
            h('i', { className: 'cr-tl-dot', style: { background: level === 'error' ? 'var(--danger)' : level === 'warn' ? 'var(--medium)' : level === 'success' ? 'var(--success)' : color } }),
            h('div', { className: 'cr-tl-body' },
              h('div', { className: 'cr-tl-text' }, str(event.text)),
              h('div', { className: 'cr-tl-meta' },
                h('span', null, fmtAgo(event.ts, now)),
                h('span', { style: { color } }, str(event.kind)),
                event.jobId ? h('span', null, '查看 →') : null)));
          }))
          : h(EmptyState, { icon: 'zap', text: '暂无动态' }),
      });
    }

    function OverviewView(props) {
      const snapshot = obj(props && props.snapshot);
      return h('div', { className: 'cr-stack' },
        h(StatsCards, { snapshot }),
        h(HeatmapPanel, { snapshot }),
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr) minmax(0,.82fr)',
            gap: 14,
            alignItems: 'start',
          },
        },
        h(LiveQueue, { snapshot, onOpenJob: props && props.onOpenJob }),
        h(RecentReviews, { snapshot, onOpenJob: props && props.onOpenJob }),
        h(ActivityFeed, { snapshot, onOpenJob: props && props.onOpenJob })),
        h('div', { className: 'cr-grid-2' },
          h(RecentProjects, { snapshot, onSwitchProject: props && props.onSwitchProject }),
          h(HotModules, { snapshot, onOpenModule: props && props.onOpenModule })));
    }

    // =====================================================================
    // 8. 评审列表视图
    // =====================================================================

    const STATUS_FILTERS = [
      { value: 'all', label: '全部' },
      { value: 'running', label: '进行中' },
      { value: 'queued', label: '排队' },
      { value: 'completed', label: '已完成' },
      { value: 'failed', label: '失败' },
    ];

    function ReviewsView(props) {
      const snapshot = obj(props && props.snapshot);
      const jobs = arr(snapshot.jobs);
      const projects = arr(snapshot.projects);
      const [status, setStatus] = React.useState('all');
      const [type, setType] = React.useState('all');
      const [projectId, setProjectId] = React.useState('all');
      const [query, setQuery] = React.useState('');
      const [expanded, setExpanded] = React.useState('');
      const now = Date.now();

      const statusCounts = {};
      jobs.forEach((job) => { statusCounts[str(job.status)] = (statusCounts[str(job.status)] || 0) + 1; });

      const filtered = jobs.filter((job) => {
        if (status !== 'all' && str(job.status) !== status) return false;
        if (type !== 'all' && str(job.type) !== type) return false;
        if (projectId !== 'all' && str(job.projectId) !== projectId) return false;
        if (query) {
          const haystack = `${str(job.title)} ${str(job.subtitle)} ${str(job.projectName)} ${str(job.id)}`.toLowerCase();
          if (!haystack.includes(str(query).toLowerCase())) return false;
        }
        return true;
      });

      return h('div', { className: 'cr-stack' },
        h(Card, {
          title: '全部评审',
          icon: 'list',
          subtitle: `共 ${jobs.length} 条任务 · 显示 ${filtered.length} 条`,
          right: h('span', { className: 'cr-faint', style: { fontSize: 10, fontFamily: 'var(--mono)' } },
            `完成 ${statusCounts.completed || 0} · 失败 ${statusCounts.failed || 0} · 运行 ${statusCounts.running || 0}`),
          bodyClassName: 'cr-card-body is-tight',
          children: [
            h('div', { key: 'toolbar', className: 'cr-toolbar', style: { padding: '2px 4px 10px' } },
              h(Segmented, {
                key: 'status',
                value: status,
                onChange: setStatus,
                options: STATUS_FILTERS.map((item) => ({
                  value: item.value,
                  label: item.value === 'all' ? `全部 ${jobs.length}` : `${item.label} ${statusCounts[item.value] || 0}`,
                })),
              }),
              h('div', { key: 'sp', style: { width: 6 } }),
              h(SelectField, {
                key: 'type',
                value: type,
                onChange: setType,
                options: [{ value: 'all', label: '全部类型' }].concat(Object.keys(TYPE_META).map((key) => ({ value: key, label: TYPE_META[key].label }))),
              }),
              h(SelectField, {
                key: 'project',
                value: projectId,
                onChange: setProjectId,
                options: [{ value: 'all', label: '全部项目' }].concat(projects.map((project) => ({ value: project.id, label: project.name }))),
              }),
              h('div', { key: 'grow', className: 'cr-toolbar-grow' }),
              h(SearchInput, {
                key: 'search',
                value: query,
                onChange: setQuery,
                placeholder: '搜索任务 / 项目 / ID',
                style: { width: 236 },
              })),
            h('div', { key: 'head', className: 'cr-row', style: { gridTemplateColumns: '58px minmax(0,1fr) 74px 92px 74px 78px 22px', cursor: 'default', background: 'transparent' } },
              h('span', { className: 'cr-label' }, '类型'),
              h('span', { className: 'cr-label' }, '任务'),
              h('span', { className: 'cr-label' }, '严重度'),
              h('span', { className: 'cr-label', style: { textAlign: 'right' } }, '耗时 / tokens'),
              h('span', { className: 'cr-label' }, '引擎'),
              h('span', { className: 'cr-label' }, '状态'),
              h('span', null, '')),
            filtered.length
              ? h('div', { key: 'list', className: 'cr-list' }, filtered.map((job) => h(ReviewRow, {
                key: job.id,
                job,
                now,
                expanded: expanded === job.id,
                onToggle: () => setExpanded(expanded === job.id ? '' : job.id),
                onOpen: props && props.onOpenJob,
                onCancel: props && props.onCancel,
                onRetry: props && props.onRetry,
                onDelete: props && props.onDelete,
              })))
              : h(EmptyState, { key: 'empty', icon: 'search', text: '没有匹配的评审', hint: '调整筛选条件或清空搜索关键词' }),
          ],
        }));
    }

    function ReviewRow(props) {
      const spec = props || {};
      const job = obj(spec.job);
      const counts = obj(obj(job.counts).bySeverity);
      const status = str(job.status);
      const busy = status === 'running' || status === 'queued';
      return h('div', { 'data-job-row': job.id },
        h('div', {
          className: 'cr-row',
          style: { gridTemplateColumns: '58px minmax(0,1fr) 74px 92px 74px 78px 22px' },
          onClick: () => spec.onOpen && spec.onOpen(job.id),
        },
        h(TypeBadge, { type: job.type }),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'cr-row-title' }, str(job.title)),
          h('div', { className: 'cr-row-sub' },
            h('span', { className: 'cr-mono' }, str(job.projectName)),
            h('span', null, '·'),
            h('span', null, `${num(obj(job.counts).filesReviewed)}/${num(obj(job.counts).filesPlanned)} 文件`),
            h('span', null, '·'),
            num(job.resolvedCount) > 0 ? h('span', { style: { color: 'var(--success)' } }, `已修复 ${num(job.resolvedCount)}`) : null,
            num(job.resolvedCount) > 0 ? h('span', null, '·') : null,
            h('span', { className: 'cr-mono' }, fmtAgo(job.createdAt, spec.now)),
            h('span', null, '·'),
            h('span', { className: 'cr-ellipsis', style: { maxWidth: 300 } }, str(obj(job.summary).headline, str(job.subtitle))))),
        h(SeverityBar, { counts, height: 5 }),
        h('div', { style: { textAlign: 'right' } },
          h('div', { className: 'cr-row-num' }, fmtMs(job.durationMs)),
          h('div', { style: { fontSize: 9, color: 'var(--faint)', fontFamily: 'var(--mono)' } }, num(obj(job.counts).tokens) ? `${fmtCompact(num(obj(job.counts).tokens))} tk` : '—')),
        h(EngineBadge, { engine: job.engine }),
        h('span', { style: { display: 'flex', justifyContent: 'flex-start' } }, h(StatusPill, { status })),
        h('button', {
          type: 'button',
          className: 'cr-icon-btn',
          style: { width: 22, height: 22, border: 0, background: 'transparent', transform: spec.expanded ? 'rotate(90deg)' : 'none', transition: 'transform .16s ease' },
          onClick: (event) => { event.stopPropagation(); if (spec.onToggle) spec.onToggle(); },
          title: '展开最近动态',
        }, h(Icon, { name: 'chevronRight', size: 13 }))),
        spec.expanded ? h('div', {
          style: { margin: '0 8px 6px', padding: '9px 11px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-soft)' },
        },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { className: 'cr-side-title', style: { marginBottom: 5 } }, '最近动态'),
            arr(job.activity).slice(-5).map((event, index) => h('div', { key: index, className: 'cr-act-line', style: { padding: '1px 0' } },
              h('span', { className: 'cr-act-ts' }, fmtStamp(event.ts)),
              h('span', { className: 'cr-act-text', style: { whiteSpace: 'normal' } }, str(event.text))))),
          h('div', { style: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' } },
            h('div', { style: { display: 'flex', gap: 6 } },
              h('button', { type: 'button', className: 'cr-btn is-sm', onClick: (event) => { event.stopPropagation(); spec.onOpen && spec.onOpen(job.id); } },
                h(Icon, { name: 'external', size: 11 }), '查看详情'),
              busy ? h('button', {
                type: 'button', className: 'cr-btn is-sm is-danger',
                onClick: (event) => { event.stopPropagation(); spec.onCancel && spec.onCancel(job.id); },
              }, h(Icon, { name: 'ban', size: 11 }), '取消') : h('button', {
                type: 'button', className: 'cr-btn is-sm',
                onClick: (event) => { event.stopPropagation(); spec.onRetry && spec.onRetry(job.id); },
              }, h(Icon, { name: 'refresh', size: 11 }), '重新运行'),
              h('button', {
                type: 'button', className: 'cr-btn is-sm is-danger', title: '删除记录',
                onClick: (event) => { event.stopPropagation(); spec.onDelete && spec.onDelete(job.id); },
              }, h(Icon, { name: 'trash', size: 11 }))),
            h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end', marginTop: 2 } },
              arr(job.stages).map((stage) => h('span', {
                key: str(stage.key),
                className: 'cr-badge',
                style: {
                  color: str(stage.status) === 'failed' ? 'var(--danger-soft)' : str(stage.status) === 'running' ? 'var(--accent-soft)' : str(stage.status) === 'skipped' ? 'var(--faint)' : 'var(--muted)',
                  background: 'rgba(255,255,255,.035)',
                  borderColor: 'var(--surface-3)',
                  fontFamily: 'var(--mono)',
                },
              }, str(stage.label || STAGE_LABEL[str(stage.key)]))))))) : null);
    }

    // =====================================================================
    // 9. 详情视图
    // =====================================================================

    function findingsToMarkdown(job, findings, resolutions = {}) {
      const meta = obj(job);
      const counts = severityCounts(findings);
      const fixedCount = findings.filter((finding) => resolutions[str(finding.key)]).length;
      const lines = [
        `# ${str(meta.title, '代码评审')}`,
        '',
        `- 项目：${str(meta.projectName, '—')}`,
        `- 类型：${str(obj(TYPE_META[str(meta.type)]).label, str(meta.type))}`,
        `- 引擎：${str(meta.engine, '—')}`,
        `- 耗时：${fmtMs(meta.durationMs)}`,
        `- 问题：共 ${counts.total}（严重 ${counts.critical} / 高 ${counts.high} / 中 ${counts.medium} / 低 ${counts.low}）`,
        `- 修复状态：已修复 ${fixedCount} · 未修复 ${counts.total - fixedCount}`,
        '',
      ];
      sortFindings(findings).forEach((finding, index) => {
        const severity = SEV_META[str(finding.severity)] || SEV_META.low;
        const fixed = resolutions[str(finding.key)] ? '（已修复）' : '';
        lines.push(`## ${index + 1}. [${severity.label}]${fixed} ${str(finding.path)}:${num(finding.startLine)}`);
        lines.push('');
        lines.push(`**${str(finding.title)}**`);
        lines.push('');
        lines.push(str(finding.content));
        lines.push('');
        if (str(finding.suggestionCode)) {
          lines.push('```suggestion');
          lines.push(str(finding.suggestionCode));
          lines.push('```');
          lines.push('');
        }
      });
      return lines.join('\n');
    }

    /** Prompt for the client-side fallback when the Host plugin is older than the UI. */
    function buildFixPromptText(job, findings) {
      const meta = obj(job);
      const sorted = sortFindings(findings);
      const lines = [
        `你是代码修复助手。项目「${str(meta.projectName, '')}」刚完成一次${str(obj(TYPE_META[str(meta.type)]).label, str(meta.type))}评审。`,
        `报告：${str(meta.title, '代码评审')}`,
        '请根据下面的 findings 修复代码。要求：',
        '1. 先阅读相关文件与调用方，确认问题真实存在；不确定的不要改。',
        '2. 优先处理 critical / high，其次 medium；low 可按性价比处理。',
        '3. 保持最小改动与现有代码风格，不引入无关重构。',
        '4. 修改后运行相关测试/构建；最后用中文汇总：改了什么、为什么、还剩什么没解决。',
        '',
        `共 ${sorted.length} 条问题：`,
      ];
      sorted.slice(0, 24).forEach((finding) => {
        const location = num(finding.startLine) ? `${str(finding.path)}:${num(finding.startLine)}` : str(finding.path);
        lines.push(`- [${str(finding.severity)}/${str(finding.category)}] ${location} — ${str(finding.title)}`);
        if (str(finding.content)) lines.push(`  ${str(finding.content).replace(/\s+/g, ' ').slice(0, 500)}`);
        if (str(finding.suggestionCode)) lines.push(`  建议代码：${str(finding.suggestionCode).replace(/\s+/g, ' ').slice(0, 400)}`);
      });
      if (sorted.length > 24) lines.push(`（另有 ${sorted.length - 24} 条，见代码评审中心详情页）`);
      lines.push('', '如果某条 finding 判断为误报，请说明理由并跳过，不要为了“修复”而改坏代码。');
      return lines.join('\n');
    }

    function FindingCard(props) {
      const spec = props || {};
      const finding = obj(spec.finding);
      const severity = str(finding.severity, 'low');
      const meta = SEV_META[severity] || SEV_META.low;
      const hasCode = Boolean(str(finding.existingCode) || str(finding.suggestionCode));
      const fixed = Boolean(spec.fixed);
      return h('article', {
        className: `cr-finding${fixed ? ' is-fixed' : ''}`,
        style: { '--sev': meta.color },
        'data-finding': str(finding.id),
        'data-fixed': fixed ? '1' : '0',
      },
        h('div', { className: 'cr-finding-head' },
          h(SevBadge, { severity }),
          h(CategoryBadge, { category: finding.category }),
          str(finding.source) === 'structural' ? h(Badge, { color: 'var(--purple)', soft: 'rgba(185,166,255,.1)', border: 'rgba(185,166,255,.24)', children: 'structural' }) : null,
          fixed ? h(Badge, { color: 'var(--success)', soft: 'rgba(61,220,151,.12)', border: 'rgba(61,220,151,.3)', children: '已修复' }) : null,
          h('div', { className: 'cr-finding-tools' },
            h('button', {
              type: 'button',
              className: `cr-btn is-sm${fixed ? ' is-ghost' : ''}`,
              disabled: Boolean(spec.marking),
              style: { height: 24, padding: '0 8px', fontSize: 10 },
              onClick: () => spec.onToggleFix && spec.onToggleFix(finding),
              title: fixed ? '撤销“已修复”标记' : '标记为已修复',
            }, h(Icon, { name: spec.marking ? 'clock' : (fixed ? 'refresh' : 'check'), size: 10 }),
              spec.marking ? '处理中…' : (fixed ? '撤销已修复' : '标记已修复')),
            h(CopyButton, {
              text: str(finding.suggestionCode) || str(finding.content),
              label: '复制建议',
              title: '复制建议代码 / 说明',
              onCopied: spec.onCopied,
            })),
          h('div', { style: { width: '100%' } },
            h('div', { className: 'cr-finding-title' }, str(finding.title, '未命名问题')),
            h('div', { className: 'cr-finding-file' },
              h(Icon, { name: 'file', size: 10 }),
              h('span', null, `${str(finding.path, '—')}:${num(finding.startLine)}`),
              str(finding.endLine) && num(finding.endLine) > num(finding.startLine)
                ? h('span', { style: { color: 'var(--faint)' } }, `–${num(finding.endLine)}`)
                : null,
              str(finding.rule) ? h('span', { style: { color: 'var(--faint)' } }, ` · ${str(finding.rule)}`) : null))),
        h('div', { className: 'cr-finding-body' },
          h('div', { style: { whiteSpace: 'pre-wrap' } }, str(finding.content)),
          str(finding.thinking) ? h('div', { className: 'cr-thinking' }, `判断依据：${str(finding.thinking)}`) : null,
          hasCode ? h(DiffPair, {
            existingCode: finding.existingCode,
            suggestionCode: finding.suggestionCode,
            startLine: num(finding.startLine, 1),
          }) : null));
    }

    function DetailView(props) {
      const spec = props || {};
      const jobId = str(spec.jobId);
      const [reloadToken, setReloadToken] = React.useState(0);
      const loaded = useDetailLoader(spec.connection, jobId, reloadToken);
      const [verify, setVerify] = React.useState({ id: '', auto: false });
      const autoVerifiedRef = React.useRef(new Set());
      const [sevFilter, setSevFilter] = React.useState('all');
      const [categoryFilter, setCategoryFilter] = React.useState('all');
      const [fileFilter, setFileFilter] = React.useState('all');
      const [query, setQuery] = React.useState('');
      const [fixBusy, setFixBusy] = React.useState(false);
      const [fixFilter, setFixFilter] = React.useState('all');
      const [resolutions, setResolutions] = React.useState({});
      const [markingKey, setMarkingKey] = React.useState('');
      const rpc = useRpc(spec.connection);
      const toast = useToast();
      const startFixSession = async () => {
        if (fixBusy || !spec.onCreateFix) return;
        setFixBusy(true);
        try {
          await spec.onCreateFix(job.id, {
            projectPath: str(job.projectPath),
            job,
            findings,
          });
        } catch (error) {
          toast(errorText(error), 'error');
        } finally {
          setFixBusy(false);
        }
      };

      React.useEffect(() => {
        setSevFilter('all');
        setCategoryFilter('all');
        setFileFilter('all');
        setFixFilter('all');
        setQuery('');
      }, [jobId]);

      const detail = obj(loaded.detail);
      const job = obj(detail.job);
      const findings = sortFindings(arr(detail.findings));
      React.useEffect(() => {
        setResolutions(obj(detail.resolutions));
      }, [detail.resolutions, jobId]);
      const startVerify = React.useCallback(async (auto = false) => {
        if (verify.id || !job.id) return;
        try {
          const envelope = await rpc('job.recheck', { jobId: str(job.id) });
          const payload = unwrapEnvelope(envelope, (value) => Boolean(value && value.job && value.job.id));
          if (!payload) throw new Error('校验任务启动失败');
          const nextId = str(payload.job.id);
          setVerify({ id: nextId, auto });
          toast(auto ? '检测到修复会话，正在自动校验修复状态…' : '已开始校验修复状态…', 'info');
        } catch (error) {
          toast(errorText(error), 'error');
        }
      }, [rpc, job.id, toast, verify.id]);

      // A report that a fix session was started from gets one automatic recheck
      // when it is opened again; the recheck is the same review type/scope, and
      // missing findings are reconciled by the Host.
      React.useEffect(() => {
        const id = str(job.id);
        if (!id || str(job.type) === 'workspace' || str(job.status) !== 'completed' || !job.fixAt || job.fixVerifiedAt) return;
        if (verify.id || autoVerifiedRef.current.has(id)) return;
        const age = Date.now() - (Date.parse(str(job.fixAt)) || 0);
        if (age < 30_000) return;
        autoVerifiedRef.current.add(id);
        void startVerify(true);
      }, [job.id, job.status, job.fixAt, job.fixVerifiedAt, verify.id, startVerify]);

      React.useEffect(() => {
        if (!verify.id) return undefined;
        const started = Date.now();
        const timer = setInterval(async () => {
          try {
            const envelope = await rpc('job', { id: verify.id });
            const payload = unwrapEnvelope(envelope, (value) => Boolean(value && value.job));
            const status = payload && payload.job ? str(payload.job.status) : '';
            if (['completed', 'failed', 'cancelled'].includes(status)) {
              clearInterval(timer);
              setVerify({ id: '', auto: false });
              setReloadToken((token) => token + 1);
              toast(status === 'completed' ? '校验完成，已更新修复状态' : `校验未完成：${status}`, status === 'completed' ? 'success' : 'warn');
            } else if (Date.now() - started > 10 * 60_000) {
              clearInterval(timer);
              setVerify({ id: '', auto: false });
              toast('校验仍在运行，可稍后重新打开报告查看', 'info');
            }
          } catch {
            /* transient poll errors are retried */
          }
        }, 2000);
        return () => clearInterval(timer);
      }, [verify.id, rpc, toast]);

      const isFixed = (finding) => Boolean(resolutions[str(finding.key)]);
      const fixedCount = findings.filter(isFixed).length;
      const openCount = findings.length - fixedCount;
      const toggleFixed = async (finding) => {
        const key = str(finding.key);
        if (!key || markingKey) return;
        const nextResolved = !isFixed(finding);
        setMarkingKey(key);
        try {
          await rpc('finding.resolve', { jobId: str(job.id), key, resolved: nextResolved });
          setResolutions((current) => {
            const next = { ...current };
            if (nextResolved) next[key] = { status: 'fixed', at: new Date().toISOString() };
            else delete next[key];
            return next;
          });
          toast(nextResolved ? '已标记为已修复' : '已撤销修复标记', 'success');
        } catch (error) {
          toast(errorText(error), 'error');
        } finally {
          setMarkingKey('');
        }
      };
      const files = arr(detail.files);
      const counts = severityCounts(findings);
      const stageList = arr(job.stages);
      const timing = job;

      const categories = React.useMemo(() => {
        const set = new Set();
        findings.forEach((finding) => set.add(str(finding.category, 'other')));
        return [...set];
      }, [findings]);

      const filteredFindings = findings.filter((finding) => {
        if (fixFilter === 'fixed' && !isFixed(finding)) return false;
        if (fixFilter === 'open' && isFixed(finding)) return false;
        if (sevFilter !== 'all' && str(finding.severity) !== sevFilter) return false;
        if (categoryFilter !== 'all' && str(finding.category) !== categoryFilter) return false;
        if (fileFilter !== 'all' && str(finding.path) !== fileFilter) return false;
        if (query) {
          const haystack = `${str(finding.title)} ${str(finding.content)} ${str(finding.path)} ${str(finding.rule)}`.toLowerCase();
          if (!haystack.includes(str(query).toLowerCase())) return false;
        }
        return true;
      });

      const grouped = SEVERITIES.map((severity) => ({
        severity,
        items: filteredFindings.filter((finding) => str(finding.severity) === severity),
      })).filter((group) => group.items.length);

      const coverage = obj(obj(job.summary).coverage);
      const reviewable = num(coverage.reviewable, num(obj(job.counts).filesPlanned));
      const reviewed = num(coverage.reviewed, num(obj(job.counts).filesReviewed));
      const coverageFailed = num(coverage.failed);
      const waived = num(coverage.waived);

      if (loaded.loading && !loaded.detail) {
        return h('div', { className: 'cr-stack' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('button', { type: 'button', className: 'cr-back', onClick: spec.onBack }, h(Icon, { name: 'arrowLeft', size: 13 }), '返回'),
            h(Skeleton, { width: 220, height: 14 })),
          h(PlaceholderCard, { title: '评审详情加载中…' }),
          h(PlaceholderCard, { title: '阶段与摘要' }));
      }

      if (loaded.error && !loaded.detail) {
        return h('div', { className: 'cr-stack' },
          h('button', { type: 'button', className: 'cr-back', onClick: spec.onBack }, h(Icon, { name: 'arrowLeft', size: 13 }), '返回'),
          h(Card, { title: '加载失败', icon: 'alert', iconColor: 'var(--danger)' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              h(Banner, { tone: 'error' }, loaded.error),
              h('div', null, h('button', { type: 'button', className: 'cr-btn is-primary', onClick: () => spec.onReload && spec.onReload() },
                h(Icon, { name: 'refresh', size: 12 }), '重试')))));
      }

      const status = str(job.status);
      const isBusy = status === 'running' || status === 'queued';

      const headerCard = h(Card, {
        bodyClassName: 'cr-card-body',
        children: h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(TypeBadge, { type: job.type }),
            h('span', { style: { fontSize: 10, color: 'var(--faint)', fontFamily: 'var(--mono)' } }, str(job.subtitle))),
          h('h1', { className: 'cr-detail-title' }, str(job.title, '评审详情')),
          counts.total
            ? h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('span', { className: 'cr-chip', style: { color: 'var(--accent-soft)', borderColor: 'rgba(61,220,151,.26)' } }, `已修复 ${fixedCount} / ${counts.total}`),
              openCount ? h('span', { className: 'cr-chip', style: { color: 'var(--warn-soft)' } }, `未修复 ${openCount}`) : h('span', { className: 'cr-chip', style: { color: 'var(--accent-soft)' } }, '全部已修复'))
            : null,
          h('div', { className: 'cr-chips' },
            h('span', { className: 'cr-chip' }, h(Icon, { name: 'folder', size: 11 }), h('span', null, str(job.projectName, '—'))),
            h('span', { className: 'cr-chip', title: ENGINE_SUBTITLE[engineKey(job.engine)] }, h(Icon, { name: 'zap', size: 11 }), '引擎 ', h('b', { style: { color: engineMeta(job.engine).color } }, engineMeta(job.engine).label)),
            h('span', { className: 'cr-chip' }, h(Icon, { name: 'clock', size: 11 }), '耗时 ', h('b', null, fmtMs(timing.durationMs))),
            h('span', { className: 'cr-chip' }, h(Icon, { name: 'file', size: 11 }), '文件 ', h('b', null, `${reviewed}/${num(obj(job.counts).filesPlanned)}`)),
            h('span', { className: 'cr-chip' }, h(Icon, { name: 'alert', size: 11 }), 'tokens ', h('b', null, fmtCompact(num(obj(job.counts).tokens)))),
            h('span', { className: 'cr-chip' }, h(Icon, { name: 'clock', size: 11 }), str(job.finishedAt) ? fmtStamp(job.finishedAt) : '进行中'))),
      });

      const stagesCard = h(Card, {
        title: '阶段时间线',
        icon: 'play',
        subtitle: `${num(obj(job.stage).index)}/${num(obj(job.stage).total, stageList.length)} 阶段完成`,
        bodyClassName: 'cr-card-body',
        children: h('div', { className: 'cr-stages' }, (stageList.length ? stageList : [{ key: 'resolve', label: '解析项目', status: 'pending' }]).map((stage) => {
          const stageStatus = str(stage.status, 'pending');
          const tone = stageStatus === 'done' ? 'var(--success)' : stageStatus === 'running' ? 'var(--accent)' : stageStatus === 'failed' ? 'var(--danger)' : 'var(--faint)';
          const stageDetail = str(stage.detail) || (stageStatus === 'running'
            ? `${Math.round(num(job.progress) * 100)}%`
            : stageStatus === 'done'
              ? fmtMs((parseTs(stage.finishedAt) || 0) - (parseTs(stage.startedAt) || 0))
              : '—');
          return h('div', { key: str(stage.key), className: `cr-stage is-${stageStatus}` },
            h('div', { className: 'cr-stage-top' },
              h(Icon, {
                name: stageStatus === 'done' ? 'check' : stageStatus === 'running' ? 'play' : stageStatus === 'failed' ? 'alert' : 'clock',
                size: 10,
                style: { color: tone },
              }),
              h('span', null, stageStatus === 'done' ? '完成' : stageStatus === 'running' ? '进行中' : stageStatus === 'failed' ? '失败' : stageStatus === 'skipped' ? '跳过' : '等待')),
            h('div', { className: 'cr-stage-label' }, str(stage.label || STAGE_LABEL[str(stage.key)], str(stage.key))),
            h('div', { className: 'cr-stage-detail' }, stageDetail));
        })),
      });

      const summaryCard = h(Card, {
        title: '评审摘要',
        icon: 'shield',
        subtitle: ENGINE_SUBTITLE[engineKey(job.engine)],
        bodyClassName: 'cr-card-body',
        children: h('div', null,
          h('div', { style: { fontSize: 14, fontWeight: 660, lineHeight: 1.5, color: 'var(--text)' } }, str(obj(job.summary).headline, '暂无摘要')),
          str(obj(job.summary).projectSummary)
            ? h('div', { style: { marginTop: 8, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.7 } }, str(obj(job.summary).projectSummary))
            : null,
          arr(obj(job.summary).notes).length
            ? h('div', { style: { marginTop: 9, display: 'flex', flexDirection: 'column', gap: 4 } },
              arr(obj(job.summary).notes).map((note, index) => h('div', { key: index, style: { fontSize: 10.5, color: 'var(--warn-soft)', display: 'flex', gap: 6 } },
                h('span', null, '·'), h('span', null, str(note)))))
            : null,
          str(job.error) || obj(job.error).message
            ? h('div', { style: { marginTop: 10 } }, h(Banner, { tone: 'error' }, errorText(obj(job.error).message || job.error)))
            : null),
      });

      const findingsCard = h(Card, {
        title: '问题清单',
        icon: 'alert',
        subtitle: `共 ${counts.total} 条 · 已修复 ${fixedCount} · 未修复 ${openCount} · 当前显示 ${filteredFindings.length} 条`,
        right: h(CopyButton, {
          text: findingsToMarkdown(job, findings, resolutions),
          label: '复制 Markdown',
          title: '复制完整评审结果为 Markdown',
        }),
        bodyClassName: 'cr-card-body',
        children: h('div', { className: 'cr-stack', style: { gap: 11 } },
          h('div', { className: 'cr-toolbar' },
            h(Segmented, {
              value: fixFilter,
              onChange: setFixFilter,
              options: [
                { value: 'all', label: '全部状态' },
                { value: 'open', label: `未修复 ${openCount}` },
                { value: 'fixed', label: `已修复 ${fixedCount}` },
              ],
            }),
            h(Segmented, {
              value: sevFilter,
              onChange: setSevFilter,
              options: [{ value: 'all', label: `全部 ${counts.total}` }].concat(SEVERITIES.map((severity) => ({
                value: severity, label: `${SEV_META[severity].label} ${counts[severity]}`,
              }))),
            }),
            h(SelectField, {
              value: categoryFilter,
              onChange: setCategoryFilter,
              options: [{ value: 'all', label: '全部类别' }].concat(categories.map((category) => ({ value: category, label: CATEGORY_LABEL[category] || category }))),
            }),
            h(SelectField, {
              value: fileFilter,
              onChange: setFileFilter,
              options: [{ value: 'all', label: `全部文件 (${files.length})` }].concat(files.map((file) => ({ value: str(file.path), label: `${str(file.path)} (${num(file.findings)})` }))),
              style: { maxWidth: 260 },
            }),
            h('div', { className: 'cr-toolbar-grow' }),
            h(SearchInput, { value: query, onChange: setQuery, placeholder: '搜索问题 / 文件 / 规则', style: { width: 210 } })),
          grouped.length
            ? grouped.map((group) => h('div', { key: group.severity, style: { display: 'flex', flexDirection: 'column', gap: 9 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 } },
                h(SevBadge, { severity: group.severity }),
                h('span', { style: { fontSize: 10.5, color: 'var(--faint)' } }, `${group.items.length} 条`),
                h('div', { style: { flex: '1 1 auto', height: 1, background: 'linear-gradient(90deg,rgba(255,255,255,.09),transparent)' } })),
              group.items.map((finding) => h(FindingCard, {
                key: str(finding.id),
                finding,
                fixed: isFixed(finding),
                marking: markingKey === str(finding.key),
                onToggleFix: toggleFixed,
                onCopied: () => toast && toast('建议已复制到剪贴板', 'success'),
              }))))
            : h(EmptyState, { icon: 'alert', text: '没有匹配的问题', hint: '调整状态 / 严重度 / 类别 / 文件筛选或清空搜索' })),
      });

      const sideColumn = h('div', { className: 'cr-detail-side' },
        h(Card, {
          title: '问题分布',
          icon: 'alert',
          bodyClassName: 'cr-card-body',
          children: h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
              h('span', { style: { fontFamily: 'var(--mono)', fontSize: 30, fontWeight: 680, lineHeight: 1 } }, fmtInt(counts.total)),
              h('span', { style: { fontSize: 10.5, color: 'var(--faint)' } }, '条问题')),
            h('div', { style: { marginTop: 9 } }, h(SeverityBar, { counts, height: 7 })),
            h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7 } },
              SEVERITIES.map((severity) => {
                const meta = SEV_META[severity];
                const value = counts[severity];
                return h('div', { key: severity, style: { display: 'flex', alignItems: 'center', gap: 7 } },
                  h('i', { style: { width: 6, height: 6, borderRadius: '50%', background: meta.color } }),
                  h('span', { style: { fontSize: 10.5, color: 'var(--muted)', width: 32 } }, meta.label),
                  h('div', { style: { flex: 1, height: 4, borderRadius: 99, background: 'var(--surface-3)', overflow: 'hidden' } },
                    h('i', { style: { display: 'block', height: '100%', width: `${percent(value, Math.max(1, counts.total))}%`, background: meta.color } })),
                  h('span', { style: { fontFamily: 'var(--mono)', fontSize: 10, width: 20, textAlign: 'right', color: meta.color } }, value));
              }))),
        }),
        h(Card, {
          title: '涉及文件',
          icon: 'file',
          subtitle: `Top ${Math.min(6, files.length)} / ${files.length}`,
          bodyClassName: 'cr-card-body',
          children: files.length
            ? h('div', null, files.slice(0, 6).map((file) => h('div', { key: str(file.path), className: 'cr-file-row' },
              h('i', { style: { width: 5, height: 5, borderRadius: '50%', background: SEV_META[str(file.severityMax, 'low')] ? SEV_META[str(file.severityMax, 'low')].color : 'var(--low)' } }),
              h('span', { className: 'cr-ellipsis', style: { fontSize: 10 } }, str(file.path)),
              h('span', { className: 'cr-mono' }, num(file.findings)))))
            : h(EmptyState, { icon: 'file', text: '没有文件明细' }),
        }),
        h(Card, {
          title: '覆盖率',
          icon: 'grid',
          bodyClassName: 'cr-card-body',
          children: h('div', null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--muted)' } },
              h('span', null, '已评审文件'),
              h('span', { className: 'cr-mono', style: { color: 'var(--muted)' } }, `${reviewed} / ${reviewable || reviewed}`)),
            h('div', { className: 'cr-coverage', style: { marginTop: 6 } },
              h('i', { style: { width: `${percent(reviewed, Math.max(1, reviewable || reviewed))}%`, background: 'linear-gradient(90deg,var(--accent-deep),var(--accent))' } }),
              coverageFailed ? h('i', { style: { width: `${percent(coverageFailed, Math.max(1, reviewable || reviewed))}%`, background: 'var(--danger)' } }) : null,
              waived ? h('i', { style: { width: `${percent(waived, Math.max(1, reviewable || reviewed))}%`, background: 'var(--line-strong)' } }) : null),
            h('div', { style: { marginTop: 10 } },
              h(KV, { label: '可评审', value: reviewable }),
              h(KV, { label: '已评审', value: reviewed }),
              h(KV, { label: '失败', value: coverageFailed }),
              h(KV, { label: '排除', value: waived })),
            h('div', { className: 'cr-side-block' },
              h('div', { className: 'cr-side-title' }, '原始会话'),
              h(KV, { label: 'OCR session', value: str(obj(job.artifacts).ocrSessionId, '—') }),
              h(KV, { label: 'artifact', value: str(obj(job.artifacts).rawOutputPath, '—'), title: str(obj(job.artifacts).rawOutputPath) }),
              h(KV, { label: 'engine', value: `${engineMeta(job.engine).label} · ${ENGINE_SUBTITLE[engineKey(job.engine)]}` }))),
        }),
        h(Card, {
          title: '操作',
          icon: 'gear',
          bodyClassName: 'cr-card-body',
          children: h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
            h('button', {
              type: 'button', className: 'cr-btn', style: { justifyContent: 'flex-start' },
              disabled: Boolean(verify.id) || isBusy,
              onClick: () => startVerify(false),
            }, h(Icon, { name: verify.id ? 'clock' : 'shield', size: 12 }), verify.id ? '正在校验修复状态…' : '校验修复状态'),
            h('button', {
              type: 'button', className: 'cr-btn is-primary', style: { justifyContent: 'flex-start' },
              disabled: fixBusy || isBusy,
              onClick: startFixSession,
            }, h(Icon, { name: fixBusy ? 'clock' : 'zap', size: 12 }), fixBusy ? '正在创建修复会话…' : '新建修复 Session'),
            h('button', {
              type: 'button', className: 'cr-btn', style: { justifyContent: 'flex-start' },
              onClick: () => spec.onRetry && spec.onRetry(str(job.id), str(job.type)),
            }, h(Icon, { name: 'refresh', size: 12 }), '重新运行评审'),
            isBusy ? h('button', {
              type: 'button', className: 'cr-btn is-danger', style: { justifyContent: 'flex-start' },
              onClick: () => spec.onCancel && spec.onCancel(str(job.id)),
            }, h(Icon, { name: 'ban', size: 12 }), '取消正在运行的任务') : null,
            h(CopyButton, { text: findingsToMarkdown(job, findings, resolutions), label: '复制 Markdown 报告', primary: false, title: '复制完整报告' }),
            h('button', {
              type: 'button', className: 'cr-btn is-danger', style: { justifyContent: 'flex-start' },
              onClick: () => spec.onDelete && spec.onDelete(str(job.id)),
            }, h(Icon, { name: 'trash', size: 12 }), '删除这条评审记录'))}),
      );

      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
          h('button', { type: 'button', className: 'cr-back', onClick: spec.onBack }, h(Icon, { name: 'arrowLeft', size: 13 }), '返回列表'),
          h('span', { className: 'cr-faint', style: { fontSize: 10, fontFamily: 'var(--mono)' } }, str(job.id)),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } },
            h(StatusPill, { status }),
            job.fixAt
              ? h('span', {
                className: 'cr-chip',
                style: { color: job.fixVerifiedAt ? 'var(--success)' : 'var(--medium)' },
                title: job.fixVerifiedAt ? '已校验修复状态' : '该报告创建过修复会话，打开后会自动重新校验',
              }, verify.id ? '修复校验中…' : job.fixVerifiedAt ? '修复已校验' : '待校验修复')
              : null,
            h('button', {
              type: 'button', className: 'cr-btn is-sm',
              disabled: Boolean(verify.id) || isBusy,
              onClick: () => startVerify(false),
              title: '按相同类型/范围重新评审，未再出现的问题会自动标记已修复',
            }, h(Icon, { name: verify.id ? 'clock' : 'shield', size: 11 }), verify.id ? '校验中…' : '校验修复状态'),
            h('button', {
              type: 'button', className: 'cr-btn is-sm is-primary',
              disabled: fixBusy || isBusy,
              onClick: startFixSession,
              title: '在项目目录中新建 DSH 会话，并自动填入修复提示词',
            }, h(Icon, { name: fixBusy ? 'clock' : 'zap', size: 11 }), fixBusy ? '创建中…' : '新建修复 Session'),
            isBusy
              ? h('button', { type: 'button', className: 'cr-btn is-sm is-danger', onClick: () => spec.onCancel && spec.onCancel(job.id) }, h(Icon, { name: 'ban', size: 11 }), '取消评审')
              : h('button', { type: 'button', className: 'cr-btn is-sm', onClick: () => spec.onRetry && spec.onRetry(job.id) }, h(Icon, { name: 'refresh', size: 11 }), '重新运行'))),
        h('div', { className: 'cr-detail' },
          h('div', { className: 'cr-detail-main' }, headerCard, stagesCard, summaryCard, findingsCard),
          sideColumn));
    }

    // =====================================================================
    // 10. 项目视图
    // =====================================================================

    function ProjectsView(props) {
      const snapshot = obj(props && props.snapshot);
      const projects = arr(snapshot.projects);
      const current = obj(snapshot.project);
      const [selectedId, setSelectedId] = React.useState(str(current.id));
      React.useEffect(() => { setSelectedId(str(current.id)); }, [current.id]);
      const selected = projects.find((project) => str(project.id) === str(selectedId)) || current;
      const modules = arr(selected.modules);
      const maxLoc = Math.max(1, ...modules.map((module) => num(module.loc)));

      return h('div', { className: 'cr-stack' },
        h(Card, {
          title: '项目',
          icon: 'folder',
          subtitle: `${projects.length} 个仓库 · 点击卡片切换当前项目`,
          right: h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h('button', {
              type: 'button', className: 'cr-btn is-sm',
              onClick: () => props && props.onAddProject && props.onAddProject(),
            }, h(Icon, { name: 'plus', size: 11 }), '添加项目'),
            h('span', { className: 'cr-chip' },
              h(Icon, { name: 'folder', size: 11 }),
              h('span', { className: 'cr-ellipsis' }, str(current.path, '—')))),
          bodyClassName: 'cr-card-body',
          children: h('div', { className: 'cr-projects' }, projects.map((project) => {
            const active = str(project.id) === str(current.id);
            const heatmap = obj(project.heatmap);
            const findings = obj(project.findings);
            return h('div', {
              key: str(project.id),
              className: `cr-project${active ? ' is-active' : ''}`,
              onClick: () => props && props.onSwitchProject && props.onSwitchProject(project.id),
              'data-project-card': str(project.id),
            },
            h('div', { className: 'cr-project-name' },
              h(Icon, { name: 'folder', size: 13, style: { color: active ? 'var(--accent)' : 'var(--faint)' } }),
              h('span', { className: 'cr-ellipsis' }, str(project.name)),
              project.dirty ? h(Badge, { color: 'var(--medium)', soft: 'rgba(255,209,102,.1)', border: 'rgba(255,209,102,.26)', children: 'dirty' }) : null,
              active ? h(Badge, { color: 'var(--accent-soft)', soft: 'rgba(53,224,200,.1)', border: 'rgba(53,224,200,.26)', children: '当前' }) : null),
            h('div', { className: 'cr-project-path' }, str(project.path)),
            h('div', { className: 'cr-project-meta' },
              h(Badge, { color: 'var(--muted)', soft: 'var(--surface-2)', border: 'var(--hover)', children: str(project.branch, '—') }),
              h(Badge, { color: 'var(--muted)', soft: 'var(--surface-2)', border: 'var(--hover)', children: str(project.head, '').slice(0, 7) || '—' }),
              h(Badge, { color: 'var(--purple)', soft: 'rgba(185,166,255,.09)', border: 'rgba(185,166,255,.2)', children: str(project.language, '—') }),
              h(Badge, { color: 'var(--muted)', soft: 'var(--surface-2)', border: 'var(--hover)', children: `${num(project.moduleCount)} 模块` }),
              h(Badge, { color: 'var(--muted)', soft: 'var(--surface-2)', border: 'var(--hover)', children: `${fmtCompact(num(project.loc))} LOC` })),
            h('div', { className: 'cr-mini-label' },
              h('span', null, '近 90 天提交'),
              h('span', { className: 'cr-mono', style: { color: num(findings.total) > 0 ? 'var(--danger-soft)' : 'var(--faint)' } }, `${num(findings.total)} 问题`)),
            h(MiniHeatmap, { spark: heatmap.spark }),
            h('div', { className: 'cr-project-foot' },
              h('span', null, `最近评审 ${fmtAgo(project.lastReviewAt, Date.now())}`),
              h('span', null, `${num(project.reviewCount)} 次`)));
          })),
        }),
        h('div', { className: 'cr-grid-2' },
          h(Card, {
            title: '模块明细',
            icon: 'graph',
            subtitle: `${str(selected.name)} · ${modules.length} 个模块`,
            right: h('span', { className: 'cr-faint', style: { fontSize: 10, fontFamily: 'var(--mono)' } },
              `${fmtCompact(num(selected.loc))} LOC · ${num(selected.fileCount)} 文件`),
            bodyClassName: 'cr-card-body',
            children: modules.length
              ? h('table', { className: 'cr-table' },
                h('thead', null, h('tr', null,
                  h('th', null, '模块'), h('th', null, '文件'), h('th', null, 'LOC'),
                  h('th', null, '风险'), h('th', null, '评审'), h('th', null, '问题'))),
                h('tbody', null, modules.map((module) => {
                  const color = riskColor(module.risk);
                  return h('tr', { key: str(module.id || module.name) },
                    h('td', { style: { fontFamily: 'var(--mono)', color: 'var(--muted)' } }, str(module.name)),
                    h('td', { className: 'cr-num' }, num(module.files)),
                    h('td', { className: 'cr-num' }, fmtCompact(num(module.loc))),
                    h('td', null, h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                      h('div', { className: 'cr-risk-bar', style: { width: 46 } },
                        h('i', { style: { width: `${percent(num(module.loc), maxLoc)}%`, background: color } })),
                      h('span', { style: { color, fontSize: 9.5, fontFamily: 'var(--mono)' } }, str(module.risk)))),
                    h('td', { className: 'cr-num' }, num(module.reviewCount)),
                    h('td', { className: 'cr-num', style: { color: num(obj(module.findings).total) ? 'var(--danger-soft)' : undefined } }, num(obj(module.findings).total)));
                })))
              : h(EmptyState, { icon: 'graph', text: '没有模块明细' }),
          }),
          h(Card, {
            title: '仓库信息',
            icon: 'file',
            bodyClassName: 'cr-card-body',
            children: h('div', null,
              h(KV, { label: '名称', value: str(selected.name) }),
              h(KV, { label: '路径', value: str(selected.path) }),
              h(KV, { label: 'branch', value: str(selected.branch) }),
              h(KV, { label: 'HEAD', value: `${str(selected.head, '').slice(0, 7)} ${str(selected.headSubject)}` }),
              h(KV, { label: '最近提交', value: fmtStamp(selected.committedAt) }),
              h(KV, { label: 'remote', value: str(selected.remote) }),
              h(KV, { label: '语言 / 文件', value: `${str(selected.language)} · ${num(selected.fileCount)}` }),
              h(KV, { label: '模块 / LOC', value: `${num(selected.moduleCount)} · ${fmtCompact(num(selected.loc))}` }),
              h(KV, { label: '最近评审', value: fmtStamp(selected.lastReviewAt) }),
              h(KV, { label: '问题总数', value: fmtInt(num(obj(selected.findings).total)) }),
              h('div', { className: 'cr-side-block' },
                h('div', { className: 'cr-side-title' }, 'Health'),
                h(KV, { label: 'git', value: str(obj(obj(snapshot.health).git).state) }),
                h(KV, { label: '项目数', value: num(obj(obj(snapshot.health).git).projects) }))),
          })));
    }

    // =====================================================================
    // 11. 架构视图
    // =====================================================================

    function computeArchLayout(nodes, width, height) {
      const list = arr(nodes);
      const count = list.length || 1;
      const maxLoc = Math.max.apply(null, list.map((node) => num(node.loc)).concat([1]));
      const radiusX = width * 0.305;
      const radiusY = height * 0.32;
      return list.map((node, index) => {
        const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
        const x = width / 2 + Math.cos(angle) * radiusX;
        const y = height / 2 + Math.sin(angle) * radiusY;
        const radius = 12 + 25 * Math.sqrt(num(node.loc) / maxLoc);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const side = cos > 0.28 ? 'start' : cos < -0.28 ? 'end' : 'middle';
        const halo = radius * 1.85;
        const offset = halo + 7;
        const labelX = x + (side === 'start' ? offset : side === 'end' ? -offset : 0);
        const labelY = side === 'middle' ? y + (sin > 0 ? offset + 12 : -(offset + 8)) : y + 4;
        return { node, x, y, radius, side, labelX, labelY };
      });
    }

    function ArchGraph(props) {
      const spec = props || {};
      const graph = obj(spec.graph);
      const nodes = arr(graph.nodes);
      const edges = arr(graph.edges);
      const cycles = arr(graph.cycles);
      const width = 1180;
      const height = 560;
      const [hover, setHover] = React.useState(null);
      const layout = React.useMemo(() => computeArchLayout(nodes, width, height), [nodes]);
      const byId = React.useMemo(() => {
        const map = new Map();
        layout.forEach((entry) => map.set(str(entry.node.id), entry));
        return map;
      }, [layout]);
      const cycleNodeSet = React.useMemo(() => {
        const set = new Set();
        cycles.forEach((cycle) => arr(cycle).forEach((id) => set.add(str(id))));
        return set;
      }, [cycles]);
      const neighbors = React.useMemo(() => {
        const map = new Map();
        edges.forEach((edge) => {
          const from = str(edge.from);
          const to = str(edge.to);
          if (!map.has(from)) map.set(from, new Set());
          if (!map.has(to)) map.set(to, new Set());
          map.get(from).add(to);
          map.get(to).add(from);
        });
        return map;
      }, [edges]);
      const selected = str(spec.selected);
      const connected = selected ? (neighbors.get(selected) || new Set()) : null;

      return h('div', { style: { position: 'relative', height: '100%' } },
        h('svg', { className: 'cr-graph-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet' },
          h('defs', null,
            h('marker', { id: 'cr-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
              h('path', { d: 'M0 0 L10 5 L0 10 z', fill: 'rgba(140,170,205,.6)' })),
            h('marker', { id: 'cr-arrow-hot', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
              h('path', { d: 'M0 0 L10 5 L0 10 z', fill: 'var(--high)' })),
            h('radialGradient', { id: 'cr-node-grad' },
              h('stop', { offset: '0%', stopColor: 'rgba(53,224,200,.2)' }),
              h('stop', { offset: '100%', stopColor: 'rgba(10,17,27,0)' }))),
          edges.map((edge, index) => {
            const from = byId.get(str(edge.from));
            const to = byId.get(str(edge.to));
            if (!from || !to) return null;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            const ux = dx / distance;
            const uy = dy / distance;
            const x1 = from.x + ux * (from.radius + 2);
            const y1 = from.y + uy * (from.radius + 2);
            const x2 = to.x - ux * (to.radius + 7);
            const y2 = to.y - uy * (to.radius + 7);
            const inCycle = cycleNodeSet.has(str(edge.from)) && cycleNodeSet.has(str(edge.to));
            const risk = str(edge.risk);
            const hot = risk === 'high' || risk === 'critical' || inCycle;
            const dim = selected && str(edge.from) !== selected && str(edge.to) !== selected;
            return h('line', {
              key: `edge-${index}`,
              x1, y1, x2, y2,
              stroke: inCycle ? 'var(--danger)' : hot ? 'var(--high)' : 'rgba(120,150,185,.34)',
              strokeWidth: hot ? 1.6 : 1,
              strokeDasharray: inCycle ? '5 3' : undefined,
              markerEnd: hot ? 'url(#cr-arrow-hot)' : 'url(#cr-arrow)',
              opacity: dim ? 0.16 : hot ? 0.85 : 0.6,
            });
          }),
          layout.map((entry) => {
            const node = entry.node;
            const id = str(node.id);
            const color = riskColor(node.risk);
            const isDim = selected && id !== selected && !(connected && connected.has(id));
            const isCycle = cycleNodeSet.has(id);
            return h('g', {
              key: id,
              className: `cr-graph-node${isDim ? ' is-dim' : ''}${selected === id ? ' is-active' : ''}`,
              onClick: () => spec.onSelect && spec.onSelect(id),
              onMouseEnter: (event) => setHover({ node, x: event.clientX, y: event.clientY }),
              onMouseMove: (event) => setHover((current) => (current && str(current.node.id) === id ? { ...current, x: event.clientX, y: event.clientY } : { node, x: event.clientX, y: event.clientY })),
              onMouseLeave: () => setHover(null),
            },
            h('circle', { className: 'cr-node-halo', cx: entry.x, cy: entry.y, r: entry.radius * 1.85, fill: color }),
            isCycle ? h('circle', { cx: entry.x, cy: entry.y, r: entry.radius + 6, fill: 'none', stroke: 'var(--danger)', strokeWidth: 1, strokeDasharray: '3 4', opacity: 0.6 }) : null,
            h('circle', { className: 'cr-node-core', cx: entry.x, cy: entry.y, r: entry.radius, fill: 'var(--code-bg)', stroke: color, strokeWidth: 1.7 }),
            h('circle', { cx: entry.x, cy: entry.y, r: Math.max(2.5, entry.radius * 0.26), fill: color, opacity: 0.85 }),
            h('text', {
              x: entry.labelX, y: entry.labelY, textAnchor: entry.side,
              style: { fill: 'var(--text)', paintOrder: 'stroke', stroke: 'var(--bg)', strokeWidth: 3.4, strokeLinejoin: 'round' },
            }, str(node.label || node.path).slice(0, 18)),
            h('text', { x: entry.labelX, y: entry.labelY + 12, textAnchor: entry.side, className: 'cr-graph-sub' },
              `${fmtCompact(num(node.loc))} LOC · ${num(node.files)} 文件`));
          })),
        h('div', { className: 'cr-graph-canvas-hint' }, '节点大小 = LOC · 颜色 = 风险 · 红虚线 = 循环依赖'),
        h('div', { className: 'cr-graph-canvas-legend' },
          ['low', 'medium', 'high', 'critical'].map((risk) => h('span', { key: risk },
            h('i', { style: { background: riskColor(risk) } }),
            risk === 'low' ? '低风险' : risk === 'medium' ? '中风险' : risk === 'high' ? '高风险' : '严重'))),
        hover ? h('div', {
          className: 'cr-tooltip',
          style: {
            left: `${clamp(hover.x, 20, (window.innerWidth || 1440) - 190)}px`,
            top: `${clamp(hover.y - 10, 20, (window.innerHeight || 1000) - 120)}px`,
            transform: 'translate(0, -100%)',
          },
        },
        h('div', { className: 'cr-tt-head' }, h('span', null, str(hover.node.label || hover.node.path)), h('span', null, str(hover.node.risk))),
        h('div', { className: 'cr-tt-row' }, h('span', null, 'LOC'), h('span', null, fmtInt(num(hover.node.loc)))),
        h('div', { className: 'cr-tt-row' }, h('span', null, '文件'), h('span', null, num(hover.node.files))),
        h('div', { className: 'cr-tt-row' }, h('span', null, 'kind'), h('span', null, str(hover.node.kind, 'module')))) : null);
    }

    function ArchitectureView(props) {
      const snapshot = obj(props && props.snapshot);
      const project = obj(snapshot.project);
      const loaded = useGraphLoader(props && props.connection, 'architecture', str(project.id));
      const data = obj(loaded.data);
      const graph = obj(data.graph);
      const nodes = arr(graph.nodes);
      const edges = arr(graph.edges);
      const cycles = arr(graph.cycles);
      const metrics = obj(data.metrics);
      const findings = arr(data.findings);
      const [selected, setSelected] = React.useState('');
      const [sortKey, setSortKey] = React.useState('loc');
      const [sortAsc, setSortAsc] = React.useState(false);

      const selectedNode = nodes.find((node) => str(node.id) === selected);
      const related = selected
        ? findings.filter((finding) => {
          const module = str(finding.module);
          const path = str(finding.path);
          if (selectedNode && (module === str(selectedNode.label) || module === str(selectedNode.path))) return true;
          return path.startsWith(`${str(selectedNode && selectedNode.path)}/`) || path === str(selectedNode && selectedNode.path);
        })
        : findings;

      const sortedNodes = nodes.slice().sort((a, b) => {
        const factor = sortAsc ? 1 : -1;
        if (sortKey === 'name') return str(a.label).localeCompare(str(b.label)) * factor;
        if (sortKey === 'risk') {
          const rank = (node) => ['low', 'medium', 'high', 'critical'].indexOf(str(node.risk));
          return (rank(a) - rank(b)) * factor;
        }
        return (num(a[sortKey]) - num(b[sortKey])) * factor;
      });

      const toggleSort = (key) => {
        if (key === sortKey) setSortAsc((current) => !current);
        else { setSortKey(key); setSortAsc(key === 'name'); }
      };

      return h('div', { className: 'cr-stack' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('div', null,
            h('div', { style: { fontSize: 14, fontWeight: 680 } }, '模块依赖图'),
            h('div', { className: 'cr-card-sub' },
              `${str(project.name)} · ${nodes.length} 模块 · ${edges.length} 依赖 · ${cycles.length} 组循环`)),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } },
            selected ? h('button', { type: 'button', className: 'cr-btn is-sm', onClick: () => setSelected('') },
              h(Icon, { name: 'close', size: 11 }), '清除过滤') : null,
            h(Badge, { color: 'var(--accent-soft)', soft: 'rgba(53,224,200,.1)', border: 'rgba(53,224,200,.24)', children: `风险 ${metrics.cycles != null ? num(metrics.cycles) : cycles.length} 环` }))),
        loaded.loading && !loaded.data ? h(PlaceholderCard, { title: '依赖图加载中…' }) : null,
        loaded.error && !loaded.data ? h(Banner, { tone: 'error' }, loaded.error) : null,
        h('div', { className: 'cr-graph-wrap' },
          h('div', { className: 'cr-graph-canvas' },
            h(ArchGraph, { graph, selected, onSelect: (id) => setSelected(selected === id ? '' : id) })),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
            h(Card, {
              title: '架构指标',
              icon: 'zap',
              bodyClassName: 'cr-card-body',
              children: h('div', { className: 'cr-metric-grid' },
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '模块数'), h('div', { className: 'cr-metric-v' }, nodes.length)),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '依赖边'), h('div', { className: 'cr-metric-v' }, edges.length)),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '循环依赖'), h('div', { className: 'cr-metric-v', style: { color: cycles.length ? 'var(--high)' : 'var(--success)' } }, num(metrics.cycles, cycles.length))),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '最大扇入'), h('div', { className: 'cr-metric-v' }, num(metrics.maxFanIn, 0))),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '最大扇出'), h('div', { className: 'cr-metric-v' }, num(metrics.maxFanOut, 0))),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '架构问题'), h('div', { className: 'cr-metric-v' }, findings.length)))}),
            ),
            h(Card, {
              title: '模块表',
              icon: 'list',
              subtitle: '点击表头排序 · 点击行过滤 findings',
              bodyClassName: 'cr-card-body',
              children: h('table', { className: 'cr-table' },
                h('thead', null, h('tr', null,
                  h('th', { onClick: () => toggleSort('name') }, '模块'),
                  h('th', { onClick: () => toggleSort('loc'), style: { textAlign: 'right' } }, 'LOC'),
                  h('th', { onClick: () => toggleSort('files'), style: { textAlign: 'right' } }, '文件'),
                  h('th', { onClick: () => toggleSort('risk') }, '风险'))),
                h('tbody', null, sortedNodes.map((node) => {
                  const active = selected === str(node.id);
                  return h('tr', {
                    key: str(node.id),
                    className: active ? 'is-active' : '',
                    onClick: () => setSelected(active ? '' : str(node.id)),
                    style: { cursor: 'pointer' },
                  },
                  h('td', { style: { fontFamily: 'var(--mono)', color: active ? 'var(--accent-soft)' : 'var(--muted)' } }, str(node.label || node.path).slice(0, 16)),
                  h('td', { className: 'cr-num' }, fmtCompact(num(node.loc))),
                  h('td', { className: 'cr-num' }, num(node.files)),
                  h('td', null, h('span', { style: { color: riskColor(node.risk), fontFamily: 'var(--mono)', fontSize: 9.5 } }, str(node.risk))));
                })))}),
            h(Card, {
              title: selected ? `关联问题 · ${str(selectedNode && selectedNode.label)}` : '架构问题',
              icon: 'alert',
              subtitle: `${related.length} 条`,
              bodyClassName: 'cr-card-body',
              children: related.length
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
                  related.slice(0, 6).map((finding, index) => h('div', { key: str(finding.id) || `arch-f-${index}`, style: { display: 'flex', gap: 7, alignItems: 'flex-start' } },
                    h(SevBadge, { severity: finding.severity }),
                    h('div', { style: { minWidth: 0 } },
                      h('div', { style: { fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.45 } }, str(finding.title)),
                      h('div', { style: { fontSize: 9.5, color: 'var(--faint)', fontFamily: 'var(--mono)', marginTop: 2 } }, `${str(finding.path)}:${num(finding.startLine)}`)))))
                : h(EmptyState, { icon: 'alert', text: selected ? '该模块没有关联问题' : '没有架构问题' })}),
            ));
    }

    // =====================================================================
    // 12. 信息流视图
    // =====================================================================

    const FLOW_KIND_META = {
      entry: { label: '入口', color: 'var(--accent)' },
      service: { label: '服务', color: 'var(--low)' },
      data: { label: '数据', color: 'var(--purple)' },
      external: { label: '外部', color: 'var(--high)' },
    };

    function computeFlowLayout(nodes, width, height) {
      const columns = { entry: [], service: [], data: [], external: [] };
      arr(nodes).forEach((node) => {
        const kind = str(node.kind);
        (columns[kind] || columns.service).push(node);
      });
      const columnKeys = ['entry', 'service', 'data', 'external'].filter((key) => columns[key].length);
      const nodeW = 208;
      const nodeH = 54;
      const xs = columnKeys.map((_, index) => {
        const span = width - nodeW - 80;
        return columnKeys.length === 1 ? width / 2 : 40 + nodeW / 2 + (index * span) / (columnKeys.length - 1);
      });
      const positions = new Map();
      const columnTitles = [];
      columnKeys.forEach((key, columnIndex) => {
        const list = columns[key];
        const gap = Math.min(200, (height - 80) / Math.max(1, list.length - 1));
        const startY = height / 2 + 12 - ((list.length - 1) * gap) / 2;
        columnTitles.push({ key, x: xs[columnIndex], y: 38, label: FLOW_KIND_META[key].label, color: FLOW_KIND_META[key].color });
        list.forEach((node, index) => {
          positions.set(str(node.id), {
            node,
            x: xs[columnIndex],
            y: startY + index * gap,
            w: nodeW,
            h: nodeH,
            kind: key,
          });
        });
      });
      return { positions, columnTitles, width, height };
    }

    function FlowGraph(props) {
      const spec = props || {};
      const graph = obj(spec.graph);
      const nodes = arr(graph.nodes);
      const edges = arr(graph.edges);
      const width = 1180;
      const height = 560;
      const [hover, setHover] = React.useState(null);
      const layout = React.useMemo(() => computeFlowLayout(nodes, width, height), [nodes]);
      const selected = str(spec.selected);
      const neighbors = React.useMemo(() => {
        const map = new Map();
        edges.forEach((edge) => {
          const from = str(edge.from);
          const to = str(edge.to);
          if (!map.has(from)) map.set(from, new Set());
          if (!map.has(to)) map.set(to, new Set());
          map.get(from).add(to);
          map.get(to).add(from);
        });
        return map;
      }, [edges]);
      const related = selected ? (neighbors.get(selected) || new Set()) : null;

      return h('div', { style: { position: 'relative', height: '100%' } },
        h('svg', { className: 'cr-graph-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet' },
          h('defs', null,
            h('marker', { id: 'cr-flow-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
              h('path', { d: 'M0 0 L10 5 L0 10 z', fill: 'rgba(140,170,205,.55)' })),
            h('marker', { id: 'cr-flow-arrow-hot', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
              h('path', { d: 'M0 0 L10 5 L0 10 z', fill: 'var(--high)' }))),
          layout.columnTitles.map((column) => h('g', { key: column.key },
            h('text', { x: column.x, y: column.y, textAnchor: 'middle', style: { fill: column.color, fontSize: 11, fontWeight: 640, letterSpacing: 2 } }, column.label),
            h('line', { x1: column.x - 26, y1: column.y + 10, x2: column.x + 26, y2: column.y + 10, stroke: column.color, opacity: 0.35 }))),
          edges.map((edge, index) => {
            const from = layout.positions.get(str(edge.from));
            const to = layout.positions.get(str(edge.to));
            if (!from || !to) return null;
            const risk = str(edge.risk);
            const hot = risk === 'high' || risk === 'critical';
            const dim = selected && str(edge.from) !== selected && str(edge.to) !== selected;
            const x1 = from.x + from.w / 2;
            const y1 = from.y;
            const x2 = to.x - to.w / 2 - 4;
            const y2 = to.y;
            const mid = (x1 + x2) / 2;
            const kind = str(edge.kind);
            return h('path', {
              key: `flow-${index}`,
              d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
              fill: 'none',
              stroke: hot ? 'var(--high)' : kind === 'write' ? 'rgba(185,166,255,.5)' : 'rgba(120,150,185,.36)',
              strokeWidth: hot ? 1.8 : 1.2,
              strokeDasharray: kind === 'emit' || kind === 'http' ? '4 3' : undefined,
              markerEnd: hot ? 'url(#cr-flow-arrow-hot)' : 'url(#cr-flow-arrow)',
              opacity: dim ? 0.14 : 1,
            });
          }),
          Array.from(layout.positions.values()).map((entry) => {
            const kindMeta = FLOW_KIND_META[entry.kind] || FLOW_KIND_META.service;
            const isSelected = selected === str(entry.node.id);
            const isDim = selected && !isSelected && !(related && related.has(str(entry.node.id)));
            return h('g', {
              key: str(entry.node.id),
              className: `cr-graph-node${isDim ? ' is-dim' : ''}${isSelected ? ' is-active' : ''}`,
              onClick: () => spec.onSelect && spec.onSelect(str(entry.node.id)),
              onMouseEnter: (event) => setHover({ node: entry.node, kind: entry.kind, x: event.clientX, y: event.clientY }),
              onMouseMove: (event) => setHover((current) => (current && str(current.node.id) === str(entry.node.id) ? { ...current, x: event.clientX, y: event.clientY } : { node: entry.node, kind: entry.kind, x: event.clientX, y: event.clientY })),
              onMouseLeave: () => setHover(null),
            },
            h('rect', {
              x: entry.x - entry.w / 2, y: entry.y - entry.h / 2,
              width: entry.w, height: entry.h, rx: 12,
              fill: isSelected ? 'rgba(53,224,200,.1)' : 'var(--code-bg)',
              stroke: isSelected ? kindMeta.color : `${kindMeta.color}55`,
              strokeWidth: isSelected ? 1.8 : 1.2,
            }),
            h('circle', { cx: entry.x - entry.w / 2 + 16, cy: entry.y, r: 3.4, fill: kindMeta.color }),
            h('text', {
              x: entry.x - entry.w / 2 + 28, y: entry.y - 3,
              style: { fill: 'var(--text)', fontSize: 11.5, fontWeight: 620 },
            }, str(entry.node.label).slice(0, 24)),
            h('text', {
              x: entry.x - entry.w / 2 + 28, y: entry.y + 13,
              className: 'cr-graph-sub',
            }, `${str(entry.node.path, '').slice(0, 30)}`));
          })),
        h('div', { className: 'cr-graph-canvas-hint' }, '点击节点查看关联文件与 findings'),
        hover ? h('div', {
          className: 'cr-tooltip',
          style: {
            left: `${clamp(hover.x, 20, (window.innerWidth || 1440) - 200)}px`,
            top: `${clamp(hover.y - 10, 20, (window.innerHeight || 1000) - 120)}px`,
            transform: 'translate(0, -100%)',
          },
        },
        h('div', { className: 'cr-tt-head' }, h('span', null, str(hover.node.label)), h('span', null, FLOW_KIND_META[hover.kind] ? FLOW_KIND_META[hover.kind].label : hover.kind)),
        h('div', { className: 'cr-tt-row' }, h('span', null, 'path'), h('span', null, str(hover.node.path, '—'))),
        h('div', { className: 'cr-tt-row' }, h('span', null, 'files'), h('span', null, num(hover.node.files))),
        h('div', { className: 'cr-tt-row' }, h('span', null, 'risk'), h('span', null, str(hover.node.risk, '—')))) : null);
    }

    function FlowView(props) {
      const snapshot = obj(props && props.snapshot);
      const project = obj(snapshot.project);
      const loaded = useGraphLoader(props && props.connection, 'flow', str(project.id));
      const data = obj(loaded.data);
      const graph = obj(data.graph);
      const nodes = arr(graph.nodes);
      const edges = arr(graph.edges);
      const findings = arr(data.findings);
      const summary = obj(data.summary);
      const [selected, setSelected] = React.useState('');
      const selectedNode = nodes.find((node) => str(node.id) === selected);
      const related = selected
        ? findings.filter((finding) => {
          const path = str(finding.path);
          const target = str(selectedNode && selectedNode.path);
          return target && (path === target || path.startsWith(`${target}/`));
        })
        : findings;
      const entryNodes = nodes.filter((node) => str(node.kind) === 'entry');
      const flows = entryNodes.map((entry) => {
        const firstHop = edges.filter((edge) => str(edge.from) === str(entry.id));
        const secondHop = firstHop.flatMap((edge) => edges.filter((next) => str(next.from) === str(edge.to)));
        const dataTargets = [...new Set(secondHop.filter((edge) => ['read', 'write', 'emit'].includes(str(edge.kind))).map((edge) => str(edge.to)))];
        const risk = [entry, ...firstHop, ...secondHop].some((item) => ['high', 'critical'].includes(str(item.risk))) ? 'high' : firstHop.length ? 'medium' : 'low';
        return { entry, firstHop, secondHop, dataTargets, risk };
      });
      const flowsCount = num(obj(summary.stats).flows, flows.length);
      const entriesCount = num(obj(summary.stats).entries, entryNodes.length);

      return h('div', { className: 'cr-stack' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('div', null,
            h('div', { style: { fontSize: 14, fontWeight: 680 } }, '信息流 · 入口 → 服务 → 数据'),
            h('div', { className: 'cr-card-sub' }, str(summary.headline, `${nodes.length} 节点 · ${edges.length} 条链路`))),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
            ['entry', 'service', 'data', 'external'].map((kind) => h(Badge, {
              key: kind,
              color: FLOW_KIND_META[kind].color,
              soft: `${FLOW_KIND_META[kind].color}14`,
              border: `${FLOW_KIND_META[kind].color}33`,
              children: `${FLOW_KIND_META[kind].label} ${nodes.filter((node) => str(node.kind) === kind).length}`,
            })))),
        loaded.loading && !loaded.data ? h(PlaceholderCard, { title: '信息流加载中…' }) : null,
        loaded.error && !loaded.data ? h(Banner, { tone: 'error' }, loaded.error) : null,
        h('div', { className: 'cr-graph-wrap' },
          h('div', { className: 'cr-graph-canvas' },
            h(FlowGraph, { graph, selected, onSelect: (id) => setSelected(selected === id ? '' : id) })),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
            h(Card, {
              title: '链路概览',
              icon: 'zap',
              bodyClassName: 'cr-card-body',
              children: h('div', { className: 'cr-metric-grid' },
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '业务链路'), h('div', { className: 'cr-metric-v' }, flowsCount)),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '入口'), h('div', { className: 'cr-metric-v' }, entriesCount)),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '服务节点'), h('div', { className: 'cr-metric-v' }, nodes.filter((node) => str(node.kind) === 'service').length)),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '数据访问'), h('div', { className: 'cr-metric-v' }, nodes.filter((node) => str(node.kind) === 'data').length)),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '外部依赖'), h('div', { className: 'cr-metric-v' }, nodes.filter((node) => str(node.kind) === 'external').length)),
                h('div', { className: 'cr-metric' }, h('div', { className: 'cr-metric-k' }, '链路问题'), h('div', { className: 'cr-metric-v' }, findings.length)))}),
            ),
            h(Card, {
              title: 'flow 列表',
              icon: 'list',
              subtitle: '入口 → 服务 → 数据',
              bodyClassName: 'cr-card-body',
              children: flows.length
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, flows.map((flow) => {
                  const active = selected === str(flow.entry.id);
                  return h('div', {
                    key: str(flow.entry.id),
                    style: {
                      border: `1px solid ${active ? 'rgba(53,224,200,.4)' : 'var(--line)'}`,
                      borderRadius: 10, padding: '8px 10px', cursor: 'pointer',
                      background: active ? 'rgba(53,224,200,.06)' : 'var(--surface-soft)',
                    },
                    onClick: () => setSelected(active ? '' : str(flow.entry.id)),
                  },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                    h('i', { className: 'cr-dot', style: { background: riskColor(flow.risk) } }),
                    h('span', { style: { fontSize: 11, fontWeight: 620, color: 'var(--text)' } }, str(flow.entry.label)),
                    h('span', { style: { marginLeft: 'auto', fontSize: 9, color: 'var(--faint)', fontFamily: 'var(--mono)' } }, str(flow.risk))),
                  h('div', { style: { fontSize: 9.5, color: 'var(--faint)', marginTop: 4, fontFamily: 'var(--mono)' } },
                    `${flow.firstHop.length} 服务 · ${num(flow.dataTargets.length)} 数据访问 · ${str(flow.entry.path, '')}`));
                }))
                : h(EmptyState, { icon: 'flow', text: '没有识别到业务链路' }),
            }),
            h(Card, {
              title: selected ? `关联问题 · ${str(selectedNode && selectedNode.label)}` : '信息流问题',
              icon: 'alert',
              subtitle: `${related.length} 条 · 点击节点过滤`,
              bodyClassName: 'cr-card-body',
              children: related.length
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } }, related.map((finding, index) => h('div', { key: str(finding.id) || `flow-f-${index}`, style: { display: 'flex', gap: 7, alignItems: 'flex-start' } },
                  h(SevBadge, { severity: finding.severity }),
                  h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.45 } }, str(finding.title)),
                    h('div', { style: { fontSize: 9.5, color: 'var(--faint)', fontFamily: 'var(--mono)', marginTop: 2 } }, `${str(finding.path)}:${num(finding.startLine)}`)))))
                : h(EmptyState, { icon: 'alert', text: '没有信息流问题' }),
            })));
    }

    // =====================================================================
    // 13. 新建评审弹层
    // =====================================================================

    const LAUNCH_TYPES = [
      { value: 'workspace', title: '当前改动', hint: 'staged + unstaged + untracked', recommended: true, desc: '评审工作区未提交改动，最常用' },
      { value: 'commit', title: '单次提交', hint: 'ocr review --commit <sha>', desc: '针对某个 commit 做回顾' },
      { value: 'range', title: '分支对比', hint: '--from / --to（merge-base）', desc: '分支合入前的差异评审' },
      { value: 'architecture', title: '项目架构', hint: 'ocr scan · 依赖图/环/热点', recommended: true, desc: '整体架构与模块依赖体检' },
      { value: 'module', title: '代码模块', hint: 'ocr scan --path', desc: '指定目录或文件的深度体检' },
      { value: 'flow', title: '信息流', hint: '入口 → 服务 → 数据', desc: '业务链路与数据流风险' },
    ];

    function ProjectModules(props) {
      const spec = props || {};
      const modules = arr(spec.modules);
      if (!modules.length) return h('div', { className: 'cr-hint' }, '该项目没有模块信息');
      return h('div', { className: 'cr-checks' }, modules.map((module) => {
        const name = str(module.name || module.path);
        const on = arr(spec.value).includes(name);
        return h('button', {
          key: name,
          type: 'button',
          className: `cr-check${on ? ' is-on' : ''}`,
          onClick: () => {
            const next = on ? arr(spec.value).filter((item) => item !== name) : arr(spec.value).concat([name]);
            if (spec.onChange) spec.onChange(next);
          },
        }, on ? h(Icon, { name: 'check', size: 10 }) : null, name);
      }));
    }

    function LaunchModal(props) {
      const spec = props || {};
      const snapshot = obj(spec.snapshot);
      const projects = arr(snapshot.projects);
      const fallbackProject = obj(snapshot.project);
      const toast = useToast();
      const rpc = useRpc(spec.connection);
      const defaultProjectId = str(spec.defaultProjectId, str(fallbackProject.id));
      const [projectId, setProjectId] = React.useState(defaultProjectId);
      const project = projects.find((item) => str(item.id) === str(projectId)) || fallbackProject;
      const modules = arr(project.modules);
      const [type, setType] = React.useState('workspace');
      const [commit, setCommit] = React.useState('');
      const [from, setFrom] = React.useState('main');
      const [to, setTo] = React.useState(str(project.branch, 'master'));
      const [paths, setPaths] = React.useState([]);
      const [background, setBackground] = React.useState('');
      const [effort, setEffort] = React.useState('medium');
      const [engine, setEngine] = React.useState('auto');
      const [exclude, setExclude] = React.useState('**/node_modules/**,**/dist/**');
      const [budget, setBudget] = React.useState('0');
      const [submitting, setSubmitting] = React.useState(false);

      React.useEffect(() => {
        if (defaultProjectId) setProjectId(defaultProjectId);
      }, [defaultProjectId]);

      const needsPaths = type === 'module' || type === 'flow';
      const submit = async () => {
        if (submitting) return;
        if (type === 'commit' && !str(commit)) {
          toast('请填写要评审的 commit SHA', 'warn');
          return;
        }
        if (type === 'range' && (!str(from) || !str(to))) {
          toast('请填写 from / to 分支', 'warn');
          return;
        }
        if (type === 'module' && !paths.length) {
          toast('请至少选择一个模块路径', 'warn');
          return;
        }
        setSubmitting(true);
        try {
          await rpc('start', {
            projectId: str(project.id),
            projectPath: str(project.path),
            type,
            scope: {
              commit: str(commit),
              from: str(from),
              to: str(to),
              paths: type === 'module' || type === 'flow' ? paths : [],
              flowId: '',
            },
            options: {
              effort,
              background: str(background),
              exclude: str(exclude),
              maxTokensBudget: num(budget),
              engine,
            },
          });
          toast('评审任务已加入队列', 'success');
          if (spec.onStarted) spec.onStarted();
        } catch (error) {
          toast(errorText(error), 'error');
        } finally {
          setSubmitting(false);
        }
      };

      return h(Modal, {
        open: true,
        title: '新建 Review',
        subtitle: '选择评审类型并填写范围，提交后立即出现在实时队列',
        onClose: spec.onClose,
        footer: [
          h('span', { key: 'hint', className: 'cr-grow cr-hint' }, 'Esc 关闭 · Ctrl/Cmd + K 快速打开 · 任务由 Host 侧 OCR 子进程执行'),
          h('button', { key: 'cancel', type: 'button', className: 'cr-btn is-ghost', onClick: spec.onClose }, '取消'),
          h('button', {
            key: 'submit', type: 'button', className: 'cr-btn is-primary', onClick: submit, disabled: submitting,
          }, h(Icon, { name: submitting ? 'clock' : 'play', size: 12 }), submitting ? '提交中…' : '开始评审'),
        ],
        children: [
          h('div', { key: 'project', className: 'cr-form-grid', style: { gridTemplateColumns: '1.4fr 1fr' } },
            h('div', { className: 'cr-field' },
              h('span', { className: 'cr-label' }, h(Icon, { name: 'folder', size: 11 }), '评审项目'),
              h('div', { className: 'cr-select', style: { width: '100%' } },
                h('select', {
                  value: str(project.id),
                  onChange: (event) => {
                    const value = str(event.target.value);
                    if (value === '__add__') {
                      event.target.value = str(project.id);
                      if (spec.onAddProject) spec.onAddProject();
                      return;
                    }
                    setProjectId(value);
                  },
                  style: { width: '100%' },
                }, (projects.length
                  ? projects.map((item) => h('option', { key: str(item.id), value: str(item.id) }, `${item.name} · ${str(item.branch, '—')}`))
                  : [h('option', { key: 'empty', value: '' }, '未发现项目')])
                  .concat([h('option', { key: '__add__', value: '__add__' }, '＋ 添加项目路径…')])),
                h(Icon, { name: 'chevronDown', size: 12 }))),
            h('div', { className: 'cr-field' },
              h('span', { className: 'cr-label' }, h(Icon, { name: 'file', size: 11 }), '仓库'),
              h('div', { className: 'cr-chip', style: { height: 31, justifyContent: 'flex-start' } },
                h('span', { className: 'cr-ellipsis', style: { fontFamily: 'var(--mono)', fontSize: 9.5 } }, str(project.path))))),
          h('div', { key: 'types', style: { marginTop: 14 } },
            h('span', { className: 'cr-label', style: { marginBottom: 7 } }, '评审类型'),
            h('div', { className: 'cr-type-grid' }, LAUNCH_TYPES.map((item) => h('button', {
              key: item.value,
              type: 'button',
              className: `cr-type-card${type === item.value ? ' is-active' : ''}`,
              onClick: () => setType(item.value),
            },
            item.recommended ? h('span', { className: 'cr-type-card-badge' }, '推荐') : null,
            h('div', { className: 'cr-type-card-top' },
              h('i', { className: 'cr-dot', style: { background: TYPE_META[item.value].color } }),
              item.title),
            h('div', { className: 'cr-type-card-hint' }, item.hint),
            h('div', { style: { fontSize: 9.5, color: 'var(--faint)', marginTop: 3 } }, item.desc))))),
          h('div', { key: 'scope', style: { marginTop: 14 } },
            h('span', { className: 'cr-label', style: { marginBottom: 7 } }, '范围参数'),
            type === 'commit' ? h('div', { className: 'cr-field' },
              h('span', { className: 'cr-label' }, 'commit SHA / ref'),
              h('input', {
                className: 'cr-input', value: commit, placeholder: '例如 bf9c296 或 HEAD~1',
                onChange: (event) => setCommit(event.target.value), spellCheck: false,
              })) : null,
            type === 'range' ? h('div', { className: 'cr-form-grid' },
              h('div', { className: 'cr-field' },
                h('span', { className: 'cr-label' }, 'from（基准）'),
                h('input', { className: 'cr-input', value: from, onChange: (event) => setFrom(event.target.value), spellCheck: false })),
              h('div', { className: 'cr-field' },
                h('span', { className: 'cr-label' }, 'to（目标）'),
                h('input', { className: 'cr-input', value: to, onChange: (event) => setTo(event.target.value), spellCheck: false }))) : null,
            type === 'workspace' ? h('div', { className: 'cr-banner is-info', style: { marginTop: 2 } },
              h(Icon, { name: 'zap', size: 13 }),
              h('span', null, '工作区干净时会自动返回「无改动」，不会启动 OCR 子进程。')) : null,
            needsPaths ? h('div', { className: 'cr-field' },
              h('span', { className: 'cr-label' }, `模块路径${type === 'flow' ? '（可选，留空=全仓）' : ''}`),
              h(ProjectModules, { modules, value: paths, onChange: setPaths })) : null,
            type === 'architecture' ? h('div', { className: 'cr-banner is-info' },
              h(Icon, { name: 'graph', size: 13 }),
              h('span', null, '全项目扫描：构建模块依赖图、检测循环依赖与热点模块，不产生 diff。')) : null),
          h('div', { key: 'options', style: { marginTop: 14 } },
            h('span', { className: 'cr-label', style: { marginBottom: 7 } }, '评审选项'),
            h('div', { className: 'cr-form-grid cols-3' },
              h('div', { className: 'cr-field' },
                h('span', { className: 'cr-label' }, 'effort'),
                h('div', { className: 'cr-select', style: { width: '100%' } },
                  h('select', { value: effort, onChange: (event) => setEffort(event.target.value), style: { width: '100%' } },
                    ['low', 'medium', 'high'].map((value) => h('option', { key: value, value }, value))),
                  h(Icon, { name: 'chevronDown', size: 12 }))),
              h('div', { className: 'cr-field' },
                h('span', { className: 'cr-label' }, 'engine'),
                h('div', { className: 'cr-select', style: { width: '100%' } },
                  h('select', { value: engine, onChange: (event) => setEngine(event.target.value), style: { width: '100%' } },
                    [{ value: 'auto', label: 'auto（推荐）' }, { value: 'ocr', label: 'ocr' }, { value: 'structural', label: 'structural' }]
                      .map((item) => h('option', { key: item.value, value: item.value }, item.label))),
                  h(Icon, { name: 'chevronDown', size: 12 }))),
              h('div', { className: 'cr-field' },
                h('span', { className: 'cr-label' }, 'token budget（0=不限）'),
                h('input', {
                  className: 'cr-input', value: budget, inputMode: 'numeric',
                  onChange: (event) => setBudget(event.target.value.replace(/[^0-9]/g, '')),
                }))),
            h('div', { className: 'cr-form-grid', style: { marginTop: 10 } },
              h('div', { className: 'cr-field' },
                h('span', { className: 'cr-label' }, 'exclude（逗号分隔）'),
                h('input', { className: 'cr-input', value: exclude, onChange: (event) => setExclude(event.target.value), spellCheck: false })),
              h('div', { className: 'cr-field' },
                h('span', { className: 'cr-label' }, '背景说明（可选）'),
                h('textarea', {
                  className: 'cr-input', rows: 2, value: background,
                  placeholder: '例如：这次改动是为了修复飞书回调鉴权，请重点关注签名与幂等',
                  onChange: (event) => setBackground(event.target.value),
                })))),
        ],
      });
    }

    // =====================================================================
    // 14. 设置抽屉
    // =====================================================================

    function SettingsDrawer(props) {
      const spec = props || {};
      const snapshot = obj(spec.snapshot);
      const config = obj(snapshot.config);
      const health = obj(snapshot.health);
      const ocr = obj(health.ocr);
      const llm = obj(health.llm);
      const git = obj(health.git);
      const store = obj(health.store);
      const heatmap = obj(obj(snapshot.stats).heatmap);
      const [testing, setTesting] = React.useState(false);
      const [testResult, setTestResult] = React.useState(null);
      const rpc = useRpc(spec.connection);
      const toast = useToast();

      const testLlm = async () => {
        if (testing) return;
        setTesting(true);
        try {
          const envelope = await rpc('llmTest', {});
          const payload = unwrapEnvelope(envelope, (candidate) => candidate && candidate.ok !== undefined && !candidate.job && !candidate.graph) || envelope;
          setTestResult(payload);
          toast(payload && payload.ok ? `LLM 正常 · ${num(payload.latencyMs)}ms` : `LLM 异常：${errorText(obj(payload).error)}`, payload && payload.ok ? 'success' : 'error');
        } catch (error) {
          setTestResult({ ok: false, error: errorText(error) });
          toast(errorText(error), 'error');
        } finally {
          setTesting(false);
        }
      };

      let ocrTone = 'var(--success)';
      if (str(ocr.state) === 'missing') ocrTone = 'var(--danger)';
      else if (str(ocr.state) === 'error' || str(ocr.state) === 'unconfigured') ocrTone = 'var(--medium)';
      const llmState = str(llm.state);
      const llmDelegate = llmState === 'delegate';
      let llmTone = (llmState === 'configured' || llmDelegate) ? 'var(--success)' : llmState === 'error' ? 'var(--danger)' : 'var(--medium)';
      const llmSourceLabel = { config: '配置文件', env: '环境变量', file: '~/.opencodereview/config.json', dsh: 'DSH 会话', none: '未配置' };

      return h(Drawer, {
        open: true,
        title: '设置',
        subtitle: `code-review · ${str(config.engineMode, 'auto')} 引擎`,
        onClose: spec.onClose,
        children: [
          h('div', { key: 'theme', className: 'cr-drawer-section' },
            h('div', { className: 'cr-drawer-title' }, h(Icon, { name: 'grid', size: 11 }), '主题'),
            h('div', { style: { marginTop: 8 } },
              h(Segmented, {
                value: str(spec.themeSetting, 'follow'),
                onChange: (value) => spec.onThemeChange && spec.onThemeChange(value),
                options: [
                  { value: 'follow', label: '跟随 DSH' },
                  { value: 'dark', label: '深色' },
                  { value: 'light', label: '浅色' },
                ],
              }),
              h('div', { className: 'cr-hint', style: { marginTop: 6 } },
                '浅色/深色只影响代码评审中心；默认跟随 DSH 外观设置。'))),
          h('div', { key: 'engine', className: 'cr-drawer-section' },
            h('div', { className: 'cr-drawer-title' }, h(Icon, { name: 'zap', size: 11 }), 'OCR 引擎'),
            h('div', { style: { marginTop: 8 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 } },
                h('i', { className: 'cr-dot', style: { background: ocrTone } }),
                h('span', { style: { fontSize: 11.5, color: 'var(--muted)', fontWeight: 620 } },
                  str(ocr.state) === 'ok' ? 'OCR 已就绪' : `OCR ${str(ocr.state, '未知')}`),
                h('span', { className: 'cr-mono', style: { marginLeft: 'auto', fontSize: 10, color: 'var(--faint)' } }, str(ocr.version, config.ocrVersion))),
              h(KV, { label: '可执行文件', value: str(config.ocrBin || ocr.path) }),
              h(KV, { label: '版本', value: str(ocr.version || config.ocrVersion) }),
              h(KV, { label: '检测时间', value: fmtStamp(ocr.checkedAt) }),
              str(ocr.error) ? h('div', { style: { marginTop: 8 } }, h(Banner, { tone: 'error' }, str(ocr.error))) : null)),
          h('div', { key: 'llm', className: 'cr-drawer-section' },
            h('div', { className: 'cr-drawer-title' }, h(Icon, { name: 'shield', size: 11 }), 'LLM 配置'),
            h('div', { style: { marginTop: 8 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 } },
                h('i', { className: 'cr-dot', style: { background: llmTone } }),
                h('span', { style: { fontSize: 11.5, color: 'var(--muted)', fontWeight: 620 } },
                  llmDelegate ? 'LLM 委托模式' : llmState === 'configured' ? 'LLM 已配置' : `LLM ${str(llm.state, '未知')}`),
                h('span', { className: 'cr-mono', style: { marginLeft: 'auto', fontSize: 10, color: 'var(--faint)' } }, llmDelegate ? `dsh/${str(llm.model, config.llmModel || '当前模型')}` : `${str(llm.provider, '—')}/${str(llm.model, '—')}`)),
              h(KV, { label: '来源', value: str(llm.sourceLabel, llmSourceLabel[str(llm.source)] || str(llm.source)) }),
              h(KV, { label: '提供方', value: str(config.llmProvider || llm.provider) }),
              h(KV, { label: '模型', value: str(config.llmModel || llm.model) }),
              h(KV, { label: '配置方式', value: llmDelegate ? 'DSH 当前会话模型（delegate）' : 'Host 进程内注入 OCR_LLM_*' }),
              llmDelegate ? h('div', { className: 'cr-hint', style: { marginTop: 6 } }, '无需 OCR API Key，使用 DSH 当前会话模型评审；OCR 仅负责选取文件与结构分析。') : null,
              h('div', { style: { marginTop: 9, display: 'flex', gap: 7, alignItems: 'center' } },
                h('button', {
                  type: 'button', className: 'cr-btn is-sm', disabled: testing,
                  onClick: testLlm,
                }, h(Icon, { name: testing ? 'clock' : 'zap', size: 11 }), testing ? '测试中…' : '测试 LLM'),
                testResult
                  ? h('span', { style: { fontSize: 10, color: testResult.ok ? 'var(--accent-soft)' : 'var(--danger-soft)' } },
                    testResult.ok ? `正常 · ${num(testResult.latencyMs)}ms` : errorText(testResult.error))
                  : h('span', { className: 'cr-hint' }, '调用一次最小请求验证连通性')),
              h('div', { className: 'cr-hint', style: { marginTop: 7, fontFamily: 'var(--mono)', fontSize: 9 } },
                'export OCR_LLM_URL=… OCR_LLM_TOKEN=… OCR_LLM_MODEL=…'))),
          h('div', { key: 'project', className: 'cr-drawer-section' },
            h('div', { className: 'cr-drawer-title' }, h(Icon, { name: 'folder', size: 11 }), '项目'),
            h('div', { style: { marginTop: 8 } },
              h(KV, { label: '项目根目录', value: arr(config.projectRoots).join('、') || '—' }),
              h(KV, { label: '默认项目', value: str(config.defaultProjectPath || obj(snapshot.project).path) }),
              h(KV, { label: '发现项目', value: `${num(git.projects || arr(snapshot.projects).length)} 个` }),
              h(KV, { label: '排除目录', value: arr(config.excludeProjects).join('、') || '—' }))),
          h('div', { key: 'store', className: 'cr-drawer-section' },
            h('div', { className: 'cr-drawer-title' }, h(Icon, { name: 'file', size: 11 }), '存储与轮询'),
            h('div', { style: { marginTop: 8 } },
              h(KV, { label: '状态目录', value: str(config.stateDir || store.path) }),
              h(KV, { label: '任务数', value: `${num(store.jobs, arr(snapshot.jobs).length)} / ${num(config.maxJobs, 200)}` }),
              h(KV, { label: '轮询间隔', value: `${num(config.pollSeconds, 2)} 秒` }),
              h(KV, { label: '热力图区间', value: `${str(heatmap.from, '—')} → ${str(heatmap.to, '—')}` }),
              h(KV, { label: 'store 状态', value: str(store.state, '—') }))),
          h('div', { key: 'about', className: 'cr-drawer-section' },
            h('div', { className: 'cr-drawer-title' }, h(Icon, { name: 'shield', size: 11 }), '关于'),
            h('div', { style: { marginTop: 8 } },
              h(KV, { label: '插件', value: '@jkin8010/dsh-code-review' }),
              h(KV, { label: '客户端版本', value: `v${PLUGIN_VERSION}` }),
              h(KV, {
                label: 'Host 版本',
                value: config.hostVersion ? `v${str(config.hostVersion)}` : '未上报（旧版 Host）',
              }),
              (config.hostVersion && config.hostVersion !== PLUGIN_VERSION) || !config.hostVersion
                ? h('div', { className: 'cr-hint', style: { color: 'var(--warn-soft)', marginTop: 6 } },
                  '客户端与 Host 版本不一致：请完全退出并重新打开 DSH（仅刷新页面只会更新客户端）')
                : null,
              h(KV, { label: 'OCR', value: str(config.ocrVersion, 'open-code-review') }),
              h(KV, { label: '快照版本', value: `v${num(snapshot.version)}` }),
              h(KV, { label: '生成时间', value: fmtStamp(snapshot.generatedAt) }),
              h('div', { className: 'cr-hint', style: { marginTop: 8 } }, '所有数据来自 Host 快照轮询；本界面不直接访问文件系统或 git。'))),
        ],
      });
    }

    // =====================================================================
    // 15. 页面骨架
    // =====================================================================

    function LoadingDeck(props) {
      const spec = props || {};
      const link = obj(spec.link);
      const failed = link.failures > 0;
      return h('div', { className: 'cr-booting', style: { height: '100%' } },
        h('div', { className: 'cr-boot-mark' }, h(Icon, { name: failed ? 'alert' : 'shield', size: 28 })),
        h('div', { className: 'cr-boot-text' }, failed ? '无法连接 Host 快照' : '正在加载代码评审中心…'),
        h('div', { className: 'cr-boot-sub' }, failed ? errorText(link.error) : 'CODE REVIEW STUDIO · POLLING SNAPSHOT'),
        failed ? h('div', { style: { marginTop: 6 } },
          h('button', { type: 'button', className: 'cr-btn is-primary', onClick: spec.onRetry },
            h(Icon, { name: 'refresh', size: 12 }), '立即重试（指数退避中）')) : null);
    }

    function HealthChip(props) {
      const spec = props || {};
      const tone = spec.tone || 'ok';
      const className = `cr-health-chip${tone === 'bad' ? ' is-bad' : tone === 'warn' ? ' is-warn' : ''}`;
      return h('div', { className, title: spec.title },
        h('i', { className: 'cr-dot', style: { background: spec.dotColor || (tone === 'bad' ? 'var(--danger)' : tone === 'warn' ? 'var(--medium)' : 'var(--success)') } }),
        h('span', null, spec.label),
        h('b', null, spec.value));
    }

    function Hud(props) {
      const spec = props || {};
      const snapshot = obj(spec.snapshot);
      const config = obj(snapshot.config);
      const health = obj(snapshot.health);
      const ocr = obj(health.ocr);
      const llm = obj(health.llm);
      const git = obj(health.git);
      const projects = arr(snapshot.projects);
      const project = obj(spec.currentProject || snapshot.project);
      const link = obj(spec.link);
      const pollSeconds = num(config.pollSeconds, 2);
      const ocrTone = str(ocr.state) === 'ok' ? 'ok' : str(ocr.state) === 'missing' ? 'bad' : 'warn';
      const llmState = str(llm.state);
      const llmTone = (llmState === 'configured' || llmState === 'delegate') ? 'ok' : llmState === 'error' ? 'bad' : 'warn';
      const gitTone = str(git.state) === 'ok' ? 'ok' : str(git.state) === 'error' ? 'bad' : 'warn';

      return h('header', { className: 'cr-hud' },
        h('div', { className: 'cr-brand' },
          h('div', { className: 'cr-brand-mark' }, h(Icon, { name: 'shield', size: 21 })),
          h('div', { className: 'cr-brand-text' },
            h('div', { className: 'cr-brand-title' }, '代码评审中心'),
            h('div', { className: 'cr-brand-sub' }, `CODE REVIEW STUDIO · DSH · V${PLUGIN_VERSION}`))),
        h('div', { className: 'cr-hud-mid' },
          h('div', { className: 'cr-picker' },
            h('span', { className: 'cr-picker-icon' }, h(Icon, { name: 'folder', size: 12 })),
            h('select', {
              value: str(project.id),
              onChange: (event) => {
              const value = str(event.target.value);
              if (value === '__add__') {
                event.target.value = str(project.id);
                if (spec.onAddProject) spec.onAddProject();
                return;
              }
              if (spec.onSwitchProject) spec.onSwitchProject(value);
            },
              title: '切换当前项目 / 添加项目路径',
            }, (projects.length
              ? projects.map((item) => h('option', { key: str(item.id), value: str(item.id) }, `${item.name}${item.dirty ? ' · dirty' : ''}`))
              : [h('option', { key: 'empty', value: '' }, str(project.name, '未发现项目'))])
              .concat([h('option', { key: '__add__', value: '__add__' }, '＋ 添加项目路径…')])),
            h(Icon, { name: 'chevronDown', size: 11, className: 'cr-picker-caret' })),
          h('div', { className: 'cr-health' },
            h(HealthChip, {
              label: 'OCR', value: str(ocr.version || config.ocrVersion, '—').replace(/^open-code-review\s*/, ''),
              tone: ocrTone, title: str(ocr.error, `OCR ${str(ocr.state, 'unknown')}`),
            }),
            h(HealthChip, {
              label: 'LLM',
              value: llmState === 'delegate'
                ? `DSH 模型${llm.model ? `/${str(llm.model)}` : ''}`
                : str(llm.provider, '—') + (llm.model ? `/${str(llm.model)}` : ''),
              tone: llmTone,
              title: str(llm.error, llmState === 'delegate'
                ? 'delegate：OCR 选文件 + DSH 当前会话模型评审（无需 OCR API Key）'
                : `LLM ${str(llm.state, 'unknown')} · ${str(llm.source, 'none')}`),
            }),
            h(HealthChip, {
              label: 'Git', value: `${num(git.projects || projects.length)} 项目`,
              tone: gitTone, title: str(git.error, 'git 状态'),
            }))),
        h('div', { className: 'cr-hud-right' },
          h('div', { className: `cr-poll${link.ok ? '' : ' is-bad'}`, title: link.ok ? '轮询正常' : errorText(link.error) },
            h('span', { className: `cr-dot${link.ok ? ' is-live' : ''}`, style: { background: link.ok ? 'var(--accent)' : 'var(--danger)' } }),
            h('span', null, link.ok ? '轮询 ' : '降级 '),
            h('b', null, link.ok ? `${pollSeconds}s` : `${Math.max(1, Math.round(num(link.retryMs) / 1000))}s`)),
          h('div', { className: 'cr-vsep' }),
          h('button', { type: 'button', className: 'cr-btn is-primary', onClick: spec.onNewReview, title: '新建评审（Ctrl/Cmd + K）' },
            h(Icon, { name: 'plus', size: 13 }), '新建 Review'),
          h('button', { type: 'button', className: 'cr-icon-btn', onClick: spec.onOpenSettings, title: '设置' },
            h(Icon, { name: 'gear', size: 15 }))));
    }

    function TabBar(props) {
      const spec = props || {};
      const snapshot = obj(spec.snapshot);
      const jobs = arr(snapshot.jobs);
      const projects = arr(snapshot.projects);
      const counts = { reviews: jobs.length, projects: projects.length };
      return h('nav', { className: 'cr-tabs' },
        TABS.map((tab) => h('button', {
          key: tab.key,
          type: 'button',
          className: `cr-tab${spec.view === tab.key ? ' is-active' : ''}`,
          onClick: () => spec.onSelect(tab.key),
          'data-tab': tab.key,
        },
        h(Icon, { name: tab.icon, size: 14 }),
        h('span', null, tab.label),
        counts[tab.key] != null ? h('span', { className: 'cr-tab-count' }, counts[tab.key]) : null)),
        h('div', { className: 'cr-tabs-right' },
          h('span', { className: 'cr-kbd' }, 'Ctrl', h('span', null, 'K'), h('span', null, '新建')),
          h('span', { className: 'cr-vsep' }),
          h('span', null, '更新于 ', h('span', { className: 'cr-mono' }, fmtClock(snapshot.generatedAt)))));
    }

    let connection = null;
    let clientCtx = null;
    let clientRemote = null;

    /** Ask the DSH client to focus a session; returns false when the service is absent. */
    function openDshSession(sessionId) {
      const id = str(sessionId);
      if (!id) return false;
      try {
        const uiWorkspace = clientCtx && clientCtx.get ? clientCtx.get('uiWorkspace') : null;
        if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
          uiWorkspace.openSession(id);
          return true;
        }
        const sessions = clientCtx && clientCtx.get ? clientCtx.get('sessions') : null;
        if (sessions && typeof sessions.open === 'function') {
          sessions.open(id);
          return true;
        }
      } catch {
        /* navigation is best effort */
      }
      return false;
    }

    function getClientRemote() {
      try {
        if (clientRemote && clientRemote.session) return clientRemote;
        if (clientCtx && typeof clientCtx.get === 'function') {
          const remote = clientCtx.get('remote');
          if (remote && remote.session) {
            clientRemote = remote;
            return remote;
          }
        }
        if (clientCtx && clientCtx.remote && clientCtx.remote.session) {
          clientRemote = clientCtx.remote;
          return clientCtx.remote;
        }
      } catch {
        /* service lookup is best effort */
      }
      return null;
    }

    /**
     * Fallback used when the Host plugin predates `fix.create`: the DSH Client
     * Remote session endpoints exist in the running Host, so create + prompt the
     * session directly. Keeps the button working without a Host restart.
     */
    function getFixClientApi() {
      const remote = getClientRemote();
      if (remote && remote.session && typeof remote.session.create === 'function') {
        return {
          create: (opts) => remote.session.create(opts),
          prompt: (sessionId, text, requestId) => remote.session.prompt({
            requestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: (() => {
              try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
            })(),
          }),
        };
      }
      try {
        const sessions = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : null;
        const manager = sessions && sessions.manager;
        if (manager && typeof manager.create === 'function' && typeof manager.get === 'function') {
          return {
            create: (opts) => manager.create(opts),
            prompt: (sessionId, text, requestId) => {
              const session = manager.get(sessionId);
              if (!session || typeof session.prompt !== 'function') throw new Error('Session 尚未就绪');
              return session.prompt([{ type: 'text', text }], 'queue', undefined, requestId);
            },
          };
        }
      } catch {
        /* service lookup is best effort */
      }
      return null;
    }

    /**
     * Preferred UI path: let the DSH client create a Workspace session and put
     * the fix prompt into its composer as a draft. This does not depend on the
     * Host `session.prompt` wire path, so the operator always sees the prompt
     * and can press Enter (or edit it first).
     */
    async function startFixSessionDraft(context) {
      const spec = obj(context);
      const ui = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : null;
      if (!ui || typeof ui.startSession !== 'function') return false;
      const projectPath = str(spec.projectPath).replace(/\/+$/, '');
      const findings = arr(spec.findings);
      if (!projectPath || !findings.length) return false;
      let workspaceId = '';
      try {
        const workspaces = clientCtx.get('workspaces');
        const snapshot = workspaces && workspaces.list && workspaces.list.getSnapshot();
        const items = arr(snapshot && snapshot.items);
        const found = items.find((item) => str(item.path).replace(/\/+$/, '') === projectPath);
        if (found) {
          workspaceId = str(found.workspaceId);
        } else if (workspaces && typeof workspaces.create === 'function') {
          const created = await workspaces.create({ path: projectPath });
          workspaceId = str(created && (created.workspaceId || created.id));
        }
      } catch {
        workspaceId = '';
      }
      if (!workspaceId) return false;
      ui.startSession(workspaceId, {
        prompt: buildFixPromptText(spec.job, findings),
        clearPreviousDraft: true,
      });
      return true;
    }

    async function createFixSessionViaRemote(context) {
      const api = getFixClientApi();
      if (!api) return null;
      const projectPath = str(obj(context).projectPath);
      if (!projectPath) return null;
      // Attach to the project Workspace when possible, so the opened Session is
      // grouped under the project (and can be focused by uiWorkspace).
      let workspaceId = '';
      try {
        const workspaces = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('workspaces') : null;
        const snapshot = workspaces && workspaces.list && workspaces.list.getSnapshot();
        const items = arr(snapshot && snapshot.items);
        const found = items.find((item) => str(item.path) === projectPath);
        if (found) workspaceId = str(found.workspaceId);
        if (!workspaceId && workspaces && typeof workspaces.create === 'function') {
          const createdWorkspace = await workspaces.create({ path: projectPath });
          workspaceId = str(createdWorkspace && (createdWorkspace.workspaceId || createdWorkspace.id));
        }
      } catch {
        workspaceId = '';
      }
      const created = await api.create(workspaceId ? { workspaceId } : { cwd: projectPath });
      if (!created || !created.ok) {
        throw new Error(errorText(obj(created && created.error).message || '创建会话失败'));
      }
      const sessionId = str(obj(created.value).sessionId);
      if (!sessionId) throw new Error('创建会话失败：未返回 sessionId');
      const prompt = buildFixPromptText(obj(context).job, arr(obj(context).findings));
      // The Remote gateway validates requestId as a UUID.
      let requestId;
      try {
        requestId = globalThis.crypto?.randomUUID?.();
      } catch {
        requestId = undefined;
      }
      if (!requestId) {
        requestId = '00000000-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12, '0');
      }
      let prompted = false;
      try {
        const result = await api.prompt(sessionId, prompt, requestId);
        prompted = Boolean(result && (result.ok || result.accepted));
      } catch {
        prompted = false;
      }
      return { sessionId, prompted, prompt, findings: arr(obj(context).findings).length };
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        try {
          console.error('[code-review] render failed', error);
        } catch {
          /* noop */
        }
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'cr-app' },
            h('style', null, css),
            h('div', { className: 'cr-booting' },
              h('div', { className: 'cr-boot-mark' }, h(Icon, { name: 'alert', size: 26 })),
              h('div', { className: 'cr-boot-text' }, '代码评审中心渲染失败'),
              h('div', { className: 'cr-boot-sub' }, errorText(this.state.error))));
        }
        return this.props.children;
      }
    }

    const THEME_STORAGE_KEY = 'dsh-code-review/theme';
    const THEME_MODES = ['follow', 'dark', 'light'];

    function readThemeSetting() {
      try {
        const value = localStorage.getItem(THEME_STORAGE_KEY);
        return THEME_MODES.includes(value) ? value : 'follow';
      } catch {
        return 'follow';
      }
    }

    /** Follow the DSH shell theme unless the user pinned dark/light here. */
    function useCrTheme() {
      const [setting, setSetting] = React.useState(readThemeSetting);
      const [shellTheme, setShellTheme] = React.useState(() => {
        try {
          return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
        } catch {
          return 'dark';
        }
      });
      React.useEffect(() => {
        let observer = null;
        try {
          observer = new MutationObserver(() => {
            setShellTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
          });
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        } catch {
          observer = null;
        }
        return () => observer?.disconnect();
      }, []);
      const update = React.useCallback((next) => {
        if (!THEME_MODES.includes(next)) return;
        setSetting(next);
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          /* persistence is optional */
        }
      }, []);
      const effective = setting === 'follow' ? shellTheme : setting;
      return { setting, effective, update };
    }

    function CodeReviewPage(props) {
      const spec = props || {};
      const initialView = str(spec.initialView, 'overview');
      const baseView = initialView === 'launch' || initialView === 'settings'
        ? 'overview'
        : initialView === 'detail' || TABS.some((tab) => tab.key === initialView)
          ? initialView
          : 'overview';
      const [view, setView] = React.useState(baseView);
      const [detailId, setDetailId] = React.useState(str(spec.initialJobId));
      const [launchOpen, setLaunchOpen] = React.useState(initialView === 'launch');
      const [settingsOpen, setSettingsOpen] = React.useState(initialView === 'settings');
      const [addProjectOpen, setAddProjectOpen] = React.useState(false);
      const [projectId, setProjectId] = React.useState('');
      const [pollSeconds, setPollSeconds] = React.useState(2);
      const [projectOverride, setProjectOverride] = React.useState(null);
      const returnViewRef = React.useRef(baseView === 'detail' ? 'overview' : baseView);
      const [toasts, setToasts] = React.useState([]);
      const theme = useCrTheme();
      const toastSeqRef = React.useRef(0);
      const toastTimersRef = React.useRef(new Set());

      const pushToast = React.useCallback((text, tone) => {
        toastSeqRef.current += 1;
        const id = `t-${toastSeqRef.current}`;
        setToasts((list) => list.concat([{ id, text: str(text), tone: tone || 'info' }]));
        const timer = setTimeout(() => {
          setToasts((list) => list.filter((item) => item.id !== id));
          toastTimersRef.current.delete(timer);
        }, 3400);
        toastTimersRef.current.add(timer);
      }, []);
      React.useEffect(() => () => {
        toastTimersRef.current.forEach((timer) => clearTimeout(timer));
        toastTimersRef.current.clear();
      }, []);

      const polling = useSnapshotPolling(connection, pollSeconds * 1000, projectId);
      const snapshot = polling.snapshot;
      const link = polling.link;
      const rpc = useRpc(connection);

      React.useEffect(() => {
        const configPoll = num(obj(obj(snapshot).config).pollSeconds, 2);
        if (configPoll > 0 && configPoll !== pollSeconds) setPollSeconds(configPoll);
      }, [snapshot && snapshot.config && snapshot.config.pollSeconds]);

      React.useEffect(() => {
        const id = str(obj(obj(snapshot).project).id);
        if (!projectId && id) setProjectId(id);
      }, [snapshot && snapshot.project && snapshot.project.id]);

      React.useEffect(() => {
        if (view !== 'detail' || detailId || !snapshot) return;
        const jobs = arr(snapshot.jobs);
        const pick = jobs.find((job) => str(job.status) === 'completed' && str(job.type) === 'workspace')
          || jobs.find((job) => str(job.status) === 'completed')
          || jobs[0];
        if (pick && pick.id) setDetailId(str(pick.id));
      }, [view, detailId, snapshot]);

      React.useEffect(() => {
        const onKeyDown = (event) => {
          const key = str(event.key).toLowerCase();
          if ((event.metaKey || event.ctrlKey) && key === 'k') {
            event.preventDefault();
            setLaunchOpen(true);
            return;
          }
          if (key === 'escape') {
            setLaunchOpen(false);
            setSettingsOpen(false);
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, []);

      const currentProject = projectOverride || obj(obj(snapshot).project);
      const refresh = React.useCallback(() => { void polling.fetchOnce(); }, [polling.fetchOnce]);

      const switchProject = React.useCallback(async (nextId) => {
        const id = str(nextId);
        if (!id || id === str(obj(currentProject).id)) return;
        setProjectId(id);
        try {
          const envelope = await rpc('project', { projectId: id });
          const payload = unwrapEnvelope(envelope, (candidate) => candidate && candidate.project);
          if (payload) setProjectOverride(obj(payload.project));
          pushToast(`已切换当前项目：${str(obj(payload).project ? obj(payload).project.name : id)}`, 'success');
        } catch (error) {
          pushToast(errorText(error), 'error');
        }
        refresh();
      }, [currentProject, rpc, pushToast, refresh]);

      const addProject = React.useCallback(async (path) => {
        const envelope = await rpc('project.add', { path });
        const payload = unwrapEnvelope(envelope, (value) => Boolean(value && value.snapshot));
        if (!payload) throw new Error('服务端未返回项目快照');
        const next = obj(payload);
        const nextProject = obj(next.project);
        if (nextProject.id) {
          setProjectOverride(nextProject);
          setProjectId(str(nextProject.id));
        }
        setAddProjectOpen(false);
        pushToast(`已添加项目：${str(nextProject.name, path)}`, 'success');
        refresh();
        return next;
      }, [rpc, pushToast, refresh]);

      const openJob = React.useCallback((id) => {
        const jobId = str(id);
        if (!jobId) return;
        if (view !== 'detail') returnViewRef.current = view;
        setDetailId(jobId);
        setView('detail');
      }, [view]);

      const cancelJob = React.useCallback(async (id) => {
        try {
          await rpc('cancel', { id: str(id) });
          pushToast('已取消该评审任务', 'warn');
          refresh();
        } catch (error) {
          pushToast(errorText(error), 'error');
        }
      }, [rpc, pushToast, refresh]);

      const retryJob = React.useCallback(async (id) => {
        try {
          await rpc('retry', { id: str(id) });
          pushToast('已重新加入评审队列', 'success');
          refresh();
        } catch (error) {
          pushToast(errorText(error), 'error');
        }
      }, [rpc, pushToast, refresh]);

      const createFixSession = React.useCallback(async (id, context) => {
        try {
          const drafted = await startFixSessionDraft(context);
          if (drafted) {
            await rpc('fix.mark', { jobId: str(id) }).catch(() => {});
            pushToast('已新建会话并填入修复提示词，按 Enter 发送（可先编辑）', 'success');
            refresh();
            return;
          }
        } catch {
          /* fall through to the Host path */
        }
        try {
          const envelope = await rpc('fix.create', { jobId: str(id) });
          const payload = unwrapEnvelope(envelope, (value) => Boolean(value && typeof value.sessionId === 'string' && value.sessionId));
          if (!payload) throw new Error('服务端未返回 sessionId');
          const sessionId = str(payload.sessionId);
          const opened = openDshSession(sessionId);
          if (payload.prompted === false) {
            const copied = payload.prompt ? await copyToClipboard(str(payload.prompt)) : false;
            pushToast(`修复会话已创建，但提示词发送失败：${errorText(obj(payload.error).message)}${copied ? '；提示词已复制，请到新会话粘贴发送' : ''}`, 'warn');
          } else {
            pushToast(opened
              ? `已创建修复会话并打开（${num(payload.findings)} 条 findings）`
              : `已创建修复会话 ${sessionId}，请在左侧会话列表打开`, opened ? 'success' : 'info');
          }
          refresh();
          return;
        } catch (error) {
          // Host older than the UI: use the DSH Client Remote session endpoints.
          const fallback = await createFixSessionViaRemote(context).catch((cause) => {
            throw cause;
          });
          if (!fallback) {
            throw new Error(`${errorText(error)}；客户端 v${PLUGIN_VERSION} 兼容通道不可用。请完全退出并重新打开 DSH 以加载新版 Host`);
          }
          const opened = openDshSession(fallback.sessionId);
          let copyNote = '';
          if (!fallback.prompted && fallback.prompt) {
            const copied = await copyToClipboard(str(fallback.prompt));
            if (copied) copyNote = '；提示词已复制，请到新会话粘贴发送';
          }
          pushToast(
            `${fallback.prompted ? '已创建修复会话' : '修复会话已创建（提示词未发送）'}${opened ? '并打开' : ` ${fallback.sessionId}，请在左侧会话列表打开`}` +
            `${copyNote}。插件 Host 版本较旧，重启 DSH 可启用完整模式`,
            fallback.prompted ? 'success' : 'warn',
          );
        }
      }, [rpc, pushToast, refresh]);

      const deleteJob = React.useCallback(async (id) => {
        try {
          await rpc('delete', { id: str(id) });
          pushToast('已删除评审记录', 'success');
          if (str(id) === detailId) {
            setView(returnViewRef.current || 'reviews');
            setDetailId('');
          }
          refresh();
        } catch (error) {
          pushToast(errorText(error), 'error');
        }
      }, [rpc, pushToast, refresh, detailId]);

      if (!snapshot) {
        return h('div', { className: 'cr-app', 'data-cr-theme': theme.effective, 'data-view': 'loading', 'data-ready': '0' },
          h('style', null, css),
          h(LoadingDeck, { link, onRetry: polling.retryNow }));
      }

      const overview = obj(snapshot.overview);

      return h(ToastCtx.Provider, { value: pushToast },
        h('div', { className: 'cr-app', 'data-cr-theme': theme.effective, 'data-view': view, 'data-ready': '1' },
          h('style', null, css),
          h(Hud, {
            snapshot,
            currentProject,
            link,
            onSwitchProject: switchProject,
            onNewReview: () => setLaunchOpen(true),
            onAddProject: () => setAddProjectOpen(true),
            onOpenSettings: () => setSettingsOpen(true),
          }),
          h(TabBar, {
            snapshot,
            view: view === 'detail' ? '' : view,
            onSelect: (key) => {
              setView(key);
              if (key === 'architecture' || key === 'flow') setSettingsOpen(false);
            },
          }),
          h('div', { className: 'cr-body' },
            !link.ok ? h('div', { style: { marginBottom: 12 } },
              h(Banner, {
                tone: 'warn',
                right: h('button', { type: 'button', className: 'cr-btn is-sm', onClick: polling.retryNow },
                  h(Icon, { name: 'refresh', size: 11 }), '重试'),
              }, `轮询失败（第 ${num(link.failures)} 次）：${errorText(link.error)} · 当前展示最后一次成功数据（${fmtClock(link.lastOkAt) || '—'}）`)) : null,
            snapshot.ok === false ? h('div', { style: { marginBottom: 12 } },
              h(Banner, { tone: 'error' }, 'Host 快照标记为异常（ok=false），部分数据可能不完整')) : null,
            view === 'overview' ? h(OverviewView, {
              snapshot,
              onOpenJob: openJob,
              onSwitchProject: switchProject,
              onOpenModule: (entry) => {
                pushToast(`模块 ${str(entry.module)} · ${num(entry.findings)} 个问题`, 'info');
                setView('reviews');
              },
            }) : null,
            view === 'reviews' ? h(ReviewsView, {
              snapshot,
              onOpenJob: openJob,
              onCancel: cancelJob,
              onRetry: retryJob,
              onDelete: deleteJob,
            }) : null,
            view === 'projects' ? h(ProjectsView, {
              snapshot, onSwitchProject: switchProject, onAddProject: () => setAddProjectOpen(true),
            }) : null,
            view === 'architecture' ? h(ArchitectureView, { snapshot, connection }) : null,
            view === 'flow' ? h(FlowView, { snapshot, connection }) : null,
            view === 'detail' ? h(DetailView, {
              connection,
              jobId: detailId,
              onBack: () => setView(returnViewRef.current || 'overview'),
              onCancel: cancelJob,
              onRetry: retryJob,
              onDelete: deleteJob,
              onCreateFix: createFixSession,
              onReload: () => {
                setDetailId('');
                const jobs = arr(snapshot.jobs);
                const pick = jobs.find((job) => str(job.status) === 'completed' && str(job.type) === 'workspace') || jobs[0];
                if (pick && pick.id) setDetailId(str(pick.id));
              },
            }) : null),
          launchOpen ? h(LaunchModal, {
            snapshot,
            connection,
            defaultProjectId: str(obj(currentProject).id),
            onAddProject: () => setAddProjectOpen(true),
            onClose: () => setLaunchOpen(false),
            onStarted: () => {
              setLaunchOpen(false);
              setView('reviews');
              refresh();
            },
          }) : null,
          h(AddProjectDialog, {
            open: addProjectOpen,
            onClose: () => setAddProjectOpen(false),
            onSubmit: addProject,
            connection,
          }),
          settingsOpen ? h(SettingsDrawer, {
            snapshot,
            connection,
            themeSetting: theme.setting,
            onThemeChange: theme.update,
            onClose: () => setSettingsOpen(false),
          }) : null,
          h(ToastStack, { toasts }),
          h('div', { style: { display: 'none' }, 'data-overview': JSON.stringify({
            reviewsTotal: num(overview.reviewsTotal),
            running: num(overview.running),
            queued: num(overview.queued),
          }) })));
    }

    function CodeReviewRoot(props) {
      return h(Boundary, null, h(CodeReviewPage, props));
    }

    // =====================================================================
    // 16. 侧栏图标（盾牌 + 对勾 + 扫描线）
    // =====================================================================

    function CodeReviewIcon(props) {
      const spec = props || {};
      const size = num(spec.size, 18);
      const active = Boolean(spec.active);
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2 : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('path', { d: 'M12 2.8 20.2 6.6v6.1c0 4.5-3.3 7.8-8.2 9.1-4.9-1.3-8.2-4.6-8.2-9.1V6.6Z' }),
      h('path', { d: 'M8.4 12.2l2.6 2.6 4.6-5.1' }),
      h('path', { d: 'M4.6 9.2h14.8M4.6 15.1h14.8', opacity: active ? 0.9 : 0.62 }));
    }

    // =====================================================================
    // 17. client entry
    // =====================================================================

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        clientCtx = ctx;
        connection = ctx.connection;
        if (typeof ctx.inject === 'function') {
          ctx.inject(['remote'], (scope) => {
            try {
              clientRemote = scope.remote ?? scope.get?.('remote') ?? null;
            } catch {
              clientRemote = null;
            }
          });
        }

        const locale = ctx.get('locale');
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => {
            try {
              return locale.register(PANEL_ID, dict) || (() => {});
            } catch {
              return () => {};
            }
          }, 'code-review:locale-dict');
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => pickTitle(),
        }, CodeReviewIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, CodeReviewRoot));
      },
    };
  },
});
