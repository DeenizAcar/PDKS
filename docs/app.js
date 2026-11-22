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
let personel = load('pdks_personel', null);  // [{id, ad, cinsiyet, pasif, kart}]
let silinen = load('pdks_silinen', []);       // [{id, zaman, ad, pasif, kart}] silinen personel arşivi
let records = load('pdks_records', []);      // [{id, pid, uid, name, date:'YYYY-MM-DD', time:'HH:MM:SS', type}]
let settings = Object.assign({ voice: false, voiceTime: false }, load('pdks_settings', {}));
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
const typeOrder = (t) => (t === GIRIS ? 0 : 1);
const sortRecs = (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || typeOrder(a.type) - typeOrder(b.type);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const trKucuk = (s) => (s || '').toLocaleLowerCase('tr-TR');
const adSirala = (a, b) => a.ad.localeCompare(b.ad, 'tr', { sensitivity: 'base' });

/* ---------- Eski sürümden geçiş (kart -> personel) ---------- */
if (!Array.isArray(personel)) {
  personel = Object.entries(load('pdks_cards', {})).map(([kart, ad]) => ({ id: newId(), ad, cinsiyet: 'Bilinmiyor', pasif: false, kart }));
  save('pdks_personel', personel);
}
if (records.some((r) => !r.pid)) {
  records.forEach((r) => {
    if (r.pid) return;
    const p = personel.find((q) => q.kart === r.uid);
    r.pid = p ? p.id : 'k_' + r.uid;
  });
  save('pdks_records', records);
}
const kaydetPersonel = () => save('pdks_personel', personel);
const kaydetSilinen = () => save('pdks_silinen', silinen);
const byKart = (k) => (k ? personel.find((p) => p.kart === k) : null);
const pidPerson = (pid) => personel.find((p) => p.id === pid);
const pidName = (pid) => (pidPerson(pid) || {}).ad || (records.find((r) => r.pid === pid) || {}).name || pid;
const pidKart = (pid) => { const p = pidPerson(pid); if (p) return p.kart || ''; const r = records.find((x) => x.pid === pid); return r ? r.uid : ''; };

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
  menuKapat();
  if (name === 'main') { window.scrollTo(0, 0); fitDate(); }
  if (name === 'tanimlar') renderTanim();
  if (name === 'silinen') renderSilinen();
  if (name === 'hareketler') openHareketler();
  if (name === 'ayarlar') renderSettings();
}
document.querySelectorAll('.back').forEach((b) => b.addEventListener('click', () => go('main')));
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// Android geri tuşu
window.handleBack = function () {
  if (!$('popMenu').classList.contains('hidden')) { menuKapat(); return true; }
  const d = acikDialog();
  if (d) { if (d.id === 'dlgOnay') onayCb = null; dialogKapat(d.id); return true; }
  if (!$('modal').classList.contains('hidden')) { closeModal(); return true; }
  if (screen === 'silinen') { go('tanimlar'); return true; }
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
    $('stTitle').textContent = 'Kart okutmanız için bekleniyor...';
    $('stSub').textContent = 'Personel kartınızı telefonun arkasına yaklaştırınız.';
  } else {
    $('stTitle').textContent = 'Cihazın kart okuma özelliği kapalı...';
    $('stSub').textContent = 'Kart okuma özelliğinin kapalı olduğunu yetkiliye haber veriniz.';
  }
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

function showResult(kind, { name = '', head = '', inner = '', below = '' }, ms) {
  const r = $('result');
  r.className = 'result ' + kind;
  void r.offsetWidth; // animasyonu yeniden başlat
  $('rName').textContent = name;
  $('rHead').textContent = head;
  $('rHead').classList.toggle('hidden', !head);
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

  if (screen === 'tanimlar') { tanimKart(uid); return; }
  if (screen !== 'main') return;

  const p = byKart(uid);
  if (p && !p.pasif) processKnown(p, uid, now); else processUnknown(); // pasif personelin kartı tanımsız sayılır
}

