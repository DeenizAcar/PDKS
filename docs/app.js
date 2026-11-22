'use strict';
/* PDKS - Personel Devam Kontrol Sistemi */

const ADMIN_CARD = '044708527E4480';
const IGNORE_MS = 5000;          // aynı kart 5 sn içinde tekrar okunursa dikkate alma
const RECENT_MS = 5 * 60 * 1000; // 5 dk içinde tekrar okuma -> "yakın zamanda yapıldı"
const OK_MS = 3000, BAD_MS = 5000, DUP_MS = 3000, PANEL_MS = 5000;
const GIRIS = 'GİRİŞ', CIKIS = 'ÇIKIŞ';

const $ = (id) => document.getElementById(id);
const isNative = !!(window.Android && window.Android.isNfcEnabled);

/* ---------- Depolama ---------- */
function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
let cards = load('pdks_cards', {});          // { kartNo: "Ad Soyad" }
let records = load('pdks_records', []);      // [{id, uid, name, date:'YYYY-MM-DD', time:'HH:MM:SS', type}]
let settings = Object.assign({ voice: false, voiceTime: false }, load('pdks_settings', {}));
let lastOk = load('pdks_lastok', {});         // { kartNo: {ts, type} } son başarılı giriş/çıkış
let unknownState = load('pdks_unknown', {});  // { kartNo: {date, ts, type} } tanımsız kartlar için
const lastSeen = {};                           // { kartNo: ts } 5 sn yok sayma için son dikkate alınan okuma

