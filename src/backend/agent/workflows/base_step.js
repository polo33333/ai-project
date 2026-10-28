/**
 * BaseStep — Foundation cho các bước (Nodes) trong một Workflow Engine
 */

class BaseStep {
  /**
   * @param {object} options
   * @param {string} options.id - Định danh duy nhất của bước (VD: 'query_sql_step', 'review_step')
   * @param {string} options.name - Tên hiển thị
   * @param {string} [options.description] - Mô tả chức năng
   */
  constructor({ id, name, description = '' }) {
    if (!id) throw new Error('Step ID is required');
    this.id = id;
    this.name = name || id;
    this.description = description;
  }

  /**
   * Thực thi logic của step
   * @param {object} state - Trạng thái dữ liệu chia sẻ của toàn bộ workflow
   * @param {object} context - Ngữ cảnh phiên làm việc
   * @returns {Promise<object>} Dữ liệu cập nhật vào state
   */
  async execute(state, context) {
    throw new Error(`Method execute() chưa được implement trong step "${this.id}"`);
  }
}

module.exports = BaseStep;
