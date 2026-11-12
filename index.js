/**
 * Host half of the code review studio (`@jkin8010/dsh-code-review`).
 *
 * The plugin owns every side effect: it shells out to the
 * [open-code-review](https://github.com/alibaba/open-code-review) CLI (`ocr`),
 * runs the offline structural analysers, and persists review history. The Web
 * page polls one authenticated RPC endpoint and never touches git or `ocr`
 * itself.
 *
 * Wire protocol (identical envelope to the shipped management routes):
 *   POST /api/code-review  { type:'client-request', method:'code-review',
 *                            rpcId, payload:{ method, payload } }
 *   <-  { type:'server-response', rpcId, result:{ ok, value|error } }
 *
 * Failure policy: collectors and reviews degrade instead of throwing. A missing
 * `ocr`, an unconfigured LLM, or a non-git project leaves the page readable and
 * explains the next action in `health` / `overview`.
 */
import { readFileSync } from 'node:fs';
import * as git from './host/git.js';
import * as ocr from './host/ocr.js';
import * as analyze from './host/analyze.js';
import { findOcrBinary, loadConfiguredToken, normalizeConfig, resolveOcrEnv } from './host/config.js';
import { createJobs } from './host/jobs.js';
import { createLlmReviewer } from './host/llm-review.js';
import { registerCodeReviewTool } from './host/tool.js';
import { createRpcHandler, mountRpcRoute } from './host/rpc.js';
import { createEnginePlan } from './host/engine-plan.js';
import { createServiceRefs } from './host/service-refs.js';
import { startLifecycle } from './host/lifecycle.js';
import { createCodeReviewCommand } from './host/commands.js';
import { createSnapshot } from './host/snapshot.js';
import { createStore } from './host/store.js';
import { errorText } from './host/shared.js';

export const name = 'qise-code-review';

function createLogger(ctx) {
  let logger = null;
  const resolve = () => {
    if (logger) return logger;
    try {
      const raw = ctx?.logger?.('qise-code-review');
      if (raw) {
        const normalized = {
          info: (...args) => raw.info?.(...args),
          warn: (...args) => raw.warn?.(...args),
          error: (...args) => raw.error?.(...args),
          debug: (...args) => raw.debug?.(...args),
        };
        logger = normalized;
      }
    } catch {
      /* logger is best effort */
    }
    return logger;
  };
  const log = (level) => (...args) => {
    try {
      resolve()?.[level]?.(...args);
    } catch {
      /* logging must never break a review */
    }
  };
  return { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}




const HOST_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

export function apply(ctx, rawConfig) {
  const logger = createLogger(ctx);
  const config = normalizeConfig(rawConfig, { hostCwd: process.cwd() });
  const configuredToken = loadConfiguredToken(config);
  if (configuredToken) config.ocr.llmToken = configuredToken;
  if (!config.enabled) {
    logger.info('code review studio disabled by configuration');
    return;
  }
  config.ocr.bin = findOcrBinary(config);
  config.hostVersion = HOST_VERSION;
  const serviceRefs = createServiceRefs(ctx);

  // snapshot and jobs resolve each other lazily: jobs needs the snapshot's
  // project resolver, while snapshot projects job history. Both refs are
  // assigned before the lifecycle starts any work, so no stub is needed.
  let snapshotRef = null;
  let enginePlan = () => ({ mode: 'structural', llmConfigured: false });
  const getLlmState = () => snapshotRef?.getLlmState() ?? {
    configured: false, ocrConfigured: false, provider: null, model: null,
  };
  const store = createStore({
    dir: config.stateDir,
    maxJobs: config.maxJobs,
    logger: () => logger,
  });

  // The DSH model route doubles as OCR's delegation mode: OCR still selects the
  // files and resolves rules, the session model performs the review. Both
  // services are looked up lazily so plugin mount order does not matter.
  const getLlm = () => {
    try {
      return ctx.get?.('llm') ?? undefined;
    } catch {
      return undefined;
    }
  };
  const getSelection = () => {
    try {
      return ctx.get?.('agentDefaultModel')?.currentSelection?.();
    } catch {
      return undefined;
    }
  };
  const llmReviewer = createLlmReviewer({ getLlm, getSelection, logger });

  const jobsApi = createJobs({
    config,
    env: () => resolveOcrEnv(config),
    store,
    logger,
    ocr,
    analyze,
    llmReviewer,
    getEnginePlan: () => enginePlan(),
    projectResolver: (args) => {
      if (!snapshotRef) throw new Error('code review snapshot is not initialized');
      return snapshotRef.getProject(args);
    },
    getLlmState,
  });

  const snapshot = createSnapshot({
    config,
    store,
    jobs: jobsApi,
    git,
    ocr,
    analyze,
    logger,
    defaultProjectPath: config.defaultProjectPath,
    getDelegateStatus: () => llmReviewer.status(),
  });
  snapshotRef = snapshot;
  enginePlan = createEnginePlan({
    config,
    getLlmState,
    getDelegateStatus: () => llmReviewer.status(),
  });

  // Conversational entry: one model-facing tool backing "在对话里 review 当前项目".
  registerCodeReviewTool(ctx, { jobs: jobsApi, config, logger });

  // Slash command entry: `/code-review workflow @path --fix` and friends.
  const commandDefinition = createCodeReviewCommand({
    jobs: jobsApi,
    snapshot,
    config,
    logger,
    getSessionController: () => serviceRefs.sessionController,
    getWorkspaceRegistry: () => serviceRefs.workspaceRegistry,
  });
  const disposeCommand = (commands) => {
    if (!commands || typeof commands.register !== 'function') {
      logger.warn('commands service is unavailable; /code-review is not registered');
      return null;
    }
    try {
      const dispose = commands.register(commandDefinition);
      return () => {
        try {
          if (typeof dispose === 'function') dispose();
          else dispose?.dispose?.();
        } catch {
          /* disposal is best effort */
        }
      };
    } catch (error) {
      logger.warn(`code review command registration failed: ${errorText(error)}`);
      return null;
    }
  };
  ctx.effect(() => {
    let dispose = null;
    const register = (commands) => {
      dispose = disposeCommand(commands);
    };
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (scope) => register(scope.commands ?? scope.get?.('commands')));
    } else {
      register(ctx.get?.('commands'));
    }
    return () => {
      try {
        dispose?.();
      } catch {
        /* disposal is best effort */
      }
    };
  }, 'code-review:command');

  const handler = createRpcHandler({
    config,
    snapshot,
    jobs: jobsApi,
    getServices: () => serviceRefs,
    logger,
  });

  const rpcRoute = mountRpcRoute(ctx, handler, logger);

  const disposeLifecycle = startLifecycle({
    config,
    store,
    jobs: jobsApi,
    snapshot,
    serviceRefs,
    logger,
    resolveToken: () => resolveConfiguredToken(config),
  });
  ctx.effect(() => () => disposeLifecycle().finally(() => {
    try {
      rpcRoute.dispose();
    } catch {
      /* disposal is best effort */
    }
  }), 'code-review:lifecycle');
}