/* ---------- Yardımcılar ---------- */
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const hm = (t) => t.slice(0, 5);
const trDate = (s) => s.split('-').reverse().join('.');
const upper = (s) => s.toLocaleUpperCase('tr-TR');
const normUid = (s) => String(s || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uidName = (uid) => cards[uid] || (records.find((r) => r.uid === uid) || {}).name || uid;
const typeOrder = (t) => (t === GIRIS ? 0 : 1);
const sortRecs = (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || typeOrder(a.type) - typeOrder(b.type);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function toast(msg, ms = 2500) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- Ses ---------- */
function speak(text) {
  if (!text) return;
  if (window.Android && window.Android.speak) { window.Android.speak(text); return; }
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'tr-TR';
  u.rate = 1.6;
  const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().startsWith('tr'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

/* ---------- Ekran yönetimi ---------- */
let screen = 'main';
function go(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('scr-' + name).classList.add('active');
  screen = name;
  hidePanel();
  closeModal();
  if (name === 'tanimlar') renderCards();
  if (name === 'hareketler') openHareketler();
  if (name === 'ayarlar') renderSettings();
}
document.querySelectorAll('.back').forEach((b) => b.addEventListener('click', () => go('main')));
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// Android geri tuşu
window.handleBack = function () {
  if (!$('modal').classList.contains('hidden')) { closeModal(); return true; }
  if (screen !== 'main') { go('main'); return true; }
  return false;
};

/* ---------- Üst panel ---------- */
function showPanel() {
  $('panel').classList.add('show');
  clearTimeout(showPanel.h);
  showPanel.h = setTimeout(hidePanel, PANEL_MS);
}
function hidePanel() { clearTimeout(showPanel.h); $('panel').classList.remove('show'); }

/* ---------- NFC durumu ---------- */
let nfcOn = false;
function setNfcState(on) {
  nfcOn = !!on;
  $('idle').classList.toggle('off', !nfcOn);
  $('nfcIcon').classList.toggle('off', !nfcOn);
  if (nfcOn) {
    $('stTitle').textContent = 'Kartınızı okutmanız için bekleniyor...';
    $('stSub').textContent = 'Personel kartınızı telefonun arkasına yaklaştırınız.';
    $('tnTitle').textContent = 'Tanımlamak istediğiniz kartı okutunuz...';
  } else {
    $('stTitle').textContent = 'Telefonun kart okuma özelliği kapalı...';
    $('stSub').textContent = 'Kart okuma özelliğinin kapalı olduğunu yetkiliye haber veriniz.';
    $('tnTitle').textContent = 'Telefonun kart okuma özelliği kapalı...';
  }
  document.querySelector('#scr-tanimlar .tip').classList.toggle('off', !nfcOn);
  $('nfcOrb').classList.toggle('off', !nfcOn);
}

// Tanımlar ekranındaki NFC simgesi: tıklanınca NFC aç/kapat
$('nfcToggle').addEventListener('click', () => {
  if (isNative && window.Android.toggleNfc) {
    window.Android.toggleNfc();
  } else if ('NDEFReader' in window) {
    if (webScanning) { stopWebNfc(); toast('Kart okuma durduruldu.'); }
    else startWebNfc(true);
  } else {
    toast('Bu tarayıcıda NFC desteklenmiyor.');
  }
});

/* ---------- Sonuç gösterimi ---------- */
const ICON_OK = '<svg viewBox="0 0 100 100"><path d="M18 52 L40 74 L84 26" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_BAD = '<svg viewBox="0 0 100 100"><path d="M22 22 L78 78 M78 22 L22 78" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round"/></svg>';
const ICON_DUP = '<svg viewBox="0 0 100 100"><path d="M32 34 a18 18 0 1 1 26 16 c-6 3 -8 7 -8 14" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><circle cx="50" cy="84" r="6.5" fill="currentColor"/></svg>';

function showResult(kind, { name = '', inner = '', below = '' }, ms) {
  const r = $('result');
  r.className = 'result ' + kind;
  void r.offsetWidth; // animasyonu yeniden başlat
  $('rName').textContent = name;
  $('rIcon').innerHTML = kind === 'ok' ? ICON_OK : kind === 'bad' ? ICON_BAD : ICON_DUP;
  $('rInner').innerHTML = inner;
  $('rBelow').textContent = below;
  $('idle').classList.add('hidden');
  clearTimeout(showResult.h);
  showResult.h = setTimeout(clearResult, ms);
}
function clearResult() {
  clearTimeout(showResult.h);
  $('result').className = 'result hidden';
  $('idle').classList.remove('hidden');
}

/* ---------- Kart okuma ---------- */
function onCard(raw) {
  if (document.hidden) return; // uygulama arka plandayken kart okuma yapma
  const uid = normUid(raw);
  if (!uid) return;

  // Yönetici kartı: hiçbir kontrol yapma, sadece paneli göster
  if (uid === ADMIN_CARD) {
    if (screen === 'main') showPanel();
    else if (screen === 'tanimlar') toast('Yönetici kartı tanımlanamaz.');
    return;
  }

  const now = Date.now();
  if (lastSeen[uid] && now - lastSeen[uid] < IGNORE_MS) return; // 5 sn içinde tekrar -> yok say
  lastSeen[uid] = now;

  if (screen === 'tanimlar') { defineCard(uid); return; }
  if (screen !== 'main') return;

  if (cards[uid]) processKnown(uid, now); else processUnknown(uid, now);
}

function nextTypeFor(uid, today) {
  const todays = records.filter((r) => r.uid === uid && r.date === today).sort(sortRecs);
  const last = todays[todays.length - 1];
  return !last || last.type === CIKIS ? GIRIS : CIKIS;
}

function processKnown(uid, now) {
  const d = new Date(now), today = dateStr(d);
  const name = cards[uid];
  const lo = lastOk[uid];

  // Son başarılı okutmadan bu yana 5 dk geçmediyse (aynı gün)
  if (lo && now - lo.ts < RECENT_MS && dateStr(new Date(lo.ts)) === today) {
    const t = lo.type === GIRIS ? 'Giriş' : 'Çıkış';
    showResult('dup', { name: upper(name), below: `${t} işleminiz yakın zamanda zaten yapıldı.` }, DUP_MS);
    if (settings.voice) speak(`${name}. ${t} işleminiz yakın zamanda zaten yapıldı.`);
    return;
  }

  const type = nextTypeFor(uid, today);
  const time = timeStr(d);
  records.push({ id: newId(), uid, name, date: today, time, type });
  save('pdks_records', records);
  lastOk[uid] = { ts: now, type };
  save('pdks_lastok', lastOk);

  const msg = type === GIRIS ? 'GİRİŞİNİZ BAŞARI İLE YAPILDI' : 'ÇIKIŞINIZ BAŞARI İLE YAPILDI';
  showResult('ok', { name: upper(name), inner: `Kart okutma işleminiz tamamlandı...<br>${msg} : ${hm(time)}` }, OK_MS);
  if (settings.voice) speak(settings.voiceTime ? `${name}. Saat ${hm(time)}` : name);
}

function processUnknown(uid, now) {
  const today = dateStr(new Date(now));
  let st = unknownState[uid];
  let type;
  if (!st || st.date !== today) type = GIRIS;
  else if (now - st.ts < RECENT_MS) type = st.type;     // 5 dk içinde: aynı işlem
  else type = st.type === GIRIS ? CIKIS : GIRIS;
  if (!st || st.date !== today || now - st.ts >= RECENT_MS) {
    unknownState[uid] = { date: today, ts: now, type };
    save('pdks_unknown', unknownState);
  }
  showResult('bad', {
    inner: 'Kart okutma işleminiz tamamlanamadı.',
    below: type === GIRIS ? 'GİRİŞ İŞLEMİNİZ YAPILAMADI' : 'ÇIKIŞ İŞLEMİNİZ YAPILAMADI',
  }, BAD_MS);
  if (settings.voice) speak('Tanımsız kart okuttunuz, lütfen yetkiliye danışınız.');
}

/* ---------- Modal ---------- */
let modalOk = null;
function openModal(title, bodyHtml, okText, onOk, okClass = 'primary') {
  $('mTitle').textContent = title;
  $('mBody').innerHTML = bodyHtml;
  $('mOk').textContent = okText;
  $('mOk').className = okClass;
  modalOk = onOk;
  $('modal').classList.remove('hidden');
  const f = $('mBody').querySelector('input[type=text]');
  if (f) setTimeout(() => f.focus(), 50);
}
function closeModal() { $('modal').classList.add('hidden'); modalOk = null; }
$('mCancel').addEventListener('click', closeModal);
$('mOk').addEventListener('click', () => { if (modalOk && modalOk() === false) return; closeModal(); });
$('mBody').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mOk').click(); });
const modalOpen = () => !$('modal').classList.contains('hidden');
function confirmBox(title, text, okText, fn) {
  openModal(title, `<p>${esc(text)}</p>`, okText, fn, 'danger');
}

/* ---------- Tanımlar ---------- */
function defineCard(uid) {
  if (modalOpen()) return;
  const cur = cards[uid] || '';
  openModal(cur ? 'Kart Tanımını Düzenle' : 'Yeni Kart Tanımla',
    `<label>Kart No</label><div class="mono">${esc(uid)}</div>
     <label>Adı Soyadı</label><input type="text" id="inName" value="${esc(cur)}" autocomplete="off">`,
    'Kaydet', () => {
      const n = $('inName').value.trim().replace(/\s+/g, ' ');
      if (!n) { toast('Adı soyadı giriniz.'); return false; }
      cards[uid] = n; save('pdks_cards', cards);
      renderCards(); toast(`${n} kartı ile eşleştirildi.`);
    });
}
function renderCards() {
  const list = Object.entries(cards).sort((a, b) => a[1].localeCompare(b[1], 'tr'));
  $('cardList').innerHTML = list.map(([uid, n]) =>
    `<tr><td>${esc(n)}</td><td class="mono">${esc(uid)}</td>
     <td class="x" style="white-space:nowrap"><button class="ebtn" data-edit="${esc(uid)}">Düzenle</button><button class="xbtn" data-del="${esc(uid)}" title="Sil">✕</button></td></tr>`).join('');
  $('cardEmpty').classList.toggle('hidden', list.length > 0);
}
$('cardList').addEventListener('click', (e) => {
  const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
  if (ed) defineCard(ed.dataset.edit);
  if (del) {
    const uid = del.dataset.del;
    confirmBox('Kart Tanımını Sil', `${cards[uid]} (${uid}) tanımı silinsin mi? Hareket kayıtları silinmez.`, 'Sil', () => {
      delete cards[uid]; save('pdks_cards', cards); renderCards();
    });
  }
});

/* ---------- Hareketler ---------- */
let selUid = null;
function range() {
  const s = $('fStart').value || dateStr();
  let e = $('fEnd').value || s;
  if (s > e) e = s; // başlangıç bitişten büyükse bitiş olarak başlangıcı kullan
  return [s, e];
}
function openHareketler() {
  const t = dateStr();
  $('fStart').value = t; $('fEnd').value = t;
  selUid = null;
  renderPersons();
}
function renderPersons() {
  const [s, e] = range();
  const uids = [...new Set(records.filter((r) => r.date >= s && r.date <= e).map((r) => r.uid))]
    .sort((a, b) => uidName(a).localeCompare(uidName(b), 'tr'));
  if (!uids.includes(selUid)) selUid = uids[0] || null;
  $('perList').innerHTML = uids.map((u) =>
    `<tr data-uid="${esc(u)}" class="${u === selUid ? 'on' : ''}"><td>${esc(uidName(u))}</td><td class="mono">${esc(u)}</td></tr>`).join('');
  $('perEmpty').classList.toggle('hidden', uids.length > 0);
  renderMoves();
}
function renderMoves() {
  const [s, e] = range();
  const list = selUid ? records.filter((r) => r.uid === selUid && r.date >= s && r.date <= e).sort(sortRecs) : [];
  $('movList').innerHTML = list.map((r) =>
    `<tr><td>${trDate(r.date)}</td><td>${hm(r.time)}</td><td class="tag ${r.type === GIRIS ? 'g' : 'c'}">${r.type}</td>
     <td class="x"><button class="xbtn" data-rid="${r.id}" title="Sil">✕</button></td></tr>`).join('');
  $('movEmpty').classList.toggle('hidden', list.length > 0);
}
$('perList').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-uid]'); if (!tr) return;
  selUid = tr.dataset.uid;
  document.querySelectorAll('#perList tr').forEach((x) => x.classList.toggle('on', x === tr));
  renderMoves();
});
$('fStart').addEventListener('change', renderPersons);
$('fEnd').addEventListener('change', renderPersons);
$('movList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rid]'); if (!b) return;
  const r = records.find((x) => x.id === b.dataset.rid); if (!r) return;
  confirmBox('Hareket Kaydını Sil', `${uidName(r.uid)} - ${trDate(r.date)} ${hm(r.time)} ${r.type} kaydı silinsin mi?`, 'Sil', () => {
    records = records.filter((x) => x.id !== r.id); save('pdks_records', records); renderPersons();
  });
});
$('btnAdd').addEventListener('click', () => {
  if (!selUid) { toast('Önce üstteki listeden bir personel seçiniz.'); return; }
  const uid = selUid, name = uidName(uid);
  const now = new Date();
  const e = range()[1];
  openModal('Hareket Ekle',
    `<div><b>${esc(name)}</b> <span class="mono">(${esc(uid)})</span></div>
     <label>Tarih</label><input type="date" id="aDate" value="${e < dateStr() ? e : dateStr()}">
     <label>Saat</label><input type="time" id="aTime" value="${pad(now.getHours())}:${pad(now.getMinutes())}">
     <label>Geçiş Türü</label><select id="aType"><option>${GIRIS}</option><option>${CIKIS}</option></select>`,
    'Ekle', () => {
      const date = $('aDate').value, t = $('aTime').value.slice(0, 5), type = $('aType').value;
      if (!date || !t) { toast('Tarih ve saat giriniz.'); return false; }
      if (records.some((r) => r.uid === uid && r.date === date && hm(r.time) === t)) {
        toast('Bu zamana ait bir hareket kaydı zaten var.', 3500);
        return false;
      }
      records.push({ id: newId(), uid, name, date, time: t + ':00', type });
      save('pdks_records', records);
      const [s0, e0] = range();
      if (date < s0) $('fStart').value = date;
      if (date > e0) $('fEnd').value = date;
      renderPersons();
    });
});

