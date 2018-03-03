import { Socket, Emitter } from '../sockets';
import { ChangeTracker, FileState } from './ChangeTracker';
import * as vscode from 'vscode';

export class Server {
  private _io: Socket;
  private _changeTracker: ChangeTracker;
  private _virtualConsole: () => any[];

  private _sendFile = (socket: Emitter, file: FileState, open = false): void => {
    const send = () => {
      vscode
        .workspace
        .openTextDocument(file.path)
        .then(document => {
          socket.emit('file', {
            ref: file.ref,
            path: file.path,
            text: document.getText(),
            open
          });
        });
    };

    if (file.isDirty) {
      file.events.once('flush', send);
    } else {
      send();
    }
  }

  public get io(): Socket {
    return this._io;
  }

  private _sendFiles = (socket: Emitter): void => {
    this._changeTracker
      .getFiles()
      .forEach(file => {
        this._sendFile(socket, file);
      });
  }

  private _handleClient = (socket: Socket): void => {
    socket.on('get_files', () => this._sendFiles(socket));
    socket.on('get_file', (path: string) => {
      const file = this._changeTracker.tryGetFile(path);
      if (file) {
        this._sendFile(socket, file);
      }
    });

    socket.on('sync_console', () => {
      socket.emit('sync_console', this._virtualConsole());
    });
  }

  constructor(io: Socket, virtualConsole: () => any[], wait?: number) {
    this._io = io;
    this._changeTracker = new ChangeTracker(io, wait);
    this._virtualConsole = virtualConsole;
  }

  listen() {
    this._io.on('connection', this._handleClient);
  }

  share(document: vscode.TextDocument): boolean {
    if (this._changeTracker.isTracking(document.uri)) {
      this._sendFile(
        this._io,
        this._changeTracker.tryGetFile(document.uri) as FileState,
        true);
      return false;
    }

    this._changeTracker.track(document);
    return true;
  }

  onChange(e: vscode.TextDocumentChangeEvent) {
    this._changeTracker.onDidChangeTextDocument(e);
  }

  dispose() {
    this._io.close();
  }
}