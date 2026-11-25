export const plain = (s: string) => s.normalize("NFC").replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50)).toLowerCase();

const NUMBER = "\\d+(?:,\\d{3})*(?:\\.\\d+)?";
const numeric = (s: string) => Number(s.replaceAll(",", ""));

export function numbersIn(s: string): number[] {
  return [...plain(s).matchAll(new RegExp(NUMBER, "g"))].map((m) => numeric(m[0]));
}

export function currencyAmounts(s: string): number[] {
  const currency = new RegExp("฿\\s*(" + NUMBER + ")|(" + NUMBER + ")\\s*(?:บาท|฿|\\.-)", "g");
  return [...plain(s).matchAll(currency)].map((m) => numeric(m[1] ?? m[2]));
}

const TOTAL = "(?:ยอดรวม|รวม(?:ทั้งสิ้น|ทั้งหมด)?|\\btotal\\b)";
const BESIDE_LABEL = new RegExp(TOTAL + "\\s*:?\\s*(?:฿\\s*)?(" + NUMBER + ")(?![\\d.,]|\\s*(?:รายการ|ชิ้น|items?|orders?))", "i");

export function totalIn(groups: string | readonly string[]): number | null {
  const labelled = (typeof groups === "string" ? groups.split(/\n/) : groups).map(plain).filter((s) => new RegExp(TOTAL, "i").test(s));
  const withCurrency = labelled.flatMap((s) => {
    const m = BESIDE_LABEL.exec(s);
    return m && currencyAmounts(m[0] + s.slice(m.index + m[0].length)).includes(numeric(m[1])) ? [numeric(m[1])] : [];
  });
  const fromLabels = labelled.flatMap((s) => {
    const m = BESIDE_LABEL.exec(s);
    return m ? [numeric(m[1])] : [];
  });
  const values = new Set(withCurrency.length ? withCurrency : fromLabels);
  return values.size === 1 ? [...values][0] : null;
}
