import { Socket, FileMessage, Change, ChangeMessage, scheme } from '../sockets';
import * as vscode from 'vscode';

class ClientFileState {
  public path: string;
  public ref: number;

  constructor(path: string, ref: number) {
    this.path = path;
    this.ref = ref;
  }

  update(ref: number) {
    this.ref = ref;
  }
}

function getRange(change: Change): vscode.Range {
  return new vscode.Range(
    new vscode.Position(change.sl, change.sc),
    new vscode.Position(change.el, change.ec));
}

function getUri(path: string) {
  return vscode.Uri.parse(scheme + ':' + path);
}

export class Client {
  private _socket: Socket;
  private _files: Map<string, ClientFileState> = new Map<string, ClientFileState>();
  private _syncSelection: () => void;

  constructor(socket: Socket, syncSelection: () => void) {
    this._socket = socket;
    this._syncSelection = syncSelection;
  }

  private _onFile = (file: FileMessage): void => {
    let newFile: boolean;
    if (!this._files.has(file.path)) {
      newFile = true;
      this._files.set(file.path, new ClientFileState(file.path, file.ref));
    } else {
      newFile = false;
      const state = this._files.get(file.path) as ClientFileState;
      if (state.ref > file.ref) {
        return;
      }

      state.update(file.ref);
    }

    const uri = getUri(file.path);
    vscode.workspace
      .openTextDocument(uri)
      .then(document => {
        if (newFile || file.open) {
          vscode.window.showTextDocument(document);
        }

        const edit = new vscode.WorkspaceEdit();
        const lastLine = document.lineAt(document.lineCount - 1);
        const start = new vscode.Position(0, 0);
        const end = new vscode.Position(document.lineCount - 1, lastLine.text.length);
        edit.set(uri, [new vscode.TextEdit(new vscode.Range(start, end), file.text)]);
        vscode.workspace
          .applyEdit(edit)
          .then(() => {
            console.log('Text replaced.');
            this._syncSelection();
          }, (error) => {
            console.error(error);
          });
      });
  }

  private _onChange = (update: ChangeMessage): void => {
    if (!this._files.has(update.path)) {
      return;
    }

    const state = this._files.get(update.path) as ClientFileState;
    if (update.ref !== state.ref + 1) {
      console.log(`Invalid state, syncing again. ${state.ref}/${update.ref}`);
      this._socket.emit('get_file', update.path);
    } else {
      const uri = getUri(update.path);
      const transactions: vscode.WorkspaceEdit[] = [];
      for (const tx of update.txs) {
        const edit = new vscode.WorkspaceEdit();
        const edits: vscode.TextEdit[] = [];
        for (const change of tx.changes) {
          edits.push(new vscode.TextEdit(getRange(change), change.text));
        }

        edit.set(uri, edits);
        transactions.push(edit);
      }

      vscode
        .workspace
        .openTextDocument(uri).then(() => {
          const edit = (i: number) => {
            const tx = transactions[i];
            vscode.workspace
              .applyEdit(tx)
              .then(() => {
                if (i + 1 < transactions.length) {
                  edit(i + 1);
                } else {
                  state.update(update.ref);
                  this._syncSelection();
                }
              }, (error) => {
                console.error(error);
                this._socket.emit('get_file', update.path);
              });
          };

          if (transactions.length) {
            edit(0);
          }
        }, (error) => {
          console.error(error);
        });
    }
  }

  connect() {
    const socket = this._socket;
    socket.on('connect', () => {
      socket.emit('get_files');
      socket.emit('sync_console');
    });
    socket.on('file', this._onFile);
    socket.on('change', this._onChange);
  }

  getFiles(): vscode.Uri[] {
    return Array
      .from(this._files.keys())
      .map(file => vscode.Uri.parse(scheme + ':' + file));
  }

  dispose() {
    this._socket.close();
  }
}