// Kararlar hareket kayıtlarına göre verilir (kayıt silinirse ona göre davranır)
const recTs = (r) => { const [y, m, d] = r.date.split('-').map(Number); const [h, mi, se] = r.time.split(':').map(Number); return new Date(y, m - 1, d, h, mi, se || 0).getTime(); };
function lastRecFor(pid, today) {
  const todays = records.filter((r) => r.pid === pid && r.date === today).sort(sortRecs);
  return todays[todays.length - 1] || null;
}

function processKnown(p, uid, now) {
  const d = new Date(now), today = dateStr(d);
  const name = p.ad;
  const last = lastRecFor(p.id, today);

  // Son hareket kaydından bu yana 5 dk geçmediyse
  if (last && now - recTs(last) >= 0 && now - recTs(last) < RECENT_MS) {
    showResult('dup', { name: upper(name), below: 'İşleminiz yakın zamanda zaten yapılmıştı.' }, DUP_MS);
    if (settings.voice) speak(`${name}. İşleminiz yakın zamanda zaten yapılmıştı.`);
    return;
  }

  const type = !last || last.type === CIKIS ? GIRIS : CIKIS;
  const time = timeStr(d);
  records.push({ id: newId(), pid: p.id, uid, name, date: today, time, type });
  save('pdks_records', records);

  const msg = type === GIRIS ? 'GİRİŞİNİZ BAŞARI İLE YAPILDI' : 'ÇIKIŞINIZ BAŞARI İLE YAPILDI';
  showResult('ok', { name: upper(name), head: type === GIRIS ? 'GİRİŞ' : 'ÇIKIŞ', inner: `Kart okutma işleminiz tamamlandı...<br>${msg} : ${hm(time)}` }, OK_MS);
  if (settings.voice) speak(`${name}. ${settings.voiceTime ? hm(time) + ' ' : ''}${type === GIRIS ? 'giriş' : 'çıkış'}`);
}