/* ---------- Ayarlar ---------- */
const DAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
if (!Array.isArray(settings.shifts) || settings.shifts.length !== 7) {
  settings.shifts = DAYS.map(() => ({ start: '00:00', end: '00:00' }));
}
function renderShifts() {
  $('shiftList').innerHTML = DAYS.map((d, i) =>
    `<tr><td>${d}</td>
     <td><input type="time" data-i="${i}" data-k="start" value="${settings.shifts[i].start}"></td>
     <td><input type="time" data-i="${i}" data-k="end" value="${settings.shifts[i].end}"></td></tr>`).join('');
}
$('shiftList').addEventListener('change', (e) => {
  const el = e.target; if (!el.dataset.k) return;
  settings.shifts[+el.dataset.i][el.dataset.k] = el.value || '00:00';
  if (!el.value) el.value = '00:00';
  save('pdks_settings', settings);
});
function renderSettings() {
  renderShifts();
  $('setVoice').checked = settings.voice;
  $('setVoiceTime').checked = settings.voiceTime;
  $('setVoiceTime').disabled = !settings.voice;
  $('setVoiceTime').closest('.chk').classList.toggle('dis', !settings.voice);
}
$('setVoice').addEventListener('change', (e) => { settings.voice = e.target.checked; save('pdks_settings', settings); renderSettings(); });
$('setVoiceTime').addEventListener('change', (e) => { settings.voiceTime = e.target.checked; save('pdks_settings', settings); });
$('btnTestVoice').addEventListener('click', () => speak(settings.voiceTime ? `Ahmet Yılmaz. Saat ${hm(timeStr())}` : 'Ahmet Yılmaz'));

