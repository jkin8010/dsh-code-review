// Preview data adapter for the canonical fixture (`mock-snapshot.mjs`).
//
// The fixture is owned by the Host-side Lead and exports:
//   MOCK.snapshot               完整 Snapshot
//   MOCK.detail(id)             { job, findings, files, graph }
//   MOCK.graph(kind)            { graph, summary, findings, metrics }
//   MOCK.rpc(method, payload)   直接可当 connection.rpc.call 的返回值
//   MOCK.projects / MOCK.jobs / MOCK.flows
//
// We wrap the raw MOCK.rpc value in the DSH envelope shape
// `{ ok: true, value }` so the client exercises its real unwrap path.

import * as fixture from './mock-snapshot.mjs';

const MOCK = fixture.MOCK;

if (!MOCK) {
  throw new Error('[preview] mock-snapshot.mjs must export MOCK (buildMock())');
}

export function createMockApi() {
  return {
    call(method, payload = {}) {
      try {
        const value = MOCK.rpc(method, payload || {});
        if (value && typeof value === 'object' && value.ok === false) {
          return { ok: false, error: value.error || { code: 'code-review/mock', message: 'mock rpc failed' } };
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: { code: 'code-review/mock-error', message: error?.message || String(error) } };
      }
    },
    getSnapshot: () => MOCK.snapshot,
    getDetail: (id) => MOCK.detail(id),
    getGraph: (kind) => MOCK.graph(kind),
    detailIds: () => (MOCK.jobs || []).map((job) => job.id),
    jobsWithDetails: () => (MOCK.jobs || []).filter((job) => job.status === 'completed').map((job) => job.id),
    projects: MOCK.projects,
    flows: MOCK.flows,
  };
}