function processUnknown() {
  showResult('bad', { inner: 'Kart okutma işleminiz tamamlanamadı.', below: 'İŞLEMİNİZ YAPILAMADI' }, BAD_MS);
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

/* ---------- Tanımlar (Mini Puantaj tanımlar ekranı) ---------- */
const IKON = {
  'Erkek': '<svg class="gicon" viewBox="0 0 24 24" aria-label="Erkek"><circle cx="12" cy="7.5" r="4.5" fill="#1f6fb5"/><path d="M3.5 22c0-5 3.8-8.5 8.5-8.5s8.5 3.5 8.5 8.5z" fill="#1f6fb5"/></svg>',
  'Kadın': '<svg class="gicon" viewBox="0 0 24 24" aria-label="Kadın"><path d="M12 2.2c-3.4 0-5.6 2.6-5.6 6 0 2.2-.6 4-1.6 5.3 1.6.6 3.3.8 4.6.7a5 5 0 0 0 5.2 0c1.3.1 3-.1 4.6-.7-1-1.3-1.6-3.1-1.6-5.3 0-3.4-2.2-6-5.6-6z" fill="#c2185b"/><path d="M12 15c-3.5 0-6.2 2.4-7.5 7h15c-1.3-4.6-4-7-7.5-7z" fill="#c2185b"/></svg>',
};
const fmtZaman = (iso) => { const d = new Date(iso); return `${trDate(dateStr(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* Pencereler */
const acikDialog = () => document.querySelector('.mp .dialog:not(.hidden)');
function dialogAc(id) { $('overlay').classList.remove('hidden'); $('overlay').style.background = ''; $(id).classList.remove('hidden'); }
function dialogKapat(id) {
  $(id).classList.add('hidden');
  if (!acikDialog() && $('popMenu').classList.contains('hidden')) $('overlay').classList.add('hidden');
}
document.querySelectorAll('.mp [data-close]').forEach((b) => b.addEventListener('click', () => dialogKapat(b.closest('.dialog').id)));
$('overlay').addEventListener('click', () => { if (!$('popMenu').classList.contains('hidden')) menuKapat(); });

let onayCb = null;
function onay(baslik, mesaj, cb) {
  $('onayTitle').textContent = baslik; $('onayMsg').textContent = mesaj; onayCb = cb;
  $('onayMsg').classList.remove('warn');
  $('onayEvet').textContent = 'Evet'; $('onayHayir').classList.remove('hidden');
  dialogAc('dlgOnay');
}
function uyari(baslik, mesaj) {
  $('onayTitle').textContent = baslik; $('onayMsg').textContent = mesaj; onayCb = null;
  $('onayMsg').classList.add('warn'); // uyarı yazıları kırmızı bold
  $('onayEvet').textContent = 'Tamam'; $('onayHayir').classList.add('hidden');
  dialogAc('dlgOnay');
}
$('onayEvet').addEventListener('click', () => { const f = onayCb; onayCb = null; dialogKapat('dlgOnay'); if (f) f(); });
$('onayHayir').addEventListener('click', () => { onayCb = null; dialogKapat('dlgOnay'); });

/* Uzun basma menüsü */
let menuSil = null, menuEk = null;
function menuAc(x, y, silFn, ek) {
  const m = $('popMenu'); menuSil = silFn; menuEk = ek ? ek.fn : null;
  $('popEk').textContent = ek ? ek.yazi : '';
  $('popEk').classList.toggle('hidden', !ek);
  m.classList.remove('hidden');
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  $('overlay').classList.remove('hidden'); $('overlay').style.background = 'transparent';
}
function menuKapat() {
  $('popMenu').classList.add('hidden'); menuSil = null; menuEk = null;
  if (!acikDialog()) $('overlay').classList.add('hidden');
  $('overlay').style.background = '';
}
$('popVazgec').addEventListener('click', menuKapat);
$('popSil').addEventListener('click', () => { const f = menuSil; menuKapat(); if (f) f(); });
$('popEk').addEventListener('click', () => { const f = menuEk; menuKapat(); if (f) f(); });

/* Satır etkileşimi: uzun basma + çift dokunma */
function satirSec(tr) {
  tr.parentNode.querySelectorAll('.selected').forEach((r) => r.classList.remove('selected'));
  tr.classList.add('selected');
}
function satirEtkilesim(tr, onLong, onDouble) {
  let timer = null, sx = 0, sy = 0, uzun = false, sonTik = 0;
  tr.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    uzun = false; sx = e.clientX; sy = e.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => { uzun = true; satirSec(tr); onLong(tr, sx, sy); if (navigator.vibrate) navigator.vibrate(30); }, 550);
  });
  tr.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clearTimeout(timer); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => tr.addEventListener(ev, () => clearTimeout(timer)));
  tr.addEventListener('contextmenu', (e) => e.preventDefault());
  tr.addEventListener('click', () => {
    if (uzun) { uzun = false; return; }
    satirSec(tr);
    const t = Date.now();
    if (t - sonTik < 400) { sonTik = 0; onDouble(tr); } else sonTik = t;
  });
}

/* İsimleri sahaya sığdır */
function sigdir(kok) {
  requestAnimationFrame(() => {
    (kok || document).querySelectorAll('.mp .fit').forEach((el) => {
      el.style.fontSize = '';
      let fs = parseFloat(getComputedStyle(el).fontSize) || 16;
      while (fs > 9 && el.scrollWidth > el.clientWidth + 0.5) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
    });
  });
}

/* Arama */
let araKelimeler = [];
const aramaKelimeleri = () => araKelimeler.concat($('txtAra').value.split(/\s+/).filter(Boolean)).map(trKucuk);
function renderChips() {
  const box = $('araEtiketler'); box.innerHTML = '';
  araKelimeler.forEach((k, i) => {
    const c = document.createElement('span'); c.className = 'chip';
    c.innerHTML = `<span>${esc(k)}</span><button class="xbtn" title="Kelimeyi sil">✕</button>`;
    c.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); araKelimeler.splice(i, 1); renderTanim(); });
    box.appendChild(c);
  });
  $('txtAra').placeholder = araKelimeler.length ? '' : 'İsim soyisim ara...';
}
function araGirdi() {
  const v = $('txtAra').value;
  if (/\s/.test(v)) {
    const parca = v.split(/\s+/), son = parca.pop();
    parca.filter(Boolean).forEach((k) => araKelimeler.push(k));
    $('txtAra').value = son;
  }
  renderTanim();
}

function renderTanim() {
  renderChips();
  const kel = aramaKelimeleri();
  const liste = personel.slice().sort(adSirala).filter((p) => {
    if (!kel.length) return true;
    const ad = trKucuk(p.ad);
    return kel.some((k) => ad.indexOf(k) >= 0);
  });
  const tb = $('tanimBody'); tb.innerHTML = '';
  const bos = $('tanimEmpty');
  bos.classList.toggle('hidden', liste.length > 0);
  bos.innerHTML = personel.length ? 'Aramaya uyan personel bulunamadı.' : 'Henüz personel yok.<br>“Personel Ekle” ile ekleyebilirsiniz.';
  liste.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="fit"><span class="pname${p.pasif ? ' pasif' : ''}">${esc(p.ad)}</span>` +
      (p.pasif ? '<span class="pasiftag">(PASİF)</span>' : '') + '</span></td>' +
      `<td><span class="cins">${esc(p.cinsiyet)}${IKON[p.cinsiyet] || ''}</span></td>`;
    satirEtkilesim(tr, (r, x, y) => {
      menuAc(x, y, () => {
        onay('Personel Sil', `“${p.ad}” silinsin mi?`, () => {
          personel = personel.filter((q) => q.id !== p.id);
          silinen.push({ id: newId(), zaman: new Date().toISOString(), ad: p.ad, pasif: !!p.pasif, kart: p.kart || '' });
          kaydetPersonel(); kaydetSilinen(); renderTanim(); toast('Personel silindi ve arşive alındı.');
        });
      }, {
        yazi: p.pasif ? 'Aktif Yap' : 'Pasif Yap',
        fn: () => {
          p.pasif = !p.pasif; kaydetPersonel(); renderTanim();
          toast(`“${p.ad}” ${p.pasif ? 'pasif yapıldı.' : 'aktif yapıldı.'}`);
        },
      });
    }, () => personelDialog(p));
    tb.appendChild(tr);
  });
  sigdir(tb);
}

