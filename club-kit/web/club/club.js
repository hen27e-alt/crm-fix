/*!
 * club-kit / club.js  (v1.0.0)
 * Customer club + digital store + orders, as a single ES module with no build step.
 *
 *   import { initClub } from './club/club.js';
 *   const club = initClub({ firebaseConfig, appId: 'bach', region: 'europe-west1',
 *                           brand: { accent: '#C2577A', name: 'פרחי באך' } });
 *
 * Security notes (see README.md):
 *  - No card data ever touches this code. Payment happens on the provider's hosted page.
 *  - The client only sends {productId, qty}. The server is the source of truth for prices.
 *  - All text from users / Firestore is escaped before it reaches innerHTML.
 *  - Client-side `club.has()` is a UX convenience only. Enforce access on the server / in rules.
 *
 * The file has three parts:  (1) helpers  (2) the UI + state machine  (3) backends
 * (real Firebase, then the MOCK section that can be deleted for production).
 */

const FIREBASE_SDK_VERSION = '10.14.1';
const SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/`;

/* ========================================================================== *
 * 1. Helpers
 * ========================================================================== */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefersReducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** https-only URL (payment pages, receipts, images). Returns '' when unsafe. */
function httpsUrl(u) {
  try {
    const x = new URL(String(u), location.href);
    return x.protocol === 'https:' ? x.href : '';
  } catch { return ''; }
}
/** http(s) or relative URL (legal pages). */
function pageUrl(u) {
  try {
    const x = new URL(String(u), location.href);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : '';
  } catch { return ''; }
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
  if (typeof v === 'number') return new Date(v);
  return null;
}

const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = (v) => { const d = toDate(v); return d ? dateFmt.format(d) : ''; };
const fmtDateTime = (v) => { const d = toDate(v); return d ? dateTimeFmt.format(d) : ''; };
const intFmt = new Intl.NumberFormat('he-IL');

/** Agorot (integer) -> "₪49" / "₪49.90" (he-IL). */
function money(agorot) {
  const v = Math.round(Number(agorot) || 0) / 100;
  return new Intl.NumberFormat('he-IL', {
    style: 'currency', currency: 'ILS',
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2,
  }).format(v);
}

/**
 * Normalise a phone number the way an Israeli user types it.
 * 050-123-4567 / 0501234567 / 501234567 / +972501234567 / 00972501234567  ->  +972501234567
 * Other international numbers are accepted when they start with "+".
 * @returns {{ok:boolean, e164?:string}}
 */
export function normalizePhone(raw) {
  const bad = { ok: false };
  let s = String(raw ?? '').trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s\-().־‎‏]/g, '');
  if (!s) return bad;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (/^972\d/.test(s)) s = '+' + s;
  if (s[0] === '+') {
    if (!/^\+[1-9]\d{7,14}$/.test(s)) return bad;
    if (s.startsWith('+972')) {
      const rest = s.slice(4).replace(/^0/, '');
      return /^5\d{8}$/.test(rest) ? { ok: true, e164: '+972' + rest } : bad;
    }
    return { ok: true, e164: s };
  }
  if (/^0\d+$/.test(s)) {
    const rest = s.slice(1);
    return /^5\d{8}$/.test(rest) ? { ok: true, e164: '+972' + rest } : bad;
  }
  if (/^5\d{8}$/.test(s)) return { ok: true, e164: '+972' + s };
  return bad;
}
const prettyPhone = (e164) => String(e164 || '').replace(/^\+972(\d{2})(\d{3})(\d{4})$/, '0$1-$2-$3');

/* ---- colour maths (so the accent can be any brand colour and stay readable) ---- */
function hexToRgb(h) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (!m) return null;
  let x = m[1];
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
}
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
function lum([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function tune(rgb, bg, min, toward) {
  let t = 0, c = rgb;
  while (contrast(c, bg) < min && t < 1) { t += 0.04; c = mixRgb(rgb, toward, t); }
  return c;
}
function pickButton(acc, white, ink) {
  if (contrast(acc, white) >= 4.5) return { bg: acc, on: white };
  if (contrast(acc, ink) >= 4.5) return { bg: acc, on: ink };
  return { bg: tune(acc, white, 4.5, [0, 0, 0]), on: white };
}

/* ---- tiny event emitter ---- */
function makeEmitter() {
  const map = new Map();
  return {
    on(ev, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!map.has(ev)) map.set(ev, new Set());
      map.get(ev).add(fn);
      return () => map.get(ev)?.delete(fn);
    },
    emit(ev, payload) {
      for (const fn of [...(map.get(ev) || [])]) {
        try { fn(payload); } catch (e) { console.error('[club] listener error', e); }
      }
    },
  };
}

/* ---- club.config.json ---- */
const DEFAULT_CONFIG = {
  points: { perShekel: 1 },
  tiers: [
    { id: 'member', label: 'חבר/ה', minSpendAgorot: 0, discountPct: 0 },
    { id: 'silver', label: 'כסף', minSpendAgorot: 20000, discountPct: 5 },
    { id: 'gold', label: 'זהב', minSpendAgorot: 60000, discountPct: 10 },
  ],
};
const TIER_FALLBACK_LABEL = { member: 'חבר/ה', silver: 'כסף', gold: 'זהב' };

function normalizeConfig(raw) {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!raw || typeof raw !== 'object') return base;
  const per = Number(raw.points && raw.points.perShekel ?? raw.pointsPerShekel);
  if (Number.isFinite(per) && per >= 0) base.points.perShekel = per;
  let tiers = raw.tiers;
  if (tiers && !Array.isArray(tiers) && typeof tiers === 'object') {
    tiers = Object.entries(tiers).map(([id, t]) => ({ id, ...t }));
  }
  if (Array.isArray(tiers) && tiers.length) {
    const out = tiers
      .filter((t) => t && typeof t.id === 'string')
      .map((t) => ({
        id: t.id,
        label: String(t.label || TIER_FALLBACK_LABEL[t.id] || t.id),
        minSpendAgorot: Math.max(0, Math.round(Number(t.minSpendAgorot) || 0)),
        discountPct: clamp(Number(t.discountPct) || 0, 0, 100),
        benefits: Array.isArray(t.benefits) ? t.benefits.map(String).slice(0, 8) : [],
      }))
      .sort((a, b) => a.minSpendAgorot - b.minSpendAgorot);
    if (out.length) base.tiers = out;
  }
  base.tiers = base.tiers.map((t) => ({ benefits: [], ...t }));
  return base;
}

/* ---- Hebrew copy (single place) ---- */
const ORDER_STATUS = {
  pending: ['ממתינה לתשלום', 'warn'],
  paid: ['שולמה', 'ok'],
  failed: ['נכשלה', 'bad'],
  cancelled: ['בוטלה', 'bad'],
  refunded: ['זוכתה', 'muted'],
};

function authErrorText(err) {
  const c = (err && err.code) || '';
  switch (c) {
    case 'auth/invalid-phone-number': return 'מספר הטלפון אינו תקין. הזינו מספר נייד ישראלי, למשל 050-1234567.';
    case 'auth/missing-phone-number': return 'הזינו מספר טלפון נייד.';
    case 'auth/too-many-requests': return 'בוצעו יותר מדי ניסיונות. המתינו כמה דקות ונסו שוב.';
    case 'auth/quota-exceeded': return 'שליחת הודעות SMS אינה זמינה כרגע. נסו שוב מאוחר יותר או התחברו עם Google.';
    case 'auth/invalid-verification-code': return 'הקוד שגוי. בדקו את ההודעה שהתקבלה ונסו שוב.';
    case 'auth/missing-verification-code': return 'הזינו את הקוד בן 6 הספרות מההודעה.';
    case 'auth/code-expired': return 'תוקף הקוד פג. בקשו קוד חדש.';
    case 'auth/session-expired': return 'תוקף הקוד פג. בקשו קוד חדש.';
    case 'auth/captcha-check-failed':
    case 'auth/missing-app-credential':
    case 'auth/invalid-app-credential': return 'אימות האבטחה נכשל. רעננו את הדף ונסו שוב.';
    case 'auth/network-request-failed': return 'אין חיבור לרשת. בדקו את החיבור ונסו שוב.';
    case 'auth/popup-blocked': return 'הדפדפן חסם את חלון ההתחברות. אשרו חלונות קופצים ונסו שוב.';
    case 'auth/unauthorized-domain': return 'הדומיין הזה עדיין לא מורשה להתחברות. יש להוסיף אותו ב-Firebase Authentication.';
    case 'auth/operation-not-allowed': return 'שיטת ההתחברות הזו עדיין לא הופעלה באתר.';
    case 'auth/user-disabled': return 'החשבון הזה הושבת. פנו אלינו לבירור.';
    case 'auth/account-exists-with-different-credential': return 'כבר קיים חשבון עם אותו אימייל בשיטת התחברות אחרת.';
    default: return 'ההתחברות לא הצליחה. נסו שוב בעוד רגע.';
  }
}
const SILENT_AUTH_CODES = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);
const HEBREW = /[֐-׿]/;

function checkoutErrorText(err) {
  const code = String((err && err.code) || '').replace(/^functions\//, '');
  const msg = err && err.message;
  // The server sends short, safe Hebrew messages. Prefer them when present.
  if (msg && HEBREW.test(msg) && ['invalid-argument', 'failed-precondition', 'resource-exhausted', 'unauthenticated', 'unavailable', 'not-found'].includes(code)) return msg;
  switch (code) {
    case 'unauthenticated': return 'יש להתחבר כדי להמשיך לתשלום.';
    case 'resource-exhausted': return 'בוצעו יותר מדי ניסיונות תשלום. נסו שוב בעוד שעה.';
    case 'invalid-argument':
    case 'failed-precondition':
    case 'not-found': return 'אחד הפריטים בעגלה אינו זמין יותר. רעננו את החנות ונסו שוב.';
    case 'unavailable':
    case 'deadline-exceeded': return 'שירות התשלום אינו זמין כרגע. נסו שוב בעוד רגע.';
    case 'kc/bad-url':
    case 'kc/bad-response': return 'לא התקבל קישור תשלום תקין. נסו שוב בעוד רגע.';
    default: return 'לא הצלחנו להתחיל את התשלום. לא בוצע חיוב. נסו שוב בעוד רגע.';
  }
}

/* ========================================================================== *
 * 2. UI + state machine
 * ========================================================================== */

const TABS = [
  ['account', 'חשבון', 'user'],
  ['store', 'חנות', 'bag'],
  ['orders', 'הזמנות', 'receipt'],
  ['club', 'מועדון', 'crown'],
];
const TAB_IDS = TABS.map((t) => t[0]);

const ICONS = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  bag: '<path d="M6 7h12l1 13H5L6 7z"/><path d="M9 7V6a3 3 0 0 1 6 0v1"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16v.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  back: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>',
};
const ico = (name, size = 20) =>
  `<svg class="kc-i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
const GOOGLE_G = '<svg class="kc-i" width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