/* ---------- Saat (tarih + LED saat) ---------- */
const SEG = {
  a: '12,4 48,4 54,10 48,16 12,16 6,10', b: '54,12 60,18 60,42 54,48 48,42 48,18',
  c: '54,52 60,58 60,82 54,88 48,82 48,58', d: '12,84 48,84 54,90 48,96 12,96 6,90',
  e: '6,52 12,58 12,82 6,88 0,82 0,58', f: '6,12 12,18 12,42 6,48 0,42 0,18',
  g: '12,44 48,44 54,50 48,56 12,56 6,50',
};
const DIG = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
function ledSvg(text) {
  let x = 4, out = '';
  for (const ch of text) {
    if (ch === ':') {
      out += `<circle class="on" cx="${x + 8}" cy="32" r="6"/><circle class="on" cx="${x + 8}" cy="70" r="6"/>`;
      x += 22; continue;
    }
    const on = DIG[+ch];
    out += `<g transform="translate(${x} 0) skewX(-6)">` +
      Object.keys(SEG).map((k) => `<polygon class="${on.includes(k) ? 'on' : 'of'}" points="${SEG[k]}"/>`).join('') + '</g>';
    x += 72;
  }
  return `<svg viewBox="0 0 ${x} 100" xmlns="http://www.w3.org/2000/svg">${out}</svg>`;
}
let lastDateTxt = '';
function fitDate() {
  const el = $('dateBig');
  el.style.fontSize = '100px';
  const w = el.clientWidth, sw = el.scrollWidth;
  if (w && sw) el.style.fontSize = Math.floor(100 * (w * 0.96) / sw) + 'px';
  $('dayBig').style.fontSize = el.style.fontSize; // gün adı tarih büyüklüğünde
}
function tick() {
  const d = new Date();
  const t = trDate(dateStr(d));
  if (t !== lastDateTxt) {
    lastDateTxt = t;
    $('dateBig').textContent = t;
    $('dayBig').textContent = upper(DAYS[(d.getDay() + 6) % 7]);
    fitDate();
  }
  $('led').innerHTML = ledSvg(timeStr(d));
}
window.addEventListener('resize', fitDate);
setInterval(tick, 1000); tick();

