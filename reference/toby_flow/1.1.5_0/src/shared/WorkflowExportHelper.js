/**
 * WorkflowExportHelper - Shared utility cho export workflow JSON.
 *
 * 2 callers dùng helper này:
 *   - WorkflowEditor.exportWorkflow (toolbar trong editor window) — đọc Drawflow live state
 *   - WorkflowList.exportWorkflow (button trong list card dropdown) — đọc storage
 *
 * Pattern: callers tự lấy nodes/edges/workflow từ source riêng (live vs storage),
 * sau đó gọi shared helper để format JSON nhất quán.
 *
 * CRITICAL: KHÔNG duplicate logic ở callers — tất cả filter/transform tập trung tại đây.
 * Bug pattern trước: 2 versions skew → file export thiếu fields tùy path.
 */
class WorkflowExportHelper {
  /**
   * Convert nodes to portable export format.
   * - Filter fields theo node_type (tránh defaults rò rỉ cross-type)
   * - Convert ref_file_ids/ref_file_names/ref_thumbnails → ref_images array (portable)
   * - Bỏ session-specific fields (tile_ids), giữ persistent metadata (file_names UUID, CDN URLs)
   */
  static convertNodesToExport(nodes) {
    return (nodes || []).map(node => {
      const exportNode = {
        node_id: node.node_id,
        node_type: node.node_type,
        node_name: node.node_name,
        pos_x: node.pos_x,
        pos_y: node.pos_y,
        enabled: node.enabled !== false,
      };

      // Filter fields theo node_type để tránh defaults rò rỉ cross-type.
      // DiagramCanvas force defaults `media_type='Image', model='Nano Banana Pro', ratio='Ngang',
      // quantity=1` → image/grok/prompt/note đều có rác nếu không filter ở đây.
      const t = node.node_type;
      const isGenLike = t === 'generate';
      const hasRatio = isGenLike || t === 'chatgpt' || t === 'grok';
      const hasQuantity = isGenLike || t === 'grok';
      const hasAutoDownload = isGenLike || t === 'chatgpt' || t === 'grok' || t === 'download';

      // Phase 1 — Node Reference System: Export slug + mention mode fields for mentionable nodes
      const isMentionable = ['image', 'text', 'generate', 'chatgpt', 'grok', 'prompt'].includes(t);
      if (isMentionable && node.slug) exportNode.slug = node.slug;
      if (isMentionable && node.slug_auto !== undefined) exportNode.slug_auto = node.slug_auto;
      // prompt_mode and ref_mode only for nodes that can use @mentions
      const canUseMentions = ['generate', 'chatgpt', 'grok', 'prompt'].includes(t);
      if (canUseMentions && node.prompt_mode) exportNode.prompt_mode = node.prompt_mode;
      if (canUseMentions && node.ref_mode) exportNode.ref_mode = node.ref_mode;

      if (node.prompt) exportNode.prompt = node.prompt;
      if (node.prompts) exportNode.prompts = node.prompts;
      if (isGenLike && node.gen_type) exportNode.gen_type = node.gen_type;
      if (isGenLike && node.media_type) exportNode.media_type = node.media_type;
      if (isGenLike && node.video_input_type) exportNode.video_input_type = node.video_input_type;
      if (isGenLike && node.model) exportNode.model = node.model;
      if (hasQuantity && node.quantity) exportNode.quantity = node.quantity;
      if (hasRatio && node.ratio) exportNode.ratio = node.ratio;
      if (isGenLike && node.style_prompt) exportNode.style_prompt = node.style_prompt;
      if (isGenLike && node.ref_mode) exportNode.ref_mode = node.ref_mode;
      if (hasAutoDownload && node.auto_download) exportNode.auto_download = node.auto_download;
      if (hasAutoDownload && node.download_resolution) exportNode.download_resolution = node.download_resolution;
      if (hasAutoDownload && node.video_download_resolution) exportNode.video_download_resolution = node.video_download_resolution;
      // Download node settings — chỉ export cho node download (folder/template/collect_all không áp dụng cho gen)
      if (t === 'download' && node.download_folder) exportNode.download_folder = node.download_folder;
      if (t === 'download' && node.download_file_template) exportNode.download_file_template = node.download_file_template;
      if (t === 'download' && node.download_collect_all !== undefined) exportNode.download_collect_all = node.download_collect_all;

      // Delay node
      if (t === 'delay' && node.delay_seconds) exportNode.delay_seconds = node.delay_seconds;

      // Telegram node — chỉ export khi node thực sự là 'telegram'
      if (node.node_type === 'telegram') {
        if (node.telegram_chat_id) exportNode.telegram_chat_id = node.telegram_chat_id;
        if (node.telegram_send_mode) exportNode.telegram_send_mode = node.telegram_send_mode;
        if (node.telegram_message) exportNode.telegram_message = node.telegram_message;
      }

      // Video frames (Generate node Video+Frames mode)
      // frame_X_source quyết định execution path: 'manual' (user pick), 'upstream_node_id', hoặc '' (chưa set).
      // Thiếu source → import workflow Frame mode mất logic phân biệt manual vs upstream.
      if (node.frame_1_source) exportNode.frame_1_source = node.frame_1_source;
      if (node.frame_2_source) exportNode.frame_2_source = node.frame_2_source;
      if (node.frame_1_file_name) exportNode.frame_1_file_name = node.frame_1_file_name;
      if (node.frame_2_file_name) exportNode.frame_2_file_name = node.frame_2_file_name;
      if (node.frame_1_thumbnail) exportNode.frame_1_thumbnail = node.frame_1_thumbnail;
      if (node.frame_2_thumbnail) exportNode.frame_2_thumbnail = node.frame_2_thumbnail;

      // Note node — DiagramCanvas export field 'note_text', không phải 'note'
      if (node.note_text) exportNode.note_text = node.note_text;

      // Dual URL — provider URL gốc (Grok/ChatGPT). Có TTL ~vài giờ nhưng vẫn export để
      // import ngay sau cũng có thể download bản gốc. Sau TTL fallback Flow tự động.
      if (node.result_provider_urls && Object.keys(node.result_provider_urls).length > 0) {
        exportNode.result_provider_urls = node.result_provider_urls;
      }

      // Phase CG/G — Provider routing + ChatGPT/Grok/Prompt node fields. Filter theo node_type
      // để tránh `enhance: false` rò rỉ vào generate/image/grok, `multi_prompt: false` rò rỉ tất cả.
      const isAIProvider = t === 'chatgpt' || t === 'grok' || t === 'prompt';
      if (isAIProvider && node.provider) exportNode.provider = node.provider;
      if ((t === 'generate' || t === 'chatgpt' || t === 'grok') && node.prompt_source) {
        exportNode.prompt_source = node.prompt_source;
      }
      if (isGenLike && node.multi_prompt) exportNode.multi_prompt = node.multi_prompt;
      // Prompt node (Phase CG-8) — chỉ export enhance + timeout_sec + fallback cho prompt nodes
      if (t === 'prompt' && node.enhance !== undefined) exportNode.enhance = node.enhance;
      if (t === 'prompt' && node.enhance_fallback !== undefined) exportNode.enhance_fallback = node.enhance_fallback;
      if (t === 'prompt' && node.timeout_sec) exportNode.timeout_sec = node.timeout_sec;
      // ChatGPT node (Phase CG-7)
      if (t === 'chatgpt' && node.use_fallback_prefix) exportNode.use_fallback_prefix = node.use_fallback_prefix;
      if ((t === 'chatgpt' || t === 'grok') && node.timeout_ms) exportNode.timeout_ms = node.timeout_ms;
      if ((t === 'chatgpt' || t === 'grok') && node.max_ref_images) exportNode.max_ref_images = node.max_ref_images;
      // Grok node (Phase G-6)
      if (t === 'grok' && node.grok_mode) exportNode.grok_mode = node.grok_mode;
      if (t === 'grok' && node.grok_duration) exportNode.grok_duration = node.grok_duration;
      if (t === 'grok' && node.grok_resolution) exportNode.grok_resolution = node.grok_resolution;
      if (t === 'grok' && node.grok_image_quality) exportNode.grok_image_quality = node.grok_image_quality;

      // Convert ref_file_ids → ref_images với thumbnail+file_name (portable).
      // Smart Clone case: ref_file_ids='' nhưng ref_thumbnails/ref_file_names vẫn có data
      // → build refIds từ keys của thumbnails/fileNames để giữ ref data cross-import.
      const refThumbnails = node.ref_thumbnails || {};
      const refFileNames = node.ref_file_names || {};
      const idsFromString = (node.ref_file_ids || '').split(',').map(s => s.trim()).filter(Boolean);
      const idsFromMaps = [...new Set([
        ...Object.keys(refThumbnails),
        ...Object.keys(refFileNames),
      ])];
      const refIds = idsFromString.length > 0 ? idsFromString : idsFromMaps;

      if (refIds.length > 0) {
        exportNode.ref_images = refIds.map(id => {
          const thumb = refThumbnails[id];
          const fileName = refFileNames[id];
          const result = {};
          if (thumb) {
            result.thumbnail = typeof thumb === 'object' ? thumb.thumbnail : thumb;
          }
          if (fileName) {
            result.file_name = fileName;
          }
          return result;
        }).filter(img => img.thumbnail || img.file_name);
      }

      return exportNode;
    });
  }

