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
      /** The Linux command being typed. */
      command: string;
      /** Remote transcript, kept as the server printed it. */
      output: string;
      /** Lines hidden below the newest output. 0 follows the tail. */
      scroll?: number;
      /** File under the pointer. Its name is underlined. */
      hoverPath?: string;
      /** File in the pressed click state. */
      pressedPath?: string;
    };
