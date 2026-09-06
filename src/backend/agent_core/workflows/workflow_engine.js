/**
 * WorkflowEngine — Bộ điều phối quy trình làm việc (Nodes & Pipelines) cho Agent
 * Hỗ trợ:
 * 1. Sequential execution (Chạy tuần tự các steps như n8n)
 * 2. Conditional branching (Rẽ nhánh logic dựa trên kết quả bước trước)
 * 3. State Management (Truyền và tích lũy dữ liệu xuyên suốt các node)
 * 4. Step Trace & Error Isolation (Cô lập lỗi từng node)
 */

const BaseStep = require('./base_step');

class WorkflowEngine {
  /**
   * @param {object} options
   * @param {string} options.id - Định danh workflow
   * @param {string} options.name - Tên workflow
   * @param {string} [options.description]
   */
  constructor({ id, name, description = '' }) {
    this.id = id || `workflow_${Date.now()}`;
    this.name = name || this.id;
    this.description = description;
    this.steps = [];
  }

  /**
   * Thêm một bước vào chuỗi quy trình
   * @param {BaseStep|object} step 
   * @param {Function} [condition] - Hàm điều kiện `(state) => boolean` (Nếu trả về false thì bỏ qua step này)
   */
  addStep(step, condition = null) {
    if (typeof step.execute !== 'function') {
      throw new Error(`Step thêm vào workflow phải có hàm execute(). Nhận được: ${typeof step}`);
    }
    this.steps.push({ step, condition });
    return this;
  }

  /**
   * Thực thi toàn bộ Workflow từ đầu đến cuối
   * @param {object} initialState - Dữ liệu đầu vào
   * @param {object} context - Ngữ cảnh phiên làm việc
   */
  async run(initialState = {}, context = {}) {
    const startTime = Date.now();
    const state = { ...initialState };
    const stepContext = { ...context };
    const trace = {
      workflowId: this.id,
      workflowName: this.name,
      startTime,
      executedSteps: [],
      success: true,
      error: null
    };

    for (let i = 0; i < this.steps.length; i++) {
      const { step, condition } = this.steps[i];
      const stepStartTime = Date.now();

      try {
        // 1. Kiểm tra điều kiện rẽ nhánh (If Condition)
        if (condition && typeof condition === 'function') {
          const shouldRun = await condition(state, stepContext);
          if (!shouldRun) {
            trace.executedSteps.push({
              stepIndex: i + 1,
              stepId: step.id || `step_${i}`,
              stepName: step.name || `Step ${i}`,
              skipped: true,
              reason: 'Không thỏa mãn điều kiện rẽ nhánh'
            });
            continue;
          }
        }

        const maxAttempts = Math.max(1, Number(step.retry?.maxAttempts || 1));
        const retryDelayMs = Math.max(0, Number(step.retry?.delayMs || 0));
        let stepOutput;
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            stepOutput = await step.execute(state, stepContext);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < maxAttempts && retryDelayMs > 0) {
              await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
          }
        }
        if (lastError) throw lastError;

        if (stepOutput && typeof stepOutput === 'object') Object.assign(state, stepOutput);

        trace.executedSteps.push({
          stepIndex: i + 1,
          stepId: step.id || `step_${i}`,
          stepName: step.name || `Step ${i}`,
          durationMs: Date.now() - stepStartTime,
          success: true,
          outputSummary: typeof stepOutput === 'object' ? Object.keys(stepOutput) : typeof stepOutput
        });
      } catch (error) {
        trace.success = false;
        trace.error = error.message;
        trace.executedSteps.push({
          stepIndex: i + 1,
          stepId: step.id || `step_${i}`,
          stepName: step.name || `Step ${i}`,
          durationMs: Date.now() - stepStartTime,
          success: false,
          error: error.message
        });
        break;
      }
    }

    trace.totalDurationMs = Date.now() - startTime;

    return {
      success: trace.success,
      state,
      trace
    };
  }
}

module.exports = WorkflowEngine;