/* ---- CSS (all selectors are .kc- prefixed) ---- */
function buildCss(accentHex) {
  const acc = hexToRgb(accentHex) || hexToRgb('#2f6f5e');
  const W = [255, 255, 255], INK = [28, 27, 31], DBG = [27, 26, 31];
  const btn = pickButton(acc, W, INK);
  const fgL = tune(acc, W, 4.5, [0, 0, 0]);
  const fgD = tune(acc, DBG, 4.5, W);
  const softL = mixRgb(acc, W, 0.88);
  const softD = mixRgb(acc, DBG, 0.82);
  const lightVars = `--kc-accent:${toHex(acc)};--kc-btn:${toHex(btn.bg)};--kc-on-btn:${toHex(btn.on)};--kc-accent-fg:${toHex(fgL)};--kc-accent-soft:${toHex(softL)};`;
  const darkVars = `--kc-bg:#1b1a1f;--kc-surface:#26242b;--kc-surface-2:#2f2d35;--kc-ink:#f2f0f5;--kc-muted:#b4afbd;--kc-line:#3d3a45;--kc-danger:#ff9a90;--kc-danger-bg:rgba(255,154,144,.14);--kc-ok:#86d9a2;--kc-ok-bg:rgba(134,217,162,.14);--kc-warn:#f2c76f;--kc-warn-bg:rgba(242,199,111,.14);--kc-shadow:0 12px 40px rgba(0,0,0,.6);--kc-scrim:rgba(0,0,0,.62);--kc-accent-fg:${toHex(fgD)};--kc-accent-soft:${toHex(softD)};color-scheme:dark;`;
  return `
.kc-root,.kc-fab{${lightVars}
--kc-bg:#ffffff;--kc-surface:#f6f5f7;--kc-surface-2:#ecebef;--kc-ink:#1c1b1f;--kc-muted:#5d5963;--kc-line:#dedbe2;
--kc-danger:#b3261e;--kc-danger-bg:rgba(179,38,30,.09);--kc-ok:#17653a;--kc-ok-bg:rgba(23,101,58,.1);--kc-warn:#80560a;--kc-warn-bg:rgba(128,86,10,.11);
--kc-shadow:0 12px 40px rgba(20,15,30,.28);--kc-scrim:rgba(14,10,22,.5);--kc-radius:16px;
--kc-font:var(--kc-font-family,system-ui,-apple-system,"Segoe UI","Heebo","Assistant",Arial,sans-serif);
direction:rtl;font-family:var(--kc-font);color:var(--kc-ink);line-height:1.5;font-size:16px;-webkit-text-size-adjust:100%;text-align:start}
@media (prefers-color-scheme:dark){.kc-root:not([data-theme="light"]),.kc-fab:not([data-theme="light"]){${darkVars}}}
.kc-root[data-theme="dark"],.kc-fab[data-theme="dark"]{${darkVars}}
.kc-root *,.kc-root *::before,.kc-root *::after{box-sizing:border-box}
.kc-root{position:fixed;inset:0;z-index:2147483000;display:none}
.kc-root[data-open="true"]{display:block}
.kc-backdrop{position:absolute;inset:0;background:var(--kc-scrim);opacity:0;transition:opacity .22s ease}
.kc-open .kc-backdrop{opacity:1}
.kc-sheet{position:absolute;inset-inline:0;bottom:0;margin-inline:auto;width:100%;max-width:520px;height:min(90vh,720px);height:min(90dvh,720px);display:flex;flex-direction:column;background:var(--kc-bg);color:var(--kc-ink);border-radius:22px 22px 0 0;box-shadow:var(--kc-shadow);transform:translateY(28px);opacity:0;transition:transform .26s cubic-bezier(.2,.8,.2,1),opacity .2s ease;outline:none;overflow:hidden}
.kc-open .kc-sheet{transform:none;opacity:1}
@media (min-width:640px){.kc-sheet{bottom:24px;border-radius:22px;height:min(86vh,700px);height:min(86dvh,700px)}}
.kc-grab{flex:none;width:40px;height:4px;border-radius:4px;background:var(--kc-line);margin:8px auto 0}
@media (min-width:640px){.kc-grab{display:none}}
.kc-head{flex:none;display:flex;align-items:center;gap:8px;padding:6px 16px 4px}
.kc-title{flex:1;min-width:0;margin:0;font-size:1.15rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kc-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;border:0;background:transparent;color:var(--kc-ink);cursor:pointer;font:inherit}
.kc-iconbtn:hover{background:var(--kc-surface)}
.kc-tabs{flex:none;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px 12px 0;border-bottom:1px solid var(--kc-line)}
.kc-tab{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:56px;padding:6px 2px 8px;border:0;background:transparent;color:var(--kc-muted);font:inherit;font-size:.8125rem;font-weight:600;cursor:pointer;border-radius:12px 12px 0 0}
.kc-tab[aria-selected="true"]{color:var(--kc-accent-fg)}
.kc-tab[aria-selected="true"]::after{content:"";position:absolute;inset-inline:18%;bottom:-1px;height:3px;border-radius:3px 3px 0 0;background:var(--kc-accent-fg)}
.kc-tab:hover{background:var(--kc-surface)}
.kc-badge{position:absolute;top:4px;inset-inline-end:calc(50% - 22px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--kc-btn);color:var(--kc-on-btn);font-size:.6875rem;line-height:18px;text-align:center}
.kc-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px;-webkit-overflow-scrolling:touch}
.kc-body:focus-visible{outline-offset:-3px}
.kc-recaptcha{position:absolute;width:0;height:0;overflow:hidden}
.kc-root :focus-visible,.kc-fab:focus-visible{outline:3px solid var(--kc-accent-fg);outline-offset:2px}
.kc-h{margin:0 0 4px;font-size:1.25rem;font-weight:700;line-height:1.3}
.kc-h3{margin:0;font-size:1rem;font-weight:700;line-height:1.35}
.kc-p{margin:0 0 12px;color:var(--kc-muted)}
.kc-small{font-size:.8125rem;color:var(--kc-muted)}
.kc-stack{display:flex;flex-direction:column;gap:12px}
.kc-row{display:flex;align-items:center;gap:12px}
.kc-grow{flex:1;min-width:0}
.kc-spread{display:flex;align-items:center;justify-content:space-between;gap:12px}
.kc-sp{height:12px}
.kc-ltr{direction:ltr;unicode-bidi:isolate;display:inline-block}
.kc-i{flex:none}
.kc-card{background:var(--kc-surface);border:1px solid var(--kc-line);border-radius:var(--kc-radius);padding:14px}
.kc-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 20px;border-radius:12px;border:1px solid transparent;font:inherit;font-weight:700;font-size:1rem;cursor:pointer;text-decoration:none;text-align:center;transition:filter .15s,background-color .15s}
.kc-btn[disabled],.kc-btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.kc-btn-primary{background:var(--kc-btn);color:var(--kc-on-btn)}
.kc-btn-primary:not([disabled]):hover{filter:brightness(1.08)}
.kc-btn-ghost{background:var(--kc-bg);border-color:var(--kc-line);color:var(--kc-ink)}
.kc-btn-ghost:not([disabled]):hover{background:var(--kc-surface)}
.kc-btn-danger{background:var(--kc-danger);color:var(--kc-bg)}
.kc-btn-quiet{background:transparent;color:var(--kc-accent-fg);min-height:44px;padding:0 10px}
.kc-btn-quiet:hover{background:var(--kc-accent-soft)}
.kc-btn-block{width:100%}
.kc-btn-sm{min-height:44px;padding:0 14px;font-size:.9375rem}
.kc-field{display:flex;flex-direction:column;gap:6px}
.kc-label{font-weight:600;font-size:.9375rem}
.kc-input{width:100%;min-height:48px;padding:0 14px;border:1px solid var(--kc-line);border-radius:12px;background:var(--kc-bg);color:var(--kc-ink);font:inherit;font-size:1rem}
.kc-input::placeholder{color:var(--kc-muted);opacity:.8}
.kc-input[dir="ltr"]{text-align:left}
.kc-input.kc-code{text-align:center;letter-spacing:.5em;font-size:1.4rem;font-weight:700;padding-inline-start:.5em}
.kc-check{display:flex;align-items:flex-start;gap:12px;min-height:44px;padding:8px 0;cursor:pointer;font-size:.9375rem;line-height:1.5}
.kc-check input{flex:none;width:22px;height:22px;margin:2px 0 0;accent-color:var(--kc-btn);cursor:pointer}
.kc-check a,.kc-link{color:var(--kc-accent-fg);text-decoration:underline;text-underline-offset:3px}
.kc-alert{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:12px;font-size:.9375rem;background:var(--kc-danger-bg);color:var(--kc-danger);border:1px solid color-mix(in srgb,var(--kc-danger) 35%,transparent)}
.kc-alert .kc-i{margin-top:2px}
.kc-alert.kc-info{background:var(--kc-accent-soft);color:var(--kc-ink);border-color:var(--kc-line)}
.kc-alert.kc-warn{background:var(--kc-warn-bg);color:var(--kc-warn);border-color:color-mix(in srgb,var(--kc-warn) 35%,transparent)}
.kc-chip{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:0 10px;border-radius:999px;font-size:.8125rem;font-weight:600;background:var(--kc-surface-2);color:var(--kc-ink);white-space:nowrap}
.kc-chip.kc-ok{background:var(--kc-ok-bg);color:var(--kc-ok)}
.kc-chip.kc-warn{background:var(--kc-warn-bg);color:var(--kc-warn)}
.kc-chip.kc-bad{background:var(--kc-danger-bg);color:var(--kc-danger)}
.kc-chip.kc-muted{background:var(--kc-surface-2);color:var(--kc-muted)}
.kc-chip.kc-accent{background:var(--kc-accent-soft);color:var(--kc-accent-fg)}
.kc-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:var(--kc-btn);color:var(--kc-on-btn);font-weight:700;font-size:1.4rem;overflow:hidden;position:relative}
.kc-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.kc-avatar.kc-sm{width:30px;height:30px;font-size:.95rem}
.kc-hero{display:flex;align-items:center;gap:14px}
.kc-name{margin:0;font-size:1.15rem;font-weight:700;overflow-wrap:anywhere}
.kc-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kc-stat{background:var(--kc-surface);border:1px solid var(--kc-line);border-radius:14px;padding:12px;text-align:start;font:inherit;color:inherit;cursor:pointer;min-height:44px}
.kc-stat:hover{background:var(--kc-surface-2)}
.kc-stat .kc-k{display:block;font-size:.8125rem;color:var(--kc-muted)}
.kc-stat .kc-v{display:block;font-size:1.2rem;font-weight:700}
.kc-switch{flex:none;position:relative;width:52px;height:32px;border-radius:16px;border:0;background:var(--kc-line);cursor:pointer;padding:0;transition:background-color .15s}
.kc-switch::after{content:"";position:absolute;top:4px;inset-inline-start:4px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .15s}
.kc-switch[aria-checked="true"]{background:var(--kc-btn)}
.kc-switch[aria-checked="true"]::after{transform:translateX(-20px)}
.kc-switch-wrap{position:relative;flex:none;display:flex;align-items:center;justify-content:center;min-width:52px;min-height:44px}
.kc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.kc-prod{display:flex;gap:12px;padding:12px;background:var(--kc-surface);border:1px solid var(--kc-line);border-radius:var(--kc-radius)}
.kc-prod-img{flex:none;width:72px;height:72px;border-radius:12px;object-fit:cover;background:var(--kc-surface-2)}
.kc-prod-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.kc-prod-desc{margin:0;font-size:.875rem;color:var(--kc-muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.kc-prod-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto;flex-wrap:wrap}
.kc-price{font-weight:800;font-size:1.1rem}
.kc-stepper{display:inline-flex;align-items:center;border:1px solid var(--kc-line);border-radius:12px;background:var(--kc-bg);overflow:hidden}
.kc-stepper button{width:44px;height:44px;border:0;background:transparent;color:var(--kc-ink);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font:inherit}
.kc-stepper button:hover:not([disabled]){background:var(--kc-surface)}
.kc-stepper button[disabled]{opacity:.35;cursor:not-allowed}
.kc-stepper output{min-width:32px;text-align:center;font-weight:700}
.kc-cartbar{position:sticky;bottom:-16px;margin:16px -16px -16px;padding:12px 16px 16px;background:var(--kc-bg);border-top:1px solid var(--kc-line)}
.kc-line{display:flex;gap:10px;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--kc-line)}
.kc-line:last-child{border-bottom:0}
.kc-sum{display:flex;justify-content:space-between;gap:12px;padding:3px 0}
.kc-sum.kc-total{font-weight:800;font-size:1.1rem;padding-top:10px;margin-top:6px;border-top:1px solid var(--kc-line)}
.kc-progress{height:12px;border-radius:99px;background:var(--kc-surface-2);overflow:hidden}
.kc-progress>i{display:block;height:100%;border-radius:99px;background:var(--kc-btn);transition:width .6s cubic-bezier(.2,.8,.2,1)}
.kc-tiercard{background:linear-gradient(160deg,var(--kc-accent-soft),var(--kc-surface));border:1px solid var(--kc-line);border-radius:20px;padding:18px}
.kc-bigtier{font-size:1.6rem;font-weight:800;line-height:1.2}
.kc-points{font-size:2.2rem;font-weight:800;line-height:1.1}
.kc-ticks{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.kc-ticks li{display:flex;gap:8px;align-items:flex-start}
.kc-ticks .kc-i{color:var(--kc-ok);margin-top:3px}
.kc-tierrow{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:12px;border:1px solid var(--kc-line);border-radius:14px;background:var(--kc-bg)}
.kc-tierrow[aria-current="true"]{border-color:var(--kc-accent-fg);background:var(--kc-accent-soft)}
.kc-order{background:var(--kc-surface);border:1px solid var(--kc-line);border-radius:var(--kc-radius);padding:14px;display:flex;flex-direction:column;gap:8px}
.kc-order ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:.9375rem}
.kc-center{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:24px 8px}
.kc-bubble{display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;border-radius:50%;background:var(--kc-accent-soft);color:var(--kc-accent-fg)}
.kc-bubble.kc-ok{background:var(--kc-ok-bg);color:var(--kc-ok)}
.kc-bubble.kc-bad{background:var(--kc-danger-bg);color:var(--kc-danger)}
.kc-bubble.kc-warn{background:var(--kc-warn-bg);color:var(--kc-warn)}
.kc-spin{display:inline-block;width:22px;height:22px;border-radius:50%;border:3px solid var(--kc-line);border-top-color:var(--kc-accent-fg);animation:kc-rot .8s linear infinite;flex:none}
.kc-spin.kc-lg{width:40px;height:40px;border-width:4px}
.kc-btn-primary .kc-spin{border-color:rgba(255,255,255,.35);border-top-color:var(--kc-on-btn)}
@keyframes kc-rot{to{transform:rotate(360deg)}}
.kc-skel{border-radius:12px;background:linear-gradient(90deg,var(--kc-surface) 25%,var(--kc-surface-2) 50%,var(--kc-surface) 75%);background-size:200% 100%;animation:kc-shim 1.2s linear infinite}
@keyframes kc-shim{to{background-position:-200% 0}}
.kc-toast{position:absolute;inset-inline:16px;bottom:16px;margin-inline:auto;max-width:360px;padding:12px 16px;border-radius:12px;background:var(--kc-ink);color:var(--kc-bg);font-size:.9375rem;box-shadow:var(--kc-shadow);opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .2s,transform .2s;text-align:center}
.kc-toast[data-show="true"]{opacity:1;transform:none}
.kc-divider{height:1px;background:var(--kc-line);margin:4px 0}
.kc-danger-zone{border:1px solid color-mix(in srgb,var(--kc-danger) 40%,transparent);border-radius:var(--kc-radius);padding:14px;background:var(--kc-danger-bg)}
.kc-mockbar{margin:0 0 12px;padding:8px 12px;border-radius:10px;background:var(--kc-warn-bg);color:var(--kc-warn);font-size:.8125rem;font-weight:600}
.kc-fab{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;padding:0 14px;border-radius:999px;border:1px solid var(--kc-line);background:var(--kc-bg);color:var(--kc-ink);font:inherit;font-weight:700;font-size:.9375rem;cursor:pointer;box-shadow:0 2px 10px rgba(20,15,30,.18);vertical-align:middle}
.kc-fab:hover{background:var(--kc-surface)}
.kc-fab.kc-has-avatar{padding:0 7px}
.kc-fab--floating{position:fixed;inset-block-end:16px;inset-inline-end:16px;z-index:2147482000}
.kc-vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){
  .kc-root *,.kc-root *::before,.kc-root *::after{transition-duration:.001ms!important;animation-duration:.001ms!important;animation-iteration-count:1!important}
  .kc-spin{animation:none;border-top-color:var(--kc-accent-fg);border-inline-end-color:var(--kc-accent-fg)}
  .kc-skel{animation:none}
}
@media (max-width:380px){.kc-tab{font-size:.75rem}.kc-btn{padding:0 14px}}
`;
}

