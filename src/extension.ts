'use strict';
import * as vscode from 'vscode';
import { scheme, Socket } from './sockets';
import { Client } from './client/Client';
import { Server } from './server/Server';
import * as path from 'path';
import { EventEmitter } from 'events';
const throttle = require('lodash.throttle');

const lineDecoration = vscode.window.createTextEditorDecorationType({
  borderWidth: '1px 0',
  isWholeLine: true,
  borderColor: new vscode.ThemeColor('focusBorder'),
  rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
  borderStyle: 'solid',
  overviewRulerColor: new vscode.ThemeColor('focusBorder'),
  overviewRulerLane: vscode.OverviewRulerLane.Full,
});

class ServerManager {
  private _disposables: vscode.Disposable[] | null = null;
  private _server: Server | null = null;
  private _virtualConsole: any[] = [];
  private _dumpedItems: any[] = [];

  private _syncConsoleImmediate: () => void = () => {
    if (this._server) {
      if (this._virtualConsole.length === 0) {
        this._server.io.emit('clear');
      } else if (this._dumpedItems.length === this._virtualConsole.length) {
        this._server.io.emit('sync_console', this._virtualConsole);
      } else {
        this._server.io.emit('dump', this._dumpedItems);
        this._dumpedItems = [];
      }
    }
  }

  private _syncConsole: () => void;

  private _onChange = (e: vscode.TextDocumentChangeEvent) => {
    if (this._server) {
      this._server.onChange(e);
    }
  }

  private _syncSelectionImmediate: () => void = () => {
    if (this._server) {
      this._server.io.emit('selection', {
        path: this._selectionPath,
        line: this._selectionLine
      });
    }
  }

  private _syncSelection: () => void;

  private _onSelection = (e: vscode.TextEditorSelectionChangeEvent) => {
    const document = e.textEditor.document;
    if (document.uri.scheme === 'file') {
      this._selectionPath = document.uri.path;
      this._selectionLine = e.selections[0].active.line;
    } else {
      this._selectionPath = null;
      this._selectionLine = null;
    }

    this._syncSelection();
  }

  private _selectionPath: string | null = null;
  private _selectionLine: number | null = null;

  constructor() {
    this._syncConsole = this._syncConsoleImmediate;
    this._syncSelection = this._syncSelectionImmediate;
  }

  get started() {
    return this._server !== null;
  }

  start(port: number, callback: (error: any) => void, wait = 500): boolean {
    if (this._server) {
      callback(null);
      return false;
    }

    this._selectionLine = null;
    this._selectionPath = null;
    if (typeof wait === 'number') {
      this._syncConsole = throttle(this._syncConsoleImmediate, wait, {
        leading: false,
        trailing: true
      });

      this._syncSelection = throttle(this._syncSelectionImmediate, wait);
    } else {
      this._syncConsole = this._syncConsoleImmediate;
      this._syncSelection = this._syncSelectionImmediate;
    }

    console.log(`Trying to start server in port ${port}`);
    const http = require('http').createServer();
    const io = require('socket.io')(http, {
      serveClient: false,
      cookie: false
    });

    if (this._disposables === null) {
      this._disposables = [
        vscode.workspace.onDidChangeTextDocument(this._onChange),
        vscode.window.onDidChangeTextEditorSelection(this._onSelection)
      ];
    }

    const server = new Server(io, () => this._virtualConsole, wait);
    server.listen();
    http.listen(port, function (error: any) {
      if (error) {
        return callback(error);
      }

      callback(null);
    });

    this._server = server;
    return true;
  }

  share(document: vscode.TextDocument) {
    if (this._server) {
      const newFile = this._server.share(document);
      const name = path.basename(document.fileName);
      if (newFile) {
        vscode.window.showInformationMessage(`Sharing ${name}.`);
      } else {
        vscode.window.showInformationMessage(`Refreshing ${name}.`);
      }
    }
  }

