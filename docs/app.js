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
}

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
  const people = new Map();
  Object.entries(cards).forEach(([u, n]) => people.set(u, n));
  records.forEach((r) => { if (!people.has(r.uid)) people.set(r.uid, r.name); });
  if (!people.size) { toast('Önce Tanımlar ekranından kart tanımlayınız.'); return; }
  const opts = [...people].sort((a, b) => a[1].localeCompare(b[1], 'tr'))
    .map(([u, n]) => `<option value="${esc(u)}" ${u === selUid ? 'selected' : ''}>${esc(n)} (${esc(u)})</option>`).join('');
  const now = new Date();
  openModal('Hareket Ekle',
    `<label>Personel</label><select id="aUid">${opts}</select>
     <label>Tarih</label><input type="date" id="aDate" value="${range()[1] < dateStr() ? range()[1] : dateStr()}">
     <label>Saat</label><input type="time" id="aTime" value="${pad(now.getHours())}:${pad(now.getMinutes())}">
     <label>Geçiş Türü</label><select id="aType"><option>${GIRIS}</option><option>${CIKIS}</option></select>`,
    'Ekle', () => {
      const uid = $('aUid').value, date = $('aDate').value, t = $('aTime').value, type = $('aType').value;
      if (!uid || !date || !t) { toast('Tüm alanları doldurunuz.'); return false; }
      records.push({ id: newId(), uid, name: people.get(uid), date, time: t.length === 5 ? t + ':00' : t, type });
      save('pdks_records', records);
      selUid = uid;
      const [s, e] = range();
      if (date < s) $('fStart').value = date;
      if (date > e) $('fEnd').value = date;
      renderPersons();
    });
});

/* ---------- Ayarlar ---------- */
function renderSettings() {
  $('setVoice').checked = settings.voice;
  $('setVoiceTime').checked = settings.voiceTime;
  $('setVoiceTime').disabled = !settings.voice;
  $('setVoiceTime').closest('.chk').classList.toggle('dis', !settings.voice);
}
$('setVoice').addEventListener('change', (e) => { settings.voice = e.target.checked; save('pdks_settings', settings); renderSettings(); });
$('setVoiceTime').addEventListener('change', (e) => { settings.voiceTime = e.target.checked; save('pdks_settings', settings); });
$('btnTestVoice').addEventListener('click', () => speak(settings.voiceTime ? `Ahmet Yılmaz. Saat ${hm(timeStr())}` : 'Ahmet Yılmaz'));

/* ---------- Saat ---------- */
function tick() {
  const d = new Date();
  $('clock').textContent = `${trDate(dateStr(d))}  ${timeStr(d)}`;
}
setInterval(tick, 1000); tick();

/* ---------- NFC: Android uygulaması ---------- */
window.onNativeCard = (uid) => onCard(uid);
window.onNativeNfcState = (on) => setNfcState(on);

/* ---------- NFC: Web (Chrome Android - Web NFC) ---------- */
let webReader = null, webScanning = false;
async function startWebNfc(fromGesture) {
  if (webScanning) return;
  try {
    if (!webReader) {
      webReader = new NDEFReader();
      webReader.addEventListener('reading', (e) => onCard(e.serialNumber));
      webReader.addEventListener('readingerror', () => {});
    }
    await webReader.scan();
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