/* Personel ekle / düzenle penceresi */
let duzenlenen = null;
function personelDialog(p, kart) {
  duzenlenen = p || null;
  $('dlgPersonelTitle').textContent = p ? 'Personel Düzenle' : 'Personel Ekle';
  $('inpAd').value = p ? p.ad : '';
  $('inpCins').value = p ? p.cinsiyet : 'Bilinmiyor';
  $('inpKart').value = p ? (p.kart || '') : (kart || '');
  $('inpPasif').checked = !!(p && p.pasif);
  $('dlgPersonelErr').textContent = '';
  dialogAc('dlgPersonel');
  if (!p) setTimeout(() => $('inpAd').focus(), 50);
}
const kartSahibi = (kart) => { const o = byKart(kart); return o && o !== duzenlenen ? o : null; };
function personelKaydet() {
  const ad = $('inpAd').value.replace(/\s+/g, ' ').trim();
  if (!ad) { $('dlgPersonelErr').textContent = 'Adı soyadı boş olamaz.'; return false; }
  if (personel.some((q) => q !== duzenlenen && trKucuk(q.ad) === trKucuk(ad))) { $('dlgPersonelErr').textContent = 'Bu isimde bir personel zaten var.'; return false; }
  const kart = $('inpKart').value.trim();
  const sahip = kartSahibi(kart);
  if (sahip) { uyari('Uyarı', `${kart} kart no “${sahip.ad}” adlı personele tanımlı.`); return false; }
  const pasif = $('inpPasif').checked;
  if (duzenlenen) Object.assign(duzenlenen, { ad, cinsiyet: $('inpCins').value, pasif, kart });
  else personel.push({ id: newId(), ad, cinsiyet: $('inpCins').value, pasif, kart });
  kaydetPersonel(); dialogKapat('dlgPersonel'); renderTanim();
  return true;
}
$('btnPersonelKaydet').addEventListener('click', personelKaydet);
$('inpAd').addEventListener('keydown', (e) => { if (e.key === 'Enter') personelKaydet(); });
$('btnPersonelEkle').addEventListener('click', () => personelDialog(null));

