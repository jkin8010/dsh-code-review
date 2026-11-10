/**
 * Resolve which review engine will run, without touching jobs or storage.
 *
 * Precedence: forced structural → forced OCR → auto (OCR when its LLM is
 * configured, else DSH delegate when available, else structural).
 */
export function createEnginePlan({ config, getLlmState, getDelegateStatus }) {
  return () => {
    if (config.engine === 'structural') return { mode: 'structural', llmConfigured: false };
    const ocrLlm = getLlmState();
    if (config.engine === 'ocr') {
      return {
        mode: 'ocr',
        llmConfigured: Boolean(ocrLlm.ocrConfigured),
        provider: ocrLlm.provider ?? null,
        model: ocrLlm.model ?? null,
      };
    }
    if (ocrLlm.ocrConfigured) {
      return {
        mode: 'ocr',
        llmConfigured: true,
        provider: ocrLlm.provider ?? null,
        model: ocrLlm.model ?? null,
      };
    }
    const delegate = getDelegateStatus();
    if (delegate.available) {
      return {
        mode: 'delegate',
        llmConfigured: true,
        provider: delegate.provider ?? null,
        model: delegate.model ?? null,
      };
    }
    return { mode: 'structural', llmConfigured: false };
  };
}
