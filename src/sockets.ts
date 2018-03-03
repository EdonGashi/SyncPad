export interface Emitter {
  emit(event: string, payload?: any): void;
}

export interface Listener {
  on(event: string, handler: (payload?: any) => void): void;
}

export type Socket = Emitter & Listener & { close(): void };

export interface FileMessage {
  path: string;
  ref: number;
  text: string;
  open: boolean;
}

export interface ChangeMessage {
  path: string;
  ref: number;
  txs: Transaction[];
}

export interface Change {
  text: string;
  sl: number;
  sc: number;
  el: number;
  ec: number;
}

export interface Transaction {
  changes: Change[];
}

export const scheme = 'syncpad';
