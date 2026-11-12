import base64
import hashlib
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

os.environ['NO_PROXY'] = '*'
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8600/'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp())
WORK = pathlib.Path(tempfile.mkdtemp())
MIB = 1048576
results = [0, 0]

MOCK_STREAM = """
window.__saved = null;
window.showSaveFilePicker = async ({ suggestedName }) => ({
    createWritable: async () => {
        const parts = [];
        window.__saved = { name: suggestedName, closed: false, aborted: false };
        return {
            write: async (data) => { parts.push(new Uint8Array(data)); },
            close: async () => {
                window.__saved.closed = true;
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob(parts));
                a.download = suggestedName;
                document.body.appendChild(a);
                a.click();
                a.remove();
            },
            abort: async () => { window.__saved.aborted = true; parts.length = 0; },
        };
    },
});
"""
NO_STREAM = "delete window.showSaveFilePicker;"


def check(name, ok, info=''):
    results[0 if ok else 1] += 1
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'  {info}'), flush=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class App:
    def __init__(self, browser, mode, **ctx):
        self.mode = mode
        self.context = browser.new_context(accept_downloads=True, **ctx)
        self.context.add_init_script(MOCK_STREAM if mode == 'stream' else NO_STREAM)
        self.page = self.context.new_page()
        self.console = []
        self.requests = []
        self.page.on('console', lambda m: self.console.append(m.text) if m.type in ('error', 'warning') else None)
        self.page.on('pageerror', lambda e: self.console.append('PAGEERROR ' + str(e)))
        self.page.on('request', lambda r: self.requests.append(r.url))
        self.page.on('dialog', lambda d: d.accept())
        self.page.goto(BASE)
        self.page.wait_for_selector('#home-title')

    def leave_if_asked(self):
        self.page.wait_for_timeout(50)
        if self.page.is_visible('#ask'):
            self.page.click('#ask-leave')

    def home(self):
        self.page.click('.brand')
        self.leave_if_asked()
        self.page.wait_for_selector('#view-home:not([hidden])')

    def lock(self, files=None, folder=None, save=True):
        p = self.page
        self.home()
        p.click('[data-go="lock"]')
        if folder:
            p.set_input_files('#lock-folder', str(folder))
        if files:
            for group in files:
                p.set_input_files('#lock-files', group)
        p.click('#lock-btn')
        p.wait_for_selector('[data-step="save"]:not([hidden]), #lock-alert:not([hidden])', timeout=60000)
        if not p.is_visible('[data-step="save"]'):
            return None, p.inner_text('#lock-alert')
        if not save:
            return None, None
        with p.expect_download(timeout=300000) as download:
            p.click('#lock-save-btn')
        target = WORK / download.value.suggested_filename
        download.value.save_as(target)
        p.wait_for_selector('[data-step="key"]:not([hidden])')
        words = p.locator('#lock-key .key-word').all_inner_texts()
        return target, '-'.join(words)

    def finish_lock(self):
        self.page.check('#key-saved')
        self.page.click('#lock-finish')
        self.page.wait_for_selector('#view-home:not([hidden])')

    def open(self, path, key, save=True):
        p = self.page
        self.home()
        p.click('[data-go="open"]')
        p.set_input_files('#open-file', str(path))
        p.wait_for_selector('#view-open [data-step="key"]:not([hidden]), #open-alert:not([hidden])')
        if p.is_visible('#open-alert'):
            return None, p.inner_text('#open-alert')
        p.fill('#open-key', key)
        p.click('#open-form button[type=submit]')
        p.wait_for_selector('#view-open [data-step="ready"]:not([hidden]), #open-alert:not([hidden]), #open-hint.bad', timeout=60000)
        if p.is_visible('#open-alert'):
            return None, p.inner_text('#open-alert')
        if p.is_visible('#open-hint.bad'):
            return None, p.inner_text('#open-hint')
        if not save:
            return None, p.inner_text('#open-out-name')
        try:
            with p.expect_download(timeout=300000) as download:
                p.click('#open-save-btn')
            target = WORK / ('opened-' + download.value.suggested_filename)
            download.value.save_as(target)
        except Exception:
            p.wait_for_selector('#open-alert:not([hidden])', timeout=60000)
            return None, p.inner_text('#open-alert')
        p.wait_for_selector('[data-step="done"]:not([hidden])')
        return target, download.value.suggested_filename

    def open_hat(self, path, password, via_open=False):
        p = self.page
        self.home()
        p.click('[data-go="open"]')
        if via_open:
            p.set_input_files('#open-file', str(path))
        else:
            p.click('[data-go="hat"]')
            p.set_input_files('#hat-file', str(path))
        p.wait_for_selector('#view-hat [data-step="key"]:not([hidden]), #view-hat [data-step="keys"]:not([hidden]), #hat-alert:not([hidden])')
        if not (p.is_visible('#view-hat [data-step="key"]') or p.is_visible('#view-hat [data-step="keys"]')):
            return None, p.inner_text('#hat-alert')
        note = p.inner_text('#hat-alert') if p.is_visible('#hat-alert') else ''
        if isinstance(password, tuple):
            p.fill('#hat-private', password[0])
            p.fill('#hat-sender', password[1])
            p.click('#hat-keys-form button[type=submit]')
        else:
            p.fill('#hat-password', password)
            p.click('#hat-form button[type=submit]')
        p.wait_for_selector('#view-hat [data-step="ready"]:not([hidden]), #hat-alert:not([hidden]), #hat-hint.bad, #hat-keys-hint.bad', timeout=60000)
        if p.is_visible('#hat-hint.bad'):
            return None, p.inner_text('#hat-hint')
        if p.is_visible('#hat-keys-hint.bad'):
            return None, p.inner_text('#hat-keys-hint')
        if not p.is_visible('#view-hat [data-step="ready"]'):
            return None, p.inner_text('#hat-alert')
        with p.expect_download(timeout=300000) as download:
            p.click('#hat-save-btn')
        target = WORK / ('hat-' + download.value.suggested_filename)
        download.value.save_as(target)
        p.wait_for_selector('#view-hat [data-step="done"]:not([hidden])')
        return target, note or download.value.suggested_filename

    def close(self):
        self.context.close()


