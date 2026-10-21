/**
 * Agent Core — Entry Point Module V2
 * Nạp đầy đủ 9 built-in tools, ToolManager, Harness, Workflows và SearchHub
 */

const BaseTool = require('./tools/base_tool');
const ToolManager = require('./tools/tool_manager');
const AgentHarness = require('./harness/agent_harness');
const LocalModelHarness = require('./harness/local_model_harness');
const errorRecovery = require('./harness/error_recovery');
const searchHub = require('./search/search_hub');
const BaseStep = require('./workflows/base_step');
const WorkflowEngine = require('./workflows/workflow_engine');
const builtinWorkflows = require('./workflows/builtin_workflows');
const workflowService = require('./workflows/workflow_service');
const {
  ListSqlMetricsTool, QuerySqlMetricTool, GovernedWorkflowTool, MemoryTool,
  GetJoinPathTool, ResolveDateRangeTool, GetDateTimeTool,
  ExportDataTool,
  GetWorkflowDatasetTool, ReadContextResultTool,
  PlanDataQueryTool,
  ExecuteSqlTool,
  RenderChartTool,
  CalculateStatsTool,
  CalculateExpressionTool,
  SearchSchemaTool,
  GetGlossaryTermTool,
  SearchKnowledgeTool
} = require('./tools/builtins');

// Khởi tạo một ToolManager mặc định nạp sẵn toàn bộ 9 core tools
const defaultToolManager = new ToolManager();
defaultToolManager.registerTools([
  ...['recall_memory', 'remember_preference', 'forget_memory'].map(name => new MemoryTool(name)),
  new ListSqlMetricsTool(), new QuerySqlMetricTool(),
  ...['list_workflows', 'run_workflow', 'get_workflow_status', 'resume_workflow', 'cancel_workflow'].map(name => new GovernedWorkflowTool(name)),
  new GetJoinPathTool(), new ResolveDateRangeTool(), new GetDateTimeTool(),
  new ExportDataTool(),
  new GetWorkflowDatasetTool(), new ReadContextResultTool(),
  new PlanDataQueryTool(),
  new ExecuteSqlTool(),
  new RenderChartTool(),
  new CalculateStatsTool(),
  new CalculateExpressionTool(),
  new SearchSchemaTool(),
  new GetGlossaryTermTool(),
  new SearchKnowledgeTool()
]);
require('../services/mcp_service').bindToolManager(defaultToolManager, BaseTool);

// Khởi tạo một Harness mặc định
const defaultHarness = new AgentHarness({
  toolManager: defaultToolManager,
  maxIterations: 10
});
const localHarness = new LocalModelHarness({ toolManager: defaultToolManager });

module.exports = {
  // Lớp cơ sở & Quản lý Tool
  BaseTool,
  ToolManager,
  defaultToolManager,

  // 9 Built-in Tools
  builtins: {
    ReadContextResultTool,
    GetWorkflowDatasetTool,
    GetJoinPathTool, ResolveDateRangeTool, GetDateTimeTool,
    ExportDataTool,
    PlanDataQueryTool,
    ExecuteSqlTool,
    RenderChartTool,
    CalculateStatsTool,
    CalculateExpressionTool,
    SearchSchemaTool,
    GetGlossaryTermTool,
    SearchKnowledgeTool
  },

  // Execution Harness & Self-Correction
  AgentHarness,
  defaultHarness,
  LocalModelHarness,
  localHarness,
  errorRecovery,

  // Search & Knowledge Integration
  searchHub,

  // Workflow Engine (Pipelines)
  BaseStep,
  WorkflowEngine,
  builtinWorkflows,
  workflowService
};
