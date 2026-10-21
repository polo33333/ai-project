'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { evaluate, schema } = require('./eval/retrieval_measurement');
function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (inputPath === '--schema') { process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`); return; }
  if (!inputPath || !outputPath) throw new Error('Usage: node scripts/evaluate_retrieval_modes.js <reviewed-input.json> <report.json> (or --schema)');
  const report = evaluate(JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8')));
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: path.resolve(outputPath), blocks: report.blocks.map(({ block, status, reasons }) => ({ block, status, reasons })) }, null, 2));
  if (report.blocks.some(block => block.status !== 'retrieval_non_inferior')) process.exitCode = 2;
}
try { main(); } catch (error) { console.error(error.message); if (error.details) console.error(JSON.stringify(error.details)); process.exitCode = 1; }
