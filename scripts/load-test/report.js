'use strict';

const fs = require('fs');
const path = require('path');

class Report {
  constructor() {
    this.metrics = {};
    this.errors = [];
    this.startTime = null;
    this.endTime = null;
  }

  start() {
    this.startTime = Date.now();
  }

  end() {
    this.endTime = Date.now();
  }

  recordLatency(operation, durationMs) {
    if (!this.metrics[operation]) {
      this.metrics[operation] = { latencies: [], errors: 0, successes: 0 };
    }
    this.metrics[operation].latencies.push(durationMs);
    this.metrics[operation].successes++;
  }

  recordError(operation, error) {
    if (!this.metrics[operation]) {
      this.metrics[operation] = { latencies: [], errors: 0, successes: 0 };
    }
    this.metrics[operation].errors++;
    this.errors.push({ operation, error: error.message || String(error), timestamp: Date.now() });
  }

  _percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  getSummary() {
    const durationMs = (this.endTime || Date.now()) - this.startTime;
    const summary = {
      durationMs,
      operations: {},
      totalRequests: 0,
      totalErrors: 0,
    };

    for (const [op, data] of Object.entries(this.metrics)) {
      const total = data.successes + data.errors;
      summary.operations[op] = {
        total,
        successes: data.successes,
        errors: data.errors,
        errorRate: total > 0 ? data.errors / total : 0,
        p50: this._percentile(data.latencies, 50),
        p95: this._percentile(data.latencies, 95),
        p99: this._percentile(data.latencies, 99),
        throughput: total / (durationMs / 1000),
      };
      summary.totalRequests += total;
      summary.totalErrors += data.errors;
    }

    summary.overallErrorRate = summary.totalRequests > 0
      ? summary.totalErrors / summary.totalRequests
      : 0;

    return summary;
  }

  printConsoleTable() {
    const summary = this.getSummary();
    console.log('\n=== Load Test Results ===');
    console.log(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
    console.log(`Total Requests: ${summary.totalRequests}`);
    console.log(`Total Errors: ${summary.totalErrors}`);
    console.log(`Overall Error Rate: ${(summary.overallErrorRate * 100).toFixed(2)}%\n`);

    const header = ['Operation', 'Total', 'Errors', 'Error%', 'p50(ms)', 'p95(ms)', 'p99(ms)', 'RPS'];
    const rows = Object.entries(summary.operations).map(([op, stats]) => [
      op,
      stats.total,
      stats.errors,
      (stats.errorRate * 100).toFixed(1) + '%',
      stats.p50.toFixed(0),
      stats.p95.toFixed(0),
      stats.p99.toFixed(0),
      stats.throughput.toFixed(1),
    ]);

    // Simple table output
    const colWidths = header.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
    const formatRow = (row) => row.map((cell, i) => String(cell).padEnd(colWidths[i])).join(' | ');

    console.log(formatRow(header));
    console.log(colWidths.map(w => '-'.repeat(w)).join('-+-'));
    rows.forEach(row => console.log(formatRow(row)));
    console.log('');
  }

  writeJsonReport(filePath) {
    const summary = this.getSummary();
    const outputDir = path.dirname(filePath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(summary, null, 2));
    console.log(`JSON report written to: ${filePath}`);
  }

  checkThresholds(config) {
    const summary = this.getSummary();
    let passed = true;

    if (summary.overallErrorRate > config.maxErrorRate) {
      console.error(`FAIL: Error rate ${(summary.overallErrorRate * 100).toFixed(2)}% exceeds threshold ${(config.maxErrorRate * 100).toFixed(2)}%`);
      passed = false;
    }

    for (const [op, stats] of Object.entries(summary.operations)) {
      if (stats.p95 > config.maxP95Latency) {
        console.error(`FAIL: ${op} p95 latency ${stats.p95.toFixed(0)}ms exceeds threshold ${config.maxP95Latency}ms`);
        passed = false;
      }
    }

    return passed;
  }
}

module.exports = Report;
