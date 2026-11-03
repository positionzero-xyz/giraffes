import { readFileSync, writeFileSync } from "node:fs";

const [dumpPath, outDir, historyChars = "100000"] = process.argv.slice(2);
const body = JSON.parse(readFileSync(dumpPath, "utf8"));
const system = body.system.map((b) => b.text).find((t) => t.startsWith("You are a personal assistant"));
const content = body.messages.find((m) => m.role === "user").content;
const user = typeof content === "string" ? content : content.find((c) => c.type === "text").text;
const jsonSchema = body.tools.find((t) => t.name === "StructuredOutput").input_schema;
if (!system || !user.includes("(no earlier messages)")) throw new Error("dump is not a first giraffes turn");

const lines = [];
for (let i = 0; lines.join("\n").length < Number(historyChars); i++) {
  lines.push(i % 2 === 0
    ? `Person: message ${i}, can you find me a table for four near Sukhumvit on Friday around 7pm, somewhere quiet?`
    : `You: reply ${i}, I found two options near Asok and can hold one if you tell me which you prefer.`);
}
const history = lines.join("\n").slice(0, Number(historyChars));

const base = { model: "claude-haiku-5-5", system, jsonSchema };
writeFileSync(`${outDir}/fx-small.json`, JSON.stringify({ ...base, user }));
writeFileSync(`${outDir}/fx-large.json`, JSON.stringify({ ...base, user: user.replace("(no earlier messages)", history) }));
console.log(JSON.stringify({ systemChars: system.length, smallUserChars: user.length, largeUserChars: user.length + history.length - 21 }));
