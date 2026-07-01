/**
 * FlowAdapter - Provider adapter cho Google Flow (labs.google).
 *
 * Đây là wrapper mỏng quanh PromptQueue / MessageBridge.runAutoPrompt hiện có.
 * Mục tiêu: KHÔNG thay thế các call site hiện tại (GenTab, Task, Workflow vẫn
 * gọi MessageBridge.runAutoPrompt trực tiếp). Adapter chỉ phục vụ những flow
 * mới cần generic provider routing (vd: workflow chatgpt -> generate).
 *
 * Pipeline mode: nếu PromptQueue.isEnabled() thì dùng PromptQueue.submitJob.
 * Ngược lại fallback runAutoPrompt legacy.
 */
class FlowAdapter extends AIProviderAdapter {
  constructor() {
    super();
    this.key = 'flow';
    this.displayName = 'Google Flow';
    this.featureKey = 'gen_enabled';
    this.executionAction = 'generate';

    // Phase 6 Bug O (2026-06-03): XÓA _defaultCapabilities hardcoded.
    // Strict Server-Only — capabilities + max_ref_images đọc 100% từ PCM (Phase J seeded).
  }

  /**
   * Phase 6 Bug O: Capabilities strict server-only — đọc từ PCM safeGet*.
   * SSE update → PCM cache invalidate → next read returns fresh data.
   */
  get capabilities() {
    const pcm = typeof ProviderConfigManager !== 'undefined' ? ProviderConfigManager : null;
    const supports = pcm?.safeGetSupportsSync?.('flow') || {};
    const maxImg = pcm?.safeGetMaxRefImagesSync?.('flow', 'image') ?? 0;
    const maxVidIng = pcm?.safeGetMaxRefImagesSync?.('flow', 'video_ingredients') ?? 0;

    return {
      supportsRatio: supports.ratio ?? false,
      supportsQuantity: supports.quantity ?? false,
      supportsVideo: supports.video ?? false,
      supportsRefImage: supports.ref_image ?? false,
      supportsAutoDownload: supports.auto_download ?? false,
      supportsHumanized: supports.humanized ?? false,
      maxRefImagesImage: maxImg,
      maxRefImagesVideoIngredients: maxVidIng,
      maxRefImages: Math.max(maxImg, maxVidIng),
    };
  }

  /**
   * Flow yêu cầu tab labs.google đang mở. Background.js đã có handler
   * 'ensureFlowTabReady' / 'ensureFlowTabActive' và mỗi call site (GenTab/
   * Task/Workflow) tự gọi riêng để giữ consistency với behavior cũ.
   * Adapter trả ready: true để caller tự chịu trách nhiệm tab management.
   */
  async ensureReady() {
    return { ready: true };
  }

  /**
   * Trả về max ref images theo mode hiện tại của Flow.
   * Phase J: Delegate to PCM với fallback.
   *
   * @param {object} ctx
   * @param {string} ctx.mode - 'image' | 'video' | 'Image' | 'Video' (case-insensitive)
   * @param {boolean} ctx.isFrames - true khi video mode dùng Frames input (frame_1+frame_2)
   * @returns {number}
   */
  getMaxRefImages({ mode = 'image', isFrames = false } = {}) {
    // Phase 6 Bug O: strict server-only — không fallback _defaultCapabilities
    const pcm = typeof ProviderConfigManager !== 'undefined' ? ProviderConfigManager : null;
    const isVideo = String(mode || '').toLowerCase() === 'video';
    if (isVideo && !isFrames) {
      return pcm?.safeGetMaxRefImagesSync?.('flow', 'video_ingredients') ?? 0;
    }
    return pcm?.safeGetMaxRefImagesSync?.('flow', 'image') ?? 0;
  }

