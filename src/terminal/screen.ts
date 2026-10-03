import type { AskRequest } from '../ssh/auth';
import type { HostKeyQuestion } from '../ssh/session';
import type { Notice } from '../types';
import type { Draft, Step } from './wizard';

export interface ConnectionItem {
  id: string;
  name: string;
  userHost: string;
  detail: string;
}

export type Screen =
  | { kind: 'loading' }
  | { kind: 'connections'; items: ConnectionItem[]; selected: number; notice?: Notice; command: string; pick: number }
  | { kind: 'confirm'; item: ConnectionItem; choice: number; notice?: Notice }
  | { kind: 'pick'; mode: 'edit' | 'delete'; items: ConnectionItem[]; selected: number; notice?: Notice }
  | {
      kind: 'wizard';
      title: string;
      draft: Draft;
      step: Step;
      input: string;
      /** Index into the current choice list. Ignored on typed steps. */
      pick: number;
      error?: string;
      notice?: Notice;
    }
  | { kind: 'connecting'; label: string }
  /** A host key to confirm while connecting: a new server, or a changed key. */
  | { kind: 'trust'; question: HostKeyQuestion; choice: number }
  /** A password, passphrase, or keyboard-interactive prompt while connecting. */
  | { kind: 'ask'; label: string; request: AskRequest; input: string; save: boolean }
  /** The connection dropped. Enter reconnects, Esc goes back to the list. */
  | { kind: 'lost'; name: string; reason: string; choice: number; retryIn?: number };