/* ---------- NFC: Android uygulaması ---------- */
window.onNativeCard = (uid) => onCard(uid);
window.onNativeNfcState = (on) => setNfcState(on);

/* ---------- NFC: Web (Chrome Android - Web NFC) ---------- */
let webReader = null, webScanning = false, webAbort = null, webUserStopped = false;
function stopWebNfc(byUser = true) {
  if (webAbort) webAbort.abort();
  webAbort = null; webScanning = false;
  if (byUser) webUserStopped = true;
  setNfcState(false);
}
async function startWebNfc(fromGesture) {
  if (webScanning || document.hidden) return;
  if (fromGesture) webUserStopped = false;
  if (webUserStopped) return;
  try {
    if (!webReader) {
      webReader = new NDEFReader();
      webReader.addEventListener('reading', (e) => onCard(e.serialNumber));
      webReader.addEventListener('readingerror', () => {});
    }
    webAbort = new AbortController();
    await webReader.scan({ signal: webAbort.signal });
    webScanning = true;
    $('startOverlay').classList.add('hidden');
    setNfcState(true);
  } catch (err) {
    setNfcState(false);
    if (err && err.name === 'NotAllowedError' && !fromGesture) $('startOverlay').classList.remove('hidden');
  }
}
$('startOverlay').addEventListener('click', () => { speak(' '); startWebNfc(true); });

