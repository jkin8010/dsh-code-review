/**
 * Lazy references to core Host services the plugin needs at call time.
 *
 * `sessionController` and `workspaceRegistry` mount independently of this
 * plugin, so they are captured through `ctx.inject` per apply() rather than in
 * module scope: two mounted instances (tests, multiple hosts) keep separate
 * references and disposal clears them.
 */
export function createServiceRefs(ctx) {
  const state = { sessionController: null, workspaceRegistry: null };
  if (typeof ctx.inject === 'function') {
    for (const name of Object.keys(state)) {
      ctx.inject([name], (scope) => {
        state[name] = scope[name] ?? scope.get?.(name) ?? null;
      });
    }
  }
  return {
    get(name) {
      if (state[name]) return state[name];
      try {
        return ctx.get?.(name) ?? null;
      } catch {
        return null;
      }
    },
    get sessionController() {
      return this.get('sessionController');
    },
    get workspaceRegistry() {
      return this.get('workspaceRegistry');
    },
    dispose() {
      state.sessionController = null;
      state.workspaceRegistry = null;
    },
  };
}