/* ---- main entry ---- */
export function initClub(opts = {}) {
  if (typeof document === 'undefined') throw new Error('club.js needs a browser');
  const appId = String(opts.appId || 'app');
  const brand = Object.assign({ name: 'מועדון לקוחות', accent: '#2f6f5e', theme: 'auto' }, opts.brand || {});
  const legal = Object.assign({ terms: 'terms.html', privacy: 'privacy.html', refunds: 'refunds.html' }, opts.legalUrls || {});
  const waitMs = Number.isFinite(opts.checkoutWaitMs) ? opts.checkoutWaitMs : 60000;
  const configUrl = opts.configUrl || new URL('./club.config.json', import.meta.url).href;
  const emitter = makeEmitter();
  const { emit } = emitter;
  const reduced = prefersReducedMotion;

  /* ----- backend selection (real path never touches the mock code) ----- */
  let backend = null;
  let CFG = normalizeConfig(null);
  const mockOpts = opts.mock ? (opts.mock === true ? {} : opts.mock) : null;

  const S = {
    open: false, tab: 'account', authReady: false, initError: '',
    user: null, profile: null, member: null, entList: [], orders: [], ordersState: 'idle',
    products: [], productsState: 'idle',
    cart: {}, storeView: 'list', consent: false, paying: false, payError: '', mockPay: null,
    signin: { step: 'choose', phone: '', code: '', e164: '', terms: false, marketing: false, err: '', busy: '', resendIn: 0 },
    nameDraft: null, nameBusy: false, redirectErr: '',
    checkout: null, pendingReturn: null, afterAuth: null, tierBefore: null,
    deleteStep: 0, deleting: false, deleteErr: '',
  };

  /* ----- storage helpers (never throw) ----- */
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
    lget(k) { try { return localStorage.getItem(k); } catch { return null; } },
    lset(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const CART_KEY = `kc_cart_${appId}`;
  try {
    const saved = JSON.parse(store.lget(CART_KEY) || '{}');
    if (saved && typeof saved === 'object') {
      for (const [id, q] of Object.entries(saved)) {
        const n = Math.round(Number(q));
        if (/^[\w-]{1,80}$/.test(id) && n >= 1 && n <= 10) S.cart[id] = n;
      }
    }
  } catch { /* ignore */ }
  const saveCart = () => store.lset(CART_KEY, JSON.stringify(S.cart));

  /* ----- derived data ----- */
  const tiers = () => CFG.tiers;
  const tierIdx = (id) => Math.max(0, tiers().findIndex((t) => t.id === id));
  const tierOf = (id) => tiers().find((t) => t.id === id) || { id, label: TIER_FALLBACK_LABEL[id] || id || 'חבר/ה', minSpendAgorot: 0, discountPct: 0, benefits: [] };
  const memberTierId = () => (S.member && S.member.tier) || tiers()[0].id;
  const activeFeatures = () => {
    const now = new Date();
    const set = new Set();
    for (const e of S.entList) {
      const exp = toDate(e.expiresAt);
      if (!exp || exp > now) set.add(e.feature || e.id);
    }
    return set;
  };
  const productById = (id) => S.products.find((p) => p.id === id);
  const cartLines = () => Object.entries(S.cart)
    .map(([id, qty]) => ({ id, qty, p: productById(id) }))
    .filter((l) => l.p);
  const cartCount = () => cartLines().reduce((n, l) => n + l.qty, 0);
  const cartSubtotal = () => cartLines().reduce((n, l) => n + l.qty * l.p.priceAgorot, 0);
  const displayName = () => (S.profile && S.profile.displayName) || (S.user && S.user.displayName) || '';
  const greetName = () => displayName() || 'חבר/ה';
  const initialOf = () => {
    const n = displayName().trim();
    if (n) return [...n][0].toUpperCase();
    return S.user ? '★' : '';
  };

  /* ----- styles ----- */
  let styleEl = document.getElementById('kc-style');
  if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'kc-style'; document.head.appendChild(styleEl); }
  styleEl.textContent = buildCss(brand.accent);

  /* ----- DOM ----- */
  let root = null, sheet = null, bodyEl = null, tabsEl = null, titleEl = null, toastEl = null, recaptchaEl = null;
  let lastFocus = null, inerted = [], prevOverflow = '', closeTimer = 0, toastTimer = 0, resendTimer = 0, waitTimer = 0;
  let lastHtml = '', lastViewKey = '', renderQueued = false;
  const fabs = new Set();

  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'kc-root';
    root.dir = 'rtl';
    root.lang = 'he';
    if (brand.theme === 'light' || brand.theme === 'dark') root.dataset.theme = brand.theme;
    root.dataset.open = 'false';
    root.innerHTML = `
      <div class="kc-backdrop" data-act="close"></div>
      <div class="kc-sheet" role="dialog" aria-modal="true" aria-labelledby="kc-title" tabindex="-1">
        <div class="kc-grab" aria-hidden="true"></div>
        <div class="kc-head">
          <h2 class="kc-title" id="kc-title">${esc(brand.name)}</h2>
          <button type="button" class="kc-iconbtn" data-act="close" aria-label="סגירה">${ico('close', 22)}</button>
        </div>
        <div class="kc-tabs" role="tablist" aria-label="אזורי המועדון">
          ${TABS.map(([id, label, icon]) => `<button type="button" role="tab" class="kc-tab" id="kc-tab-${id}" data-tab="${id}" aria-controls="kc-panel" aria-selected="false" tabindex="-1">${ico(icon, 22)}<span>${esc(label)}</span></button>`).join('')}
        </div>
        <div class="kc-body" id="kc-panel" role="tabpanel" tabindex="0"></div>
        <div class="kc-toast" role="status" aria-live="polite" data-show="false"></div>
        <div class="kc-recaptcha" aria-hidden="true"></div>
      </div>`;
    document.body.appendChild(root);
    sheet = root.querySelector('.kc-sheet');
    bodyEl = root.querySelector('.kc-body');
    tabsEl = root.querySelector('.kc-tabs');
    titleEl = root.querySelector('.kc-title');
    toastEl = root.querySelector('.kc-toast');
    recaptchaEl = root.querySelector('.kc-recaptcha');
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('error', onImgError, true);
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.dataset.show = 'false'; }, 3600);
  }

  /* ----- open / close ----- */
  function open(tab) {
    ensureDom();
    if (TAB_IDS.includes(tab)) setTab(tab, false);
    if (!S.open) {
      S.open = true;
      lastFocus = document.activeElement;
      clearTimeout(closeTimer);
      root.dataset.open = 'true';
      prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      inerted = [];
      for (const el of document.body.children) {
        if (el === root || el.hasAttribute('inert') || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        if (el.className && /grecaptcha/i.test(String(el.className))) continue;
        if (el.querySelector && el.querySelector('iframe[src*="recaptcha"]')) continue;
        el.setAttribute('inert', '');
        inerted.push(el);
      }
      requestAnimationFrame(() => { root.classList.add('kc-open'); });
      render(true);
      setTimeout(() => { if (S.open) sheet.focus({ preventScroll: true }); }, 30);
    } else {
      render();
    }
    if (S.tab === 'store') loadProducts();
    emit('open', { tab: S.tab });
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    root.classList.remove('kc-open');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!S.open) root.dataset.open = 'false'; }, reduced() ? 0 : 240);
    document.documentElement.style.overflow = prevOverflow;
    for (const el of inerted) el.removeAttribute('inert');
    inerted = [];
    S.mockPay = null;
    try { if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    emit('close', {});
  }

  function setTab(tab, rerender = true) {
    if (!TAB_IDS.includes(tab)) return;
    if (S.tab !== tab) {
      // leaving a finished checkout screen returns to normal tabs
      if (S.checkout && S.checkout.phase !== 'waiting') S.checkout = null;
      else if (S.checkout) { S.checkout = null; stopWait(); }
      S.mockPay = null;
      if (S.deleteStep) S.deleteStep = 0;
    } else if (S.checkout && S.checkout.phase !== 'waiting') {
      S.checkout = null;
    }
    S.tab = tab;
    if (tab === 'store') loadProducts();
    if (rerender) render();
  }

  /* ----- events ----- */
  function onClick(e) {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn && root.contains(tabBtn)) { setTab(tabBtn.dataset.tab); return; }
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    if (t.disabled || t.getAttribute('aria-disabled') === 'true') return;
    act(t.dataset.act, t.dataset.arg || '', t);
  }
  function onSubmit(e) {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    act(f.dataset.form, '', f);
  }
  function setPath(path, val) {
    const parts = path.split('.');
    let o = S;
    while (parts.length > 1) o = o[parts.shift()];
    o[parts[0]] = val;
  }
  function onInput(e) {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.bind) return;
    const val = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.bind === 'signin.code') {
      const digits = String(val).replace(/\D/g, '').slice(0, 6);
      if (digits !== val) t.value = digits;
      S.signin.code = digits;
      return;
    }
    setPath(t.dataset.bind, val);
    if (t.type === 'checkbox') {
      if (t.dataset.bind === 'signin.terms' && val) S.signin.err = '';
      render();
    }
  }
  function onImgError(e) {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.closest('.kc-root')) img.remove();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const nodes = [...sheet.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')]
        .filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      const a = document.activeElement;
      if (e.shiftKey && (a === first || a === sheet)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      return;
    }
    const tabBtn = e.target.closest && e.target.closest('[role="tab"]');
    if (tabBtn) {
      const i = TAB_IDS.indexOf(tabBtn.dataset.tab);
      let n = -1;
      // RTL: ArrowLeft moves to the next tab visually (towards the left)
      if (e.key === 'ArrowLeft') n = (i + 1) % TAB_IDS.length;
      else if (e.key === 'ArrowRight') n = (i - 1 + TAB_IDS.length) % TAB_IDS.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = TAB_IDS.length - 1;
      if (n >= 0) {
        e.preventDefault();
        setTab(TAB_IDS[n]);
        root.querySelector(`#kc-tab-${TAB_IDS[n]}`).focus();
      }
    }
  }

  /* ----- actions ----- */
  function act(name, arg) {
    switch (name) {
      case 'close': close(); break;
      case 'goto': S.checkout = null; setTab(arg); break;
      case 'google': signInGoogle(); break;
      case 'phone-mode': S.signin.err = ''; S.signin.step = 'phone'; render(); focusSoon('#kc-phone'); break;
      case 'phone-back': S.signin.err = ''; S.signin.step = 'choose'; S.signin.code = ''; stopResend(); render(); break;
      case 'phone-send': phoneSend(false); break;
      case 'phone-resend': phoneSend(true); break;
      case 'phone-change': S.signin.err = ''; S.signin.step = 'phone'; S.signin.code = ''; stopResend(); render(); focusSoon('#kc-phone'); break;
      case 'phone-verify': phoneVerify(); break;
      case 'add': changeQty(arg, +1); break;
      case 'inc': changeQty(arg, +1); break;
      case 'dec': changeQty(arg, -1); break;
      case 'remove': delete S.cart[arg]; saveCart(); emit('cart', { count: cartCount() }); if (!cartLines().length) S.storeView = 'list'; render(); break;
      case 'view-cart': S.storeView = 'cart'; S.payError = ''; render(); break;
      case 'view-store': S.storeView = 'list'; render(); break;
      case 'retry-products': loadProducts(true); break;
      case 'pay': pay(); break;
      case 'need-login': S.afterAuth = 'cart'; setTab('account'); break;
      case 'toggle-marketing': toggleMarketing(); break;
      case 'save-name': saveName(); break;
      case 'signout': doSignOut(); break;
      case 'delete-1': S.deleteStep = 1; S.deleteErr = ''; render(); focusSoon('[data-f="delete-cancel"]'); break;
      case 'delete-cancel': S.deleteStep = 0; S.deleteErr = ''; render(); break;
      case 'delete-confirm': deleteAccount(); break;
      case 'mock-pay': mockPayOutcome(arg); break;
      case 'checkout-done': S.checkout = null; S.storeView = 'list'; render(); break;
      case 'checkout-orders': S.checkout = null; stopWait(); setTab('orders'); break;
      case 'checkout-cart': S.checkout = null; stopWait(); S.tab = 'store'; S.storeView = cartLines().length ? 'cart' : 'list'; render(); break;
      case 'checkout-club': S.checkout = null; stopWait(); setTab('club'); break;
      default: break;
    }
  }
  function focusSoon(sel) {
    setTimeout(() => { const n = bodyEl && bodyEl.querySelector(sel); if (n) n.focus(); }, 20);
  }

  function changeQty(id, delta) {
    const p = productById(id);
    if (!p) return;
    const cur = S.cart[id] || 0;
    const next = clamp(cur + delta, 0, 10);
    if (next === 0) delete S.cart[id]; else S.cart[id] = next;
    saveCart();
    emit('cart', { count: cartCount() });
    if (!cartLines().length) S.storeView = 'list';
    render();
  }

  /* ----- auth ----- */
  function rememberSignup() {
    const v = { terms: !!S.signin.terms, marketing: !!S.signin.marketing, at: Date.now() };
    S.pendingSignup = v;
    store.set('kc_pending_signup', JSON.stringify(v));
  }
  function requireTerms() {
    if (S.signin.terms) return true;
    S.signin.err = 'יש לאשר את תנאי השימוש ומדיניות הפרטיות כדי להמשיך.';
    render();
    focusSoon('[data-f="signin-terms"]');
    return false;
  }
  async function signInGoogle() {
    if (S.signin.busy || !requireTerms()) return;
    S.signin.err = ''; S.signin.busy = 'google'; render();
    rememberSignup();
    try {
      await backend.signInGoogle();
    } catch (err) {
      if (!SILENT_AUTH_CODES.has(err && err.code)) S.signin.err = authErrorText(err);
    }
    S.signin.busy = ''; render();
  }
  async function phoneSend(isResend) {
    if (S.signin.busy) return;
    if (!isResend && !requireTerms()) return;
    const n = normalizePhone(S.signin.phone);
    if (!isResend && !n.ok) {
      S.signin.err = authErrorText({ code: 'auth/invalid-phone-number' });
      render(); focusSoon('#kc-phone');
      return;
    }
    const e164 = isResend ? S.signin.e164 : n.e164;
    S.signin.err = ''; S.signin.busy = isResend ? 'resend' : 'send'; render();
    rememberSignup();
    try {
      await backend.phoneStart(e164, recaptchaEl);
      S.signin.e164 = e164; S.signin.step = 'code'; S.signin.code = '';
      startResend(30);
      S.signin.busy = ''; render(); focusSoon('#kc-code');
      return;
    } catch (err) {
      if (!SILENT_AUTH_CODES.has(err && err.code)) S.signin.err = authErrorText(err);
    }
    S.signin.busy = ''; render();
  }
  async function phoneVerify() {
    if (S.signin.busy) return;
    if (S.signin.code.length !== 6) {
      S.signin.err = authErrorText({ code: 'auth/missing-verification-code' });
      render(); focusSoon('#kc-code');
      return;
    }
    S.signin.err = ''; S.signin.busy = 'verify'; render();
    try {
      await backend.phoneConfirm(S.signin.code);
    } catch (err) {
      S.signin.err = authErrorText(err);
      if (err && (err.code === 'auth/code-expired' || err.code === 'auth/session-expired')) S.signin.code = '';
    }
    S.signin.busy = ''; render();
    if (S.signin.err) focusSoon('#kc-code');
  }
  function startResend(sec) {
    stopResend();
    S.signin.resendIn = sec;
    resendTimer = setInterval(() => {
      S.signin.resendIn = Math.max(0, S.signin.resendIn - 1);
      const b = bodyEl && bodyEl.querySelector('[data-resend]');
      if (b) {
        b.textContent = S.signin.resendIn > 0 ? `שליחה חוזרת בעוד ${S.signin.resendIn} שנ׳` : 'שליחת קוד חדש';
        b.disabled = S.signin.resendIn > 0 || !!S.signin.busy;
      }
      if (S.signin.resendIn <= 0) stopResend();
    }, 1000);
  }
  function stopResend() { clearInterval(resendTimer); resendTimer = 0; }

  async function doSignOut() {
    try { await backend.signOut(); } catch (e) { console.warn('[club] signOut', e); }
    toast('התנתקתם בהצלחה.');
  }

  async function onAuthChange(u) {
    const wasUser = S.user;
    S.user = u;
    if (!S.authReady) { S.authReady = true; }
    if (u) {
      stopResend();
      S.signin = { step: 'choose', phone: '', code: '', e164: '', terms: false, marketing: false, err: '', busy: '', resendIn: 0 };
      attachUserData(u);
      ensureProfile(u);
      if (!wasUser || wasUser.uid !== u.uid) {
        if (S.open && S.tab === 'account') toast(`ברוכים הבאים, ${displayName() || 'חבר/ה'}!`);
        if (S.afterAuth === 'cart') { S.afterAuth = null; S.tab = 'store'; S.storeView = 'cart'; }
      }
    } else {
      detachUserData();
      S.profile = null; S.member = null; S.entList = []; S.orders = []; S.ordersState = 'idle';
      S.deleteStep = 0; S.deleting = false; S.nameDraft = null;
      if (S.checkout && S.checkout.phase === 'waiting') { stopWait(); S.checkout = { phase: 'needsLogin', orderId: S.checkout.orderId }; }
      emit('entitlements', new Set());
      emit('member', null);
      emit('orders', []);
    }
    emit('auth', publicUser());
    updateFabs();
    if (S.pendingReturn && S.authReady) processReturn();
    else if (u && S.checkout && S.checkout.phase === 'needsLogin') { const id = S.checkout.orderId; waitForOrder(id); }
    render();
  }

  const publicUser = () => (S.user ? { ...S.user, displayName: displayName() || S.user.displayName || '' } : null);

  let unsubs = [];
  function detachUserData() { for (const u of unsubs) { try { u(); } catch { /* ignore */ } } unsubs = []; }
  function attachUserData(u) {
    detachUserData();
    const uid = u.uid;
    S.ordersState = 'loading';
    unsubs.push(backend.watchProfile(uid, (p) => { S.profile = p; if (S.nameDraft === null) S.nameDraft = null; scheduleRender(); updateFabs(); }));
    unsubs.push(backend.watchMember(uid, (m) => { S.member = m; emit('member', m ? { ...m } : null); scheduleRender(); }));
    unsubs.push(backend.watchEntitlements(uid, (list) => {
      S.entList = list || [];
      emit('entitlements', activeFeatures());
      scheduleRender();
    }));
    unsubs.push(backend.watchOrders(uid, (list, err) => {
      if (err) { S.ordersState = 'error'; } else { S.orders = list || []; S.ordersState = 'ready'; emit('orders', S.orders.map((o) => ({ ...o }))); }
      scheduleRender();
    }));
  }

  async function ensureProfile(u) {
    let pending = S.pendingSignup;
    if (!pending) { try { pending = JSON.parse(store.get('kc_pending_signup') || 'null'); } catch { pending = null; } }
    S.pendingSignup = null;
    store.del('kc_pending_signup');
    try {
      await backend.ensureProfile(u, { termsAccepted: !!(pending && pending.terms), marketing: !!(pending && pending.marketing) });
    } catch (e) {
      console.warn('[club] ensureProfile failed', e);
    }
  }

  async function toggleMarketing() {
    if (!S.user) return;
    const next = !(S.profile && S.profile.marketingConsent);
    const prev = S.profile;
    S.profile = { ...(S.profile || {}), marketingConsent: next };
    render();
    try {
      await backend.setMarketingConsent(S.user.uid, next);
      toast(next ? 'נרשמתם לקבלת עדכונים.' : 'ההסכמה לדיוור בוטלה.');
    } catch (e) {
      console.warn('[club] marketing', e);
      S.profile = prev;
      render();
      toast('לא הצלחנו לשמור את ההעדפה. נסו שוב.');
    }
  }
  async function saveName() {
    if (!S.user || S.nameBusy) return;
    const v = String(S.nameDraft ?? displayName()).trim().slice(0, 60);
    if (!v) { toast('הזינו שם להצגה.'); return; }
    S.nameBusy = true; render();
    try {
      await backend.setDisplayName(S.user.uid, v);
      S.profile = { ...(S.profile || {}), displayName: v };
      S.nameDraft = null;
      toast('השם עודכן.');
      emit('auth', publicUser());
    } catch (e) {
      console.warn('[club] name', e);
      toast('לא הצלחנו לשמור את השם. נסו שוב.');
    }
    S.nameBusy = false; render(); updateFabs();
  }

  async function deleteAccount() {
    if (S.deleting || !S.user) return;
    S.deleting = true; S.deleteErr = ''; render();
    const u = S.user;
    detachUserData();
    try {
      await backend.deleteAccount();
    } catch (e) {
      console.warn('[club] delete', e);
      S.deleting = false;
      S.deleteErr = 'לא הצלחנו למחוק את החשבון. לא נמחק דבר. נסו שוב בעוד רגע או פנו אלינו.';
      attachUserData(u);
      render();
      return;
    }
    try { await backend.signOut(); } catch { /* the Auth user is already gone */ }
    S.deleting = false; S.deleteStep = 0;
    S.cart = {}; saveCart();
    setTab('account', false);
    render();
    toast('החשבון נמחק. תודה שהייתם איתנו.');
  }

  /* ----- products ----- */
  function normProduct(p) {
    if (!p || typeof p !== 'object') return null;
    const price = Math.round(Number(p.priceAgorot));
    const id = String(p.id || '');
    const name = String(p.name || '').trim();
    if (!id || !name || !(price > 0)) return null;
    return {
      id, name, description: String(p.description || ''), priceAgorot: price,
      grants: Array.isArray(p.grants) ? p.grants.map(String) : [],
      accessDays: Number.isFinite(Number(p.accessDays)) && p.accessDays !== null ? Math.round(Number(p.accessDays)) : null,
      active: p.active !== false, sort: Number.isFinite(Number(p.sort)) ? Number(p.sort) : 0,
      imageUrl: httpsUrl(p.imageUrl || ''),
    };
  }
  async function loadProducts(force) {
    if (!backend) return;
    if (S.productsState === 'loading' || (S.productsState === 'ready' && !force)) return;
    S.productsState = 'loading'; scheduleRender();
    let list = null;
    try { list = await backend.loadProducts(); } catch (e) { console.warn('[club] products', e); list = null; }
    if ((!list || !list.length) && opts.productsFallbackUrl) {
      try {
        const r = await fetch(opts.productsFallbackUrl, { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          const arr = Array.isArray(j) ? j : (j && j.products);
          if (Array.isArray(arr)) list = arr.filter((p) => p && p.active !== false);
        }
      } catch (e) { console.warn('[club] products fallback', e); }
    }
    if (list === null) { S.productsState = 'error'; }
    else {
      S.products = list.map(normProduct).filter(Boolean).filter((p) => p.active).sort((a, b) => a.sort - b.sort);
      S.productsState = 'ready';
      // drop cart lines that no longer exist
      let changed = false;
      for (const id of Object.keys(S.cart)) if (!productById(id)) { delete S.cart[id]; changed = true; }
      if (changed) saveCart();
    }
    scheduleRender();
  }

  /* ----- checkout ----- */
  async function pay() {
    if (S.paying) return;
    if (!S.user) { S.afterAuth = 'cart'; setTab('account'); return; }
    const lines = cartLines();
    if (!lines.length || !S.consent) return;
    S.paying = true; S.payError = ''; render();
    S.tierBefore = memberTierId();
    store.set('kc_tier_before', S.tierBefore);
    try {
      const res = await backend.createCheckout(lines.map((l) => ({ productId: l.id, qty: l.qty })));
      if (!res || !res.orderId || !res.paymentUrl) throw { code: 'kc/bad-response' };
      emit('checkout', { status: 'redirect', orderId: res.orderId });
      if (backend.isMock && String(res.paymentUrl).startsWith('mock:')) {
        S.paying = false;
        S.mockPay = { orderId: res.orderId, total: lines.reduce((n, l) => n + l.qty * l.p.priceAgorot, 0) };
        render();
        return;
      }
      const url = httpsUrl(res.paymentUrl);
      if (!url) throw { code: 'kc/bad-url' };
      location.assign(url);       // `paying` stays true until the page unloads (reset on pageshow)
    } catch (err) {
      console.warn('[club] checkout', err);
      S.paying = false; S.payError = checkoutErrorText(err); render();
    }
  }
  window.addEventListener('pageshow', (e) => { if (e.persisted && S.paying) { S.paying = false; render(); } });

  function mockPayOutcome(outcome) {
    const m = S.mockPay;
    if (!m) return;
    S.mockPay = null;
    if (outcome === 'cancel') {
      handleReturn('cancel', m.orderId);
      return;
    }
    backend.mockSettle(m.orderId, outcome === 'failed' ? 'failed' : 'paid');
    handleReturn('success', m.orderId);
  }

  function handleReturn(status, orderId) {
    S.pendingReturn = { status, orderId };
    if (S.authReady) processReturn();
  }
  function processReturn() {
    const r = S.pendingReturn;
    if (!r) return;
    S.pendingReturn = null;
    S.tab = 'store'; S.storeView = 'list';
    if (!S.tierBefore) S.tierBefore = store.get('kc_tier_before');
    if (r.status === 'cancel') {
      S.checkout = { phase: 'cancel', orderId: r.orderId };
      emit('checkout', { status: 'cancel', orderId: r.orderId });
    } else if (!S.user) {
      S.checkout = { phase: 'needsLogin', orderId: r.orderId };
    } else {
      waitForOrder(r.orderId);
    }
    open('store');
    render(true);
  }
  function stopWait() {
    clearTimeout(waitTimer); waitTimer = 0;
    if (waitUnsub) { try { waitUnsub(); } catch { /* ignore */ } waitUnsub = null; }
  }
  let waitUnsub = null;
  function waitForOrder(orderId) {
    stopWait();
    S.checkout = { phase: 'waiting', orderId, order: null };
    waitTimer = setTimeout(() => {
      if (S.checkout && S.checkout.phase === 'waiting') {
        S.checkout.phase = 'timeout';
        emit('checkout', { status: 'timeout', orderId });
        render();
      }
    }, waitMs);
    waitUnsub = backend.watchOrder(orderId, (order, err) => {
      if (!S.checkout || S.checkout.orderId !== orderId) return;
      if (err) { clearTimeout(waitTimer); S.checkout.phase = 'error'; render(); return; }
      if (!order) return;
      S.checkout.order = order;
      const st = order.status;
      if (st === 'paid') {
        clearTimeout(waitTimer);
        S.checkout.phase = 'paid';
        S.cart = {}; saveCart(); emit('cart', { count: 0 });
        emit('checkout', { status: 'paid', orderId });
      } else if (st === 'failed' || st === 'cancelled') {
        clearTimeout(waitTimer);
        S.checkout.phase = 'failed';
        emit('checkout', { status: st, orderId });
      } else if (st === 'refunded') {
        clearTimeout(waitTimer);
        S.checkout.phase = 'refunded';
      }
      render();
    });
  }
  function readReturnParams() {
    let q;
    try { q = new URLSearchParams(location.search); } catch { return null; }
    const c = q.get('checkout');
    if (c !== 'success' && c !== 'cancel') return null;
    const id = q.get('order') || '';
    q.delete('checkout'); q.delete('order');
    try {
      const qs = q.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch { /* ignore */ }
    if (c === 'success' && !/^[A-Za-z0-9_-]{4,128}$/.test(id)) return { status: 'cancel-invalid' };
    return { status: c, orderId: /^[A-Za-z0-9_-]{4,128}$/.test(id) ? id : '' };
  }

  /* ----- rendering ----- */
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    Promise.resolve().then(() => { renderQueued = false; render(); });
  }

  function currentView() {
    if (S.checkout) return 'checkout:' + S.checkout.phase;
    if (S.tab === 'account') return 'account:' + (S.user ? 'in' : S.signin.step) + (S.deleteStep ? ':del' : '');
    if (S.tab === 'store') return 'store:' + (S.mockPay ? 'mockpay' : S.storeView);
    return S.tab;
  }

  function render(force) {
    if (!S.open || !bodyEl) { updateFabs(); return; }
    // tabs
    for (const b of tabsEl.querySelectorAll('[data-tab]')) {
      const sel = b.dataset.tab === S.tab;
      b.setAttribute('aria-selected', sel ? 'true' : 'false');
      b.tabIndex = sel ? 0 : -1;
      if (sel) bodyEl.setAttribute('aria-labelledby', b.id);
    }
    let badge = tabsEl.querySelector('.kc-badge');
    const n = cartCount();
    if (n > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'kc-badge'; tabsEl.querySelector('#kc-tab-store').appendChild(badge); }
      badge.textContent = String(n);
      badge.setAttribute('aria-label', `${n} פריטים בעגלה`);
    } else if (badge) badge.remove();

    const viewKey = currentView();
    const html = renderBody();
    if (!force && html === lastHtml && viewKey === lastViewKey) return;

    const a = document.activeElement;
    const inBody = a && bodyEl.contains(a);
    const fkey = inBody && a.dataset ? a.dataset.f : null;
    const selStart = inBody && 'selectionStart' in a ? a.selectionStart : null;
    const selEnd = inBody && 'selectionEnd' in a ? a.selectionEnd : null;
    const scroll = bodyEl.scrollTop;

    bodyEl.innerHTML = html;
    lastHtml = html;
    const viewChanged = viewKey !== lastViewKey;
    lastViewKey = viewKey;
    bodyEl.scrollTop = viewChanged ? 0 : scroll;

    if (inBody) {
      let target = fkey ? bodyEl.querySelector(`[data-f="${CSS.escape(fkey)}"]`) : null;
      if (target) {
        target.focus({ preventScroll: true });
        try { if (selStart !== null && target.setSelectionRange && target.type !== 'checkbox') target.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
      } else {
        target = bodyEl.querySelector('[data-autofocus]') || bodyEl;
        target.focus({ preventScroll: true });
      }
    }
    if (viewChanged && S.checkout && S.checkout.phase !== 'waiting') {
      const h = bodyEl.querySelector('[data-autofocus]');
      if (h) h.focus({ preventScroll: true });
    }
    updateFabs();
  }

  const btn = (label, act_, o = {}) =>
    `<button type="${o.submit ? 'submit' : 'button'}" class="kc-btn ${o.cls || 'kc-btn-primary'}${o.block ? ' kc-btn-block' : ''}"${act_ ? ` data-act="${esc(act_)}"` : ''}${o.arg ? ` data-arg="${esc(o.arg)}"` : ''}${o.f ? ` data-f="${esc(o.f)}"` : ''}${o.disabled ? ' disabled' : ''}${o.attrs ? ' ' + o.attrs : ''}>${o.busy ? '<span class="kc-spin" aria-hidden="true"></span>' : ''}${o.icon ? ico(o.icon) : ''}<span>${esc(label)}</span></button>`;
  const alertBox = (msg, kind = '') => msg ? `<div class="kc-alert ${kind}" role="${kind === 'kc-info' ? 'status' : 'alert'}">${ico(kind === 'kc-info' ? 'info' : 'alert')}<div>${esc(msg)}</div></div>` : '';
  const mockBar = () => (backend && backend.isMock ? '<div class="kc-mockbar">מצב הדגמה: אין חיבור לשרת, הנתונים נשמרים בזיכרון בלבד.</div>' : '');
  const legalLink = (k, label) => `<a href="${esc(pageUrl(legal[k]) || '#')}" target="_blank" rel="noopener">${esc(label)}</a>`;

  function renderBody() {
    if (S.initError) {
      return `<div class="kc-center" data-autofocus tabindex="-1"><div class="kc-bubble kc-bad">${ico('alert', 32)}</div><h3 class="kc-h">שירות ההתחברות לא נטען</h3><p class="kc-p">${esc(S.initError)}</p>${btn('רענון הדף', 'reload', { cls: 'kc-btn-ghost' })}</div>`;
    }
    if (S.checkout) return mockBar() + renderCheckout();
    switch (S.tab) {
      case 'store': return mockBar() + renderStore();
      case 'orders': return mockBar() + renderOrders();
      case 'club': return mockBar() + renderClub();
      default: return mockBar() + renderAccount();
    }
  }

  /* -- account -- */
  function renderAccount() {
    if (!S.authReady) {
      return `<div class="kc-stack" aria-busy="true" aria-label="טוען"><div class="kc-skel" style="height:28px;width:55%"></div><div class="kc-skel" style="height:48px"></div><div class="kc-skel" style="height:48px"></div></div>`;
    }
    if (!S.user) return renderSignIn();
    return renderProfile();
  }

  function renderSignIn() {
    const s = S.signin;
    const err = alertBox(S.redirectErr || s.err);
    if (s.step === 'phone') {
      return `<form class="kc-stack" data-form="phone-send" novalidate>
        <button type="button" class="kc-btn kc-btn-quiet" style="align-self:flex-start" data-act="phone-back" data-f="back">${ico('back')}<span>חזרה</span></button>
        <div><h3 class="kc-h" data-autofocus tabindex="-1">התחברות עם טלפון</h3><p class="kc-p">נשלח אליכם קוד אימות ב-SMS למספר הנייד.</p></div>
        <div class="kc-field">
          <label class="kc-label" for="kc-phone">מספר טלפון נייד</label>
          <input class="kc-input" id="kc-phone" data-f="phone" data-bind="signin.phone" type="tel" dir="ltr" inputmode="tel" autocomplete="tel" placeholder="050-1234567" value="${esc(s.phone)}" aria-describedby="kc-phone-hint"${s.err ? ' aria-invalid="true"' : ''}>
          <span class="kc-small" id="kc-phone-hint">אפשר להזין גם עם קידומת +972.</span>
        </div>
        ${err}
        ${termsBlock()}
        ${btn(s.busy === 'send' ? 'שולחים קוד…' : 'שליחת קוד', '', { submit: true, block: true, busy: s.busy === 'send', disabled: !!s.busy, f: 'send' })}
      </form>`;
    }
    if (s.step === 'code') {
      const canResend = s.resendIn <= 0 && !s.busy;
      return `<form class="kc-stack" data-form="phone-verify" novalidate>
        <button type="button" class="kc-btn kc-btn-quiet" style="align-self:flex-start" data-act="phone-change" data-f="back">${ico('back')}<span>החלפת מספר</span></button>
        <div><h3 class="kc-h" data-autofocus tabindex="-1">הזינו את הקוד</h3><p class="kc-p">שלחנו קוד בן 6 ספרות אל <span class="kc-ltr">${esc(prettyPhone(s.e164))}</span>.</p></div>
        <div class="kc-field">
          <label class="kc-label" for="kc-code">קוד אימות</label>
          <input class="kc-input kc-code" id="kc-code" data-f="code" data-bind="signin.code" type="text" dir="ltr" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" value="${esc(s.code)}"${s.err ? ' aria-invalid="true"' : ''}>
        </div>
        ${err}
        ${btn(s.busy === 'verify' ? 'מאמתים…' : 'אימות והתחברות', '', { submit: true, block: true, busy: s.busy === 'verify', disabled: !!s.busy, f: 'verify' })}
        <button type="button" class="kc-btn kc-btn-ghost kc-btn-block" data-act="phone-resend" data-resend data-f="resend"${canResend ? '' : ' disabled'}>${s.resendIn > 0 ? `שליחה חוזרת בעוד ${s.resendIn} שנ׳` : 'שליחת קוד חדש'}</button>
        ${backend && backend.isMock ? '<p class="kc-small">הדגמה: הקוד הוא 123456.</p>' : ''}
      </form>`;
    }
    return `<div class="kc-stack">
      <div><h3 class="kc-h" data-autofocus tabindex="-1">ברוכים הבאים למועדון</h3><p class="kc-p">התחברו כדי לצבור נקודות, לקנות ולעקוב אחרי ההזמנות שלכם.</p></div>
      ${termsBlock()}
      ${err}
      ${btn(s.busy === 'google' ? 'מתחברים…' : 'המשך עם Google', 'google', { cls: 'kc-btn-ghost', block: true, busy: s.busy === 'google', disabled: !!s.busy, f: 'google', icon: '' }).replace('<span>', GOOGLE_G + '<span>')}
      ${btn('המשך עם מספר טלפון', 'phone-mode', { cls: 'kc-btn-primary', block: true, icon: 'phone', disabled: !!s.busy, f: 'phone-mode' })}
      <p class="kc-small">אין צורך בסיסמה. פרטי תשלום לא נשמרים אצלנו.</p>
    </div>`;
  }
  function termsBlock() {
    const s = S.signin;
    return `<div>
      <label class="kc-check"><input type="checkbox" data-bind="signin.terms" data-f="signin-terms"${s.terms ? ' checked' : ''}${s.err && !s.terms ? ' aria-invalid="true"' : ''}><span>קראתי ואני מסכים/ה ל${legalLink('terms', 'תנאי השימוש')} ול${legalLink('privacy', 'מדיניות הפרטיות')}.</span></label>
      <label class="kc-check"><input type="checkbox" data-bind="signin.marketing" data-f="signin-marketing"${s.marketing ? ' checked' : ''}><span>אשמח לקבל עדכונים ומבצעים (לא חובה, אפשר לבטל בכל עת).</span></label>
    </div>`;
  }

  function renderProfile() {
    const u = S.user;
    const t = tierOf(memberTierId());
    const pts = (S.member && S.member.points) || 0;
    const marketing = !!(S.profile && S.profile.marketingConsent);
    const contact = u.email || prettyPhone(u.phoneNumber) || '';
    const draft = S.nameDraft === null ? displayName() : S.nameDraft;
    const ents = [...S.entList].filter((e) => { const x = toDate(e.expiresAt); return !x || x > new Date(); });
    const photo = httpsUrl(u.photoURL || '');
    return `<div class="kc-stack">
      <div class="kc-hero">
        <span class="kc-avatar" aria-hidden="true">${esc(initialOf())}${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : ''}</span>
        <div class="kc-grow"><h3 class="kc-name" data-autofocus tabindex="-1">${esc(greetName())}</h3><div class="kc-small"><span class="${u.email ? '' : 'kc-ltr'}">${esc(contact)}</span></div></div>
      </div>
      <div class="kc-stats">
        <button type="button" class="kc-stat" data-act="goto" data-arg="club" data-f="stat-tier"><span class="kc-k">דרגה</span><span class="kc-v">${esc(t.label)}</span></button>
        <button type="button" class="kc-stat" data-act="goto" data-arg="club" data-f="stat-points"><span class="kc-k">נקודות</span><span class="kc-v">${esc(intFmt.format(pts))}</span></button>
      </div>
      <form class="kc-card kc-stack" data-form="save-name" novalidate>
        <div class="kc-field">
          <label class="kc-label" for="kc-name">שם להצגה</label>
          <input class="kc-input" id="kc-name" data-f="name" data-bind="nameDraft" maxlength="60" autocomplete="name" value="${esc(draft)}" placeholder="איך לפנות אליכם?">
        </div>
        ${btn(S.nameBusy ? 'שומרים…' : 'שמירת שם', '', { submit: true, cls: 'kc-btn-ghost kc-btn-sm', busy: S.nameBusy, disabled: S.nameBusy, f: 'save-name' })}
      </form>
      <div class="kc-card">
        <h3 class="kc-h3" style="margin-bottom:8px">מה פתוח אצלכם</h3>
        ${ents.length ? `<ul class="kc-list">${ents.map((e) => {
          const exp = toDate(e.expiresAt);
          return `<li class="kc-spread"><span class="kc-chip kc-accent kc-ltr">${esc(e.feature || e.id)}</span><span class="kc-small">${exp ? 'עד ' + esc(fmtDate(exp)) : 'ללא הגבלת זמן'}</span></li>`;
        }).join('')}</ul>` : `<p class="kc-p" style="margin:0">עדיין אין תכנים שנפתחו. רכישה בחנות תפתח אותם כאן.</p>`}
      </div>
      <div class="kc-card kc-spread">
        <div class="kc-grow"><div class="kc-label" id="kc-mk-l">עדכונים ומבצעים</div><div class="kc-small" id="kc-mk-d">קבלת הודעות שיווקיות. אפשר לשנות בכל רגע.</div></div>
        <span class="kc-switch-wrap"><button type="button" class="kc-switch" role="switch" aria-checked="${marketing}" aria-labelledby="kc-mk-l" aria-describedby="kc-mk-d" data-act="toggle-marketing" data-f="marketing"></button></span>
      </div>
      ${btn('התנתקות', 'signout', { cls: 'kc-btn-ghost', block: true, icon: 'logout', f: 'signout' })}
      <div class="kc-divider"></div>
      ${renderDelete()}
    </div>`;
  }
  function renderDelete() {
    if (S.deleteStep === 1) {
      return `<div class="kc-danger-zone kc-stack" role="group" aria-labelledby="kc-del-h">
        <h3 class="kc-h3" id="kc-del-h">למחוק את החשבון לצמיתות?</h3>
        <p class="kc-p" style="margin:0;color:var(--kc-ink)">הפעולה אינה הפיכה. יימחקו הפרופיל, חברות המועדון, הנקודות והגישה לתכנים שרכשתם. הזמנות נשמרות ללא פרטים מזהים, כנדרש לצורכי חשבונאות.</p>
        ${alertBox(S.deleteErr)}
        <div class="kc-stack" style="gap:8px">
          ${btn(S.deleting ? 'מוחקים…' : 'כן, למחוק את החשבון שלי', 'delete-confirm', { cls: 'kc-btn-danger', block: true, busy: S.deleting, disabled: S.deleting, icon: S.deleting ? '' : 'trash', f: 'delete-confirm' })}
          ${btn('ביטול, להשאיר את החשבון', 'delete-cancel', { cls: 'kc-btn-ghost', block: true, disabled: S.deleting, f: 'delete-cancel' })}
        </div>
      </div>`;
    }
    return `<div class="kc-stack" style="gap:6px"><span class="kc-small">אזור רגיש</span>${btn('מחיקת החשבון', 'delete-1', { cls: 'kc-btn-ghost', block: true, icon: 'trash', f: 'delete-1' })}</div>`;
  }

  /* -- store -- */
  function accessChip(p) {
    return p.accessDays ? `גישה ל-${p.accessDays} ימים` : 'גישה ללא הגבלת זמן';
  }
  function isOwned(p) {
    if (p.accessDays || !p.grants.length) return false;
    const act_ = activeFeatures();
    const permanent = new Set(S.entList.filter((e) => !toDate(e.expiresAt)).map((e) => e.feature || e.id));
    return p.grants.every((g) => act_.has(g) && permanent.has(g));
  }
  function renderStore() {
    if (S.mockPay) return renderMockPay();
    if (S.productsState === 'idle' || S.productsState === 'loading') {
      return `<div class="kc-stack" aria-busy="true"><div class="kc-skel" style="height:104px"></div><div class="kc-skel" style="height:104px"></div><div class="kc-skel" style="height:104px"></div></div>`;
    }
    if (S.productsState === 'error') {
      return `<div class="kc-center"><div class="kc-bubble kc-warn">${ico('alert', 32)}</div><h3 class="kc-h" data-autofocus tabindex="-1">לא הצלחנו לטעון את החנות</h3><p class="kc-p">בדקו את החיבור לרשת ונסו שוב.</p>${btn('ניסיון חוזר', 'retry-products', { cls: 'kc-btn-ghost', f: 'retry' })}</div>`;
    }
    if (!S.products.length) {
      return `<div class="kc-center"><div class="kc-bubble">${ico('bag', 32)}</div><h3 class="kc-h" data-autofocus tabindex="-1">החנות בהכנה</h3><p class="kc-p">עדיין אין מוצרים זמינים לרכישה. נעדכן כאן ברגע שהחנות תיפתח.</p></div>`;
    }
    if (S.storeView === 'cart' && cartLines().length) return renderCart();
    const n = cartCount();
    return `<div class="kc-stack">
      <h3 class="kc-h" data-autofocus tabindex="-1">החנות</h3>
      <ul class="kc-list">${S.products.map(productCard).join('')}</ul>
      ${n ? `<div class="kc-cartbar">${btn(`צפייה בעגלה · ${n} ${n === 1 ? 'פריט' : 'פריטים'} · ${money(cartSubtotal())}`, 'view-cart', { block: true, icon: 'bag', f: 'view-cart' })}</div>` : ''}
    </div>`;
  }
  function productCard(p) {
    const q = S.cart[p.id] || 0;
    const owned = isOwned(p);
    return `<li class="kc-prod">
      ${p.imageUrl ? `<img class="kc-prod-img" src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="kc-prod-main">
        <h4 class="kc-h3">${esc(p.name)}</h4>
        ${p.description ? `<p class="kc-prod-desc">${esc(p.description)}</p>` : ''}
        <div><span class="kc-chip kc-muted">${esc(accessChip(p))}</span></div>
        <div class="kc-prod-foot">
          <span class="kc-price">${esc(money(p.priceAgorot))}</span>
          ${owned ? `<span class="kc-chip kc-ok">${ico('check', 14)}כבר ברשותכם</span>`
            : q ? stepper(p, q)
            : btn('הוספה לעגלה', 'add', { arg: p.id, cls: 'kc-btn-primary kc-btn-sm', icon: 'plus', f: 'add:' + p.id, attrs: `aria-label="${esc('הוספת ' + p.name + ' לעגלה')}"` })}
        </div>
      </div>
    </li>`;
  }
  function stepper(p, q) {
    return `<div class="kc-stepper" role="group" aria-label="${esc('כמות: ' + p.name)}">
      <button type="button" data-act="inc" data-arg="${esc(p.id)}" data-f="inc:${esc(p.id)}" aria-label="${esc('הוספת יחידה: ' + p.name)}"${q >= 10 ? ' disabled' : ''}>${ico('plus', 18)}</button>
      <output aria-live="polite">${q}</output>
      <button type="button" data-act="dec" data-arg="${esc(p.id)}" data-f="dec:${esc(p.id)}" aria-label="${esc(q === 1 ? 'הסרה מהעגלה: ' + p.name : 'הפחתת יחידה: ' + p.name)}">${ico(q === 1 ? 'trash' : 'minus', 18)}</button>
    </div>`;
  }
  function renderCart() {
    const lines = cartLines();
    const sub = cartSubtotal();
    const t = tierOf(memberTierId());
    const estDisc = S.user && t.discountPct > 0 ? Math.round(sub * t.discountPct / 100) : 0;
    const total = sub - estDisc;
    const ready = !!S.consent && !S.paying;
    return `<div class="kc-stack">
      <button type="button" class="kc-btn kc-btn-quiet" style="align-self:flex-start" data-act="view-store" data-f="back">${ico('back')}<span>חזרה לחנות</span></button>
      <h3 class="kc-h" data-autofocus tabindex="-1">העגלה שלכם</h3>
      <div class="kc-card" style="padding-block:4px">
        ${lines.map((l) => `<div class="kc-line">
          <div class="kc-grow"><div class="kc-h3">${esc(l.p.name)}</div><div class="kc-small">${esc(money(l.p.priceAgorot))} ליחידה</div></div>
          ${stepper(l.p, l.qty)}
          <div style="min-width:64px;text-align:end;font-weight:700">${esc(money(l.qty * l.p.priceAgorot))}</div>
        </div>`).join('')}
      </div>
      <div>
        <div class="kc-sum"><span>סכום ביניים</span><span>${esc(money(sub))}</span></div>
        ${estDisc ? `<div class="kc-sum"><span>הנחת דרגת ${esc(t.label)} (${esc(String(t.discountPct))}%)</span><span>−${esc(money(estDisc))}</span></div>` : ''}
        <div class="kc-sum kc-total"><span>${S.user ? 'לתשלום (משוער)' : 'סה״כ'}</span><span>${esc(money(total))}</span></div>
        <p class="kc-small" style="margin:6px 0 0">${S.user ? 'הסכום הסופי, כולל הנחת המועדון, מחושב בשרת ומוצג בעמוד התשלום.' : 'התחברו כדי שהנחת המועדון תחושב בעת התשלום.'} המחירים כוללים מע״מ.</p>
      </div>
      <label class="kc-check"><input type="checkbox" data-bind="consent" data-f="consent"${S.consent ? ' checked' : ''}><span>קראתי ואני מסכים/ה ל${legalLink('terms', 'תנאי השימוש')}, ל${legalLink('privacy', 'מדיניות הפרטיות')} ול${legalLink('refunds', 'מדיניות הביטולים וההחזרים')}. ידוע לי שמדובר במוצרים דיגיטליים.</span></label>
      ${alertBox(S.payError)}
      ${S.user
        ? btn(S.paying ? 'מעבירים לעמוד התשלום…' : 'המשך לתשלום', 'pay', { block: true, busy: S.paying, disabled: !ready, f: 'pay', icon: S.paying ? '' : 'lock' })
        : btn('התחברות להמשך לתשלום', 'need-login', { block: true, f: 'need-login' })}
      ${S.user && !S.consent ? '<p class="kc-small" style="margin:-4px 0 0">סמנו את תיבת האישור כדי להמשיך.</p>' : ''}
      <p class="kc-small" style="margin:0">התשלום מתבצע בעמוד מאובטח של ספק הסליקה. פרטי הכרטיס אינם עוברים דרכנו.</p>
    </div>`;
  }

  /* -- checkout result screens -- */
  function renderCheckout() {
    const c = S.checkout;
    switch (c.phase) {
      case 'waiting':
        return `<div class="kc-center" role="status"><span class="kc-spin kc-lg" aria-hidden="true"></span><h3 class="kc-h" data-autofocus tabindex="-1">מאשרים את התשלום…</h3><p class="kc-p">זה לוקח בדרך כלל כמה שניות. אפשר להישאר בדף.</p></div>`;
      case 'timeout':
        return `<div class="kc-center"><div class="kc-bubble kc-warn">${ico('clock', 32)}</div><h3 class="kc-h" data-autofocus tabindex="-1">התשלום עדיין בבדיקה</h3><p class="kc-p">אישור התשלום מתעכב. אין צורך לשלם שוב ולא יתבצע חיוב כפול. ברגע שיאושר, ההזמנה תתעדכן אצלכם.</p>${btn('בדיקת ההזמנות שלי', 'checkout-orders', { f: 'orders' })}</div>`;
      case 'paid': {
        const o = c.order || {};
        const pts = (S.member && S.member.points) || 0;
        const up = S.tierBefore && tierIdx(memberTierId()) > tierIdx(S.tierBefore);
        const rec = httpsUrl(o.receiptUrl || '');
        return `<div class="kc-stack">
          <div class="kc-center" style="padding-bottom:0"><div class="kc-bubble kc-ok">${ico('check', 36)}</div><h3 class="kc-h" data-autofocus tabindex="-1">התשלום התקבל, תודה!</h3><p class="kc-p" style="margin:0">המוצרים נפתחו בחשבון שלכם.</p></div>
          ${up ? `<div class="kc-alert kc-info" role="status">${ico('star')}<div>עליתם לדרגת <strong>${esc(tierOf(memberTierId()).label)}</strong>. מזל טוב!</div></div>` : ''}
          <div class="kc-card">
            ${(o.items || []).map((it) => `<div class="kc-sum"><span>${esc(it.name)} × ${esc(String(it.qty))}</span><span>${esc(money(it.priceAgorot * it.qty))}</span></div>`).join('')}
            ${o.discountAgorot ? `<div class="kc-sum"><span>הנחת מועדון</span><span>−${esc(money(o.discountAgorot))}</span></div>` : ''}
            <div class="kc-sum kc-total"><span>שולם</span><span>${esc(money(o.totalAgorot))}</span></div>
          </div>
          <div class="kc-small" role="status">נקודות במועדון: <strong>${esc(intFmt.format(pts))}</strong> · דרגה: <strong>${esc(tierOf(memberTierId()).label)}</strong></div>
          ${rec ? `<a class="kc-btn kc-btn-ghost kc-btn-block" href="${esc(rec)}" target="_blank" rel="noopener">${ico('external')}<span>צפייה בקבלה</span></a>` : ''}
          ${btn('ההזמנות שלי', 'checkout-orders', { block: true, f: 'orders' })}
          ${btn('למועדון שלי', 'checkout-club', { cls: 'kc-btn-ghost', block: true, f: 'club' })}
          ${btn('חזרה לחנות', 'checkout-done', { cls: 'kc-btn-quiet', block: true, f: 'done' })}
        </div>`;
      }
      case 'failed':
      case 'refunded':
        return `<div class="kc-center"><div class="kc-bubble kc-bad">${ico('alert', 32)}</div><h3 class="kc-h" data-autofocus tabindex="-1">${c.phase === 'refunded' ? 'ההזמנה זוכתה' : 'התשלום לא הושלם'}</h3><p class="kc-p">${c.phase === 'refunded' ? 'הסכום הוחזר לאמצעי התשלום. פרטים בהזמנות שלי.' : 'לא בוצע חיוב. אפשר לנסות שוב, או להשתמש באמצעי תשלום אחר.'}</p>${c.phase === 'failed' ? btn('חזרה לעגלה', 'checkout-cart', { f: 'cart' }) : btn('ההזמנות שלי', 'checkout-orders', { f: 'orders' })}</div>`;
      case 'cancel':
        return `<div class="kc-center"><div class="kc-bubble kc-warn">${ico('info', 32)}</div><h3 class="kc-h" data-autofocus tabindex="-1">התשלום בוטל</h3><p class="kc-p">לא בוצע חיוב. העגלה נשמרה, אפשר להמשיך מאיפה שעצרתם.</p>${btn(cartLines().length ? 'חזרה לעגלה' : 'חזרה לחנות', 'checkout-cart', { f: 'cart' })}</div>`;
      case 'needsLogin':
        return `<div class="kc-center"><div class="kc-bubble">${ico('lock', 30)}</div><h3 class="kc-h" data-autofocus tabindex="-1">התחברו כדי לראות את ההזמנה</h3><p class="kc-p">כדי להציג את מצב התשלום צריך להתחבר לאותו חשבון שבו בוצעה ההזמנה.</p>${btn('התחברות', 'goto', { arg: 'account', f: 'login' })}</div>`;
      default:
        return `<div class="kc-center"><div class="kc-bubble kc-warn">${ico('alert', 32)}</div><h3 class="kc-h" data-autofocus tabindex="-1">לא הצלחנו לקרוא את ההזמנה</h3><p class="kc-p">בדקו בהזמנות שלי. אם התשלום בוצע, ההזמנה תופיע שם בעוד רגע.</p>${btn('ההזמנות שלי', 'checkout-orders', { f: 'orders' })}</div>`;
    }
  }

  /* -- orders -- */
  function loginPrompt(title, text) {
    return `<div class="kc-center"><div class="kc-bubble">${ico('lock', 30)}</div><h3 class="kc-h" data-autofocus tabindex="-1">${esc(title)}</h3><p class="kc-p">${esc(text)}</p>${btn('התחברות', 'goto', { arg: 'account', f: 'login' })}</div>`;
  }
  function renderOrders() {
    if (!S.authReady) return '<div class="kc-skel" style="height:120px"></div>';
    if (!S.user) return loginPrompt('ההזמנות שלכם', 'התחברו כדי לראות את היסטוריית ההזמנות והקבלות.');
    if (S.ordersState === 'loading') return `<div class="kc-stack" aria-busy="true"><div class="kc-skel" style="height:120px"></div><div class="kc-skel" style="height:120px"></div></div>`;
    if (S.ordersState === 'error') return `<div class="kc-center"><div class="kc-bubble kc-warn">${ico('alert', 32)}</div><h3 class="kc-h" data-autofocus tabindex="-1">לא הצלחנו לטעון הזמנות</h3><p class="kc-p">נסו לרענן את הדף בעוד רגע.</p></div>`;
    if (!S.orders.length) return `<div class="kc-center"><div class="kc-bubble">${ico('receipt', 32)}</div><h3 class="kc-h" data-autofocus tabindex="-1">עדיין אין הזמנות</h3><p class="kc-p">ההזמנות שלכם יופיעו כאן אחרי הרכישה הראשונה.</p>${btn('לחנות', 'goto', { arg: 'store', f: 'to-store' })}</div>`;
    return `<div class="kc-stack"><h3 class="kc-h" data-autofocus tabindex="-1">ההזמנות שלי</h3><ul class="kc-list">${S.orders.map(orderCard).join('')}</ul></div>`;
  }
  function orderCard(o) {
    const [label, kind] = ORDER_STATUS[o.status] || [String(o.status || ''), 'muted'];
    const rec = httpsUrl(o.receiptUrl || '');
    const shortId = String(o.id || '').slice(-6).toUpperCase();
    return `<li class="kc-order">
      <div class="kc-spread"><span class="kc-chip kc-${kind}">${esc(label)}</span><span class="kc-small">${esc(fmtDateTime(o.createdAt))}</span></div>
      <ul>${(o.items || []).map((it) => `<li>${esc(it.name)} × ${esc(String(it.qty))}</li>`).join('')}</ul>
      ${o.discountAgorot ? `<div class="kc-small">כולל הנחת מועדון: ${esc(money(o.discountAgorot))}</div>` : ''}
      <div class="kc-spread"><span class="kc-small">הזמנה <span class="kc-ltr">#${esc(shortId)}</span></span><span class="kc-price">${esc(money(o.totalAgorot))}</span></div>
      ${rec ? `<a class="kc-link" href="${esc(rec)}" target="_blank" rel="noopener">צפייה בקבלה</a>` : ''}
    </li>`;
  }

  /* -- club -- */
  function pointsRule() {
    const p = CFG.points.perShekel;
    return p === 1 ? 'צוברים נקודה אחת על כל ₪1 ששולם.' : `צוברים ${p} נקודות על כל ₪1 ששולם.`;
  }
  function tierBenefits(t) {
    const out = [];
    if (t.discountPct > 0) out.push(`הנחה של ${t.discountPct}% על רכישות בחנות`);
    out.push(`צבירת נקודות על כל רכישה`);
    for (const b of t.benefits || []) out.push(b);
    return out;
  }
  function renderClub() {
    if (!S.authReady) return '<div class="kc-skel" style="height:160px"></div>';
    const all = tiers();
    const tierList = `<div class="kc-stack" style="gap:8px"><h3 class="kc-h3">הדרגות במועדון</h3>${all.map((t, i) => {
      const cur = S.user && t.id === memberTierId();
      return `<div class="kc-tierrow"${cur ? ' aria-current="true"' : ''}><div><div class="kc-h3">${esc(t.label)}${cur ? ' <span class="kc-chip kc-accent">הדרגה שלכם</span>' : ''}</div><div class="kc-small">${i === 0 ? 'מההצטרפות' : 'מרכישות בסך ' + esc(money(t.minSpendAgorot))}</div></div><span class="kc-chip">${t.discountPct > 0 ? esc(t.discountPct + '% הנחה') : 'ללא הנחה'}</span></div>`;
    }).join('')}</div>`;
    if (!S.user) {
      return `<div class="kc-stack">
        <div><h3 class="kc-h" data-autofocus tabindex="-1">מועדון הלקוחות</h3><p class="kc-p">${esc(pointsRule())} ככל שרוכשים יותר, עולים דרגה ומקבלים הנחה גבוהה יותר.</p></div>
        ${tierList}
        ${btn('התחברות והצטרפות', 'goto', { arg: 'account', block: true, f: 'join' })}
      </div>`;
    }
    const t = tierOf(memberTierId());
    const idx = tierIdx(t.id);
    const next = all[idx + 1] || null;
    const spend = (S.member && S.member.lifetimeSpendAgorot) || 0;
    const pts = (S.member && S.member.points) || 0;
    const pct = next ? clamp((spend - t.minSpendAgorot) / Math.max(1, next.minSpendAgorot - t.minSpendAgorot), 0, 1) * 100 : 100;
    const remain = next ? Math.max(0, next.minSpendAgorot - spend) : 0;
    return `<div class="kc-stack">
      <h3 class="kc-vh" data-autofocus tabindex="-1">המועדון שלי</h3>
      <div class="kc-tiercard kc-stack">
        <div class="kc-spread"><div><div class="kc-small">הדרגה שלכם</div><div class="kc-bigtier">${esc(t.label)}</div></div>
          <div style="text-align:end"><div class="kc-small">נקודות</div><div class="kc-points">${esc(intFmt.format(pts))}</div></div></div>
        <div>
          <div class="kc-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${next ? 'התקדמות לדרגת ' + esc(next.label) : 'הדרגה הגבוהה ביותר'}"><i style="width:${pct.toFixed(1)}%"></i></div>
          <p class="kc-small" style="margin:8px 0 0">${next ? `עוד ${esc(money(remain))} ברכישות עד דרגת <strong>${esc(next.label)}</strong>${next.discountPct > t.discountPct ? ` (${esc(String(next.discountPct))}% הנחה)` : ''}.` : 'הגעתם לדרגה הגבוהה ביותר במועדון.'}</p>
        </div>
        <p class="kc-small" style="margin:0">סה״כ רכישות ששולמו: ${esc(money(spend))} · ${esc(pointsRule())}</p>
      </div>
      <div class="kc-card"><h3 class="kc-h3" style="margin-bottom:10px">ההטבות שלכם</h3><ul class="kc-ticks">${tierBenefits(t).map((b) => `<li>${ico('check', 18)}<span>${esc(b)}</span></li>`).join('')}</ul></div>
      ${tierList}
    </div>`;
  }

  /* -- mock payment page (mock mode only; never rendered in production) -- */
  function renderMockPay() {
    const m = S.mockPay;
    return `<div class="kc-stack">
      <div class="kc-alert kc-warn" role="status">${ico('info')}<div>הדגמה: זהו תחליף לעמוד התשלום של הספק. בפועל תועברו לעמוד מאובטח חיצוני.</div></div>
      <h3 class="kc-h" data-autofocus tabindex="-1">עמוד תשלום (הדמיה)</h3>
      <p class="kc-p">סכום לתשלום (ללא הנחת הדרגה, החישוב המלא בשרת ההדמיה): ${esc(money(m.total))}</p>
      ${btn('אישור תשלום (דמו)', 'mock-pay', { arg: 'paid', block: true, f: 'mock-paid' })}
      ${btn('כישלון תשלום (דמו)', 'mock-pay', { arg: 'failed', cls: 'kc-btn-ghost', block: true, f: 'mock-failed' })}
      ${btn('ביטול וחזרה לאתר', 'mock-pay', { arg: 'cancel', cls: 'kc-btn-quiet', block: true, f: 'mock-cancel' })}
    </div>`;
  }

  /* ----- fab / mountButton ----- */
  function updateFabs() {
    for (const f of fabs) paintFab(f);
  }
  function paintFab(b) {
    if (!b.isConnected && !b.dataset.kcFloating) { /* detached: keep painting, harmless */ }
    if (S.user) {
      const photo = httpsUrl(S.user.photoURL || '');
      b.classList.add('kc-has-avatar');
      b.innerHTML = `<span class="kc-avatar kc-sm" aria-hidden="true">${esc(initialOf())}${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer">` : ''}</span>`;
      b.setAttribute('aria-label', `החשבון שלי: ${greetName()}`);
    } else {
      b.classList.remove('kc-has-avatar');
      b.innerHTML = `${ico('user', 20)}<span>התחברות</span>`;
      b.setAttribute('aria-label', 'התחברות לחשבון');
    }
  }
  function mountButton(el, o = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kc-fab';
    b.dir = 'rtl';
    if (brand.theme === 'light' || brand.theme === 'dark') b.dataset.theme = brand.theme;
    b.setAttribute('aria-haspopup', 'dialog');
    if (!el) { b.classList.add('kc-fab--floating'); b.dataset.kcFloating = '1'; document.body.appendChild(b); }
    else el.appendChild(b);
    b.addEventListener('click', () => open(o.tab || 'account'));
    fabs.add(b);
    paintFab(b);
    b.destroy = () => { fabs.delete(b); b.remove(); };
    return b;
  }

  /* ----- boot ----- */
  function mapUserForPublic(u) { return u; }
  const api = {
    open, close,
    on: emitter.on,
    has: (feature) => activeFeatures().has(String(feature)),
    get user() { return publicUser(); },
    signOut: () => doSignOut(),
    mountButton,
    ready: null,
    get cartCount() { return cartCount(); },
  };

  const boot = (async () => {
    // club.config.json (never blocks the UI; defaults are already in place)
    const cfgP = fetch(configUrl, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) { CFG = normalizeConfig(j); scheduleRender(); } })
      .catch(() => {});
    try {
      if (mockOpts) {
        if (typeof createMockBackend !== 'function') throw new Error('mock backend was stripped from this build');
        backend = createMockBackend(mockOpts, () => CFG);
      } else {
        backend = await createFirebaseBackend(opts, appId);
      }
      const ret = readReturnParams();
      if (ret) {
        if (ret.status === 'cancel-invalid') S.pendingReturn = { status: 'cancel', orderId: '' }, S.pendingReturn.status = 'cancel';
        else S.pendingReturn = ret;
        if (ret.status === 'cancel-invalid') S.pendingReturn = { status: 'invalid', orderId: '' };
      }
      backend.onAuth((u) => { onAuthChange(u); });
      const re = backend.takeRedirectError && await backend.takeRedirectError();
      if (re && !SILENT_AUTH_CODES.has(re.code)) { S.redirectErr = authErrorText(re); render(); }
      await cfgP;
      emit('ready', {});
    } catch (e) {
      console.error('[club] init failed', e);
      S.initError = 'בדקו את החיבור לרשת ורעננו את הדף. אם הבעיה נמשכת, פנו אלינו.';
      S.authReady = true;
      render();
    }
  })();
  api.ready = boot;

  // handle the "reload" button of the init-error card
  const origAct = act;
  act = function patched(name, arg, el) { if (name === 'reload') { location.reload(); return; } return origAct(name, arg, el); };

  // Patch processReturn for the invalid-return marker.
  const origProcess = processReturn;
  processReturn = function patchedProcess() {
    if (S.pendingReturn && S.pendingReturn.status === 'invalid') {
      S.pendingReturn = null;
      S.checkout = { phase: 'error', orderId: '' };
      open('store');
      render(true);
      return;
    }
    return origProcess();
  };

  return api;
}

