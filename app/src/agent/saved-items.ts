import type { EpochMs, Language, TimeZone } from "../domain";
import { SEND_MESSAGE_MAX_CHARS } from "../channels/telegram";
import { DEFAULT_TIME_ZONE, fromLocal, toLocal } from "../policy/time";
import type { AgentRow } from "./store";

type SavedItem = { readonly kind: "note" | "reminder" | "task" | "setting"; readonly id: number };
export type SavedCursor = { readonly item: number; readonly offset: number };
export type SavedPage = { readonly text: string; readonly next: SavedCursor | null };

const labels = {
  en: {
    heading: "Saved items", more: "Send /memory next for the next page.", done: "End of saved items.",
    restart: "Send /memory to start a list.", changed: "Your saved items changed. Send /memory to start again.",
    note: "Note", reminder: "Reminder", task: "Task", setting: "Setting", continued: "continued",
    key: "Key", status: "Status", due: "Due", defaultDue: "Due in the default time zone", repeat: "Repeat",
    anchor: "Repeat anchor", ref: "Reference", kind: "Type", decision: "Person's decision", completes: "Completed the task",
    recorded: "Recorded", cause: "Cause", language: "Language", zone: "Time zone", checkin: "Daily check-in",
  },
  th: {
    heading: "รายการที่บันทึกไว้", more: "พิมพ์ /memory next เพื่อดูหน้าถัดไปค่ะ", done: "จบรายการที่บันทึกไว้ค่ะ",
    restart: "พิมพ์ /memory เพื่อเริ่มดูรายการค่ะ", changed: "รายการที่บันทึกไว้เปลี่ยนแล้ว พิมพ์ /memory เพื่อเริ่มใหม่ค่ะ",
    note: "บันทึก", reminder: "การเตือน", task: "งาน", setting: "การตั้งค่า", continued: "ต่อ",
    key: "ชื่ออ้างอิง", status: "สถานะ", due: "กำหนดเวลา", defaultDue: "กำหนดเวลาในเขตเวลาเริ่มต้น", repeat: "การเตือนซ้ำ",
    anchor: "เวลาเริ่มการเตือนซ้ำ", ref: "ชื่ออ้างอิง", kind: "ประเภท", decision: "การตัดสินใจของคุณ", completes: "ทำให้งานเสร็จ",
    recorded: "เวลาบันทึก", cause: "ที่มา", language: "ภาษา", zone: "เขตเวลา", checkin: "เวลาทักทายประจำวัน",
  },
};

/**
 * The saved item a person's reminder row belongs to. Each firing of a routine closes its row and adds the next with the
 * same key and note, so a routine's rows are one item. A one-off reminder is its own.
 */
export const REMINDER_ITEM = "json_array(CASE WHEN repeat IS NULL THEN id END, key, note)";

export function snapshotSavedItems(sql: SqlStorage): void {
  sql.exec("DELETE FROM saved_item");
  sql.exec(
    `INSERT INTO saved_item (ordinal, kind, source_id)
     SELECT row_number() OVER (ORDER BY kind, id) - 1, kind, id FROM (
       SELECT 'note' AS kind, id FROM memory_note
       UNION ALL SELECT 'reminder', id FROM (
         SELECT id, row_number() OVER (PARTITION BY ${REMINDER_ITEM} ORDER BY status = 'pending' DESC, id DESC) AS nth
         FROM wakeup WHERE origin = 'person'
       ) WHERE nth = 1
       UNION ALL SELECT 'task', id FROM task
     )`,
  );
  const { next } = sql.exec<{ next: number }>("SELECT COALESCE(MAX(ordinal) + 1, 0) AS next FROM saved_item").one();
  sql.exec("INSERT INTO saved_item VALUES (?, 'setting', 1), (?, 'setting', 2), (?, 'setting', 3)", next, next + 1, next + 2);
}

const iso = (at: EpochMs) => new Date(at).toISOString();
const zoned = (at: EpochMs, zone: TimeZone) => `${toLocal(at, zone)} ${zone} (${iso(at)})`;

type Reminder = {
  key: string; note: string; due_at: EpochMs; status: string; repeat: "daily" | "weekdays" | "weekly" | null;
  repeat_anchor: import("../domain").LocalDateTime | null; time_zone: TimeZone | null;
};

