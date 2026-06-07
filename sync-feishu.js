const fs = require("node:fs");
const path = require("node:path");

const API = "https://open.feishu.cn/open-apis";

function loadEnv(file = ".env") {
  const envPath = path.resolve(file);
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Put it in .env first.`);
  return value;
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || payload.code !== 0) {
    throw new Error(`Feishu API error ${payload.code || response.status} at ${url}: ${payload.msg || text}`);
  }
  return payload.data || payload;
}

async function getTenantToken(appId, appSecret) {
  const data = await request(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  return data.tenant_access_token;
}

async function bitableGet(token, appToken, route, params = {}) {
  const url = new URL(`${API}/bitable/v1/apps/${appToken}${route}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  });
  return request(url, { headers: { Authorization: `Bearer ${token}` } });
}

async function listAll(token, appToken, route, params = {}) {
  const items = [];
  let pageToken = "";
  let hasMore = false;
  do {
    const data = await bitableGet(token, appToken, route, { ...params, page_size: 100, page_token: pageToken });
    items.push(...(data.items || []));
    hasMore = Boolean(data.has_more);
    pageToken = hasMore ? data.page_token || "" : "";
  } while (hasMore && pageToken);
  return items;
}

function toText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (Array.isArray(value.text_arr)) return value.text_arr.map(toText).filter(Boolean).join(" ");
    if (Array.isArray(value.users)) return value.users.map(toText).filter(Boolean).join(" ");
    if (value.text) return String(value.text);
    if (value.name) return String(value.name);
    if (value.enName) return String(value.enName);
    if (value.en_name) return String(value.en_name);
    if (value.value) return toText(value.value);
    if (value.link) return String(value.link);
    return "";
  }
  return "";
}

function toDate(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number") return localIsoDate(new Date(value));
  if (typeof value === "string") {
    const clean = value.trim().replaceAll("/", "-");
    const timestamp = Number(clean);
    if (Number.isFinite(timestamp) && timestamp > 100000000000) return localIsoDate(new Date(timestamp));
    const match = clean.match(/20\d{2}-\d{1,2}-\d{1,2}/);
    if (match) {
      const [year, month, day] = match[0].split("-");
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
    const parsed = new Date(clean);
    if (!Number.isNaN(parsed.getTime())) return localIsoDate(parsed);
  }
  return toDate(toText(value));
}

function fieldNames(fields) {
  return Object.keys(fields || {});
}

function pick(fields, patterns) {
  const names = fieldNames(fields);
  for (const pattern of patterns) {
    const found = names.find((name) => pattern.test(name));
    if (found) return fields[found];
  }
  return "";
}

function linkedRecordIds(fields) {
  const ids = new Set();
  for (const [name, value] of Object.entries(fields || {})) {
    if (!/任务|对应|关联|link/i.test(name)) continue;
    if (!Array.isArray(value)) continue;
    value.forEach((item) => {
      if (typeof item === "string" && item.startsWith("rec")) ids.add(item);
      if (item && typeof item === "object" && typeof item.record_id === "string") ids.add(item.record_id);
    });
  }
  return [...ids];
}

function normalizeTask(record, parent = {}) {
  const fields = record.fields || {};
  const taskName =
    toText(pick(fields, [/^任务$/, /任务名称/, /工作内容/, /事项/, /内容/, /^name$/i])) ||
    toText(Object.values(fields)[0]);
  const date = toDate(pick(fields, [/^开始时间$/, /开始日期/, /任务日期/, /日期/, /^date$/i])) || parent.date || "";
  const member = toText(pick(fields, [/成员/, /负责人/, /执行人/, /人员/, /姓名/, /汇报人/, /^member$/i])) || parent.member || "";
  let project = toText(pick(fields, [/^所属项目$/, /^项目$/, /项目名称/, /客户/, /品牌/, /^project$/i])).trim() || parent.project || "";

  if (!project && taskName) {
    const withoutDate = taskName.replace(/^\d{1,2}\.\d{1,2}\s*/, "");
    project = withoutDate.split(/\s+/)[0] || "未归类";
  }

  if (!taskName || !date || !member) return null;
  return {
    date,
    member,
    project: (project || "未归类").trim(),
    name: taskName.replace(/\s+/g, " ").trim(),
    sourceRecordId: record.record_id,
  };
}

function pushExpandedTask(list, task) {
  if (!task) return;
  const joined = [task.member, task.project, task.name].join(" ");
  if (/\btbl[a-zA-Z0-9]+\b|\btext\b/i.test(joined)) return;
  const memberNames = task.member
    .split(/[,\s，、/]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  const uniqueMembers = memberNames.length ? [...new Set(memberNames)] : [task.member];
  uniqueMembers.forEach((member) => list.push({ ...task, member }));
}

function localIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromIso(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function currentWeekRange() {
  const start = process.env.FEISHU_WEEK_START;
  const end = process.env.FEISHU_WEEK_END;
  if (start && end) return { start, end };

  const weeksBack = Number(process.env.FEISHU_WEEKS_BACK || 2);
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - day + 1);
  const startDate = new Date(monday);
  startDate.setDate(monday.getDate() - weeksBack * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: localIsoDate(startDate), end: localIsoDate(sunday), weeksBack };
}

function weekOptionsInRange(range) {
  const start = dateFromIso(range.start);
  const end = dateFromIso(range.end);
  const options = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 7)) {
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekStart.getDate() + 6);
    options.push({
      start: localIsoDate(weekStart),
      end: localIsoDate(weekEnd),
      label: `${weekStart.getMonth() + 1}/${weekStart.getDate()}-${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`,
    });
  }
  return options;
}