  onDump(data: any) {
    if (this._virtualConsole.length <= 100) {
      this._virtualConsole.push(data);
      this._dumpedItems.push(data);
      this._syncConsole();
    }
  }

  onClear() {
    this._virtualConsole = [];
    this._dumpedItems = [];
    this._syncConsole();
  }

  onShowWindow() {
    if (this._server) {
      this._server.io.emit('showWindow');
    }
  }

  dispose(): boolean {
    let retval = false;
    if (this._server) {
      this._server.dispose();
      this._server = null;
      retval = true;
    }

    if (this._disposables) {
      this._disposables.forEach(d => d.dispose());
      this._disposables = null;
    }

    return retval;
  }
}

class ClientManager {
  private client: Client | null = null;
  private _disposables: vscode.Disposable[] | null = null;
  private _selectionPath: string | null = null;
  private _selectionLine: number | null = null;

  get started() {
    return this.client !== null;
  }

  private _updateLine(editor?: vscode.TextEditor) {
    if (!editor) {
      return;
    }

    const ranges: vscode.Range[] = [];
    if (this._selectionLine !== null && this._selectionPath && editor.document) {
      const uri = editor.document.uri;
      if (uri.scheme === scheme && uri.path === this._selectionPath) {
        const position = new vscode.Position(this._selectionLine, 0);
        ranges.push(new vscode.Range(position, position));
      }
    }

    editor.setDecorations(lineDecoration, ranges);
  }

  start(host: string, logger: Logger | null): boolean {
    if (this.client) {
      return false;
    }

    let hostWithoutPort = host;
    const index = hostWithoutPort.indexOf(':');
    if (index !== -1) {
      hostWithoutPort = host.substring(0, index);
    }

    this._selectionLine = null;
    this._selectionPath = null;
    const io = require('socket.io-client');
    const socket = io(host, {
      reconnectionAttempts: 3
    }) as Socket;

    const onError = (reconnect: boolean) => () => {
      this.dispose();
      const msg = reconnect ? `SyncPad connection to \'${host}\' lost.` : `Could not connect to \'${host}\'.`;
      vscode
        .window
        .showErrorMessage(msg, 'Try Again')
        .then(item => {
          if (item === 'Try Again') {
            this.start(host, logger);
          }
        });
    };

    if (!this._disposables) {
      this._disposables = [
        vscode.window.onDidChangeActiveTextEditor(this._updateLine)
      ];
    }

    socket.on('disconnect', (reason: string) => {
      this.dispose();
      const msg = reason.includes('client')
        ? `Disconnected from '${host}'.`
        : `Host '${host}' stopped sharing.`;
      vscode.window.showInformationMessage(msg);
    });

    function formatDumpData(item: any) {
      const value = item.$value;
      if (value && value.$type === 'html' && typeof value.$html === 'string') {
        value.$html = (value.$html as string).replace(/http?\:\/\/localhost/g, hostWithoutPort);
      }
    }

    socket.on('connect_error', onError(false));
    socket.on('reconnect_failed', onError(true));
    socket.on('dump', (items: any[]) => {
      if (items && logger) {
        for (const item of items) {
          if (!item) {
            continue;
          }

          formatDumpData(item);
          logger.dump(item, false);
        }

        logger.update();
      }
    });

    socket.on('clear', () => {
      if (logger) {
        logger.clear(true);
      }
    });

    socket.on('showWindow', () => {
      if (logger) {
        logger.showWindow();
      }
    });

    socket.on('sync_console', (items?: any[]) => {
      if (logger) {
        logger.clear(false);
        if (items) {
          for (const item of items) {
            if (!item) {
              continue;
            }

            formatDumpData(item);
            logger.dump(item, false);
          }
        }

        logger.update();
      }
    });

    socket.on('selection', (position: { path: string | null, line: number | null, }) => {
      this._selectionPath = position.path;
      this._selectionLine = position.line;
      this._updateLine(vscode.window.activeTextEditor);
    });

    const client = new Client(socket, () => this._updateLine(vscode.window.activeTextEditor));
    client.connect();
    this.client = client;
    return true;
  }

