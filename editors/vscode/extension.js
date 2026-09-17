// A thin VS Code client for spinel-lsp: starts the server for Ruby files
// and lets vscode-languageclient do the protocol. Settings pick the
// command (default: this extension's own copy of tools/spinel-lsp.rb
// under `ruby`) and the compiler ($SPINEL).
const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;

function activate(context) {
  const cfg = vscode.workspace.getConfiguration("spinel");
  let command = cfg.get("lsp.command") || [];
  if (!command.length) {
    command = ["ruby", path.join(context.extensionPath, "..", "..", "tools", "spinel-lsp.rb")];
  }
  const env = { ...process.env };
  const compiler = cfg.get("compiler");
  if (compiler) env.SPINEL = compiler;
  const serverOptions = {
    command: command[0],
    args: command.slice(1),
    transport: TransportKind.stdio,
    options: { env },
  };
  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "ruby" }],
    outputChannelName: "Spinel LSP",
  };
  client = new LanguageClient("spinel-lsp", "Spinel LSP", serverOptions, clientOptions);
  context.subscriptions.push({ dispose: () => client && client.stop() });
  client.start();
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
