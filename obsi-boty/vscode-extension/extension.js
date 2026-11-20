// Obsi-boty bridge for VS Code (two-way).
// → Tells the desktop pet (127.0.0.1:47321) which file is open and whether VS Code is focused.
// ← Receives commands from the pet (127.0.0.1:47322): open a file at some lines and highlight them,
//   or reveal a folder in the Explorer. Used by the guided tour and by "show me...".

const vscode = require('vscode');
const http = require('http');

const PET_PORT = 47321;
const CMD_PORT = 47322;

function post(body) {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port: PET_PORT, path: '/event', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    timeout: 1500,
  });
  req.on('error', () => { /* pet not running: ignore silently */ });
  req.on('timeout', () => req.destroy());
  req.end(data);
}

function editorInfo(editor) {
  if (!editor || editor.document.uri.scheme !== 'file') return { file: null };
  const doc = editor.document;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  return { file: doc.uri.fsPath, workspace: folder ? folder.uri.fsPath : null, languageId: doc.languageId, lines: doc.lineCount };
}

function sendEditor() {
  post({ type: 'editor', focused: vscode.window.state.focused, ...editorInfo(vscode.window.activeTextEditor) });
}

// ---------- commands from the pet ----------
const highlight = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(139, 92, 246, 0.22)', isWholeLine: true,
  overviewRulerColor: 'rgba(139, 92, 246, 0.9)', overviewRulerLane: vscode.OverviewRulerLane.Full,
  borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: 'rgba(167, 139, 250, 0.9)',
});
let clearTimer = null;

async function openFile(p, line, endLine) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (!line) return;
  const start = Math.max(0, Math.min(line - 1, doc.lineCount - 1));
  const end = Math.max(start, Math.min((endLine || line) - 1, doc.lineCount - 1));
  const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
  editor.selection = new vscode.Selection(start, 0, start, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  editor.setDecorations(highlight, [range]);
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => editor.setDecorations(highlight, []), 12000);
}

async function revealFolder(p) {
  const uri = vscode.Uri.file(p);
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('revealInExplorer', uri);
  try { await vscode.commands.executeCommand('list.expand'); } catch { /* already expanded */ }
}

function startCommandServer(context) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/cmd') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const c = JSON.parse(body);
        if (c.cmd === 'open') await openFile(c.path, c.line, c.endLine);
        else if (c.cmd === 'reveal') await revealFolder(c.path);
        else throw new Error('unknown command');
        res.writeHead(204).end();
      } catch (e) { res.writeHead(500).end(String(e.message || e)); }
    });
  });
  server.on('error', () => { /* another VS Code window already listens: that's fine */ });
  server.listen(CMD_PORT, '127.0.0.1');
  context.subscriptions.push({ dispose: () => server.close() });
}

function activate(context) {
  sendEditor();
  startCommandServer(context);
  context.subscriptions.push(
    highlight,
    vscode.window.onDidChangeActiveTextEditor(sendEditor),
    vscode.window.onDidChangeWindowState(s => post({ type: 'focus', focused: s.focused, ...editorInfo(vscode.window.activeTextEditor) })),
    vscode.commands.registerCommand('obsiBoty.explain', () => post({ type: 'explain', focused: true, ...editorInfo(vscode.window.activeTextEditor) })),
    vscode.commands.registerCommand('obsiBoty.tour', () => post({ type: 'tour', focused: true, ...editorInfo(vscode.window.activeTextEditor) })),
  );
}

function deactivate() { post({ type: 'focus', focused: false, file: null }); }

module.exports = { activate, deactivate };