/* ========================================================================== *
 * 3a. Real backend: Firebase modular SDK, loaded lazily from gstatic (pinned)
 * ========================================================================== */
async function createFirebaseBackend(opts) {
  const cfg = opts.firebaseConfig;
  if (!cfg || !cfg.projectId || !cfg.apiKey) throw new Error('firebaseConfig is missing');
  const region = opts.region || 'europe-west1';
  const [appM, authM, fsM, fnM] = await Promise.all([
    import(`${SDK_BASE}firebase-app.js`),
    import(`${SDK_BASE}firebase-auth.js`),
    import(`${SDK_BASE}firebase-firestore.js`),
    import(`${SDK_BASE}firebase-functions.js`),
  ]);
  const existing = appM.getApps().find((a) => a.options && a.options.projectId === cfg.projectId);
  const app = existing || appM.initializeApp(cfg, appM.getApps().length ? 'club-kit' : undefined);
  const auth = authM.getAuth(app);
  auth.languageCode = 'he';
  const db = fsM.getFirestore(app);
  const fns = fnM.getFunctions(app, region);

  const mapUser = (u) => (u ? { uid: u.uid, displayName: u.displayName || '', email: u.email || '', phoneNumber: u.phoneNumber || '', photoURL: u.photoURL || '' } : null);
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const tsOrNow = (v) => { const d = toDate(v); return d ? d.getTime() : Date.now(); };
  let redirectError = null;
  let verifier = null, confirmation = null;
  // Must be started before onAuthStateChanged fires so a redirect result is not lost.
  const redirectDone = authM.getRedirectResult(auth).catch((e) => { redirectError = e; });

  return {
    isMock: false,
    onAuth(cb) { return authM.onAuthStateChanged(auth, (u) => cb(mapUser(u))); },
    async takeRedirectError() { await redirectDone; const e = redirectError; redirectError = null; return e; },
    async signInGoogle() {
      const provider = new authM.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await authM.signInWithPopup(auth, provider);
      } catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
          await authM.signInWithRedirect(auth, provider); // navigates away
          return;
        }
        throw e;
      }
    },
    async phoneStart(e164, container) {
      if (verifier) { try { verifier.clear(); } catch { /* ignore */ } verifier = null; container.innerHTML = ''; }
      verifier = new authM.RecaptchaVerifier(auth, container, { size: 'invisible' });
      try {
        confirmation = await authM.signInWithPhoneNumber(auth, e164, verifier);
      } catch (e) {
        try { verifier.clear(); } catch { /* ignore */ }
        verifier = null; container.innerHTML = '';
        throw e;
      }
    },
    async phoneConfirm(code) {
      if (!confirmation) throw { code: 'auth/session-expired' };
      await confirmation.confirm(code);
      confirmation = null;
    },
    signOut() { return authM.signOut(auth); },

    async ensureProfile(u, { termsAccepted, marketing }) {
      const ref = fsM.doc(db, 'users', u.uid);
      const snap = await fsM.getDoc(ref);
      if (!snap.exists()) {
        const data = { displayName: u.displayName || '', marketingConsent: !!marketing, createdAt: fsM.serverTimestamp() };
        if (u.email) data.email = u.email;
        if (u.phoneNumber) data.phone = u.phoneNumber;
        if (termsAccepted) data.termsAcceptedAt = fsM.serverTimestamp();
        await fsM.setDoc(ref, data);
        return;
      }
      const cur = snap.data();
      const patch = {};
      if (termsAccepted && !cur.termsAcceptedAt) patch.termsAcceptedAt = fsM.serverTimestamp();
      if (marketing && !cur.marketingConsent) patch.marketingConsent = true;
      if (!cur.displayName && u.displayName) patch.displayName = u.displayName;
      if (Object.keys(patch).length) await fsM.updateDoc(ref, patch);
    },
    setMarketingConsent(uid, v) { return fsM.updateDoc(fsM.doc(db, 'users', uid), { marketingConsent: !!v }); },
    setDisplayName(uid, name) { return fsM.updateDoc(fsM.doc(db, 'users', uid), { displayName: name }); },

    watchProfile(uid, cb) { return fsM.onSnapshot(fsM.doc(db, 'users', uid), (s) => cb(s.exists() ? s.data() : null), (e) => { console.warn('[club] profile', e); cb(null); }); },
    watchMember(uid, cb) { return fsM.onSnapshot(fsM.doc(db, 'members', uid), (s) => cb(s.exists() ? s.data() : null), (e) => { console.warn('[club] member', e); cb(null); }); },
    watchEntitlements(uid, cb) { return fsM.onSnapshot(fsM.collection(db, 'users', uid, 'entitlements'), (s) => cb(rows(s)), (e) => { console.warn('[club] entitlements', e); cb([]); }); },
    watchOrders(uid, cb) {
      // where(uid == me); sorted client-side so no composite index is required.
      const q = fsM.query(fsM.collection(db, 'orders'), fsM.where('uid', '==', uid));
      return fsM.onSnapshot(q, (s) => cb(rows(s).sort((a, b) => tsOrNow(b.createdAt) - tsOrNow(a.createdAt))), (e) => { console.warn('[club] orders', e); cb([], e); });
    },
    watchOrder(id, cb) {
      return fsM.onSnapshot(fsM.doc(db, 'orders', id), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null), (e) => { console.warn('[club] order', e); cb(null, e); });
    },
    async loadProducts() {
      // active == true only; ordered by `sort` client-side so no composite index is required.
      const s = await fsM.getDocs(fsM.query(fsM.collection(db, 'products'), fsM.where('active', '==', true)));
      return rows(s);
    },
    async createCheckout(items) {
      const call = fnM.httpsCallable(fns, 'createCheckout');
      const res = await call({ items, consent: true });
      return res.data;
    },
    async deleteAccount() {
      const call = fnM.httpsCallable(fns, 'deleteMyAccount');
      await call();
    },
    mockSettle() { /* mock only */ },
  };
}

