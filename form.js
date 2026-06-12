const state = {
  user: null,
  member: null,
  projects: [],
  members: [],
  collaboratorIds: new Set(),
};

const els = {
  userCard: document.querySelector("#userCard"),
  loginPanel: document.querySelector("#loginPanel"),
  formPanel: document.querySelector("#formPanel"),
  resultPanel: document.querySelector("#resultPanel"),
  memberHint: document.querySelector("#memberHint"),
  reloadBtn: document.querySelector("#reloadBtn"),
  selects: [document.querySelector("#projectLevel0"), document.querySelector("#projectLevel1"), document.querySelector("#projectLevel2")],
  newRootProjectName: document.querySelector("#newRootProjectName"),
  addRootProjectBtn: document.querySelector("#addRootProjectBtn"),
  newProjectName: document.querySelector("#newProjectName"),
  addProjectBtn: document.querySelector("#addProjectBtn"),
  taskForm: document.querySelector("#taskForm"),
  taskName: document.querySelector("#taskName"),
  status: document.querySelector("#status"),
  taskDate: document.querySelector("#taskDate"),
  deadline: document.querySelector("#deadline"),
  note: document.querySelector("#note"),
  reportPreview: document.querySelector("#reportPreview"),
  collaboratorList: document.querySelector("#collaboratorList"),
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

function selectProjectPath(projectId) {
  const path = [];
  let current = state.projects.find((project) => project.id === projectId);
  while (current) {
    path.unshift(current.id);
    current = state.projects.find((project) => project.id === current.parentId);
  }
  renderProjectSelects();
  path.slice(0, els.selects.length).forEach((id, index) => {
    els.selects[index].value = id;
    renderProjectSelects(index);
  });
  updateReportPreview();
}

function renderUser() {
  const name = state.user?.name || "未登录";
  const avatar = state.user?.avatar_url
    ? `<img src="${state.user.avatar_url}" alt="${name}" />`
    : name.slice(0, 1);
  els.userCard.innerHTML = `
    <div class="lanyard-band"></div>
    <div class="lanyard-clip"></div>
    <div class="lanyard-badge">
      <div class="lanyard-shine"></div>
      <div class="avatar">${avatar}</div>
      <div>
        <span>${state.member ? "已匹配飞书成员" : "等待匹配成员表"}</span>
        <strong>${name}</strong>
        <small>${state.member ? state.member.name : "Weekly form"}</small>
      </div>
    </div>
  `;
  els.userCard.classList.remove("swing-in");
  void els.userCard.offsetWidth;
  els.userCard.classList.add("swing-in");
}

function renderCollaborators() {
  const currentId = state.member?.id;
  const candidates = state.members.filter((member) => member.id && member.id !== currentId && member.name);
  if (!candidates.length) {
    els.collaboratorList.innerHTML = `<div class="collab-empty">暂无可选协作成员</div>`;
    return;
  }
  els.collaboratorList.innerHTML = candidates
    .map(
      (member) => `
        <button class="collab-chip ${state.collaboratorIds.has(member.id) ? "active" : ""}" type="button" data-member-id="${member.id}">
          <span>${member.name.slice(0, 1)}</span>
          <strong>${member.name}</strong>
        </button>
      `,
    )
    .join("");
}

function updateReportPreview() {
  const date = els.taskDate.value || todayIso();
  const monday = mondayOf(date);
  const name = state.member?.name || state.user?.name || "当前成员";
  const collaboratorNames = state.members
    .filter((member) => state.collaboratorIds.has(member.id))
    .map((member) => member.name);
  const names = [name, ...collaboratorNames].join("、");
  els.reportPreview.textContent = `将关联周报：${names} + ${formatDate(monday)}；项目：${selectedProjectName()}`;
}

async function loadOptions({ refresh = false } = {}) {
  const data = await api(`/api/form-options${refresh ? "?refresh=1" : ""}`);
  state.user = data.user;
  state.member = data.member;
  state.members = data.members || [];
  state.collaboratorIds = new Set([...state.collaboratorIds].filter((id) => state.members.some((member) => member.id === id)));
  state.projects = data.projects || [];
  renderUser();
  renderCollaborators();
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
els.reloadBtn.addEventListener("click", () => loadOptions({ refresh: true }));

els.collaboratorList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-member-id]");
  if (!button) return;
  const id = button.dataset.memberId;
  if (state.collaboratorIds.has(id)) {
    state.collaboratorIds.delete(id);
  } else {
    state.collaboratorIds.add(id);
  }
  renderCollaborators();
  updateReportPreview();
});

els.addRootProjectBtn.addEventListener("click", async () => {
  const name = els.newRootProjectName.value.trim();
  if (!name) return showResult("error", "先写一个一级项目名称。");
  const created = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, parentId: "" }),
  });
  state.projects.push(created);
  els.newRootProjectName.value = "";
  selectProjectPath(created.id);
  showResult("success", `已新增一级项目：${created.name}`);
});

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
    collaboratorIds: [...state.collaboratorIds],
  };
  try {
    setSubmitting(true, "正在写入飞书...");
    showResult("success", "正在提交，请稍等。系统会自动关联项目、成员、协作成员和对应周报。");
    const data = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.taskName.value = "";
    els.note.value = "";
    setSubmitSuccess();
    showResult("success", `提交成功：已写入任务，并关联到 ${data.members.join("、")} 的本周周报。`);
    setTimeout(() => setSubmitting(false), 1500);
  } catch (error) {
    setSubmitting(false);
    showResult("error", error.message);
  }
});

boot().catch((error) => showResult("error", error.message));
