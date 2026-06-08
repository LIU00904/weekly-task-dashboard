const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

process.env.TZ = process.env.TZ || "Asia/Shanghai";

const root = __dirname;
const port = Number(process.env.PORT || 8765);
const syncHour = Number(process.env.SYNC_HOUR || 9);
const syncMinute = Number(process.env.SYNC_MINUTE || 0);
const homePage = process.env.HOME_PAGE || "index.html";
const FEISHU_API = "https://open.feishu.cn/open-apis";
const FEISHU_AUTH_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

let syncing = false;
let formDataCache = null;
const formDataCacheTtl = Number(process.env.FORM_DATA_CACHE_TTL_MS || 10 * 60 * 1000);

function loadEnv(file = ".env") {
  const envPath = path.join(root, file);
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

loadEnv();

function runSync() {
  if (syncing) return;
  syncing = true;
  const child = spawn(process.execPath, ["sync-feishu.js"], { cwd: root, stdio: "inherit" });
  child.on("exit", () => {
    syncing = false;
  });
}

function msUntilNextSync() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(syncHour, syncMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailySync() {
  const delay = msUntilNextSync();
  console.log(`Next Feishu sync at ${new Date(Date.now() + delay).toLocaleString()}`);
  setTimeout(() => {
    runSync();
    scheduleDailySync();
  }, delay);
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers);
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, JSON.stringify(body), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function getEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseCookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function makeId() {
  return crypto.randomBytes(24).toString("base64url");
}

function cookieSecret() {
  return process.env.COOKIE_SECRET || getEnv("FEISHU_APP_SECRET");
}

function sign(value) {
  return crypto.createHmac("sha256", cookieSecret()).update(value).digest("base64url");
}

function encodeSession(user) {
  const payload = Buffer.from(JSON.stringify({ user, createdAt: Date.now() }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decodeSession(value) {
  if (!value || !value.includes(".")) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature || sign(payload) !== signature) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    if (!session.user || Date.now() - Number(session.createdAt || 0) > maxAge) return null;
    return session;
  } catch {
    return null;
  }
}

function originFor(request) {
  const protocol = request.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${request.headers.host}`;
}

function callbackUrl(request) {
  return process.env.FEISHU_REDIRECT_URI || `${originFor(request)}/auth/feishu/callback`;
}

function setSession(response, user) {
  const cookie = `sid=${encodeURIComponent(encodeSession(user))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
  response.setHeader("Set-Cookie", cookie);
}

function currentSession(request) {
  const sid = parseCookies(request).sid;
  return decodeSession(sid);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function feishuRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from Feishu: ${text.slice(0, 300)}`);
    }
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API error ${payload.code || response.status}: ${payload.msg || text}`);
    }
    return payload.data || payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAppAccessToken() {
  const data = await feishuRequest(`${FEISHU_API}/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: getEnv("FEISHU_APP_ID"),
      app_secret: getEnv("FEISHU_APP_SECRET"),
    }),
  });
  return data.app_access_token;
}

async function getTenantToken() {
  const data = await feishuRequest(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: getEnv("FEISHU_APP_ID"),
      app_secret: getEnv("FEISHU_APP_SECRET"),
    }),
  });
  return data.tenant_access_token;
}

async function bitable(token, tableId, route = "", options = {}) {
  const url = new URL(`${FEISHU_API}/bitable/v1/apps/${getEnv("FEISHU_APP_TOKEN")}/tables/${tableId}${route}`);
  Object.entries(options.params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  });
  return feishuRequest(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function listRecords(token, tableId) {
  const items = [];
  let pageToken = "";
  do {
    const data = await bitable(token, tableId, "/records", { params: { page_size: 100, page_token: pageToken } });
    items.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token || "" : "";
  } while (pageToken);
  return items;
}

function toText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (Array.isArray(value.text_arr)) return value.text_arr.join(" ");
    if (Array.isArray(value.users)) return value.users.map(toText).join(" ");
    return value.text || value.name || value.enName || value.en_name || "";
  }
  return "";
}

function toDate(value) {
  if (!value) return "";
  if (typeof value === "number") return localIsoDate(new Date(value));
  const text = toText(value).replaceAll("/", "-");
  const match = text.match(/20\d{2}-\d{1,2}-\d{1,2}/);
  if (!match) return "";
  const [year, month, day] = match[0].split("-");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function localIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function mondayOf(value) {
  const date = value ? new Date(`${value}T00:00:00+08:00`) : new Date();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return localIsoDate(date);
}

function dateToTimestamp(value) {
  return new Date(`${value}T00:00:00+08:00`).getTime();
}

function linkedIds(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (Array.isArray(item.record_ids)) return item.record_ids;
    if (item && item.record_id) return [item.record_id];
    return [];
  });
}

async function getFormData(token) {
  if (formDataCache && Date.now() - formDataCache.createdAt < formDataCacheTtl) {
    return formDataCache.data;
  }
  const projectTable = getEnv("FEISHU_TABLE_ID");
  const taskTable = process.env.FEISHU_TASK_TABLE_ID || "tbloya8aPRt4mRZM";
  const memberTable = process.env.FEISHU_MEMBER_TABLE_ID || "tblCEEhA1CP5CHDi";
  const [projectsRaw, membersRaw] = await Promise.all([listRecords(token, projectTable), listRecords(token, memberTable)]);
  const projects = projectsRaw
    .map((record) => ({
      id: record.record_id,
      name: toText(record.fields["项目名称"]).trim(),
      parentId: linkedIds(record.fields["父记录 2"])[0] || "",
    }))
    .filter((item) => item.name && !/\btbl[a-zA-Z0-9]+\b|\btext\b/i.test(item.name));
  const members = membersRaw.map((record) => ({
    id: record.record_id,
    name: toText(record.fields["成员"] || record.fields["账号"]).trim(),
    users: record.fields["账号"]?.users || record.fields["账号"] || [],
  }));
  const data = { projectTable, taskTable, memberTable, projects, members };
  formDataCache = { data, createdAt: Date.now() };
  return data;
}

function clearFormDataCache() {
  formDataCache = null;
}

function findMember(members, user) {
  return members.find((member) =>
    (member.users || []).some(
      (account) =>
        sameValue(account.id, user.open_id) ||
        sameValue(account.open_id, user.open_id) ||
        sameValue(account.userId, user.user_id) ||
        sameValue(account.user_id, user.user_id) ||
        sameValue(account.name, user.name) ||
        sameValue(account.enName, user.en_name) ||
        sameValue(account.en_name, user.en_name)
    )
  );
}

function userFromMember(member) {
  const account = (member.users || [])[0] || {};
  return {
    name: account.name || member.name,
    en_name: account.en_name || account.enName || member.name,
    open_id: account.id || account.open_id,
    user_id: account.userId || account.user_id,
  };
}

function sameValue(left, right) {
  if (left == null || right == null) return false;
  const a = String(left).trim();
  const b = String(right).trim();
  return Boolean(a && b && a === b);
}

async function findOrCreateWeeklyReport(token, user, member, projectId, taskDate) {
  const reportTable = process.env.FEISHU_REPORT_TABLE_ID || "tblwzZTptqgVn9Qj";
  const monday = mondayOf(taskDate);
  const reports = await listRecords(token, reportTable);
  const existing = reports.find((record) => {
    const sameDate = toDate(record.fields["日期"]) === monday;
    const users = record.fields["成员"] || [];
    const sameUser = users.some?.(
      (item) =>
        sameValue(item.id, user.open_id) ||
        sameValue(item.open_id, user.open_id) ||
        sameValue(item.userId, user.user_id) ||
        sameValue(item.user_id, user.user_id) ||
        sameValue(item.name, user.name)
    );
    return sameDate && sameUser;
  });
  if (existing) return existing.record_id;

  const fields = {
    日期: dateToTimestamp(monday),
    成员: [{ id: user.open_id }],
    所属项目: [projectId],
  };
  const created = await bitable(token, reportTable, "/records", { method: "POST", body: { fields } });
  return created.record?.record_id;
}

async function handleApi(request, response, url) {
  try {
    if (url.pathname === "/api/me") {
      const session = currentSession(request);
      sendJson(response, 200, { user: session?.user || null, loginUrl: "/auth/feishu" });
      return true;
    }

    if (url.pathname === "/api/form-options") {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "请先用飞书登录" }), true;
      const token = await getTenantToken();
      const data = await getFormData(token);
      const member = findMember(data.members, session.user);
      sendJson(response, 200, {
        user: session.user,
        member,
        members: data.members.map((item) => ({ id: item.id, name: item.name })),
        projects: data.projects,
      });
      return true;
    }

    if (url.pathname === "/api/projects" && request.method === "POST") {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "请先用飞书登录" }), true;
      const body = await readBody(request);
      const name = String(body.name || "").trim();
      if (!name) return sendJson(response, 400, { error: "项目名称不能为空" }), true;
      const token = await getTenantToken();
      const fields = { 项目名称: name };
      if (body.parentId) fields["父记录 2"] = [body.parentId];
      const created = await bitable(token, getEnv("FEISHU_TABLE_ID"), "/records", { method: "POST", body: { fields } });
      clearFormDataCache();
      sendJson(response, 200, { id: created.record?.record_id, name, parentId: body.parentId || "" });
      return true;
    }

    if (url.pathname === "/api/tasks" && request.method === "POST") {
      const session = currentSession(request);
      if (!session) return sendJson(response, 401, { error: "请先用飞书登录" }), true;
      const body = await readBody(request);
      const taskName = String(body.taskName || "").trim();
      const projectId = String(body.projectId || "").trim();
      const taskDate = String(body.taskDate || "").trim();
      if (!taskName || !projectId || !taskDate) return sendJson(response, 400, { error: "任务、项目、日期都要填写" }), true;

      const token = await getTenantToken();
      const data = await getFormData(token);
      const member = findMember(data.members, session.user);
      if (!member) return sendJson(response, 400, { error: `没有在成员表里找到 ${session.user.name} 对应账号` }), true;

      const collaboratorIds = Array.isArray(body.collaboratorIds) ? body.collaboratorIds.map(String) : [];
      const collaborators = collaboratorIds
        .map((id) => data.members.find((item) => item.id === id))
        .filter((item) => item && item.id !== member.id);
      const assignees = [member, ...collaborators];
      const missingAccounts = collaborators.filter((item) => !userFromMember(item).open_id);
      if (missingAccounts.length) {
        return sendJson(response, 400, { error: `协作成员 ${missingAccounts.map((item) => item.name).join("、")} 没有绑定飞书账号` }), true;
      }

      const reportIds = [];
      for (const assignee of assignees) {
        const reportUser = assignee.id === member.id ? session.user : userFromMember(assignee);
        const reportId = await findOrCreateWeeklyReport(token, reportUser, assignee, projectId, taskDate);
        if (reportId && !reportIds.includes(reportId)) reportIds.push(reportId);
      }
      const fields = {
        任务: taskName,
        所属项目: [projectId],
        状态: body.status || "已完成",
        开始时间: dateToTimestamp(taskDate),
        任务执行人: assignees.map((item) => item.id),
        "📝  周报": reportIds,
      };
      if (body.deadline) fields["截止时间"] = dateToTimestamp(body.deadline);
      if (body.note) fields["备注"] = String(body.note);
      const created = await bitable(token, data.taskTable, "/records", { method: "POST", body: { fields } });
      runSync();
      sendJson(response, 200, { recordId: created.record?.record_id, reportIds, members: assignees.map((item) => item.name) });
      return true;
    }
  } catch (error) {
    sendJson(response, 500, { error: error.message });
    return true;
  }
  return false;
}

async function handleAuth(request, response, url) {
  if (url.pathname === "/auth/feishu") {
    const state = makeId();
    response.setHeader("Set-Cookie", `oauth_state=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
    const redirectUri = callbackUrl(request);
    const auth = new URL(FEISHU_AUTH_URL);
    auth.searchParams.set("client_id", getEnv("FEISHU_APP_ID"));
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("scope", process.env.FEISHU_OAUTH_SCOPE || "auth:user.id:read");
    auth.searchParams.set("state", state);
    send(response, 302, "", { Location: auth.toString() });
    return true;
  }

  if (url.pathname === "/auth/feishu/callback") {
    const cookies = parseCookies(request);
    if (!url.searchParams.get("code") || cookies.oauth_state !== url.searchParams.get("state")) {
      send(response, 400, "Feishu login failed: invalid code or state");
      return true;
    }
    try {
      const appToken = await getAppAccessToken();
      const tokenData = await feishuRequest(`${FEISHU_API}/authen/v1/oidc/access_token`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: url.searchParams.get("code"),
        }),
      });
      const userData = await feishuRequest(`${FEISHU_API}/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      setSession(response, {
        name: userData.name,
        en_name: userData.en_name,
        open_id: userData.open_id,
        user_id: userData.user_id,
        avatar_url: userData.avatar_thumb || userData.avatar_url,
      });
      send(response, 302, "", { Location: "/form.html" });
    } catch (error) {
      send(response, 500, `Feishu login failed: ${error.message}`);
    }
    return true;
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (await handleAuth(request, response, url)) return;
  if (url.pathname.startsWith("/api/") && (await handleApi(request, response, url))) return;

  const pathname = decodeURIComponent(url.pathname === "/" ? `/${homePage}` : url.pathname);
  const filePath = path.resolve(root, `.${pathname}`);

  if (!filePath.startsWith(root)) {
    send(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(response, 404, "Not found");
      return;
    }
    const headers = {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
    };
    if ([".html", ".css", ".js"].includes(path.extname(filePath)) || path.basename(filePath) === "data.json") {
      headers["Cache-Control"] = "no-store";
    }
    send(response, 200, data, headers);
  });
});

runSync();
scheduleDailySync();
server.listen(port, () => {
  console.log(`Dashboard running at http://localhost:${port}/`);
  console.log(`Feishu sync schedule: every day at ${String(syncHour).padStart(2, "0")}:${String(syncMinute).padStart(2, "0")}`);
});
