const throttle = require('lodash.throttle');
import * as vscode from 'vscode';
import { Emitter, Transaction } from '../sockets';
import { EventEmitter } from 'events';

export class FileState {
  private _transactions: Transaction[] = [];
  public path: string;
  public ref = 0;
  public events = new EventEmitter();

  constructor(path: string) {
    this.path = path;
  }

  get isDirty() {
    return this._transactions.length !== 0;
  }

  flushAndIncrement() {
    this.ref++;
    const transactions = this._transactions;
    this._transactions = [];
    return transactions;
  }

  addTransaction(transaction: Transaction) {
    this._transactions.push(transaction);
  }
}

export class ChangeTracker {
  private _files: Map<string, FileState> = new Map<string, FileState>();
  private _broadcaster: Emitter;
  private _flush: (path: string) => void;
  public events: EventEmitter = new EventEmitter;

  private _flushImmediate(path: string) {
    const state = this._files.get(path) as FileState;
    if (!state.isDirty) {
      return;
    }

    const txs = state.flushAndIncrement();
    this.broadcast('change', {
      path,
      ref: state.ref,
      txs
    });

    this.events.emit('flush', path, state);
    state.events.emit('flush', path, state);
  }

  constructor(broadcaster: Emitter, wait?: number) {
    this._broadcaster = broadcaster;
    if (typeof wait === 'number') {
      this._flush = throttle(this._flushImmediate.bind(this), wait);
    } else {
      this._flush = this._flushImmediate.bind(this);
    }
  }

  getFiles(): FileState[] {
    return Array.from(this._files.values());
  }

  track(document: vscode.TextDocument): boolean {
    if (!this.canTrack(document.uri)) {
      return false;
    }

    if (this.isTracking(document.uri)) {
      this.refresh(document);
    } else {
      const path = document.uri.path;
      this._files.set(path, new FileState(path));
      this.broadcast('file', {
        path,
        ref: 0,
        text: document.getText()
      });
    }

    return true;
  }

  refresh(document: vscode.TextDocument): boolean {
    if (!this.isTracking(document.uri)) {
      return false;
    }

    const path = document.uri.path;
    const state = this._files.get(path) as FileState;
    state.flushAndIncrement();
    this.broadcast('file', {
      path,
      ref: state.ref,
      text: document.getText()
    });

    return true;
  }

  tryGetFile(path: string | vscode.Uri): FileState | undefined {
    if (typeof path === 'string') {
      return this._files.get(path);
    } else {
      return this._files.get(path.path);
    }
  }

  canTrack(uri: vscode.Uri) {
    return uri.scheme === 'file';
  }

  isTracking(uri: vscode.Uri | string) {
    if (typeof uri === 'string') {
      return this._files.has(uri);
    }

    return this.canTrack(uri) && this._files.has(uri.path);
  }

  onDidChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
    const document = e.document;
    if (!this.isTracking(document.uri)) {
      return;
    }

    const path = document.uri.path;
    const state = this._files.get(path) as FileState;
    state.addTransaction({
      changes: e.contentChanges.map(c => {
        const { start, end } = c.range;
        return {
          text: c.text,
          sl: start.line,
          sc: start.character,
          el: end.line,
          ec: end.character
        };
      })
    });

    this._flush(path);
  }

  broadcast(event: string, payload: any): void {
    this._broadcaster.emit(event, payload);
  }
}
