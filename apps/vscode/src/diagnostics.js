// Doctor results as native VS Code diagnostics.
//
// The DOCTOR panel is good at explaining a problem in detail. VS Code is good
// at telling you a problem exists while you are looking at something else.
// This bridges the two: every non-passing check becomes an entry in the
// Problems panel, and clicking it opens the full report at that check.
//
// The report is a virtual document (er-studio:doctor). Nothing is written to
// disk, and there is no file to accidentally commit.

const vscode = require('vscode');

const SCHEME = 'er-studio';
const REPORT_URI = vscode.Uri.parse(`${SCHEME}:doctor-report.txt`);

const SEVERITY = {
  fail: vscode.DiagnosticSeverity.Error,
  warn: vscode.DiagnosticSeverity.Warning,
  skip: vscode.DiagnosticSeverity.Information
};

class DoctorDiagnostics {
  constructor() {
    // No DiagnosticCollection is created here. An empty collection still
    // registers "ER Studio Doctor" as a problem source, and the Doctor tab is
    // the view for this - so the Problems panel is left entirely to your code.
    // The collection is only created if update() is ever called.
    this.collection = null;
    this.text = 'Run "ER Studio: Run Environment Doctor" to produce a report.\n';
    this.emitter = new vscode.EventEmitter();

    this.provider = {
      onDidChange: this.emitter.event,
      provideTextDocumentContent: () => this.text
    };
  }

  register(context) {
    this.context = context;
    context.subscriptions.push(
      this.emitter,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.provider)
    );
    return this;
  }

  ensureCollection() {
    if (!this.collection) {
      this.collection = vscode.languages.createDiagnosticCollection('ER Studio Doctor');
      if (this.context) this.context.subscriptions.push(this.collection);
    }
    return this.collection;
  }

  // Renders the report document. Kept separate from diagnostics so "Open Doctor
  // Report" works without ER Studio ever writing to the Problems panel.
  render(report) {
    const lines = [];
    const anchors = new Map();

    const env = report.env || {};
    lines.push('ER STUDIO - ENVIRONMENT DOCTOR');
    lines.push('');
    lines.push(`Generated   ${report.generatedAt || new Date().toISOString()}`);
    lines.push(`Platform    ${env.platform || 'unknown'}`);
    lines.push(`Node        ${env.node || 'unknown'}`);
    lines.push(`ER Studio   ${env.erStudio || 'unknown'}`);
    lines.push(`Workspace   ${env.workspace || 'unknown'}`);
    if (env.project) lines.push(`Project     ${env.project}`);
    lines.push('');

    const s = report.summary || {};
    lines.push(
      `${s.pass || 0} passed  ${s.warn || 0} warning${s.warn === 1 ? '' : 's'}  ` +
      `${s.fail || 0} failed  ${s.skip || 0} skipped`
    );
    lines.push('');
    lines.push('-'.repeat(72));
    lines.push('');

    for (const check of report.checks || []) {
      anchors.set(check.id, lines.length);
      lines.push(`[${String(check.status).toUpperCase().padEnd(4)}] ${check.group} / ${check.label}`);
      if (check.message) lines.push(`        ${check.message}`);
      if (check.detail) {
        for (const part of String(check.detail).split('\n')) lines.push(`        ${part}`);
      }
      if (check.fix) {
        if (check.fix.text) lines.push(`        fix: ${check.fix.text}`);
        if (check.fix.command) lines.push(`        run: ${check.fix.command}`);
        if (check.fix.url) lines.push(`        see: ${check.fix.url}`);
      }
      lines.push('');
    }

    this.text = lines.join('\n');
    this.emitter.fire(REPORT_URI);
    this.anchors = anchors;
    this.lines = lines;

    const totals = report.summary || {};
    return { failed: totals.fail || 0, warned: totals.warn || 0 };
  }

  // Optional: file findings in the Problems panel. Not used by default.
  update(report) {
    const result = this.render(report);
    const anchors = this.anchors;
    const lines = this.lines;

    const diagnostics = [];
    for (const check of report.checks || []) {
      if (check.status === 'pass') continue;

      const line = anchors.get(check.id) ?? 0;
      const range = new vscode.Range(line, 0, line, (lines[line] || '').length);

      const diagnostic = new vscode.Diagnostic(
        range,
        check.message || check.label,
        SEVERITY[check.status] ?? vscode.DiagnosticSeverity.Information
      );
      diagnostic.source = 'ER Studio';
      diagnostic.code = check.id;

      // The fix text is the useful part when hovering in the Problems panel.
      if (check.fix && check.fix.text) {
        diagnostic.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(REPORT_URI, range),
            check.fix.text
          )
        ];
      }

      diagnostics.push(diagnostic);
    }

    this.ensureCollection().set(REPORT_URI, diagnostics);
    return { failed: s.fail || 0, warned: s.warn || 0 };
  }

  async show() {
    const doc = await vscode.workspace.openTextDocument(REPORT_URI);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  clear() {
    if (this.collection) this.collection.clear();
  }
}

module.exports = { DoctorDiagnostics, REPORT_URI };
