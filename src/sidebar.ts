import * as vscode from 'vscode';

export interface ActivityBarActions {
  /** Ignore focus changes while the side bar is put away. */
  beginIconClick(): void;
  /** Open another Easy SSH terminal after the side bar is closed. */
  finishIconClick(): void;
}

/**
 * The activity-bar icon is a view container, so a click reveals this view.
 * Hand the side bar back immediately and open another terminal instead.
 */
export class EasySshSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'easySsh.sidebar';
  private handling = false;

  constructor(private readonly actions: ActivityBarActions) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.html = '<!DOCTYPE html><html><body></body></html>';
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.onIconClick();
    });
    this.onIconClick();
  }

  dispose(): void {}

  private onIconClick(): void {
    if (this.handling) return;
    this.handling = true;
    this.actions.beginIconClick();
    void this.leaveSidebar().finally(() => {
      this.actions.finishIconClick();
      this.handling = false;
    });
  }

  private async leaveSidebar(): Promise<void> {
    // Explorer becomes the active side-bar view, then the side bar closes.
    // Leaving Easy SSH selected made the next side-bar open flash this view.
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
  }
}