/* ========================================================================== *
 * 3b. ===== MOCK BACKEND (demo / tests only). Safe to delete this whole section
 *      for production: the real path never references it (see `typeof` guard).
 *      In-memory fake of auth, Firestore reads, callables and entitlements.
 * ========================================================================== */
function createMockBackend(mo, getCfg) {
  const latency = Number.isFinite(mo.latencyMs) ? mo.latencyMs : 200;
  const payDelay = Number.isFinite(mo.payDelayMs) ? mo.payDelayMs : 1200;
  const L = () => sleep(latency);
  const clone = (x) => (x == null ? x : structuredClone(x));
  const SAMPLE_PRODUCTS = [
    { id: 'demo-reading', name: 'מוצר דוגמה א׳', description: 'תיאור לדוגמה של מוצר דיגיטלי. זהו מוצר הדגמה ואינו מוצע למכירה.', priceAgorot: 4900, currency: 'ILS', grants: ['premium_readings'], accessDays: null, active: true, sort: 1 },
    { id: 'demo-guide', name: 'מוצר דוגמה ב׳ (30 יום)', description: 'גישה מוגבלת בזמן, כדי לראות איך נראה תוקף זכאות.', priceAgorot: 9900, currency: 'ILS', grants: ['extra_guides'], accessDays: 30, active: true, sort: 2 },
    { id: 'demo-vip', name: 'מוצר דוגמה ג׳', description: 'חבילה גדולה יותר. רכישה אחת כאן מספיקה כדי לעלות דרגה בהדגמה.', priceAgorot: 24900, currency: 'ILS', grants: ['premium_readings', 'vip_pack'], accessDays: null, active: true, sort: 3 },
  ];
  const products = mo.products ? clone(mo.products) : SAMPLE_PRODUCTS;
  const db = { users: {}, members: {}, ent: {}, orders: [] };
  let user = null;
  const authCbs = new Set();
  const watchers = new Set();
  let seq = 1000;
  const rid = () => 'ORD' + (++seq) + Math.random().toString(36).slice(2, 6).toUpperCase();

  const notify = (type) => { for (const w of [...watchers]) if (w.type === type) w.push(); };
  function watch(type, get, cb) {
    const w = { type, push() { const [v, err] = get(); cb(clone(v), err); } };
    watchers.add(w);
    setTimeout(() => { if (watchers.has(w)) w.push(); }, Math.min(latency, 80));
    return () => watchers.delete(w);
  }
  const emitAuth = () => { for (const cb of [...authCbs]) cb(clone(user)); };
  const tierFor = (spend) => { const t = [...getCfg().tiers].reverse().find((x) => spend >= x.minSpendAgorot); return t ? t.id : getCfg().tiers[0].id; };
  const discountFor = (tierId) => (getCfg().tiers.find((t) => t.id === tierId) || { discountPct: 0 }).discountPct;
  const ensureMember = (uid) => { if (!db.members[uid]) db.members[uid] = { points: 0, lifetimeSpendAgorot: 0, ordersCount: 0, tier: getCfg().tiers[0].id, updatedAt: new Date() }; };
  function signInAs(u) {
    user = u;
    ensureMember(u.uid);
    emitAuth();
  }
  for (const s of (mo.seedOrders || [])) {
    db.orders.push({ id: s.id, uid: 'mock-google-1', appId: 'mock', status: s.status || 'pending', items: s.items || [{ productId: 'demo-reading', name: 'מוצר דוגמה א׳', priceAgorot: 4900, qty: 1 }], subtotalAgorot: 4900, discountAgorot: 0, totalAgorot: 4900, currency: 'ILS', createdAt: new Date(), ...s.extra });
    if (s.settleAfterMs != null) setTimeout(() => settle(s.id, s.settleTo || 'paid'), s.settleAfterMs);
  }
  function settle(orderId, outcome) {
    const o = db.orders.find((x) => x.id === orderId);
    if (!o || o.status !== 'pending') return;
    if (outcome === 'failed') { o.status = 'failed'; o.failedReason = 'declined'; notify('order'); notify('orders'); return; }
    o.status = 'paid'; o.paidAt = new Date(); o.receiptUrl = 'https://example.com/receipt/' + o.id;
    const uid = o.uid;
    ensureMember(uid);
    const m = db.members[uid];
    m.lifetimeSpendAgorot += o.totalAgorot;
    m.points += Math.floor((o.totalAgorot / 100) * getCfg().points.perShekel);
    m.ordersCount += 1;
    m.tier = tierFor(m.lifetimeSpendAgorot);
    m.updatedAt = new Date();
    db.ent[uid] = db.ent[uid] || {};
    for (const it of o.items) {
      const p = products.find((x) => x.id === it.productId);
      if (!p) continue;
      for (const g of p.grants) {
        const exp = p.accessDays ? new Date(Date.now() + p.accessDays * 864e5) : null;
        db.ent[uid][g] = { feature: g, productId: p.id, orderId: o.id, grantedAt: new Date(), expiresAt: exp };
      }
    }
    notify('order'); notify('orders'); notify('member'); notify('ent');
  }

  if (mo.user === 'google') signInAs({ uid: 'mock-google-1', displayName: 'דנה לוי', email: 'dana@example.com', phoneNumber: '', photoURL: '' });
  if (mo.user === 'google') db.users['mock-google-1'] = { displayName: 'דנה לוי', email: 'dana@example.com', marketingConsent: false, termsAcceptedAt: new Date(), createdAt: new Date() };
  if (mo.member && user) { Object.assign(db.members[user.uid], mo.member); }

  let pendingPhone = null;
  return {
    isMock: true,
    onAuth(cb) { authCbs.add(cb); setTimeout(() => cb(clone(user)), 30); return () => authCbs.delete(cb); },
    async takeRedirectError() { return null; },
    async signInGoogle() {
      await sleep(Math.max(latency, 150));
      if (mo.googleFails) throw { code: mo.googleFails };
      signInAs({ uid: 'mock-google-1', displayName: 'דנה לוי', email: 'dana@example.com', phoneNumber: '', photoURL: '' });
    },
    async phoneStart(e164) {
      await sleep(Math.max(latency, 150));
      if (/0000000$/.test(e164)) throw { code: 'auth/too-many-requests' };
      pendingPhone = e164;
    },
    async phoneConfirm(code) {
      await sleep(Math.max(latency, 150));
      if (!pendingPhone) throw { code: 'auth/session-expired' };
      if (code === '000000') throw { code: 'auth/code-expired' };
      if (code !== '123456') throw { code: 'auth/invalid-verification-code' };
      signInAs({ uid: 'mock-phone-' + pendingPhone.replace(/\D/g, ''), displayName: '', email: '', phoneNumber: pendingPhone, photoURL: '' });
      pendingPhone = null;
    },
    async signOut() { await sleep(60); user = null; emitAuth(); },
    async ensureProfile(u, { termsAccepted, marketing }) {
      await L();
      const cur = db.users[u.uid];
      if (!cur) db.users[u.uid] = { displayName: u.displayName || '', email: u.email || undefined, phone: u.phoneNumber || undefined, marketingConsent: !!marketing, termsAcceptedAt: termsAccepted ? new Date() : undefined, createdAt: new Date() };
      else { if (termsAccepted && !cur.termsAcceptedAt) cur.termsAcceptedAt = new Date(); if (marketing) cur.marketingConsent = true; }
      ensureMember(u.uid);
      notify('profile'); notify('member');
    },
    async setMarketingConsent(uid, v) { await L(); if (mo.failProfileWrite) throw new Error('denied'); db.users[uid].marketingConsent = !!v; notify('profile'); },
    async setDisplayName(uid, n) { await L(); db.users[uid].displayName = n; notify('profile'); },
    watchProfile: (uid, cb) => watch('profile', () => [db.users[uid] || null], cb),
    watchMember: (uid, cb) => watch('member', () => [db.members[uid] || null], cb),
    watchEntitlements: (uid, cb) => watch('ent', () => [Object.values(db.ent[uid] || {})], cb),
    watchOrders: (uid, cb) => watch('orders', () => [db.orders.filter((o) => o.uid === uid).sort((a, b) => b.createdAt - a.createdAt)], cb),
    watchOrder: (id, cb) => watch('order', () => { const o = db.orders.find((x) => x.id === id); return [o && user && o.uid === user.uid ? o : null]; }, cb),
    async loadProducts() { await L(); if (mo.productsError) throw new Error('mock products error'); return clone(products.filter((p) => p.active)); },
    async createCheckout(items) {
      await sleep(Math.max(latency, 300));
      if (mo.failCheckout) throw { code: mo.failCheckout, message: mo.failCheckoutMessage || '' };
      if (!user) throw { code: 'functions/unauthenticated' };
      if (!Array.isArray(items) || !items.length || items.length > 20) throw { code: 'functions/invalid-argument' };
      const lines = items.map((i) => {
        const p = products.find((x) => x.id === i.productId && x.active);
        if (!p) throw { code: 'functions/failed-precondition' };
        if (!(i.qty >= 1 && i.qty <= 10)) throw { code: 'functions/invalid-argument' };
        return { productId: p.id, name: p.name, priceAgorot: p.priceAgorot, qty: i.qty };
      });
      const subtotal = lines.reduce((n, l) => n + l.priceAgorot * l.qty, 0);
      ensureMember(user.uid);
      const tier = db.members[user.uid].tier;
      const pct = discountFor(tier);
      const discount = Math.round(subtotal * pct / 100);
      const order = { id: rid(), uid: user.uid, appId: 'mock', status: 'pending', items: lines, subtotalAgorot: subtotal, discountAgorot: discount, totalAgorot: subtotal - discount, currency: 'ILS', memberTier: tier, discountPct: pct, provider: 'payplus', createdAt: new Date() };
      db.orders.push(order);
      notify('orders');
      return { orderId: order.id, paymentUrl: 'mock:' + order.id };
    },
    // Simulates the provider webhook arriving a moment after the customer is sent back.
    mockSettle(orderId, outcome) { setTimeout(() => settle(orderId, outcome), payDelay); },
    async deleteAccount() {
      await sleep(Math.max(latency, 400));
      if (mo.failDelete) throw new Error('mock delete failure');
      const uid = user.uid;
      delete db.users[uid]; delete db.members[uid]; delete db.ent[uid];
      for (const o of db.orders) if (o.uid === uid) { o.uid = 'deleted'; }
      notify('orders');
    },
  };
}
/* ===== END MOCK BACKEND ===== */
