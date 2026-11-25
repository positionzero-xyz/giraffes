import type { FormDrive } from "./types.ts";

export const AMOUNT = "137";
const MARK = "ตัวอย่าง7319";

const DOM = String.raw`
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible";
  const controls = (selector) => [...document.querySelectorAll(selector)].filter((el) => visible(el) && !el.disabled);
  const buttons = () => controls('button, input[type=submit], input[type=button], a[href], [role=button], [role=tab]');
  const caption = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  const rendered = () => [...document.querySelectorAll("body *")]
    .filter((el) => visible(el) && typeof el.innerText === "string")
    .map((el) => {
      const next = el.nextElementSibling;
      if (el.matches("dt") && next?.matches("dd") && visible(next)) return el.innerText.trim() + "\n" + next.innerText.trim();
      return el.innerText.trim();
    })
    .filter((text) => text && text.length <= 320)
    .reverse();
`;

const evaluate = (code: string) => `(() => {${DOM}\n${code}})()`;

export const SNAPSHOT = evaluate("return { text: document.body?.innerText ?? '', groups: [...new Set(rendered())] };");

export type Entered = { readonly field: string; readonly value: string; readonly label: string };
export type Submit = { readonly ok: true; readonly entered: Entered[] } | { readonly ok: false; readonly reason: string };

const selectors = {
  booking: ["name", "phone", "date", "time"],
  expense: ["item", "amount"],
} as const;

export function fillAndSubmit(drive: FormDrive): string {
  return evaluate(`
    const fields = controls("input, textarea, select").filter((el) => !el.readOnly &&
      !["hidden", "submit", "button", "reset", "checkbox", "radio", "file", "image"].includes(el.type));
    const hint = (el) => [
      el.name, el.id, el.placeholder, el.getAttribute("aria-label"),
      ...[...(el.labels || [])].map((label) => label.innerText),
      ...(el.getAttribute("aria-labelledby") || "").split(" ").map((id) => document.getElementById(id)?.innerText),
    ].join(" ").toLowerCase();
    const rules = {
      name: (el) => /(?:^|[^a-z])(?:name|customer)(?:[^a-z]|$)|ชื่อ/.test(hint(el)),
      phone: (el) => el.type === "tel" || /phone|mobile|tel|เบอร์|โทร/.test(hint(el)),
      date: (el) => el.type === "date" || /date|วันที่|วันจอง/.test(hint(el)),
      time: (el) => el.type === "time" || /(?:^|[^a-z])(?:time|slot)(?:[^a-z]|$)|เวลา/.test(hint(el)),
      item: (el) => /what|item|desc|name|รายการ|ชื่อ/.test(hint(el)),
      amount: (el) => el.type === "number" || /amount|price|จำนวน|เงิน|บาท|ราคา/.test(hint(el)),
    };
    const values = { name: "${MARK}", phone: "0812345678", date: "2026-12-20", time: "14:30", item: "${MARK}", amount: "${AMOUNT}" };
    const entered = [];
    const chosen = [];
    for (const field of ${JSON.stringify(selectors[drive])}) {
      const el = fields.find((el) => !chosen.includes(el) && rules[field](el));
      if (!el) return { ok: false, reason: "missing working " + field + " control" };
      let value = values[field];
      let label = "";
      if (el instanceof HTMLSelectElement) {
        const options = [...el.options].filter((option) => option.value && !option.disabled && !option.hidden);
        const choice = options.find((option) => option.value === value) ?? options.at(-1);
        if (!choice) return { ok: false, reason: "no usable " + field + " option" };
        value = choice.value;
        label = choice.label;
      }
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (el.value !== value || entered.some((prior) => prior.value === value)) {
        return { ok: false, reason: "could not enter distinct " + field + " value" };
      }
      chosen.push(el);
      entered.push({ field, value, label });
    }
    const form = chosen[0].form;
    const actions = buttons();
    const button = actions.find((b) => form && b.form === form && b.type === "submit")
      ?? actions.find((b) => /จอง|บันทึก|เพิ่ม|ยืนยัน|ส่ง|save|add|book|submit/i.test(caption(b)));
    if (!button) return { ok: false, reason: "no submit action" };
    button.click();
    return { ok: true, entered };
  `);
}

export const AFTER_RELOAD = evaluate(String.raw`
  const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key));
  const rows = [...document.querySelectorAll("li, tr, article, [role=row], div, p, dd")]
    .filter((el) => visible(el) && el.innerText.length <= 320 && !el.querySelector("form, input, select"))
    .map((el) => el.innerText);
  return { stored, rows, groups: rendered() };
`);

const FORMS: Readonly<Record<string, readonly string[]>> = {
  "2026-12-20": ["20/12/2026", "20/12/2569", "2569-12-20", "20/12/69", "12/20/2026"],
  "14:30": ["14.30"],
  "0812345678": ["081-234-5678", "081 234 5678"],
};

const representations = ({ value, label }: Entered) => new Set([value, ...(FORMS[value] ?? []), ...(label ? [label] : [])]);

function entries(value: unknown): string[][] {
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string" || typeof v === "number")) return [value.map(String)];
    return value.flatMap(entries);
  }
  if (typeof value !== "object" || value === null) return [];
  const flat = Object.values(value).flatMap((v) => typeof v === "string" || typeof v === "number" ? [String(v)] : []);
  return [flat, ...Object.values(value).flatMap(entries)];
}

export function formEvidence(entered: readonly Entered[], stored: readonly (string | null)[], rows: readonly string[]) {
  const parsed = stored.flatMap((s) => {
    if (!s) return [];
    try {
      return entries(JSON.parse(s));
    } catch {
      return [];
    }
  });
  const matched = (values: readonly string[], field: Entered) => values.some((v) => representations(field).has(v));
  const shown = rows.some((row) => entered.every((field) => [...representations(field)].some((value) => {
    const escaped = value.replace(/[.*+?^$${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?<![0-9])" + escaped + "(?![0-9])").test(row);
  })));
  const complete = parsed.some((values) => entered.every((field) => matched(values, field)));
  const missing = entered.filter((field) => !parsed.some((values) => matched(values, field))).map((field) => field.value);
  return { complete, shown, missing, reason: complete ? "complete entry after reload" : "nothing saved as one complete entry" };
}

export function clickItem(names: readonly string[]): string {
  return evaluate(`
    const names = ${JSON.stringify(names)};
    const targets = [...document.querySelectorAll("body *")].reverse().filter((el) =>
      visible(el) && typeof el.innerText === "string" && el.innerText.length < 180 &&
      names.some((name) => el.innerText.includes(name)));
    for (const row of targets) {
      const add = buttons().filter((button) => row.contains(button) && /เพิ่ม|เลือก|สั่ง|add|^[+＋]$/i.test(caption(button)));
      if (add.length !== 1) continue;
      add[0].click();
      return true;
    }
    return false;
  `);
}

export function switchView(view: "order" | "menu"): string {
  const pattern = view === "order" ? "รายการที่เลือก|ออเดอร์|ตะกร้า|order|cart|รายการสั่ง|ดูรายการ" : "เมนู|menu|ย้อนกลับ";
  return evaluate(`
    const control = buttons().find((b) => /${pattern}/i.test(caption(b)) && !/เพิ่ม|ลบ|add|remove/i.test(caption(b)));
    if (!control) return false;
    control.click();
    return true;
  `);
}