  /**
   * Convert edges to portable export format.
   * Phase WK-1 typed multi-port — preserve source_port + target_port cho import lại đúng.
   */
  static convertEdgesToExport(edges) {
    return (edges || []).map(e => ({
      edge_id: e.edge_id,
      source_node_id: e.source_node_id,
      source_handle: e.source_handle,
      source_port: e.source_port || null,
      target_node_id: e.target_node_id,
      target_handle: e.target_handle,
      target_port: e.target_port || null,
      data_type: e.data_type || 'image',
    }));
  }

  /**
   * Build settings object từ workflow metadata.
   * Workflow object có thể là Drawflow live workflow (WorkflowEditor) hoặc storage workflow (WorkflowList).
   */
  static buildSettings(workflow) {
    return {
      parallel: workflow?.parallel_execution ?? true,
      quantity: workflow?.quantity || 1,
      delay_between_nodes: workflow?.delay_between_nodes || 3,
      timeout_per_node: workflow?.timeout_per_node || 120,
      retry_on_error: workflow?.retry_on_error || 0,
      stop_on_error: workflow?.stop_on_error !== false,
    };
  }

  /**
   * Build complete export JSON structure.
   */
  static buildExportData(workflowName, description, workflow, nodes, edges) {
    return {
      version: '1.0',
      type: 'workflow',
      exported_at: new Date().toISOString(),
      workflow: {
        name: workflowName || (window.I18n?.t?.('workflow.untitled') || 'Workflow không tên'),
        description: description || '',
        settings: this.buildSettings(workflow),
        nodes: this.convertNodesToExport(nodes),
        edges: this.convertEdgesToExport(edges),
      },
    };
  }

  /**
   * Build filename: workflow_{sanitized_name}_{YYYYMMDD_HHmmss}.json
   */
  static buildExportFilename(name) {
    const safeName = (name || 'workflow')
      .substring(0, 30)
      .replace(/[^a-zA-Z0-9À-ɏḀ-ỿ_\- ]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .trim() || 'workflow';

    const now = new Date();
    const timestamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');

    return `workflow_${safeName}_${timestamp}.json`;
  }

  /**
   * Trigger JSON file download via temporary <a> tag + Blob URL.
   */
  static downloadJson(data, filename) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
  }
}

window.WorkflowExportHelper = WorkflowExportHelper;