  openFiles() {
    if (this.client) {
      this.client.getFiles().forEach((file: vscode.Uri) => {
        vscode.workspace
          .openTextDocument(file)
          .then(document => vscode.window.showTextDocument(document));
      });
    }
  }

  dispose() {
    if (this.client) {
      this.client.dispose();
      this.client = null;
    }

    if (this._disposables) {
      this._disposables.forEach(d => d.dispose());
      this._disposables = null;
    }
  }
}

class SyncPadContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();

  get onDidChange(): vscode.Event<vscode.Uri> {
    return this._onDidChange.event;
  }

  provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
    return '';
  }
}

interface Logger {
  dump(data: any, update: boolean): void;
  clear(update: boolean): void;
  update(): void;
  showWindow(): void;
  events: EventEmitter;
}

export default class Config {
  constructor(config: vscode.WorkspaceConfiguration) {
    this.listenServerPort = config.get<number>("listenServerPort") || 5257;
  }

  listenServerPort: number;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, new SyncPadContentProvider());
  const serverManager = new ServerManager();
  const clientManager = new ClientManager();
  let sharpPad: Logger | Thenable<Logger> | null = null;
  function hookEvents(api: Logger | null) {
    if (api === null) {
      return;
    }

    const { events } = api;
    events.on('dump', (data: any) => {
      serverManager.onDump(data);
    });

    events.on('showWindow', () => {
      serverManager.onShowWindow();
    });

    events.on('clear', () => {
      serverManager.onClear();
    });
  }

  const sharpPadExtension = vscode.extensions.getExtension('jmazouri.sharppad');
  if (sharpPadExtension) {
    console.log('Found SharpPad extension.');
    if (sharpPadExtension.isActive) {
      sharpPad = sharpPadExtension.exports as Logger;
      hookEvents(sharpPad);
    } else {
      sharpPad = sharpPadExtension
        .activate()
        .then((api: Logger) => {
          hookEvents(api);
          return api;
        });
    }
  } else {
    console.log('Could not connect to SharpPad.');
  }

  const config = new Config(vscode.workspace.getConfiguration('syncpad'));
  let port = config.listenServerPort;
  const shareFile = vscode.commands.registerCommand('syncpad.shareFile', () => {
    serverManager.start(port, (error) => {
      if (error) {
        return vscode.window.showErrorMessage('Could not start SyncPad server.');
      }

      const editor = vscode.window.activeTextEditor;
      if (editor) {
        serverManager.share(editor.document);
      }
    });
  });

  const stopSharing = vscode.commands.registerCommand('syncpad.stopSharing', () => {
    if (serverManager.dispose()) {
      vscode.window.showInformationMessage('Stopped sharing.');
    }
  });

  const joinSession = vscode.commands.registerCommand('syncpad.joinSession', () => {
    if (clientManager.started) {
      return;
    }

    vscode.window
      .showInputBox({
        placeHolder: 'Host address'
      })
      .then(input => {
        if (input) {
          if (!input.startsWith('http://')) {
            input = 'http://' + input;
          }

          if (!input.match(/\:\d+$/)) {
            input = input + ':' + port;
          }

          if (sharpPad && (sharpPad as Thenable<Logger>).then) {
            (sharpPad as Thenable<Logger>).then((api: Logger) => {
              clientManager.start(input as string, api);
            });
          } else {
            clientManager.start(input, sharpPad as Logger | null);
          }
        }
      });
  });

  const disconnect = vscode.commands.registerCommand('syncpad.disconnect', () => {
    clientManager.dispose();
  });

  const openFiles = vscode.commands.registerCommand('syncpad.openFiles', () => {
    clientManager.openFiles();
  });

  context.subscriptions.push(
    lineDecoration,
    shareFile,
    stopSharing,
    joinSession,
    disconnect,
    provider,
    serverManager,
    clientManager,
    openFiles);
}

export function deactivate() {

}