/* ---------- USB/Bluetooth klavye tipi kart okuyucu desteği ---------- */
let kbBuf = '', kbTime = 0;
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || modalOpen()) return;
  const now = Date.now();
  if (now - kbTime > 300) kbBuf = '';
  kbTime = now;
  if (e.key === 'Enter') { if (kbBuf.length >= 4) onCard(kbBuf); kbBuf = ''; return; }
  if (/^[0-9a-zA-Z]$/.test(e.key)) kbBuf += e.key;
});

/* ---------- Başlat ---------- */
(function init() {
  if (isNative) {
    setNfcState(window.Android.isNfcEnabled());
    return;
  }
  if ('NDEFReader' in window) {
    setNfcState(false);
    if (navigator.permissions) {
      navigator.permissions.query({ name: 'nfc' })
        .then((p) => { if (p.state === 'granted') startWebNfc(false); else $('startOverlay').classList.remove('hidden'); })
        .catch(() => $('startOverlay').classList.remove('hidden'));
    } else $('startOverlay').classList.remove('hidden');
    // Arka plana geçince okumayı durdur, öne gelince yeniden başlat
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (webScanning) stopWebNfc(false); }
      else startWebNfc(false);
    });
    // NFC kapalıysa periyodik olarak tekrar dene
    setInterval(() => { if (!webScanning) startWebNfc(false); }, 4000);
  } else {
    setNfcState(false);
    const h = $('webHint');
    h.innerHTML = 'Bu tarayıcı NFC kart okumayı desteklemiyor. Android telefonda <b>Chrome</b> ile açın veya <a href="apk/">Android uygulamasını indirin</a>.';
    h.classList.remove('hidden');
  }
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
