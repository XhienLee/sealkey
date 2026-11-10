# Sealkey

Lock files with a 6-word key and open them again, entirely in your browser. Files and keys never reach a server.

**Use it now: <https://sealkey.netlify.app>**

1. Choose one file, several files or a folder. Sealkey creates a 6-word key and saves one `.seal` file.
2. Send the `.seal` file one way (email, Drive) and the key another way (a message, a call, in person).
3. The receiver opens Sealkey, picks the file, types the key and saves the original file, or a ZIP when several files were locked.

A lost key cannot be recovered by anyone.

## Deploy

Sealkey is plain static files with no build step, so you can deploy it from a GitHub fork or by uploading a folder. Whatever host you use, it must:

- serve the site over HTTPS
- send the security headers in `_headers`
- serve `.js` and `.mjs` files as `text/javascript`

### Cloudflare Pages

1. Fork [XhienLee/sealkey](https://github.com/XhienLee/sealkey) to your GitHub account.
2. In the Cloudflare dashboard, open **Workers & Pages** and choose **Create application**, then **Pages**, then **Connect to Git**.
3. Pick your fork of `sealkey`.
4. Build settings:
   - Production branch: `main`
   - Framework preset: `None`
   - Build command: leave empty
   - Build output directory: `/`
5. Choose **Save and Deploy**. The site appears at `<project>.pages.dev`.
6. Turn off Web Analytics for the project if it's on.
7. Optional: add your own domain under **Custom domains**.

To update, sync your fork with this repository. Every push to `main` deploys again.

### Netlify

1. Fork [XhienLee/sealkey](https://github.com/XhienLee/sealkey) to your GitHub account.
2. In Netlify, choose **Add new site**, then **Import an existing project**, then **GitHub**.
3. Pick your fork of `sealkey`.
4. Build settings:
   - Branch to deploy: `main`
   - Base directory: leave empty
   - Build command: leave empty
   - Publish directory: `.`
5. Choose **Deploy**. The site appears at `<name>.netlify.app`.
6. Optional: add your own domain under **Domain management**.

Netlify reads `_headers` automatically. To update, sync your fork with this repository. Every push to `main` deploys again.

### Without a GitHub account

First get the files. On the [repository page](https://github.com/XhienLee/sealkey), choose **Code**, then **Download ZIP**, and unzip it. No account is needed. You'll get a folder named `sealkey-main` that contains `index.html` and `_headers`. Upload that folder, not the folder around it.

Netlify Drop:

1. Go to <https://app.netlify.com/drop>.
2. Drag the `sealkey-main` folder onto the page. The site appears at `<name>.netlify.app`.
3. Sign up or log in when asked, so the site stays online and you can update it.
4. To update, download the new ZIP and drag the new folder onto the **Deploys** page of your site.

Cloudflare Pages:

1. Sign up for a free Cloudflare account.
2. Open **Workers & Pages** and choose **Create application**, then **Get started** next to **Drag and drop your files**.
3. Name the project, then drag in the `sealkey-main` folder or the ZIP itself.
4. Choose **Deploy site**. The site appears at `<project>.pages.dev`.
5. To update, open the project, choose **Create new deployment** and upload the new folder.

A project made this way can't be connected to GitHub later. You'd need a new project for that.

### Any other web server

1. Download or clone this repository.
2. Copy these to the web root: `index.html`, `css/`, `js/`, `fonts/` and `vendor/`. The rest of the repository isn't needed.
3. Add the headers from `_headers` and the `.mjs` type.
4. Turn on HTTPS, for example with Let's Encrypt.

nginx, inside the `server` block:

```nginx
types { text/html html; text/css css; text/javascript js mjs; font/woff2 woff2; }
add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" always;
add_header Referrer-Policy "no-referrer" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
```

Apache, in the site config or `.htaccess`, with `mod_headers` on:

```apache
AddType text/javascript .js .mjs
Header always set Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
Header always set Referrer-Policy "no-referrer"
Header always set X-Content-Type-Options "nosniff"
Header always set Cross-Origin-Opener-Policy "same-origin"
Header always set Strict-Transport-Security "max-age=31536000"
Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"
```

### Local, with `tools/serve.py`

For trying Sealkey on your own computer. It needs Python 3 and nothing else.

1. Download or clone this repository, and open a terminal in its folder.
2. Run `python3 tools/serve.py 8000`. On Windows, use `py tools/serve.py 8000`.
3. Open <http://127.0.0.1:8000>.
4. Stop it with Ctrl+C.

It sends the same headers as `_headers` and turns off caching. It only listens on your own computer, so phones on your network can't reach it. To try Sealkey on a phone, deploy it to one of the hosts above.

### After deploying

- Open the site and lock and open a small file.
- In DevTools, the Network tab should show no requests while locking or opening.
- Check the headers at [securityheaders.com](https://securityheaders.com).

## Tests

```bash
node --test tests/*.test.mjs
python3 tools/serve.py 8600 &
python3 tests/e2e.py http://127.0.0.1:8600/
```

The Node tests cover key generation, the file format and the encryption, including damaged and changed files. `tests/e2e.py` drives the real app in Chromium with Playwright.

## How it works

The 6 words are picked with `crypto.getRandomValues` and rejection sampling from 7,772 words, giving about 77.5 bits. Argon2id (3 passes, 64 MiB, a new 16-byte salt per file) turns the key into a 32-byte encryption key. The file is then encrypted with libsodium's XChaCha20-Poly1305 secretstream in 1 MiB chunks, so every chunk is authenticated and any change, reordering or truncation is caught.

Encryption runs in a Web Worker. Chrome and Edge on a computer stream straight to disk. Other browsers build the result in memory and offer it only after the whole file has been checked.

| Browser | Saving | Size limit |
|---|---|---|
| Chrome, Edge on a computer | Streams to disk | About 10 GB |
| Firefox, Safari on a computer | In memory, then download | 1 GB |
| Phones and tablets | In memory, then download | 500 MB |

Several files or a folder are packed into an uncompressed ZIP inside the locked file, up to 10,000 files. Empty folders are not kept.

### Wordlist

The words come from the EFF Long Wordlist, with its 4 hyphenated words removed: `drop-down`, `felt-tip`, `t-shirt` and `yo-yo`. Keys use dashes, so a hyphenated word would read as two words when typed.

## File format

All numbers are little-endian.

| Bytes | Field |
|---|---|
| 4 | Magic `SEAL` |
| 1 | Format version, `1` |
| 1 | KDF, `1` = Argon2id |
| 4 | Argon2 passes |
| 4 | Argon2 memory in KiB |
| 4 | Chunk size in bytes |
| 16 | Salt |
| 24 | Secretstream header |

Then the secretstream messages:

1. **Metadata**, 512 bytes before encryption, tag MESSAGE, with the 58-byte header as associated data: content type at byte 0 (`1` one file, `2` ZIP bundle), file count at 1 (4 bytes), name length at 5 (2 bytes), UTF-8 name at 7 (up to 255 bytes), original size at 262 (8 bytes), zero padding.
2. **Data**, the file or ZIP in chunks of the stated size, tag MESSAGE.
3. The last data chunk has tag FINAL. An empty file is one empty FINAL chunk.

When opening, Sealkey refuses passes above 10, memory above 512 MiB and chunks above 16 MiB, and checks the file length against the metadata before saving anything.

## What it cannot protect against

- A hacked phone or computer
- Someone who gets both the file and the key
- A compromised website serving changed code
- A lost key

## Checking a release

Each release on GitHub lists a SHA-256 hash. To check that your copy matches, check out the release tag and run:

```bash
git archive --format=tar HEAD | sha256sum
```

The output should match the hash on the release page.

## Credits

- Wordlist by the Electronic Frontier Foundation, [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/). `tools/eff_large_wordlist.txt` is the unchanged original from eff.org, SHA-256 `addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e`. `js/words.js` is generated from it with `node tools/make-words.mjs`, which removes the 4 hyphenated words and checks that exactly 7,772 unique words remain.
- [libsodium.js](https://github.com/jedisct1/libsodium.js) 0.8.4 (`libsodium-wrappers-sumo`), ISC license, in `vendor/libsodium/`. The only change is the import path in `libsodium-wrappers.mjs`, so it loads the local `libsodium-sumo.mjs`.
- [client-zip](https://github.com/Touffy/client-zip) 2.5.1, MIT license, in `vendor/client-zip/`.
- Inter, Space Grotesk and JetBrains Mono fonts, SIL Open Font License 1.1, in `fonts/`.

## Need a custom website?

Sealkey is made by Ninth Life Labs. If you'd like a custom website or web app built for you, get in touch:

- Facebook: <https://www.facebook.com/profile.php?id=61596408329725>
- Email: team.ninthlifelabs@gmail.com

## License

MIT. See `LICENSE`.