// Kart No sahasının yanındaki ✕: onaydan sonra sahayı boşalt, kaydet ve pencereyi kapat
$('btnKartSil').addEventListener('click', (e) => {
  e.preventDefault();
  const cur = $('inpKart').value;
  if (!cur) return;
  onay('Kart No Sil', `${cur} kart no silinecektir. Devam etmek istiyor musunuz?`, () => {
    $('inpKart').value = '';
    personelKaydet();
  });
});
// Kart No sahasına elle veri girilemez
['keydown', 'paste', 'drop', 'beforeinput'].forEach((ev) => $('inpKart').addEventListener(ev, (e) => e.preventDefault()));
$('inpKart').addEventListener('focus', () => $('inpKart').blur());

// Tanımlar ekranında NFC ile kart okutulunca
function tanimKart(uid) {
  if (!$('dlgOnay').classList.contains('hidden')) return; // onay/uyarı açıkken yok say
  if ($('dlgPersonel').classList.contains('hidden')) {
    // pencere kapalı: kart tanımlıysa o personeli düzenle, değilse uyarı ver
    menuKapat();
    const p = byKart(uid);
    if (p) personelDialog(p, ''); else uyari('Uyarı', 'Bu kart sistemde kayıtlı değil.');
    return;
  }
  const cur = $('inpKart').value;
  if (cur === uid) return; // aynı kart tekrar okutuldu: hiçbir şey yapma
  const sahip = kartSahibi(uid);
  if (sahip) { uyari('Uyarı', `${uid} kart no “${sahip.ad}” adlı personele tanımlı.`); return; }
  if (!cur) { $('inpKart').value = uid; return; }
  onay('Kart No Değişikliği', `${cur} kart no silinip yerine ${uid} kart no tanımlanacaktır. Devam etmek istiyor musunuz?`, () => {
    $('inpKart').value = uid;
    personelKaydet();
  });
}

$('txtAra').addEventListener('input', araGirdi);
$('txtAra').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && $('txtAra').value.trim()) { araKelimeler.push($('txtAra').value.trim()); $('txtAra').value = ''; renderTanim(); }
  else if (e.key === 'Backspace' && !$('txtAra').value && araKelimeler.length) { araKelimeler.pop(); renderTanim(); }
});
$('araKutu').addEventListener('click', () => $('txtAra').focus());
$('btnAraTemizle').addEventListener('click', (e) => { e.stopPropagation(); araKelimeler = []; $('txtAra').value = ''; renderTanim(); });
$('btnSilinenArsiv').addEventListener('click', () => go('silinen'));
$('btnTanimKapat').addEventListener('click', () => go('main'));