  /**
   * Get duration override theo Flow web model constraints.
   *
   * Schema: `provider_models.config.duration_overrides[]` — admin set qua
   * `/admin/provider-models/{id}/edit`. Mỗi rule có shape:
   *   { when: { has_ref?: bool, input_type?: string, ... },
   *     force_duration: string,
   *     reason?: string }
   *
   * Iterate rules theo order, dừng ở rule đầu match. Tất cả điều kiện trong `when`
   * phải match (AND logic). Field undefined trong `when` = wildcard (any value).
   *
   * Use case: Flow ép duration=8s khi Veo 3.1 Lite/Fast Ingredients + add ref image
   * (nếu chọn duration khác, Flow silent drop ref → video gen không có ref).
   *
   * @param {object} ctx
   * @param {string} ctx.modelValue — vd 'veo-3.1-fast' (provider_models.value)
   * @param {boolean} ctx.hasRef — có ref image (cappedRefIds.length > 0)
   * @param {string} [ctx.inputType] — 'Ingredients' | 'Frames' (default Ingredients)
   * @returns {string|null} Forced duration (vd '8s') hoặc null nếu không có override
   */
  getDurationOverride({ modelValue, hasRef = false, hasRefVideo = false, inputType = 'Ingredients' } = {}) {
    if (!modelValue) return null;
    const Registry = typeof ModelRegistry !== 'undefined' ? ModelRegistry : null;
    const model = Registry?.findModel?.('flow', modelValue);
    const overrides = model?.config?.duration_overrides;
    if (!Array.isArray(overrides) || overrides.length === 0) return null;

    for (const rule of overrides) {
      const when = rule?.when || {};
      // AND logic: tất cả conditions trong when phải match. Undefined = wildcard.
      if (when.has_ref !== undefined && when.has_ref !== hasRef) continue;
      // 2026-05-27: has_ref_video — vd Omni Flash add ref VIDEO → force_duration '10s'.
      if (when.has_ref_video !== undefined && when.has_ref_video !== hasRefVideo) continue;
      if (when.input_type !== undefined && when.input_type !== inputType) continue;
      // Extend conditions ở đây khi thêm rule mới (vd when.duration_gt, when.quantity, ...)

      // First match wins
      return rule.force_duration || null;
    }
    return null;
  }

  /**
   * Check model có hỗ trợ thêm REF VIDEO (chọn/upload video làm reference) không.
   * Schema: `provider_models.config.supports_ref_video` (bool). Default FALSE (opt-in — chỉ
   * model bật mới cho phép ref video, vd Omni Flash). Khi true → media picker cho phép chọn +
   * upload video; thường kèm duration_overrides `{ when:{has_ref_video:true}, force_duration:"10s" }`.
   *
   * @param {string} modelValue — vd 'omni-flash'
   * @returns {boolean} true CHỈ khi admin set config.supports_ref_video === true
   */
  supportsRefVideo(modelValue) {
    if (!modelValue) return false;
    const Registry = typeof ModelRegistry !== 'undefined' ? ModelRegistry : null;
    const model = Registry?.findModel?.('flow', modelValue);
    return model?.config?.supports_ref_video === true;
  }

  /**
   * Check model có hỗ trợ ref images không (có thể conditional theo input_type).
   *
   * Schema (2 forms, support cả simple + advanced):
   *
   * Form 1 — Simple (global flag):
   *   `provider_models.config.supports_ref_images = false` → block toàn bộ.
   *
   * Form 2 — Advanced (conditional rules, ưu tiên hơn):
   *   `provider_models.config.ref_support_overrides[]`:
   *   ```json
   *   [{ "when": { "input_type": "Ingredients" }, "supported": false,
   *      "reason": "Veo Quality Ingredients không hỗ trợ ref" }]
   *   ```
   *   First match wins, AND logic, undefined field = wildcard. Default = supported (true).
   *
   * Use case: Veo 3.1 Quality + Ingredients KHÔNG hỗ trợ ref → Flow silent drop.
   * Trong Frames mode (2 keyframes) thì vẫn dùng được — cần conditional rule.
   *
   * @param {string} modelValue — vd 'veo-3.1-quality'
   * @param {object} [ctx]
   * @param {string} [ctx.inputType] — 'Ingredients' | 'Frames' | undefined (image mode → undefined).
   *   Undefined = không match rules có `when.input_type` → fall through tới global flag.
   * @param {string} [ctx.duration] — vd '4s' | '6s' | '8s' | '10s'. Dùng cho rules có
   *   `when.duration` (equality) hoặc `when.duration_in` (array). Undefined = wildcard.
   * @returns {boolean} — true (default) nếu model hỗ trợ; false nếu admin set tắt
   */
  supportsRefImages(modelValue, { inputType, duration } = {}) {
    if (!modelValue) return true; // unknown model → assume supports (graceful default)
    const Registry = typeof ModelRegistry !== 'undefined' ? ModelRegistry : null;
    const model = Registry?.findModel?.('flow', modelValue);
    const cfg = model?.config || {};

    const evaluateRefSupport = (probeDuration) => {
      const list = cfg.ref_support_overrides;
      if (Array.isArray(list) && list.length > 0) {
        for (const rule of list) {
          const when = rule?.when || {};
          if (when.input_type !== undefined && when.input_type !== inputType) continue;
          if (when.duration !== undefined && when.duration !== probeDuration) continue;
          if (Array.isArray(when.duration_in) && when.duration_in.length > 0
              && (probeDuration === undefined || !when.duration_in.includes(probeDuration))) continue;
          return rule.supported !== false; // first match wins
        }
      }
      // Form 1: global flag fallback
      return cfg.supports_ref_images !== false;
    };

    // Direct check với duration hiện tại
    if (evaluateRefSupport(duration)) return true;

    // Smart fallback (intent-based): model có auto-bump rule `duration_overrides[{has_ref:true,force_duration:X}]`
    // = admin's explicit signal "model SUPPORT ref, chỉ cần fix duration=X". → picker mở bình thường.
    // Vd Lite/Fast: dù admin có rule block ref Ingredients, sự hiện diện của auto-bump 8s nói lên
    // ý đồ admin: ref được phép (sẽ rescue bằng auto-bump). KHÔNG hiện banner.
    // Quality (không có auto-bump rule) → smart fallback không fire → block rule áp dụng → banner.
    const durationOverrides = cfg.duration_overrides;
    if (Array.isArray(durationOverrides) && durationOverrides.length > 0) {
      const hasAutoBumpForCtx = durationOverrides.some(rule => {
        const when = rule?.when || {};
        if (when.has_ref !== true) return false;
        if (when.input_type !== undefined && when.input_type !== inputType) return false;
        return !!rule.force_duration;
      });
      if (hasAutoBumpForCtx) return true;
    }

    return false;
  }

