import * as vscode from 'vscode';
import { EasySshController } from './controller';
import { ConnectionStore } from './store';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Easy SSH');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'easySsh.open';
  status.show();
  const store = new ConnectionStore(context.globalState, context.secrets);
  const controller = new EasySshController(store, output, status);

  context.subscriptions.push(
    output,
    status,
    vscode.commands.registerCommand('easySsh.open', () => controller.open()),
    vscode.commands.registerCommand('easySsh.setDownloadFolder', () => controller.setDownloadFolder()),
    vscode.commands.registerCommand('easySsh.resetHostKeys', () => controller.resetHostKeys()),
    vscode.window.registerTerminalLinkProvider(controller),
    vscode.window.onDidCloseTerminal((terminal) => controller.onClosed(terminal)),
  );
}

export function deactivate(): void {
  // Terminal disposal closes the session.
}
