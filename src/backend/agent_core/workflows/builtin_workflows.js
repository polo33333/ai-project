/**
 * Predefined Workflows
 * Định nghĩa sẵn các Pipeline phổ biến (VD: Quy trình Data Analysis & Auto Export)
 */

const WorkflowEngine = require('./workflow_engine');
const BaseStep = require('./base_step');
const { ExecuteSqlTool, ExportDataTool } = require('../tools/builtins');

// Step 1: Query SQL
class SqlExecutionStep extends BaseStep {
  constructor() {
    super({ id: 'sql_step', name: 'Thực thi SQL Query' });
    this.tool = new ExecuteSqlTool();
  }

  async execute(state, context) {
    if (!state.sql) throw new Error('State thiếu trường "sql" để thực thi truy vấn');
    const res = await this.tool.execute({ sql: state.sql }, context);
    if (!res.success) throw new Error(res.error || 'Lỗi khi thực thi câu lệnh SQL');
    return {
      queryResult: res.result.rows || res.result.data || [],
      rowCount: res.result.rowCount ?? (res.result.rows ? res.result.rows.length : 0),
      columns: res.result.columns || []
    };
  }
}

// Step 2: Export Data (Chỉ chạy khi thỏa mãn điều kiện)
class ExportDataStep extends BaseStep {
  constructor() {
    super({ id: 'export_step', name: 'Xuất Báo Cáo File' });
    this.tool = new ExportDataTool();
  }

  async execute(state, context) {
    const res = await this.tool.execute({
      data: state.queryResult || [],
      format: state.exportFormat || 'xlsx',
      filename: state.exportFilename || 'Bao_Cao'
    }, context);
    if (!res.success) throw new Error(res.error || 'Lỗi khi xuất file');
    return {
      exportDownloadUrl: res.result.downloadUrl,
      exportedFilename: res.result.fileName || res.result.filename
    };
  }
}

/**
 * Tạo một Workflow mẫu: Tự động chạy SQL -> Nếu có dữ liệu và yêu cầu export thì sinh file
 */
function createDataExportPipeline({ id, name } = {}) {
  const workflow = new WorkflowEngine({
    id: id || 'data_export_pipeline',
    name: name || 'Quy trình Tự động Truy vấn & Xuất File'
  });

  workflow.addStep(new SqlExecutionStep());
  
  // Step xuất file chỉ chạy nếu rowCount > 0 và state có yêu cầu export = true
  workflow.addStep(
    new ExportDataStep(),
    (state) => state.rowCount > 0 && state.requiresExport === true
  );

  return workflow;
}

module.exports = {
  SqlExecutionStep,
  ExportDataStep,
  createDataExportPipeline
};
