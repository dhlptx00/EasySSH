import type { AskRequest } from '../ssh/auth';
import type { HostKeyQuestion } from '../ssh/session';
import type { AuthMethod, Notice } from '../types';
import type { Draft, Field, Step } from './wizard';

export interface ConnectionItem {
  id: string;
  name: string;
  userHost: string;
  /** "key via bastion": sign-in and jump hosts in one string, for the slash menu. */
  detail: string;
  auth: AuthMethod;
  /** Jump hosts, by saved connection name when one matches, e.g. "bastion". */
  via?: string;
  /** Milliseconds since the epoch of the last successful connect. */
  lastUsed?: number;
  /** For the details box under the list. */
  host?: string;
  port?: number;
  username?: string;
  keyPath?: string;
  /** Jump hosts as user@host:port, comma-separated. */
  jumpHosts?: string;
  askPassword?: boolean;
  startPath?: string;
}

/** The result of Test connection on the summary. */
export interface TestResult {
  ok: boolean;
  text: string;
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
      /** Set while one field is changed from the summary: the wizard returns there after it. */
      field?: Field;
      mode?: 'new' | 'edit';
    }
  /**
   * The last page of /new and the field picker of /edit: every value, the
   * equivalent ssh command, and Test connection / Save / Back.
   */
  | {
      kind: 'summary';
      mode: 'new' | 'edit';
      title: string;
      draft: Draft;
      /** Index into the fields, then the actions. */
      choice: number;
      test?: TestResult;
      notice?: Notice;
    }
  | { kind: 'connecting'; label: string; title?: string }
  /** A host key to confirm while connecting: a new server, or a changed key. */
  | { kind: 'trust'; question: HostKeyQuestion; choice: number }
  /** A password, passphrase, or keyboard-interactive prompt while connecting. */
  | { kind: 'ask'; label: string; request: AskRequest; input: string; save: boolean }
  /** The connection dropped. Enter reconnects, Esc goes back to the list. */
  | { kind: 'lost'; name: string; reason: string; choice: number; retryIn?: number };

/** Actions under the fields on the summary, in order. */
export const SUMMARY_ACTIONS = ['test', 'save', 'back'] as const;
export type SummaryAction = (typeof SUMMARY_ACTIONS)[number];