  /**
   * Check model có hỗ trợ chế độ Video Frames (2 keyframes) không.
   * Schema: `provider_models.config.supports_frames` (bool). Default true (graceful).
   * Set false → extension ẩn option "Frames" + port frame_1/frame_2 + ép video_input_type='Ingredients'.
   *
   * @param {string} modelValue — vd 'veo-3.1-quality'
   * @returns {boolean} false CHỈ khi admin set config.supports_frames === false
   */
  supportsFrames(modelValue) {
    if (!modelValue) return true; // unknown model → assume supports (graceful default)
    const Registry = typeof ModelRegistry !== 'undefined' ? ModelRegistry : null;
    const model = Registry?.findModel?.('flow', modelValue);
    return model?.config?.supports_frames !== false;
  }

  /**
   * Submit prompt tới Flow.
   *
   * Params shape (linh hoạt — chấp nhận cả single prompt và batch):
   *   { prompt, prompts, settings, refFileIds, refImageMode, autoDownload,
   *     owner, label, taskName }
   *
   * Pipeline mode (PromptQueue.isEnabled()):
   *   -> PromptQueue.submitJob({ owner, label, prompts, settings, ... })
   *
   * Legacy mode:
   *   -> MessageBridge.runAutoPrompt(params) — giữ nguyên signature gốc.
   */
  async submit(params) {
    const p = params || {};

    // Pipeline mode: PromptQueue
    if (typeof PromptQueue !== 'undefined' && typeof PromptQueue.isEnabled === 'function' && PromptQueue.isEnabled()) {
      const inst = PromptQueue.getInstance();
      // Normalize prompts: ưu tiên array prompts, fallback single prompt.
      const promptsArr = Array.isArray(p.prompts) && p.prompts.length > 0
        ? p.prompts
        : (p.prompt ? [p.prompt] : []);
      return await inst.submitJob({
        owner: p.owner || 'prompts',
        label: p.label || 'Flow generate',
        prompts: promptsArr,
        settings: p.settings || {},
        refFileIds: p.refFileIds || [],
        refImageMode: p.refImageMode || 'all',
        autoDownload: p.autoDownload,
        taskName: p.taskName || null,
      });
    }

    // Legacy mode: gọi thẳng MessageBridge.runAutoPrompt với payload gốc.
    if (!window.MessageBridge || typeof window.MessageBridge.runAutoPrompt !== 'function') {
      return { success: false, error: 'BRIDGE_NOT_LOADED' };
    }
    // Phase 2c+: Server-Only — delayBetweenPrompts từ ExecutionConfig, KHÔNG fallback af_settings.
    // inputTimeout vẫn là user setting hợp lệ (không nằm trong 16 deprecated keys).
    const settings = window.storageSettings?.getSettings?.() || {};
    const delayBetweenSec = window.ExecutionConfig?.safeGetDelayBetweenPromptsSec?.() ?? 5;
    const payload = {
      ...p,
      delayBetweenMs: p.delayBetweenMs ?? delayBetweenSec * 1000,
      inputTimeoutMs: p.inputTimeoutMs ?? (settings.inputTimeout || 1200),
    };
    return await window.MessageBridge.runAutoPrompt(payload);
  }

  /**
   * Upload reference image lên Flow qua ImmediateUploader.
   * ImmediateUploader.upload là static method với signature
   * (file, thumbnail, options).
   */
  async uploadRef(file, thumbnail, options) {
    if (!window.ImmediateUploader || typeof window.ImmediateUploader.upload !== 'function') {
      throw new Error('ImmediateUploader not loaded');
    }
    return await window.ImmediateUploader.upload(file, thumbnail, options || {});
  }
}

window.FlowAdapter = FlowAdapter;