/* Silinen personel arşivi */
function renderSilinen() {
  const liste = silinen.slice().sort((a, b) => (a.zaman < b.zaman ? 1 : a.zaman > b.zaman ? -1 : 0));
  const tb = $('silinenBody'); tb.innerHTML = '';
  $('silinenEmpty').classList.toggle('hidden', liste.length > 0);
  liste.forEach((k) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b>${fmtZaman(k.zaman)}</b></td><td><span class="fit"><span class="pname">${esc(k.ad)}</span>${k.kart ? ` <span class="skart">(${esc(k.kart)})</span>` : ''}</span>` +
      (k.pasif ? '<span class="pasifken">(PASİFKEN)</span>' : '') + '</td>';
    satirEtkilesim(tr, (r, x, y) => {
      menuAc(x, y, () => {
        onay('Kayıt Sil', `“${k.ad}” silme kaydı arşivden silinsin mi?`, () => {
          silinen = silinen.filter((q) => q.id !== k.id); kaydetSilinen(); renderSilinen(); toast('Kayıt silindi.');
        });
      });
    }, () => {});
    tb.appendChild(tr);
  });
  const ilk = tb.querySelector('tr'); if (ilk) satirSec(ilk);
  sigdir(tb);
}
$('btnSilinenTumSil').addEventListener('click', () => {
  if (!silinen.length) { toast('Silinecek kayıt yok.'); return; }
  onay('Tümünü Sil', `Tüm arşiv kayıtları (${silinen.length} adet) silinsin mi?`, () => {
    silinen = []; kaydetSilinen(); renderSilinen(); toast('Tüm arşiv silindi.');
  });
});
$('btnSilinenKapat').addEventListener('click', () => go('tanimlar'));

/* Excel Dışa Aktar / İçe Aktar */
let xlsxSoz = null;
function xlsxYukle() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxSoz) xlsxSoz = new Promise((ok, hata) => {
    const sc = document.createElement('script'); sc.src = 'vendor/xlsx.full.min.js';
    sc.onload = () => ok(window.XLSX);
    sc.onerror = () => { xlsxSoz = null; hata(new Error('xlsx yüklenemedi')); };
    document.head.appendChild(sc);
  });
  return xlsxSoz;
}
function dosyaKaydet(b64, ad, mime, mesaj) {
  if (isNative && window.Android.saveFile) {
    const r = window.Android.saveFile(ad, b64, mime);
    toast(r ? `${mesaj} (İndirilenler/${ad})` : 'Dosya kaydedilemedi.', 3500);
    return Promise.resolve();
  }
  const url = `data:${mime};base64,${b64}`;
  return fetch(url).then((r) => r.blob()).then((blob) => {
    const file = new File([blob], ad, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: ad }).catch((e) => { if (e && e.name !== 'AbortError') indir(url, ad); });
    }
    indir(url, ad); toast(mesaj);
  });
}
function indir(url, ad) { const a = document.createElement('a'); a.href = url; a.download = ad; document.body.appendChild(a); a.click(); a.remove(); }

function disaAktar() {
  xlsxYukle().then((X) => {
    const pRows = personel.slice().sort(adSirala).map((p) => ({ 'Adı Soyadı': p.ad, 'Cinsiyeti': p.cinsiyet, 'Kart No': p.kart || '', 'Durumu': p.pasif ? 'Pasif' : 'Aktif' }));
    const hRows = records.slice().sort((a, b) => pidName(a.pid).localeCompare(pidName(b.pid), 'tr') || sortRecs(a, b))
      .map((r) => ({ 'Adı Soyadı': pidName(r.pid), 'Kart No': r.uid || '', 'Tarih': trDate(r.date), 'Saat': hm(r.time), 'Tür': r.type }));
    const wb = X.utils.book_new();
    const ws1 = X.utils.json_to_sheet(pRows, { header: ['Adı Soyadı', 'Cinsiyeti', 'Kart No', 'Durumu'] });
    ws1['!cols'] = [{ wch: 32 }, { wch: 12 }, { wch: 18 }, { wch: 10 }];
    const ws2 = X.utils.json_to_sheet(hRows, { header: ['Adı Soyadı', 'Kart No', 'Tarih', 'Saat', 'Tür'] });
    ws2['!cols'] = [{ wch: 32 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 8 }];
    X.utils.book_append_sheet(wb, ws1, 'Personel');
    X.utils.book_append_sheet(wb, ws2, 'Hareketler');
    const b64 = X.write(wb, { bookType: 'xlsx', type: 'base64' });
    return dosyaKaydet(b64, `pdks_${dateStr()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel dosyası kaydedildi.');
  }).catch((e) => { console.error(e); toast('Dışa aktarılamadı.'); });
}

