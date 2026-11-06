// Classifies one SMS from a UAE provider (forwarded by an iPhone Shortcuts automation) into a
// Services event: a delivery, a bill or an official matter. Pure: no I/O.
// One-time codes are always dropped, and long digit runs (card / account numbers) are masked.
// shortcut: sender-ID keywords are best guesses from the providers' usual names; add one to
// PROVIDERS when a real SMS from a new sender is missed.
import { createHash } from 'node:crypto';

const PROVIDERS = [
  // [name, kind, test on the normalized sender (lowercase, letters and digits only)]
  ['du', 'bill', (s) => s === 'du' || s === 'duinfo'],
  ['e&', 'bill', (s) => s.includes('etisalat') || s.startsWith('eand') || s === 'e'],
  ['DEWA', 'bill', (s) => s.includes('dewa')],
  ['TAQA', 'bill', (s) => s.includes('taqa') || s.includes('addc') || s.includes('aadc')],
  ['Salik', 'bill', (s) => s.includes('salik')],
  ['Amazon', 'delivery', (s) => s.includes('amazon')],
  ['noon', 'delivery', (s) => s.includes('noon')],
  ['Deliveroo', 'delivery', (s) => s.includes('deliveroo')],
  ['talabat', 'delivery', (s) => s.includes('talabat')],
  ['Instashop', 'delivery', (s) => s.includes('instashop')],
  ['Washmen', 'delivery', (s) => s.includes('washmen')],
  ['Careem', 'delivery', (s) => s.includes('careem')],
  ['Aramex', 'delivery', (s) => s.includes('aramex')],
  ['Emirates Post', 'delivery', (s) => s.includes('emiratespost') || s.includes('empost')],
  ['ICP', 'official', (s) => s.includes('icp') || s === 'ica'],
  ['UAE PASS', 'official', (s) => s.includes('uaepass')],
  ['TAMM', 'official', (s) => s.includes('tamm')],
  ['GDRFA', 'official', (s) => s.includes('gdrfa') || s.includes('amer')],
  ['RTA', 'official', (s) => s.includes('rta')],
  ['Police', 'official', (s) => s.includes('police') || s.includes('moi')],
];

const OTP = /\b(otp|one[- ]time|verification|passcode|pin|code de v[ée]rification)\b|\bcode\b.{0,20}\d{4,8}|\d{4,8}.{0,30}\bcode\b/i;
const PROMO = /%\s*off|\boffer|\bsale\b|\bdeal|discount|promo|coupon|voucher|cashback|exclusive|\bwin\b|soldes|r[ée]duction|offre/i;
const DELIVERY = /order|commande|shipped|dispatched|on (its|the) way|out for delivery|arriving|delivered|delivery|livr|pick-?up|collected|courier|en route|rider/i;
const DELIVERED = /delivered|has arrived|livr[ée]e?\b|dropped off|completed/i;
const BILL = /bill|facture|invoice|statement|due|amount|aed|dhs|payment|recharge|top-?up|balance|solde/i;
const PAID = /payment (has been )?received|thank you for (your )?payment|paid successfully|paiement re[çc]u|recharged successfully/i;

const normalize = (sender) => String(sender).toLowerCase().replace(/[^a-z0-9]/g, '');

export function classifySms(sender, text, at = null) {
  if (typeof sender !== 'string' || typeof text !== 'string') return null;
  const body = text.replace(/\s+/g, ' ').trim();
  if (!body || OTP.test(body)) return null;
  const s = normalize(sender);
  const provider = PROVIDERS.find(([, , test]) => test(s));
  if (!provider) return null;
  const [name, kind] = provider;
  let done = false;
  if (kind === 'delivery') {
    if (PROMO.test(body) || !DELIVERY.test(body)) return null;
    done = DELIVERED.test(body);
  } else if (kind === 'bill') {
    if (PROMO.test(body) || !BILL.test(body)) return null;
    done = PAID.test(body);
  } else if (PROMO.test(body)) {
    return null;
  }
  const title = body.replace(/\d{8,}/g, (d) => `••••${d.slice(-4)}`).slice(0, 300);
  const ref = 'sms:' + createHash('sha256').update(`${s}|${body}`).digest('hex').slice(0, 32);
  return { ref, kind, provider: name, title, at, done };
}
