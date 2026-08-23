/* Скачивает зашифрованный файл, спрашивает пароль, расшифровывает в браузере.
   Формат: 'VELO1' | итерации (uint32 BE) | соль (16) | iv (12) | AES-256-GCM. */
(function () {
  var DATA_URL = "__DATA_URL__";
  var STORE_KEY = "track-vault-key";
  var gate = document.getElementById('tv-gate');
  var status = document.getElementById('tv-gateStatus');
  var cache = null;

  function say(text, isError) {
    status.textContent = text;
    status.className = isError ? 'status err' : 'status';
  }

  async function download() {
    if (cache) return cache;
    say('качаю данные…');
    var resp = await fetch(DATA_URL);
    if (!resp.ok) throw new Error('не скачалось: HTTP ' + resp.status);
    var total = +resp.headers.get('content-length') || 0;
    var reader = resp.body.getReader();
    var chunks = [], got = 0, chunk;
    while (!(chunk = await reader.read()).done) {
      chunks.push(chunk.value);
      got += chunk.value.length;
      say(total ? 'качаю данные… ' + Math.round(got / total * 100) + '%'
                : 'качаю данные… ' + Math.round(got / 1e6) + ' МБ');
    }
    var blob = new Uint8Array(got), at = 0;
    chunks.forEach(function (c) { blob.set(c, at); at += c.length; });
    cache = blob;
    return blob;
  }

  async function unpack(blob, keyBytes, password) {
    if (new TextDecoder().decode(blob.slice(0, 5)) !== 'VELO1') throw new Error('файл не тот');
    var iters = new DataView(blob.buffer, blob.byteOffset + 5, 4).getUint32(0);
    var salt = blob.slice(9, 25), iv = blob.slice(25, 37), cipher = blob.slice(37);
    if (!keyBytes) {
      say('проверяю пароль…');
      var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
                                               'PBKDF2', false, ['deriveBits']);
      keyBytes = new Uint8Array(await crypto.subtle.deriveBits(
        {name: 'PBKDF2', salt: salt, iterations: iters, hash: 'SHA-256'}, base, 256));
    }
    var key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    say('расшифровываю…');
    var packed = await crypto.subtle.decrypt({name: 'AES-GCM', iv: iv}, key, cipher);
    var stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return {text: await new Response(stream).text(), keyBytes: keyBytes};
  }

  async function open(password, keyBytes, remember) {
    var res = await unpack(await download(), keyBytes, password);
    if (remember) {
      localStorage.setItem(STORE_KEY, btoa(String.fromCharCode.apply(null, res.keyBytes)));
    }
    window.VELO_DATA = JSON.parse(res.text);
    gate.remove();
    window.__bootMap();
  }

  document.getElementById('tv-gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = document.getElementById('tv-pw').value;
    if (!pw) return;
    open(pw, null, document.getElementById('tv-remember').checked).catch(function (err) {
      var wrongPassword = err.name === 'OperationError' || /decrypt/i.test(String(err.message || err));
      say(wrongPassword ? 'пароль не подошёл' : 'ошибка: ' + (err.message || err), true);
    });
  });

  var saved = localStorage.getItem(STORE_KEY);
  if (saved) {
    var bytes = Uint8Array.from(atob(saved), function (c) { return c.charCodeAt(0); });
    open(null, bytes, false).catch(function () {
      localStorage.removeItem(STORE_KEY);
      say('сохранённый ключ не подошёл, введи пароль', true);
    });
  } else {
    document.getElementById('tv-pw').focus();
  }
})();
