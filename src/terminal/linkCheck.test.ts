import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry } from '../types';
import type { ActionMenu } from './actions';
import { EasySshApp } from './app';
import type { AppHost } from './host';
import { fakeRemote, flush, sleep, type FakeRemote } from './testHost';

const HOME = '/home/demo/project';
const file = (name: string, size = 10): BrowseEntry => ({ name, path: `${HOME}/${name}`, kind: 'file', size, mtime: 0 });

interface Rig {
  app: EasySshApp;
  remote: FakeRemote;
  menus: ActionMenu[];
  lists: number;
  listing: BrowseEntry[];
}

async function rig(listing: BrowseEntry[]): Promise<Rig> {
  const remote = fakeRemote({ cwd: HOME, files: listing });
  const state: Rig = { app: undefined as unknown as EasySshApp, remote, menus: [], lists: 0, listing };
  remote.session.list = async () => {
    state.lists += 1;
    return state.listing;
  };
  const host: AppHost = {
    ...remote.host,
    showActionMenu: async (menu) => {
      state.menus.push(menu);
      return undefined;
    },
  };
  const app = new EasySshApp(host, () => {});
  app.setSize(80, 20);
  app.open();
  await flush();
  app.onInput([{ type: 'key', key: 'enter' }]);
  await flush();
  remote.push(`\x1b]7;${HOME}\x07$ `);
  await flush();
  await sleep(200);
  state.app = app;
  return state;
}

/** Print command output, then the prompt with its folder report. */
async function run(r: Rig, output: string): Promise<void> {
  r.remote.push(`${output}\x1b]7;${HOME}\x07$ `);
  await flush();
  await sleep(250);
  await flush();
}

async function settle(): Promise<void> {
  await flush();
  await sleep(30);
  await flush();
}

describe('listing refresh after a command (names made by mv, touch, mkdir)', () => {
  it('a name a command created in the same folder becomes a link after the prompt', async () => {
    const r = await rig([file('notes.txt')]);
    assert.deepEqual(r.app.linkFor('new.txt'), []);
    r.listing = [file('notes.txt'), file('new.txt')];
    await run(r, 'touch new.txt\r\n');
    const links = r.app.linkFor('new.txt');
    assert.equal(links.length, 1);
    assert.equal(links[0].remotePath, `${HOME}/new.txt`);
    // A renamed name stops being a link.
    r.listing = [file('renamed.txt'), file('new.txt')];
    await run(r, 'mv notes.txt renamed.txt\r\n');
    assert.deepEqual(r.app.linkFor('notes.txt'), []);
    assert.equal(r.app.linkFor('renamed.txt').length, 1);
    r.app.dispose();
  });

  it('several prompts in quick succession make one listing', async () => {
    const r = await rig([file('notes.txt')]);
    const before = r.lists;
    for (let index = 0; index < 5; index += 1) r.remote.push(`\x1b]7;${HOME}\x07$ `);
    await flush();
    await sleep(300);
    assert.equal(r.lists - before, 1);
    r.app.dispose();
  });

  it('a big folder is listed again only when its time changed', async () => {
    const many = Array.from({ length: 2100 }, (_, index) => file(`f${index}.txt`));
    const r = await rig(many);
    let folderTime = 1000;
    r.remote.session.stat = async () => ({ kind: 'dir', size: 0, mtime: folderTime });
    await run(r, '');
    const first = r.lists;
    await run(r, 'echo hi\r\nhi\r\n');
    assert.equal(r.lists, first);
    folderTime = 2000;
    await run(r, 'touch x\r\n');
    assert.equal(r.lists, first + 1);
    r.app.dispose();
  });
});

describe('stale terminal links (VS Code kept a link after the row changed)', () => {
  it('a link whose row is unchanged opens its own name', async () => {
    const r = await rig([file('README.md'), file('app.yaml')]);
    r.remote.push('README.md\r\n');
    await flush();
    const [link] = r.app.linkFor('README.md');
    r.app.activateLink(link);
    await settle();
    assert.equal(r.menus.at(-1)?.title.startsWith('README.md'), true);
    r.app.dispose();
  });

  it('after `clear && ls` redrew the row, the click acts on the name now under the link', async () => {
    const r = await rig([file('README.md'), file('app.yaml')]);
    r.remote.push('\x1b[H\x1b[2JREADME.md\r\n');
    await flush();
    const [link] = r.app.linkFor('README.md');
    assert.equal(link.anchors?.length, 1);
    r.remote.push('\x1b[H\x1b[2Japp.yaml\r\n');
    await flush();
    r.app.activateLink(link);
    await settle();
    assert.equal(r.menus.length, 1);
    assert.equal(r.menus[0].title.startsWith('app.yaml'), true);
    assert.ok(r.remote.logs.some((line) => line.includes('using /home/demo/project/app.yaml instead of /home/demo/project/README.md')));
    r.app.dispose();
  });

  it('no name under the old link: a message instead of acting on the wrong file', async () => {
    const r = await rig([file('README.md'), file('app.yaml')]);
    r.remote.push('\x1b[H\x1b[2J          README.md\r\n');
    await flush();
    const [link] = r.app.linkFor('          README.md');
    r.remote.push('\x1b[H\x1b[2Japp.yaml\r\n');
    await flush();
    r.app.activateLink(link);
    await settle();
    assert.equal(r.menus.length, 0);
    assert.ok(r.remote.notes.some((note) => note.text.includes('changed')));
    r.app.dispose();
  });

  it('a line VS Code wrapped (no matching row) is trusted as before', async () => {
    const r = await rig([file('README.md')]);
    const [link] = r.app.linkFor('not on screen README.md');
    assert.deepEqual(link.anchors, []);
    r.app.activateLink(link);
    await settle();
    assert.equal(r.menus.length, 1);
    r.app.dispose();
  });
});
