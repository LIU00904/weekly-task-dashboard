const state = {
  user: null,
  member: null,
  projects: [],
};

const els = {
  userCard: document.querySelector("#userCard"),
  loginPanel: document.querySelector("#loginPanel"),
  formPanel: document.querySelector("#formPanel"),
  resultPanel: document.querySelector("#resultPanel"),
  memberHint: document.querySelector("#memberHint"),
  reloadBtn: document.querySelector("#reloadBtn"),
  selects: [document.querySelector("#projectLevel0"), document.querySelector("#projectLevel1"), document.querySelector("#projectLevel2")],
  newProjectName: document.querySelector("#newProjectName"),
  addProjectBtn: document.querySelector("#addProjectBtn"),
  taskForm: document.querySelector("#taskForm"),
  taskName: document.querySelector("#taskName"),
  status: document.querySelector("#status"),
  taskDate: document.querySelector("#taskDate"),
  deadline: document.querySelector("#deadline"),
  note: document.querySelector("#note"),
  reportPreview: document.querySelector("#reportPreview"),
  submitBtn: document.querySelector("#submitBtn"),
  submitLabel: document.querySelector("#submitBtn .submit-label"),
};

function todayIso() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function mondayOf(value) {
  const date = value ? new Date(`${value}T00:00:00+08:00`) : new Date();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDate(value) {
  const [year, month, day] = value.split("-");
  return `${year}/${month}/${day}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function selectedProjectId() {
  return [...els.selects].reverse().map((select) => select.value).find(Boolean) || "";
}

function selectedProjectName() {
  const id = selectedProjectId();
  return state.projects.find((project) => project.id === id)?.name || "未选择项目";
}

function childrenOf(parentId) {
  return state.projects
    .filter((project) => project.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function fillSelect(level, parentId) {
  const select = els.selects[level];
  const children = childrenOf(parentId);
  select.innerHTML = `<option value="">${level === 0 ? "选择项目" : "不选择 / 无更多分支"}</option>`;
  for (const project of children) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    select.append(option);
  }
  select.disabled = level > 0 && !parentId;
}

function renderProjectSelects(changedLevel = -1) {
  if (changedLevel <= -1) fillSelect(0, "");
  for (let level = Math.max(changedLevel + 1, 1); level < els.selects.length; level += 1) {
    fillSelect(level, els.selects[level - 1].value);
  }
  updateReportPreview();
}

function renderUser() {
  if (!state.user) return;
  const avatar = state.user.avatar_url
    ? `<img src="${state.user.avatar_url}" alt="${state.user.name}" />`
    : state.user.name.slice(0, 1);
  els.userCard.innerHTML = `
    <div class="avatar">${avatar}</div>
    <div>
      <strong>${state.user.name}</strong>
      <span>${state.member ? `已匹配成员：${state.member.name}` : "等待匹配成员表"}</span>
    </div>
  `;
}

function updateReportPreview() {
  const date = els.taskDate.value || todayIso();
  const monday = mondayOf(date);
  const name = state.member?.name || state.user?.name || "当前成员";
  els.reportPreview.textContent = `将关联周报：${name} + ${formatDate(monday)}；项目：${selectedProjectName()}`;
}

async function loadOptions() {
  const data = await api("/api/form-options");
  state.user = data.user;
  state.member = data.member;
  state.projects = data.projects || [];
  renderUser();
  els.memberHint.textContent = state.member
    ? `已根据飞书账号自动匹配：${state.member.name}`
    : "没有在成员表里匹配到当前账号，提交前需要先把账号加入成员表。";
  renderProjectSelects();
}

function showResult(type, text) {
  els.resultPanel.className = `panel result-panel ${type}`;
  els.resultPanel.textContent = text;
}

function setSubmitting(isSubmitting, label = "提交并写入多维表格") {
  els.submitBtn.disabled = isSubmitting;
  els.submitBtn.classList.toggle("is-loading", isSubmitting);
  els.submitBtn.classList.remove("is-success");
  els.submitLabel.textContent = label;
}

function setSubmitSuccess() {
  els.submitBtn.classList.remove("is-loading");
  els.submitBtn.classList.add("is-success");
  els.submitLabel.textContent = "已提交，写入成功";
}

async function boot() {
  els.taskDate.value = todayIso();
  els.deadline.value = "";
  updateReportPreview();
  const me = await api("/api/me");
  if (!me.user) {
    els.loginPanel.classList.remove("hidden");
    els.formPanel.classList.add("hidden");
    return;
  }
  state.user = me.user;
  els.loginPanel.classList.add("hidden");
  els.formPanel.classList.remove("hidden");
  await loadOptions();
}

els.selects.forEach((select, index) => {
  select.addEventListener("change", () => renderProjectSelects(index));
});

els.taskDate.addEventListener("change", updateReportPreview);
els.reloadBtn.addEventListener("click", loadOptions);

els.addProjectBtn.addEventListener("click", async () => {
  const name = els.newProjectName.value.trim();
  if (!name) return showResult("error", "先写一个项目/分支名称。");
  const parentId = selectedProjectId();
  const created = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, parentId }),
  });
  state.projects.push(created);
  els.newProjectName.value = "";
  renderProjectSelects();
  showResult("success", `已新增：${created.name}`);
});

els.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (els.submitBtn.disabled) return;
  const projectId = selectedProjectId();
  if (!projectId) return showResult("error", "先选择一个项目或分支。");
  const payload = {
    projectId,
    taskName: els.taskName.value.trim(),
    status: els.status.value,
    taskDate: els.taskDate.value,
    deadline: els.deadline.value,
    note: els.note.value.trim(),
  };
  try {
    setSubmitting(true, "正在写入飞书...");
    showResult("success", "正在提交，请稍等。系统会自动关联项目、成员和本周周报。");
    const data = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.taskName.value = "";
    els.note.value = "";
    setSubmitSuccess();
    showResult("success", `提交成功：已写入任务，并关联到 ${data.member} 的本周周报。`);
    setTimeout(() => setSubmitting(false), 1500);
  } catch (error) {
    setSubmitting(false);
    showResult("error", error.message);
  }
});

boot().catch((error) => showResult("error", error.message));
