import * as vscode from 'vscode';
import type { EasySshApp } from './app';
import { InputDecoder } from './input';

/** Pseudoterminal that hosts the Easy SSH screen in the integrated terminal. */
export class EasySshPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.closeEmitter.event;
  private readonly decoder = new InputDecoder();
  private ended = false;

  constructor(private readonly app: EasySshApp) {}

  write(data: string): void {
    if (!this.ended) this.writeEmitter.fire(data);
  }

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    this.app.setSize(dimensions?.columns ?? 80, dimensions?.rows ?? 24);
    this.writeEmitter.fire('\x1b[?1049h\x1b[?2004h');
    this.app.open();
  }

  close(): void {
    this.end();
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.app.setSize(dimensions.columns, dimensions.rows);
  }

  handleInput(data: string): void {
    if (!this.ended) this.app.onInput(this.decoder.push(data));
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.writeEmitter.fire('\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l\x1b[?25h');
    this.app.dispose();
    this.closeEmitter.fire();
  }
}