async function main() {
  loadEnv();
  const appId = required("FEISHU_APP_ID");
  const appSecret = required("FEISHU_APP_SECRET");
  const appToken = required("FEISHU_APP_TOKEN");
  const tableId = required("FEISHU_TABLE_ID");
  const taskTableId = process.env.FEISHU_TASK_TABLE_ID || "";
  const viewId = process.env.FEISHU_VIEW_ID || "";
  const output = process.env.FEISHU_OUTPUT || "data.json";

  const token = await getTenantToken(appId, appSecret);
  const tables = await listAll(token, appToken, "/tables");

  const tableData = [];
  for (const table of tables) {
    const fields = await listAll(token, appToken, `/tables/${table.table_id}/fields`);
    const records = await listAll(token, appToken, `/tables/${table.table_id}/records`, table.table_id === tableId ? { view_id: viewId } : {});
    tableData.push({ table, fields, records });
  }

  const recordById = new Map();
  for (const data of tableData) {
    for (const record of data.records) recordById.set(record.record_id, record);
  }

  const mainTable = tableData.find((data) => data.table.table_id === tableId);
  const taskTable =
    tableData.find((data) => data.table.table_id === taskTableId) ||
    tableData.find((data) => {
      const names = data.fields.map((field) => field.field_name);
      return names.includes("任务") && names.includes("开始时间") && names.includes("任务执行人");
    });
  const week = currentWeekRange();
  const candidates = [];

  if (taskTable) {
    for (const record of taskTable.records) {
      const normalized = normalizeTask(record);
      if (normalized && normalized.date >= week.start && normalized.date <= week.end) pushExpandedTask(candidates, normalized);
    }
  } else if (mainTable) {
    for (const record of mainTable.records) {
    const parent = normalizeTask(record) || {
      date: toDate(pick(record.fields, [/周报日期/, /^日期$/, /date/i])),
      member: toText(pick(record.fields, [/成员/, /负责人/, /姓名/, /汇报人/])),
      project: toText(pick(record.fields, [/项目/, /客户/, /品牌/])),
    };

    const links = linkedRecordIds(record.fields);
    if (links.length) {
      links.forEach((id) => {
        const linked = recordById.get(id);
        const normalized = linked ? normalizeTask(linked, parent) : null;
        if (normalized) pushExpandedTask(candidates, normalized);
      });
      return;
    }

    const normalized = normalizeTask(record);
    if (normalized) pushExpandedTask(candidates, normalized);
  }
  }

  const deduped = [...new Map(candidates.map((task) => [`${task.date}|${task.member}|${task.project}|${task.name}`, task])).values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.member.localeCompare(b.member) || a.project.localeCompare(b.project));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      appToken,
      tableId,
      taskTableId: taskTable?.table.table_id || "",
      viewId,
      range: week,
      weeks: weekOptionsInRange(week),
    },
    tasks: deduped,
  };

  fs.writeFileSync(path.resolve(output), `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(
    path.resolve("feishu-debug.json"),
    `${JSON.stringify(
      {
        generatedAt: payload.generatedAt,
        tables: tableData.map((data) => ({
          table: data.table,
          fieldNames: data.fields.map((field) => field.field_name),
          recordCount: data.records.length,
          sample: data.records.slice(0, 2),
        })),
        normalizedCount: deduped.length,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Synced ${deduped.length} tasks to ${output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
