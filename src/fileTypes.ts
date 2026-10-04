/**
 * Which remote files the action menu offers to Open in an editor tab.
 * By name first (case-insensitive); anything unknown is decided by sniffing
 * its first bytes (see looksLikeText).
 */

/** Extensions of files that are text: the menu shows Open. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    'txt md markdown rst adoc tex log out err csv tsv json jsonc json5 yaml yml toml ini cfg conf cnf properties env xml plist ' +
    'service timer socket rules repo list sh bash zsh fish ksh ps1 psm1 bat cmd awk sed py rb pl pm php lua r js mjs cjs ts ' +
    'jsx tsx vue svelte java kt kts scala groovy gradle go rs c h cpp cc cxx hpp cs swift m dart ex exs erl hs clj sql html ' +
    'htm css scss sass less svg diff patch pem crt csr key pub gitignore gitattributes dockerignore editorconfig lock tf hcl ' +
    'nginx vim proto graphql'
  ).split(' '),
);

/** Whole file names (without an extension that decides) that are text. */
const TEXT_NAMES: ReadonlySet<string> = new Set(
  (
    'Dockerfile Makefile Jenkinsfile Vagrantfile Gemfile Procfile README LICENSE CHANGELOG .bashrc .profile .bash_profile ' +
    '.zshrc .vimrc .gitconfig authorized_keys known_hosts config hosts crontab'
  )
    .split(' ')
    .map((name) => name.toLowerCase()),
);

/** Extensions of files that are not text: the menu hides Open. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    'zip tar gz tgz bz2 tbz2 xz txz zst 7z rar lz lzma z cab apk deb rpm jar war ear whl egg dmg iso img jpg jpeg png gif ' +
    'bmp webp ico tif tiff heic psd raw mp3 wav flac aac ogg m4a mp4 mkv avi mov wmv flv webm pdf doc docx xls xlsx ppt ' +
    'pptx odt ods epub exe dll so a o ko bin elf class pyc pyo wasm msi db sqlite sqlite3 mdb dat pcap ttf otf woff woff2 ' +
    'swp core dump p12 pfx keystore jks'
  ).split(' '),
);

/** How many leading bytes the sniff reads. */
export const SNIFF_BYTES = 8192;

/** libfoo.so.1, libssl.so.3.0.2 */
const VERSIONED_SHARED_LIBRARY = /\.so(\.\d+)+$/i;

export type NameKind = 'text' | 'binary' | 'unknown';

/** The extension Easy SSH looks at: after the last dot, so ".env" is "env" and "a.tar.gz" is "gz". */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Text, binary, or unknown (then sniff the content) from the file name alone. */
export function classifyName(name: string): NameKind {
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower)) return 'text';
  if (VERSIONED_SHARED_LIBRARY.test(lower)) return 'binary';
  const extension = extensionOf(lower);
  if (!extension) return 'unknown';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (BINARY_EXTENSIONS.has(extension)) return 'binary';
  return 'unknown';
}

/**
 * Whether the first bytes of a file look like text: no NUL byte and valid UTF-8.
 * A multibyte character cut off by the end of the sample is fine.
 */
export function looksLikeText(head: Uint8Array): boolean {
  let index = 0;
  const length = head.length;
  while (index < length) {
    const byte = head[index];
    if (byte === 0) return false;
    if (byte < 0x80) {
      index += 1;
      continue;
    }
    let need: number;
    let min: number;
    if (byte >= 0xc2 && byte <= 0xdf) {
      need = 1;
      min = 0x80;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      need = 2;
      min = 0x800;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      need = 3;
      min = 0x10000;
    } else {
      return false;
    }
    let code = byte & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    for (let offset = 1; offset <= need; offset += 1) {
      // Cut off by the end of the sample: the rest of the character is unread.
      if (index + offset >= length) return true;
      const next = head[index + offset];
      if ((next & 0xc0) !== 0x80) return false;
      code = (code << 6) | (next & 0x3f);
    }
    // Overlong forms, UTF-16 surrogates and values past U+10FFFF are not UTF-8.
    if (code < min || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return false;
    index += need + 1;
  }
  return true;
}
