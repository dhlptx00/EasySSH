import type { BrowseEntry, Notice, TransferState } from '../types';
import type { Draft, Step } from './wizard';

export interface ConnectionItem {
  id: string;
  name: string;
  userHost: string;
  detail: string;
}

export type Screen =
  | { kind: 'loading' }
  | { kind: 'connections'; items: ConnectionItem[]; selected: number; notice?: Notice; command: string }
  | { kind: 'confirm'; item: ConnectionItem; choice: number; notice?: Notice }
  | {
      kind: 'wizard';
      title: string;
      draft: Draft;
      step: Step;
      input: string;
      error?: string;
      notice?: Notice;
    }
  | { kind: 'connecting'; label: string }
  | { kind: 'trust'; hostLabel: string; fingerprint: string; choice: number }
  | {
      kind: 'browse';
      title: string;
      userHost: string;
      cwd: string;
      entries: BrowseEntry[];
      selected: number;
      notice?: Notice;
      transfer?: TransferState;
      /** Null hides the path prompt. An empty string shows it. */
      goto: string | null;
    };