const CINS_GERI = { 'erkek': 'Erkek', 'kadın': 'Kadın', 'kadin': 'Kadın', 'bilinmiyor': 'Bilinmiyor' };
function hucre(row, adlar) {
  for (const a of adlar) for (const k in row) if (trKucuk(k).replace(/\s+/g, ' ').trim() === a) return row[k];
  return undefined;
}
function tarihCoz(v) {
  if (v instanceof Date) return dateStr(v);
  const m = String(v || '').trim().match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  return m ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null;
}
function saatCoz(v) {
  if (v instanceof Date) return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  if (typeof v === 'number') { const t = Math.round(v * 1440); return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; }
  const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad(+m[1])}:${m[2]}` : null;
}
function iceAktar(dosya) {
  Promise.all([xlsxYukle(), dosya.arrayBuffer()]).then(([X, buf]) => {
    const wb = X.read(buf, { type: 'array', cellDates: true });
    const sPers = wb.Sheets['Personel'] || wb.Sheets[wb.SheetNames[0]];
    const sHar = wb.Sheets['Hareketler'];
    const yeniP = [], yeniH = [];
    const adBul = (liste, ad) => liste.find((q) => trKucuk(q.ad) === trKucuk(ad));
    if (sPers) X.utils.sheet_to_json(sPers, { defval: '' }).forEach((row) => {
      const ad = String(hucre(row, ['adı soyadı', 'adi soyadi', 'ad soyad', 'isim soyisim', 'isim']) || row[Object.keys(row)[0]] || '').replace(/\s+/g, ' ').trim();
      if (!ad || adBul(personel, ad) || adBul(yeniP, ad)) return;
      const cins = CINS_GERI[trKucuk(String(hucre(row, ['cinsiyeti', 'cinsiyet']) || '').trim())] || 'Bilinmiyor';
      const pasif = trKucuk(String(hucre(row, ['durumu', 'durum']) || '')).trim() === 'pasif';
      let kart = normUid(hucre(row, ['kart no', 'kartno', 'kart']));
      if (kart && (byKart(kart) || yeniP.some((q) => q.kart === kart) || kart === ADMIN_CARD)) kart = '';
      yeniP.push({ id: newId(), ad, cinsiyet: cins, pasif, kart });
    });
    if (sHar) X.utils.sheet_to_json(sHar, { defval: '', raw: true }).forEach((row) => {
      const ad = String(hucre(row, ['adı soyadı', 'adi soyadi', 'ad soyad']) || '').replace(/\s+/g, ' ').trim();
      const p = adBul(personel, ad) || adBul(yeniP, ad); if (!p) return;
      const date = tarihCoz(hucre(row, ['tarih'])), t = saatCoz(hucre(row, ['saat']));
      const tur = trKucuk(String(hucre(row, ['tür', 'tur']) || '')).trim();
      const type = tur.startsWith('g') ? GIRIS : tur.startsWith('ç') || tur.startsWith('c') ? CIKIS : null;
      if (!date || !t || !type) return;
      const time = t + ':00';
      const ayni = (r) => r.pid === p.id && r.date === date && hm(r.time) === t && r.type === type;
      if (records.some(ayni) || yeniH.some(ayni)) return;
      yeniH.push({ id: newId(), pid: p.id, uid: normUid(hucre(row, ['kart no'])) || p.kart || '', name: p.ad, date, time, type });
    });
    if (!yeniP.length && !yeniH.length) { toast('Dosyada eklenecek yeni kayıt bulunamadı.'); return; }
    onay('İçe Aktar', `${yeniP.length} yeni personel ve ${yeniH.length} yeni hareket kaydı eklensin mi? (Var olan kayıtlar silinmez)`, () => {
      yeniP.forEach((p) => personel.push(p));
      yeniH.forEach((h) => records.push(h));
      kaydetPersonel(); save('pdks_records', records); renderTanim();
      toast(`${yeniP.length} personel, ${yeniH.length} hareket kaydı eklendi.`);
    });
  }).catch((e) => { console.error(e); toast('Dosya okunamadı. Excel (.xlsx) dosyası seçiniz.'); });
}
$('btnDisaAktar').addEventListener('click', disaAktar);
$('btnIceAktar').addEventListener('click', () => { $('inpIceAktar').value = ''; $('inpIceAktar').click(); });
$('inpIceAktar').addEventListener('change', function () { if (this.files && this.files[0]) iceAktar(this.files[0]); });
window.addEventListener('resize', () => { clearTimeout(sigdir.t); sigdir.t = setTimeout(() => sigdir(), 150); });

/* ---------- Hareketler ---------- */
let selPid = null;
function range() {
  const s = $('fStart').value || dateStr();
  let e = $('fEnd').value || s;
  if (s > e) e = s; // başlangıç bitişten büyükse bitiş olarak başlangıcı kullan
  return [s, e];
}
function openHareketler() {
  const t = dateStr();
  $('fStart').value = t; $('fEnd').value = t;
  selPid = null;
  renderPersons();
}
function renderPersons() {
  const [s, e] = range();
  const pids = [...new Set(records.filter((r) => r.date >= s && r.date <= e).map((r) => r.pid))]
    .sort((a, b) => pidName(a).localeCompare(pidName(b), 'tr'));
  if (!pids.includes(selPid)) selPid = pids[0] || null;
  $('perList').innerHTML = pids.map((u) =>
    `<tr data-pid="${esc(u)}" class="${u === selPid ? 'on' : ''}"><td>${esc(pidName(u))}</td><td class="mono">${esc(pidKart(u))}</td></tr>`).join('');
  $('perEmpty').classList.toggle('hidden', pids.length > 0);
  renderMoves();
}
function renderMoves() {
  const [s, e] = range();
  const list = selPid ? records.filter((r) => r.pid === selPid && r.date >= s && r.date <= e).sort(sortRecs) : [];
  $('movList').innerHTML = list.map((r) =>
    `<tr><td>${trDate(r.date)}</td><td>${hm(r.time)}</td><td class="tag ${r.type === GIRIS ? 'g' : 'c'}">${r.type}</td>
     <td class="x"><button class="xbtn" data-rid="${r.id}" title="Sil">✕</button></td></tr>`).join('');
  $('movEmpty').classList.toggle('hidden', list.length > 0);
}
$('perList').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-pid]'); if (!tr) return;
  selPid = tr.dataset.pid;
  document.querySelectorAll('#perList tr').forEach((x) => x.classList.toggle('on', x === tr));
  renderMoves();
});
$('fStart').addEventListener('change', renderPersons);
$('fEnd').addEventListener('change', renderPersons);
$('movList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rid]'); if (!b) return;
  const r = records.find((x) => x.id === b.dataset.rid); if (!r) return;
  confirmBox('Hareket Kaydını Sil', `${pidName(r.pid)} - ${trDate(r.date)} ${hm(r.time)} ${r.type} kaydı silinsin mi?`, 'Sil', () => {
    records = records.filter((x) => x.id !== r.id); save('pdks_records', records); renderPersons();
  });
});
$('btnAdd').addEventListener('click', () => {
  if (!selPid) { toast('Önce üstteki listeden bir personel seçiniz.'); return; }
  const pid = selPid, name = pidName(pid), uid = pidKart(pid);
  const now = new Date();
  const e = range()[1];
  openModal('Hareket Ekle',
    `<div><b>${esc(name)}</b>${uid ? ` <span class="mono">(${esc(uid)})</span>` : ''}</div>
     <label>Tarih</label><input type="date" id="aDate" value="${e < dateStr() ? e : dateStr()}">
     <label>Saat</label><input type="time" id="aTime" value="${pad(now.getHours())}:${pad(now.getMinutes())}">
     <label>Geçiş Türü</label><select id="aType"><option>${GIRIS}</option><option>${CIKIS}</option></select>`,
    'Ekle', () => {
      const date = $('aDate').value, t = $('aTime').value.slice(0, 5), type = $('aType').value;
      if (!date || !t) { toast('Tarih ve saat giriniz.'); return false; }
      if (records.some((r) => r.pid === pid && r.date === date && hm(r.time) === t)) {
        toast('Bu zamana ait bir hareket kaydı zaten var.', 3500);
        return false;
      }
      records.push({ id: newId(), pid, uid, name, date, time: t + ':00', type });
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
$('btnTestVoice').addEventListener('click', () => speak(`Ahmet Yılmaz. ${settings.voiceTime ? hm(timeStr()) + ' ' : ''}giriş`));

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
  const w = el.clientWidth;
  if (!w) return; // ana ekran gizliyken ölçme (genişlik 0 olur); ana ekrana dönünce yeniden hesaplanır
  el.style.fontSize = '100px';
  const sw = el.scrollWidth;
  if (sw) el.style.fontSize = Math.floor(100 * (w * 0.96) / sw) + 'px';
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
  const ro = e.target && e.target.readOnly;
  if ((tag === 'INPUT' && !ro) || tag === 'SELECT' || tag === 'TEXTAREA' || modalOpen()) return;
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
