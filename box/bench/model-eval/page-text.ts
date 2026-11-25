export const plain = (s: string) => s.normalize("NFC").replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50)).toLowerCase();

const NUMBER = "[-−+]?\\d+(?:,\\d{3})*(?:\\.\\d+)?";
const numeric = (s: string) => Number(s.replaceAll(",", "").replace("−", "-"));

export function numbersIn(s: string): number[] {
  return [...plain(s).matchAll(new RegExp(NUMBER, "g"))].map((m) => numeric(m[0]));
}

export function currencyAmounts(s: string): number[] {
  const currency = new RegExp("฿\\s*(" + NUMBER + ")|(" + NUMBER + ")\\s*(?:บาท|฿|\\.-)", "g");
  return [...plain(s).matchAll(currency)].map((m) => numeric(m[1] ?? m[2]));
}

const TOTAL = "(?:(?:ยอด)?รวม(?:ทั้งสิ้น|ทั้งหมด|ค่าใช้จ่าย)?|\\btotal(?: expenses)?\\b)";
const UNIT = "(?:บาท|฿|\\bthb\\b)";
const BESIDE_LABEL = new RegExp(
  TOTAL + "\\s*:?\\s*(\\(\\s*" + UNIT + "\\s*\\))?\\s*(฿\\s*)?(" + NUMBER + ")" +
    "(?![\\d.,]|\\s*(?:รายการ|ชิ้น|items?|orders?))(\\s*" + UNIT + ")?",
  "gi",
);

export function totalIn(groups: string | readonly string[]): number | null {
  const contexts = typeof groups === "string" ? [groups] : groups;
  const matches = contexts.flatMap((group) => [...plain(group).matchAll(BESIDE_LABEL)]);
  const currency = matches.filter(([, labelUnit, prefix, , suffix]) => labelUnit || prefix || suffix);
  const values = new Set((currency.length ? currency : matches).map(([, , , amount]) => numeric(amount)));
  return values.size === 1 ? [...values][0] : null;
}