function itemText(sql: SqlStorage, item: SavedItem, a: AgentRow): string {
  const t = labels[a.language];
  switch (item.kind) {
    case "note":
      return sql.exec<{ text: string }>("SELECT text FROM memory_note WHERE id = ?", item.id).one().text;
    case "reminder": {
      const r = sql.exec<Reminder>("SELECT key, note, due_at, status, repeat, repeat_anchor, time_zone FROM wakeup WHERE id = ?", item.id).one();
      const zone = r.time_zone ?? a.tz;
      const lines = [r.note, `${t.key}: ${r.key}`, `${t.status}: ${r.status}`, `${t.due}: ${zoned(r.due_at, zone)}`];
      lines.push(`${t.repeat}: ${r.repeat ?? "—"}`);
      if (r.repeat_anchor !== null) lines.push(`${t.anchor}: ${r.repeat_anchor} ${zone}`);
      if (r.status === "pending" && r.time_zone === null && a.tz !== DEFAULT_TIME_ZONE) {
        const due = fromLocal(toLocal(r.due_at, a.tz), DEFAULT_TIME_ZONE);
        lines.push(`${t.defaultDue}: ${zoned(due, DEFAULT_TIME_ZONE)}`);
      }
      return lines.join("\n");
    }
    case "task": {
      const task = sql.exec<{ ref: string; title: string; kind: string; status: string; opened_at: EpochMs; touched_at: EpochMs; closed_at: EpochMs | null }>(
        "SELECT ref, title, kind, status, opened_at, touched_at, closed_at FROM task WHERE id = ?", item.id,
      ).one();
      const dates = [iso(task.opened_at), iso(task.touched_at), ...(task.closed_at === null ? [] : [iso(task.closed_at)])];
      const facts = sql.exec<{ kind: string; ref: string; detail: string; completes: number; person_decision: number; cause_kind: string; cause_at: EpochMs; at: EpochMs }>(
        "SELECT kind, ref, detail, completes, person_decision, cause_kind, cause_at, at FROM task_fact WHERE task_id = ? ORDER BY id", item.id,
      );
      const lines = [task.title, `${t.ref}: ${task.ref}`, `${t.kind}: ${task.kind}`, `${t.status}: ${task.status}`, `${t.recorded}: ${dates.join(" / ")}`];
      for (const fact of facts) {
        const proposalRef = (fact.kind === "proposed" || fact.kind === "plan_accepted")
          && fact.ref.startsWith(`${item.id}.`) && /^\d+\.\d+$/.test(fact.ref);
        lines.push(
          `• ${fact.kind} (${t.recorded}: ${iso(fact.at)}; ${t.cause}: ${fact.cause_kind}, ${iso(fact.cause_at)})`,
          ...(fact.ref && !proposalRef ? [`${t.ref}: ${fact.ref}`] : []),
          fact.detail,
          `${t.decision}: ${Boolean(fact.person_decision)}; ${t.completes}: ${Boolean(fact.completes)}`,
        );
      }
      return lines.join("\n");
    }
    case "setting":
      return item.id === 1 ? `${t.language}: ${a.language}` : item.id === 2 ? `${t.zone}: ${a.tz}` : `${t.checkin}: ${a.checkinLocal}`;
  }
}

/** What ends a page: how to ask for the next one, and what to do after the last. */
export type SavedFooter = { readonly more: string; readonly done: string };

export function renderSavedPage(
  { sql, cursor, agent, footer }: { sql: SqlStorage; cursor: SavedCursor; agent: AgentRow; footer?: SavedFooter },
): SavedPage {
  const t = { ...labels[agent.language], ...footer };
  let text = t.heading;
  let { item, offset } = cursor;
  let next: SavedCursor | null = null;
  for (const row of sql.exec<SavedItem>("SELECT kind, source_id AS id FROM saved_item WHERE ordinal >= ? ORDER BY ordinal", item)) {
    const header = `\n\n${item + 1}. ${t[row.kind]}${offset ? ` (${t.continued})` : ""}\n`;
    const body = itemText(sql, row, agent);
    const space = SEND_MESSAGE_MAX_CHARS - text.length - header.length - 2 - Math.max(t.more.length, t.done.length);
    if (body.length - offset > space && text !== t.heading) {
      next = { item, offset };
      break;
    }
    let end = Math.min(body.length, offset + space);
    if (end < body.length && /[\ud800-\udbff]/u.test(body[end - 1] ?? "")) end--;
    text += header + body.slice(offset, end);
    if (end < body.length) {
      next = { item, offset: end };
      break;
    }
    item++;
    offset = 0;
  }
  return { text: `${text}\n\n${next ? t.more : t.done}`, next };
}

export function savedPageNotice(language: Language, changed: boolean): SavedPage {
  return { text: changed ? labels[language].changed : labels[language].restart, next: null };
}
