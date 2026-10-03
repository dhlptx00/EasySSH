/**
 * Integration tests against a real OpenSSH server (test/integration/Dockerfile).
 * Skipped unless EASYSSH_IT_PORT is set. Environment:
 *   EASYSSH_IT_HOST        server address (default 127.0.0.1)
 *   EASYSSH_IT_PORT        server port
 *   EASYSSH_IT_INNER_PORT  the port as seen from the server itself, for the jump test (default 22)
 *   EASYSSH_IT_KEY         private key whose public key setup.sh installed
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import { HostKeyDeclined } from '../../src/ssh/errors';
import { openSession, type HostKeyQuestion, type OpenedSession, type SshSession } from '../../src/ssh/session';
import { setupLine, type ShellKind } from '../../src/ssh/shellFeed';
import type { AskAnswer, AskRequest } from '../../src/ssh/auth';
import type { ConflictChoice, ConnectionRecord, SecretPayload, UploadOptions } from '../../src/types';
import { EasySshApp } from '../../src/terminal/app';
import type { AppHost } from '../../src/terminal/host';

const PORT = Number(process.env.EASYSSH_IT_PORT ?? 0);
const HOST = process.env.EASYSSH_IT_HOST ?? '127.0.0.1';
const INNER_PORT = Number(process.env.EASYSSH_IT_INNER_PORT ?? 22);
const KEY = process.env.EASYSSH_IT_KEY ?? '';
const PASSWORD = 'easy-ssh-it';
const skip = !PORT || !KEY ? 'set EASYSSH_IT_PORT and EASYSSH_IT_KEY to run against a test sshd' : false;

interface Opened extends OpenedSession {
  asked: AskRequest[];
  questions: HostKeyQuestion[];
  store: Map<string, string>;
}

async function connect(
  username: string,
  options: {
    auth?: ConnectionRecord['auth'];
    secret?: SecretPayload;
    answers?: string[];
    trust?: boolean;
    policy?: 'ask' | 'trustFirst';
    store?: Map<string, string>;
    jumps?: ConnectionRecord['jumps'];
    host?: string;
    port?: number;
  } = {},
): Promise<Opened> {
  const asked: AskRequest[] = [];
  const questions: HostKeyQuestion[] = [];
  const store = options.store ?? new Map<string, string>();
  const answers = [...(options.answers ?? [])];
  const auth = options.auth ?? 'privateKey';
  const opened = await openSession({
    record: {
      id: `it-${username}`,
      name: username,
      host: options.host ?? HOST,
      port: options.port ?? PORT,
      username,
      auth,
      privateKeyPath: auth === 'privateKey' ? KEY : undefined,
      jumps: options.jumps ?? [],
    },
    secret: options.secret ?? {},
    known: { get: (id) => store.get(id), trust: async (id, fp) => void store.set(id, fp) },
    knownHosts: [],
    hostKeyPolicy: options.policy ?? 'trustFirst',
    ui: {
      ask: async (request): Promise<AskAnswer | undefined> => {
        asked.push(request);
        const value = answers.shift();
        return value === undefined ? undefined : { value, save: request.save ?? false };
      },
      trustHostKey: async (question) => {
        questions.push(question);
        return options.trust ?? true;
      },
    },
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    identityFiles: [],
    signal: new AbortController().signal,
    onClose: () => {},
    log: () => {},
  });
  return { ...opened, asked, questions, store };
}

/** A login shell whose output is collected, with a wait-for-pattern helper. */
async function shell(session: SshSession) {
  let output = '';
  let closed = false;
  const waiters: (() => void)[] = [];
  await session.openShell(120, 30, (chunk) => {
    output += chunk;
    for (const wake of waiters.splice(0)) wake();
  }, () => {
    closed = true;
    for (const wake of waiters.splice(0)) wake();
  });
  const waitFor = async (pattern: RegExp | string, ms = 8000): Promise<void> => {
    const deadline = Date.now() + ms;
    const test = () => (typeof pattern === 'string' ? output.includes(pattern) : pattern.test(output));
    while (!test()) {
      if (closed) throw new Error(`shell closed before ${pattern}. Output:\n${JSON.stringify(output)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${pattern}. Output:\n${JSON.stringify(output)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return {
    get output() {
      return output;
    },
    write: (data: string) => session.writeShell(data),
    waitFor,
    closed: () => closed,
  };
}

function transfer(extra: Partial<UploadOptions> = {}): UploadOptions {
  return {
    signal: new AbortController().signal,
    concurrency: 16,
    maxFiles: 1000,
    onProgress: () => {},
    resolveConflict: async () => 'replace' as ConflictChoice,
    ...extra,
  };
}

async function readRemote(session: SshSession, remote: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easyssh-it-'));
  try {
    const result = await session.download(remote, dir, 'file', transfer());
    return await fs.promises.readFile(result.localPath, 'utf8');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

const OSC7 = (dir: string) => `\x1b]7;${dir}\x07`;

describe('real sshd', { skip }, () => {
  for (const [user, kind, prompt] of [
    ['esit_bash', 'bash', /it-bash:~\$ /],
    ['esit_zsh', 'zsh', /it-zsh:~% /],
    ['esit_fish', 'fish', /it-fish:~> /],
  ] as const) {
    it(`installs the folder hook in a ${kind} login shell without errors (U7, B2)`, async () => {
      const opened = await connect(user);
      try {
        assert.equal(opened.shell, kind as ShellKind);
        const term = await shell(opened.session);
        await term.waitFor(prompt);
        term.write(`${setupLine(kind)}\n`);
        await term.waitFor(OSC7(opened.cwd));
        term.write('cd /tmp\n');
        await term.waitFor(OSC7('/tmp'));
        assert.doesNotMatch(term.output, /syntax error|command not found|parse error|Unknown command/i);
      } finally {
        opened.session.close();
      }
    });
  }

  it('shows login output before the first prompt and keeps the hook out of bash history (B11, B12)', async () => {
    const opened = await connect('esit_bash');
    try {
      const term = await shell(opened.session);
      await term.waitFor(/it-bash:~\$ /);
      assert.match(term.output, /EASY-SSH-IT-LOGIN-BANNER/);
      term.write(`${setupLine('bash', '/tmp')}\n`);
      await term.waitFor(OSC7('/tmp'));
      term.write('echo marker-$((6*7))\n');
      await term.waitFor('marker-42');
      term.write('exit\n');
      const deadline = Date.now() + 5000;
      while (!term.closed() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      const history = await readRemote(opened.session, `${opened.cwd}/.bash_history`);
      assert.match(history, /echo marker-/);
      assert.doesNotMatch(history, /PROMPT_COMMAND|printf/);
    } finally {
      opened.session.close();
    }
  });

  it('copies a file in parallel chunks byte for byte, and reads /proc files that report size 0 (U2, B5, B6)', async () => {
    const opened = await connect('esit_bash');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easyssh-it-'));
    try {
      const data = randomBytes(3 * 1024 * 1024 + 12345);
      const local = path.join(dir, 'blob.bin');
      await fs.promises.writeFile(local, data);
      await opened.session.upload([local], opened.cwd, transfer());
      const back = await opened.session.download(`${opened.cwd}/blob.bin`, dir, 'blob.bin', transfer());
      assert.equal(back.localPath, path.join(dir, 'blob (1).bin'));
      const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
      assert.equal(sha(await fs.promises.readFile(back.localPath)), sha(data));
      const cpu = await opened.session.download('/proc/self/status', dir, 'status', transfer());
      assert.ok(cpu.bytes > 0);
      assert.match(await fs.promises.readFile(cpu.localPath, 'utf8'), /^Name:/m);
    } finally {
      opened.session.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('asks before replacing a remote file on upload (U6)', async () => {
    const opened = await connect('esit_bash');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easyssh-it-'));
    try {
      // A fresh remote folder per run: upload a local folder holding the first version.
      const caseName = `case-${randomBytes(4).toString('hex')}`;
      await fs.promises.mkdir(path.join(dir, caseName));
      await fs.promises.writeFile(path.join(dir, caseName, 'notes.txt'), 'v1');
      await opened.session.upload([path.join(dir, caseName)], opened.cwd, transfer());
      const remoteDir = `${opened.cwd}/${caseName}`;
      const local = path.join(dir, 'notes.txt');
      const asked: string[][] = [];
      await fs.promises.writeFile(local, 'v2');
      await opened.session.upload([local], remoteDir, transfer({ resolveConflict: async (names) => (asked.push(names), 'replace') }));
      assert.deepEqual(asked, [['notes.txt']]);
      assert.equal(await readRemote(opened.session, `${remoteDir}/notes.txt`), 'v2');
      await fs.promises.writeFile(local, 'v3');
      const kept = await opened.session.upload([local], remoteDir, transfer({ resolveConflict: async () => 'keep' }));
      assert.deepEqual(kept.renamed, ['notes.txt -> notes (1).txt']);
      assert.equal(await readRemote(opened.session, `${remoteDir}/notes.txt`), 'v2');
      assert.equal(await readRemote(opened.session, `${remoteDir}/notes (1).txt`), 'v3');
      const skipped = await opened.session.upload([local], remoteDir, transfer({ resolveConflict: async () => 'skip' }));
      assert.equal(skipped.kept, 1);
      assert.equal(await readRemote(opened.session, `${remoteDir}/notes.txt`), 'v2');
      const names = (await opened.session.list(remoteDir)).map((entry) => entry.name);
      assert.ok(!names.some((name) => name.endsWith('.part')), names.join(','));
    } finally {
      opened.session.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('downloads a folder with its structure and skips symlinks', async () => {
    const opened = await connect('esit_bash');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easyssh-it-'));
    try {
      const term = await shell(opened.session);
      await term.waitFor(/it-bash:~\$ /);
      term.write('rm -rf ~/site && mkdir -p ~/site/sub ~/site/empty && echo hi > ~/site/sub/a.txt && echo top > ~/site/b.txt && chmod 750 ~/site/sub && ln -s /etc/hostname ~/site/link && echo SETUP-$((1+1))\n');
      await term.waitFor('SETUP-2');
      const result = await opened.session.downloadFolder(`${opened.cwd}/site`, dir, 'site', { ...transfer(), maxFiles: 100 });
      assert.equal(result.localPath, path.join(dir, 'site'));
      assert.equal(result.files, 2);
      assert.deepEqual(result.skipped, [{ path: 'link', reason: 'symlink' }]);
      assert.equal(await fs.promises.readFile(path.join(dir, 'site', 'sub', 'a.txt'), 'utf8'), 'hi\n');
      assert.ok(fs.statSync(path.join(dir, 'site', 'empty')).isDirectory());
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'site', 'sub')).mode & 0o777, 0o750);
      const again = await opened.session.downloadFolder(`${opened.cwd}/site`, dir, 'site', { ...transfer(), maxFiles: 100 });
      assert.equal(again.localPath, path.join(dir, 'site (1)'));
      await assert.rejects(opened.session.downloadFolder(`${opened.cwd}/site`, dir, 'site', { ...transfer(), maxFiles: 1 }), /more than 1 files/);
      assert.deepEqual(fs.readdirSync(dir).sort(), ['site', 'site (1)']);
    } finally {
      opened.session.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('answers a PAM keyboard-interactive password prompt with the saved password (S2)', async () => {
    const opened = await connect('esit_kbd', { auth: 'password', secret: { password: PASSWORD } });
    try {
      assert.deepEqual(opened.asked, []);
      assert.equal(opened.shell, 'bash');
    } finally {
      opened.session.close();
    }
    const asked = await connect('esit_kbd', { auth: 'password', secret: { password: 'wrong' }, answers: [PASSWORD] });
    try {
      assert.equal(asked.asked.length, 1);
      assert.equal(asked.asked[0].masked, true);
    } finally {
      asked.session.close();
    }
  });

  it('asks again after a wrong password and offers to save the typed one (S3)', async () => {
    const opened = await connect('esit_bash', { auth: 'password', secret: { password: 'wrong' }, answers: [PASSWORD] });
    try {
      assert.equal(opened.asked[0].title, 'Wrong password. Try again');
      assert.equal(opened.savePassword, PASSWORD);
    } finally {
      opened.session.close();
    }
  });

  it('shows an unknown host key and connects only when accepted (S1)', async () => {
    await assert.rejects(connect('esit_bash', { policy: 'ask', trust: false }), HostKeyDeclined);
    const store = new Map<string, string>();
    const first = await connect('esit_bash', { policy: 'ask', trust: true, store });
    first.session.close();
    assert.equal(first.questions.length, 1);
    assert.equal(first.questions[0].kind, 'unknown');
    assert.match(first.questions[0].fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(store.get(`${HOST}:${PORT}`), first.questions[0].fingerprint);
    const second = await connect('esit_bash', { policy: 'ask', trust: false, store });
    second.session.close();
    assert.equal(second.questions.length, 0);
    store.set(`${HOST}:${PORT}`, '00'.repeat(32));
    await assert.rejects(connect('esit_bash', { policy: 'trustFirst', trust: false, store }), HostKeyDeclined);
  });

  it('connects through a jump host and stores its key per hop (B16)', async () => {
    const store = new Map<string, string>();
    const opened = await connect('esit_zsh', {
      store,
      host: '127.0.0.1',
      port: INNER_PORT,
      jumps: [{ host: HOST, port: PORT, username: 'esit_bash', auth: 'privateKey', privateKeyPath: KEY }],
    });
    try {
      assert.equal(opened.shell, 'zsh');
      assert.deepEqual([...store.keys()].sort(), [`${HOST}:${PORT}`, `${HOST}:${PORT}>127.0.0.1:${INNER_PORT}`].sort());
    } finally {
      opened.session.close();
    }
  });

  for (const user of ['esit_bash', 'esit_zsh', 'esit_fish']) {
    it(`runs a whole Easy SSH terminal session against ${user}: login output, hidden hook, folder tracking`, async () => {
      const status: string[] = [];
      const shown: string[] = [];
      const record: ConnectionRecord = { id: user, name: user, host: HOST, port: PORT, username: user, auth: 'privateKey', privateKeyPath: KEY, jumps: [] };
      const host: AppHost = {
        listConnections: async () => [record],
        saveConnection: async () => {},
        deleteConnection: async () => {},
        secretFlags: async () => ({ password: false, passphrase: false }),
        importConfig: async () => ({ ok: true, message: '' }),
        connect: async () => {
          const opened = await connect(user);
          return { session: opened.session, cwd: opened.cwd, usedFallbackPath: false, notes: opened.notes, shell: opened.shell };
        },
        downloadFolder: () => os.tmpdir(),
        home: () => os.homedir(),
        chooseDownloadFolder: async () => undefined,
        classifyDrop: () => null,
        keyExists: () => true,
        setStatus: (text) => {
          if (text) status.push(text);
        },
        log: () => {},
        scrollTerminal: () => {},
        quit: () => {},
      };
      const app = new EasySshApp(host, (data) => shown.push(data));
      app.setSize(120, 30);
      app.open();
      const until = async (test: () => boolean, what: string, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (!test()) {
          if (Date.now() > deadline) throw new Error(`timed out: ${what}\n${JSON.stringify(shown.join('').slice(-2000))}\n${status.join('\n')}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      try {
        await until(() => shown.join('').includes(user), 'connection list');
        app.onInput([{ type: 'key', key: 'enter' }]);
        await until(() => status.some((line) => line === `${user}:/home/${user}`), 'connected');
        // Typed right away: held until the hook is in, then sent.
        for (const ch of 'cd /tmp\r') app.onRawInput(ch);
        await until(() => status.at(-1) === `${user}:/tmp`, 'cd /tmp tracked');
        const screen = shown.join('');
        if (user === 'esit_bash') assert.match(screen, /EASY-SSH-IT-LOGIN-BANNER/);
        assert.doesNotMatch(screen, /PROMPT_COMMAND|precmd_functions|fish_prompt|syntax error|command not found/);
        assert.ok(app.linkFor('anything').length === 0);
      } finally {
        app.dispose();
      }
    });
  }
});