def make(name, size):
    path = WORK / 'src' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(os.urandom(size))
    return path


def run_sizes(app, sizes, label):
    for size in sizes:
        src = make(f'size-{size}.bin', size)
        sealed, key = app.lock(files=[str(src)])
        opened, name = app.open(sealed, key)
        ok = opened is not None and sha(opened.read_bytes()) == sha(src.read_bytes()) and name == src.name
        expected_len = 58 + 529 + size + 17 * max(1, -(-size // MIB))
        check(f'{label}: {size:,} bytes round trip', ok and sealed.stat().st_size == expected_len, (name, sealed.stat().st_size if sealed else None))


def build_tree():
    root = WORK / 'tree' / 'Trip'
    files = {
        'Day 1/beach.bin': os.urandom(300000),
        'Day 1/日本語 ñ 😀.txt': 'unicode'.encode(),
        'Day 2/empty.txt': b'',
        'Day 2/' + 'very long name ' * 12 + '.txt': b'long',
        '.hidden': b'secret',
        'notes.txt': os.urandom(MIB + 5),
    }
    for rel, data in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return root, files


def clean(rel):
    parts = []
    for part in rel.split('/'):
        part = part.lstrip('. ').rstrip('. ')
        parts.append(part[:200])
    return '/'.join(parts)


def verify_zip(path, expected):
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        names = {i.filename: z.read(i.filename) for i in z.infolist() if not i.is_dir()}
    seven = subprocess.run(['7z', 't', str(path)], capture_output=True, text=True).returncode == 0
    unz = subprocess.run(['unzip', '-tq', str(path)], capture_output=True, text=True).returncode == 0
    same = {k: sha(v) for k, v in names.items()} == {k: sha(v) for k, v in expected.items()}
    return bad is None and seven and unz and same, (bad, seven, unz, sorted(names)[:8], sorted(expected)[:8])


def attacks(app, sealed, key, label):
    data = sealed.read_bytes()
    start = 58 + 529
    chunk = MIB + 17

    def variant(name, blob):
        path = WORK / f'attack-{name}.seal'
        path.write_bytes(blob)
        return path

    def flip(at):
        copy = bytearray(data)
        copy[at] ^= 1
        return bytes(copy)

    def set32(offset, value):
        copy = bytearray(data)
        copy[offset:offset + 4] = value.to_bytes(4, 'little')
        return bytes(copy)

    cases = [
        ('cut at chunk boundary', data[:start + chunk], 'incomplete'),
        ('cut mid chunk', data[:start + chunk + 500], 'incomplete'),
        ('flip in header salt', flip(20), 'Wrong key'),
        ('flip in metadata', flip(60), 'Wrong key'),
        ('flip in middle chunk', flip(start + chunk + 99), 'damaged'),
        ('flip in last chunk', flip(len(data) - 5), 'damaged'),
        ('chunks swapped', data[:start] + data[start + chunk:start + 2 * chunk] + data[start:start + chunk] + data[start + 2 * chunk:], 'damaged'),
        ('chunk removed', data[:start + chunk] + data[start + 2 * chunk:], 'incomplete'),
        ('extra bytes after final', data + b'x', 'was changed'),
        ('huge Argon2 memory', set32(10, 1048576), "can't be opened safely"),
        ('huge passes', set32(6, 99), "can't be opened safely"),
        ('huge chunk size', set32(14, 1 << 30), "can't be opened safely"),
        ('newer version', data[:4] + bytes([2]) + data[5:], 'newer version'),
        ('photo instead of locked file', b'\xff\xd8\xff\xe0' + os.urandom(4000), "isn't a locked file"),
    ]
    for name, blob, expect in cases:
        opened, text = app.open(variant(name.replace(' ', '-'), blob), key)
        check(f'{label}: {name}', opened is None and text is not None and expect.lower() in text.lower(), text)
    opened, text = app.open(sealed, 'tiger-mango-velvet-cloud-pebble-walnut')
    check(f'{label}: wrong key', opened is None and 'Wrong key' in text, text)
    for typed, expect in [
        (key.upper().replace('-', '   '), None),
        (' - '.join(key.split('-')[:5]), 'should be 6 words'),
        (key + '-zoom', 'should be 6 words'),
        (key[:-1] + 'q', 'should be 6 words'),
    ]:
        opened, text = app.open(sealed, typed, save=False)
        if expect is None:
            check(f'{label}: key typed with capitals and spaces', opened is None and text == sealed.name.replace('.seal', '') or text == 'attack-source.bin', text)
        else:
            check(f'{label}: rejects "{typed[-20:]}"', expect in (text or ''), text)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--no-proxy-server'])
        for mode in ['stream', 'memory']:
            app = App(browser, mode)
            label = f'chromium-{mode}'
            check(f'{label}: save method detected', app.page.evaluate('document.documentElement.dataset.save') == mode)
            app.page.wait_for_load_state('networkidle')
            loaded = len(app.requests)
            run_sizes(app, [0, 1, MIB - 1, MIB, MIB + 1, 2 * MIB, 100_000_000], label)

            root, files = build_tree()
            sealed, key = app.lock(folder=root)
            opened, name = app.open(sealed, key)
            expected = {'Trip/' + clean(k): v for k, v in files.items()}
            ok, info = verify_zip(opened, expected) if opened else (False, name)
            check(f'{label}: folder bundle opens in zipfile, 7-Zip and unzip with matching hashes', ok and name == 'Trip.zip', (name, info))

            a = make('dupe/report.pdf', 1000)
            b = make('dupe2/report.pdf', 2000)
            c = make('loose.txt', 10)
            sealed, key = app.lock(files=[[str(a), str(c)], [str(b)]])
            opened, name = app.open(sealed, key)
            ok, info = verify_zip(opened, {'report.pdf': a.read_bytes(), 'loose.txt': c.read_bytes(), 'report (1).pdf': b.read_bytes()}) if opened else (False, name)
            check(f'{label}: duplicate names become name (1).ext', ok and name.startswith('files-') and name.endswith('.zip'), (name, info))

            src = make('attack-source.bin', 3 * MIB + 77)
            sealed, key = app.lock(files=[str(src)])
            attacks(app, sealed, key, label)
            check(f'{label}: no network requests while locking and opening', all(u.startswith(('blob:', 'data:')) for u in app.requests[loaded:]), [u for u in app.requests[loaded:] if not u.startswith('blob:')][:5])

            app.page.goto(BASE)
            app.page.click('[data-go="lock"]')
            app.page.set_input_files('#lock-files', str(make('cancel.bin', 200_000_000)))
            app.page.click('#lock-btn')
            app.page.wait_for_selector('[data-step="save"]:not([hidden])', timeout=60000)
            downloads = []
            app.page.on('download', lambda d: downloads.append(d))
            app.page.click('#lock-save-btn')
            app.page.wait_for_selector('#view-lock [data-step="progress"]:not([hidden])')
            for _ in range(600):
                if app.page.evaluate("document.getElementById('lock-bar').value") >= 5:
                    break
                app.page.wait_for_timeout(100)
            app.page.click('#view-lock [data-step="progress"] [data-cancel]')
            app.page.wait_for_timeout(1500)
            aborted = app.page.evaluate('window.__saved ? window.__saved.aborted : null')
            check(f'{label}: cancel while locking saves nothing', not downloads and 'Cancelled' in app.page.inner_text('#lock-alert') and (mode == 'memory' or aborted is True), (downloads, aborted))

            gone = make('gone.bin', 5 * MIB)
            app.page.goto(BASE)
            app.page.click('[data-go="lock"]')
            app.page.set_input_files('#lock-files', str(gone))
            app.page.set_input_files('#lock-files', str(make('stay.bin', 10)))
            gone.unlink()
            app.page.click('#lock-btn')
            app.page.wait_for_selector('[data-step="save"]:not([hidden])', timeout=60000)
            app.page.click('#lock-save-btn')
            app.page.wait_for_selector('#lock-alert:not([hidden])', timeout=60000)
            text = app.page.inner_text('#lock-alert')
            check(f'{label}: deleted file stops the job', "couldn't read" in text and 'gone.bin' in text and 'Nothing was saved' in text, text)

            check(f'{label}: no console errors or CSP violations', not app.console, app.console[:5])
            app.close()

        app = App(browser, 'stream')
        src = make('keycheck.bin', 1000)
        sealed, key = app.lock(files=[str(src)])
        app.page.screenshot(path=str(OUT / 'desktop-key.png'), full_page=True)
        app.finish_lock()
        html = app.page.content()
        check('key is gone from the page after Done', not any(w in html for w in key.split('-') if len(w) > 3), key)
        opened, name = app.open(sealed, key)
        check('key field is empty after opening', app.page.input_value('#open-key') == '')
        app.page.goto(BASE)
        app.page.click('[data-go="lock"]')
        many = [{'name': f'f{i}.txt', 'mimeType': 'text/plain', 'buffer': str(i).encode()} for i in range(10001)]
        app.page.set_input_files('#lock-files', many)
        check('10,001 files shows the limit message', '10,000 files' in app.page.inner_text('#lock-alert'))
        sealed, key = app.lock(files=[many[:10000]])
        opened, name = app.open(sealed, key)
        with zipfile.ZipFile(opened) as z:
            count = len(z.infolist())
            sample = z.read('f9999.txt')
        check('10,000 small files lock and open', count == 10000 and sample == b'9999', count)
        app.close()

        phone = App(browser, 'phone', viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2,
                    user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
        p = phone.page
        overflow = "() => document.documentElement.scrollWidth <= innerWidth"
        small = """() => [...document.querySelectorAll('button, a, input:not([type=file]), summary')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 44 && !e.closest('.footer') && !e.closest('p') && e.type !== 'checkbox').map(e => e.textContent.trim() + ':' + Math.round(e.getBoundingClientRect().height))"""
        check('phone: memory save method and folder button hidden', p.evaluate('document.documentElement.dataset.save') == 'memory' and not p.is_visible('#lock-folder-btn') if p.click('[data-go="lock"]') is None else False)
        p.screenshot(path=str(OUT / 'phone-lock-pick.png'), full_page=True)
        phone.home()
        p.screenshot(path=str(OUT / 'phone-home.png'), full_page=True)
        check('phone home: no sideways scroll, tap targets', p.evaluate(overflow) and not p.evaluate(small), p.evaluate(small))
        src = make('phone.bin', 3 * MIB)
        sealed, key = phone.lock(files=[[str(src), str(make('phone2.txt', 50))]])
        check('phone key screen: no sideways scroll, tap targets', p.evaluate(overflow) and not p.evaluate(small), p.evaluate(small))
        p.screenshot(path=str(OUT / 'phone-key.png'), full_page=True)
        phone.finish_lock()
        opened, name = phone.open(sealed, key, save=False)
        check('phone open screen: no sideways scroll, tap targets', p.evaluate(overflow) and not p.evaluate(small), p.evaluate(small))
        p.screenshot(path=str(OUT / 'phone-ready.png'), full_page=True)
        phone.close()

        desk = App(browser, 'stream', viewport={'width': 1280, 'height': 800})
        desk.page.screenshot(path=str(OUT / 'desktop-home.png'), full_page=True)
        desk.page.click('[data-go="lock"]')
        root, _ = build_tree()
        desk.page.set_input_files('#lock-folder', str(root))
        desk.page.screenshot(path=str(OUT / 'desktop-lock-list.png'), full_page=True)
        desk.close()

        off = App(browser, 'stream')
        p = off.page
        p.goto(BASE + '?offline')
        p.evaluate('navigator.serviceWorker.ready.then(() => true)')
        p.reload()
        p.wait_for_selector('#home-title')
        cdp = off.context.new_cdp_session(p)
        manifest = cdp.send('Page.getAppManifest')
        check('offline: manifest loads with no errors', manifest.get('url', '').endswith('manifest.webmanifest') and not manifest.get('errors'), manifest.get('errors'))
        check('offline: service worker controls the page', p.evaluate('!!navigator.serviceWorker.controller'))
        off.context.set_offline(True)
        p.reload()
        p.wait_for_selector('#home-title')
        src = make('offline.txt', 5000)
        sealed, key = off.lock(files=[[str(src)]])
        off.finish_lock()
        opened, name = off.open(sealed, key)
        check('offline: app loads, locks and opens with no network', bool(opened) and opened.read_bytes() == src.read_bytes(), name)
        check('offline: no console errors', not off.console, off.console[:5])
        off.close()

        hatdir = pathlib.Path(tempfile.mkdtemp())
        subprocess.run(['node', str(pathlib.Path(__file__).resolve().parent / 'make-hat-files.mjs'), str(hatdir)], check=True, capture_output=True)
        small = (hatdir / 'plain-small.txt').read_bytes()
        for mode in ['stream', 'memory']:
            app = App(browser, mode)
            label = f'hat.sh-{mode}'
            opened, name = app.open_hat(hatdir / 'notes.txt.enc', 'hat password')
            check(f'{label}: v2 file opens with the right name and content', bool(opened) and opened.read_bytes() == small and name == 'notes.txt', name)
            opened, info = app.open_hat(hatdir / 'notes.txt.enc', 'Hat password')
            check(f'{label}: wrong password is caught', opened is None and 'Wrong password' in info, info)
            for old in ['Encrypted-old.txt', 'Encrypted-older.txt']:
                opened, name = app.open_hat(hatdir / old, 'old password')
                check(f'{label}: v1 file {old} opens', bool(opened) and opened.read_bytes() == small and name == old.replace('Encrypted-', ''), name)
            if mode == 'stream':
                opened, name = app.open_hat(hatdir / 'big.bin.enc', 'hat password')
                check(f'{label}: v2 file over one 64 MiB chunk opens', bool(opened) and sha(opened.read_bytes()) == sha((hatdir / 'plain-big.bin').read_bytes()), name)
            keyfile = lambda name: (hatdir / name).read_text().strip()
            opened, name = app.open_hat(hatdir / 'shared.txt.enc', (keyfile('receiver-private.txt'), keyfile('sender-public.txt')))
            check(f'{label}: hat.sh key-pair file opens', bool(opened) and opened.read_bytes() == small and name == 'shared.txt', name)
            _, info = app.open_hat(hatdir / 'shared.txt.enc', (keyfile('receiver-private.txt'), keyfile('receiver-public.txt')))
            check(f'{label}: own public key is caught', 'your own public key' in info, info)
            _, info = app.open_hat(hatdir / 'shared.txt.enc', (keyfile('sender-public.txt'), keyfile('receiver-public.txt')))
            check(f'{label}: wrong hat.sh keys are caught', "don't open this file" in info, info)
            _, info = app.open_hat(hatdir / 'plain-small.txt', 'x')
            check(f'{label}: a non-hat.sh file is refused', "isn't a hat.sh file" in info, info)
            sealed, key = app.lock(files=[[str(make('for-hat.txt', 100))]])
            app.finish_lock()
            _, info = app.open_hat(sealed, 'x')
            check(f'{label}: a Sealkey file points to the right screen', 'This is a Sealkey file' in info, info)
            opened, note = app.open_hat(hatdir / 'notes.txt.enc', 'hat password', via_open=True)
            check(f'{label}: a hat.sh file dropped on Open is sent to the hat.sh screen', bool(opened) and 'made with hat.sh' in note, note)
            check(f'{label}: no console errors', not app.console, app.console[:5])
            app.close()
        shutil.rmtree(hatdir, ignore_errors=True)

        app = App(browser, 'stream')
        p = app.page
        native = []
        p.on('dialog', lambda d: native.append(d.message))

        def prompts(action):
            action()
            p.wait_for_timeout(300)
            if not p.is_visible('#ask'):
                return []
            title = p.inner_text('#ask-title')
            p.click('#ask-leave')
            p.wait_for_timeout(100)
            return [title]

        app.home()
        p.click('[data-go="lock"]')
        p.set_input_files('#lock-files', str(make('warn.txt', 100)))
        p.click('#lock-btn')
        p.wait_for_selector('[data-step="save"]:not([hidden])', timeout=60000)
        got = prompts(lambda: p.click('[data-tab="open"]'))
        check('warnings: leaving before saving asks once to stop the job', len(got) == 1 and 'Stop and leave' in got[0], got)
        got = prompts(lambda: p.click('[data-tab="lock"]'))
        check('warnings: coming back to Lock after discarding asks nothing', got == [], got)
        p.set_input_files('#lock-files', str(make('warn2.txt', 100)))
        p.click('#lock-btn')
        p.wait_for_selector('[data-step="save"]:not([hidden])', timeout=60000)
        with p.expect_download(timeout=60000):
            p.click('#lock-save-btn')
        p.wait_for_selector('#view-lock [data-step="key"]:not([hidden])')
        got = prompts(lambda: p.click('[data-tab="open"]'))
        check('warnings: leaving a key on screen asks once', len(got) == 1 and 'without your key' in got[0], got)
        got = prompts(lambda: p.click('[data-tab="lock"]'))
        check('warnings: after leaving the key, Lock asks nothing', got == [], got)
        p.set_input_files('#lock-files', str(make('warn3.txt', 100)))
        p.click('#lock-btn')
        p.wait_for_selector('[data-step="save"]:not([hidden])', timeout=60000)
        with p.expect_download(timeout=60000):
            p.click('#lock-save-btn')
        p.wait_for_selector('#view-lock [data-step="key"]:not([hidden])')
        p.check('#key-saved')
        got = prompts(lambda: p.click('[data-tab="open"]'))
        check('warnings: a key marked as saved leaves without asking', got == [], got)
        p.click('[data-tab="keys"]')
        p.click('#keys-make')
        p.wait_for_selector('#keys-secret li', timeout=60000)
        got = prompts(lambda: p.click('[data-tab="lock"]'))
        check('warnings: leaving the 12 words asks once', len(got) == 1 and '12 words' in got[0], got)
        got = prompts(lambda: p.click('[data-tab="open"]'))
        check('warnings: after leaving the 12 words, nothing else asks', got == [], got)
        p.click('[data-tab="keys"]')
        check('warnings: My key starts fresh with no words left on the page', p.is_visible('#keys-make') and p.locator('#keys-secret li').count() == 0)
        p.click('#keys-make')
        p.wait_for_selector('#keys-secret li', timeout=60000)
        p.click('[data-tab="lock"]')
        p.wait_for_selector('#ask', state='visible')
        p.keyboard.press('Escape')
        p.wait_for_timeout(200)
        check('warnings: Esc on the dialog keeps you on the page', not p.is_visible('#ask') and p.is_visible('#keys-secret'))
        p.click('[data-tab="lock"]')
        p.wait_for_selector('#ask', state='visible')
        focused = p.evaluate('document.activeElement.id')
        p.click('#ask-stay')
        p.wait_for_timeout(200)
        check('warnings: the safe button has focus and keeps you on the page', focused == 'ask-stay' and p.is_visible('#keys-secret'), focused)
        check('warnings: no browser popups are used', native == [], native)
        app.close()

        for mode in ['stream', 'memory']:
            app = App(browser, mode)
            p = app.page
            label = f'key pair-{mode}'
            app.home()
            p.click('[data-go="keys"]')
            p.click('#keys-make')
            p.wait_for_selector('#keys-secret li', timeout=60000)
            secret = p.locator('#keys-secret .key-word').all_inner_texts()
            check(f'{label}: 12 secret words are shown', len(secret) == 12, secret)
            check(f'{label}: public key waits for the saved tick', p.is_disabled('#keys-next'))
            p.check('#keys-saved')
            p.click('#keys-next')
            pub = p.inner_text('#keys-public')
            fp = p.locator('#keys-fp .key-word').all_inner_texts()
            check(f'{label}: public key and 6-word fingerprint shown', pub.startswith('sealkey-pub-') and len(fp) == 6, (pub, fp))
            app.home()
            p.click('[data-go="lock"]')
            src = make('for-key.bin', 3 * MIB)
            p.set_input_files('#lock-files', str(src))
            p.check('input[name="lock-method"][value="public"]')
            p.fill('#lock-public-key', pub[:-2] + ('A' if pub[-2] != 'A' else 'B') + pub[-1])
            p.wait_for_selector('#lock-public-hint.bad')
            check(f'{label}: a mistyped public key is caught', p.is_disabled('#lock-btn'))
            p.fill('#lock-public-key', pub)
            p.wait_for_selector('#lock-fp li')
            check(f'{label}: sender sees the same fingerprint', p.locator('#lock-fp .key-word').all_inner_texts() == fp)
            check(f'{label}: lock waits for the fingerprint tick', p.is_disabled('#lock-btn'))
            p.check('#lock-fp-checked')
            p.click('#lock-btn')
            p.wait_for_selector('[data-step="save"]:not([hidden])', timeout=60000)
            with p.expect_download(timeout=300000) as download:
                p.click('#lock-save-btn')
            sealed = WORK / ('key-' + download.value.suggested_filename)
            download.value.save_as(sealed)
            p.wait_for_selector('#view-lock [data-step="sent"]:not([hidden])')
            check(f'{label}: no 6-word key is shown for a public-key file', not p.is_visible('#lock-key li'))
            p.click('#lock-sent-done')
            opened, info = app.open(sealed, ' '.join(reversed(secret)))
            check(f'{label}: wrong 12 words are caught', opened is None and "don't open this file" in info, info)
            opened, name = app.open(sealed, '-'.join(secret).upper())
            check(f'{label}: file locked for the public key opens with the 12 words', bool(opened) and sha(opened.read_bytes()) == sha(src.read_bytes()), name)
            app.home()
            p.click('[data-go="keys"]')
            p.fill('#keys-words', ' '.join(secret))
            p.click('#keys-form button[type=submit]')
            p.wait_for_selector('#view-keys [data-step="public"]:not([hidden])', timeout=60000)
            check(f'{label}: the same words give the same public key', p.inner_text('#keys-public') == pub)
            check(f'{label}: no console errors', not app.console, app.console[:5])
            app.close()
        browser.close()
    shutil.rmtree(WORK, ignore_errors=True)
    print(f'{results[0]} passed, {results[1]} failed')
    sys.exit(1 if results[1] else 0)


main()
