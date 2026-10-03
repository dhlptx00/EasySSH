import * as vscode from 'vscode';
import { EasySshController } from './controller';
import { EasySshSidebar } from './sidebar';
import { ConnectionStore } from './store';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Easy SSH');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'easySsh.open';
  const store = new ConnectionStore(context.globalState, context.secrets);
  const controller = new EasySshController(store, output, status);
  const sidebar = new EasySshSidebar(controller);
  void controller.init();

  context.subscriptions.push(
    output,
    status,
    sidebar,
    vscode.window.onDidChangeActiveTerminal((terminal) => controller.noteActiveTerminal(terminal)),
    vscode.window.registerWebviewViewProvider(EasySshSidebar.viewId, sidebar),
    vscode.commands.registerCommand('easySsh.open', () => controller.open()),
    vscode.commands.registerCommand('easySsh.newTerminal', () => controller.newTerminal()),
    vscode.commands.registerCommand('easySsh.setDownloadFolder', () => controller.setDownloadFolder()),
    vscode.commands.registerCommand('easySsh.resetHostKeys', () => controller.resetHostKeys()),
    vscode.commands.registerCommand('easySsh.cancelTransfer', () => controller.cancelTransfer()),
    vscode.window.registerTerminalLinkProvider(controller),
    vscode.window.onDidCloseTerminal((terminal) => controller.onClosed(terminal)),
  );
}

export function deactivate(): void {
  // Terminal disposal closes the session.
}
