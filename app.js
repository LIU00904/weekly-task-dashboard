let allTasks = [];
let tasks = [];
let weekDays = [];

const palette = ["#2f6bff", "#7c3aed", "#22b573", "#f59e0b", "#f43f5e", "#06b6d4", "#8b5cf6", "#14b8a6"];
let projects = [];
let projectColors = {};
let members = [];
let weekOptions = [];
let activeWeekIndex = 0;

let activeIndex = 0;
let searchTerm = "";
let expanded = false;
let selectedProject = "全部";
let viewMode = "calendar";
let compact = false;
let hideEmptyDays = false;
let expandedRootProjects = new Set();
let dataReady = false;
let dataLoadError = "";
const dataCacheKey = "oxygen-weekly-dashboard:data:v3";

const memberList = document.querySelector("#memberList");
const pageLabel = document.querySelector("#pageLabel");
const calendarWeek = document.querySelector("#calendarWeek");
const activeMemberTitle = document.querySelector("#activeMemberTitle");
const activeMemberMeta = document.querySelector("#activeMemberMeta");
const searchInput = document.querySelector("#searchInput");
const projectFilters = document.querySelector("#projectFilters");
const drawer = document.querySelector("#taskDrawer");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const drawerKicker = document.querySelector("#drawerKicker");
const drawerTitle = document.querySelector("#drawerTitle");
const drawerMeta = document.querySelector("#drawerMeta");
const drawerList = document.querySelector("#drawerList");
const weekLabel = document.querySelector("#weekLabel");
const prevWeekButton = document.querySelector("#prevWeek");
const nextWeekButton = document.querySelector("#nextWeek");
const projectOverviewList = document.querySelector("#projectOverviewList");
const avgTasks = document.querySelector("#avgTasks");
const maxTasks = document.querySelector("#maxTasks");
const activeDays = document.querySelector("#activeDays");

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

function assertLocalDateMath() {
  const date = dateFromIso("2026-06-02");
  const weekName = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  if (weekName !== "周二" || localIsoDate(date) !== "2026-06-02") {
    throw new Error("Local date math is broken: 2026-06-02 must render as 周二.");
  }
}

function startOfWeek(value) {
  const date = typeof value === "string" ? dateFromIso(value) : new Date(value);
  const day = date.getDay() || 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - day + 1);
  return localIsoDate(date);
}

function buildWeekOptions(sourceTasks, sourceWeeks = []) {
  if (Array.isArray(sourceWeeks) && sourceWeeks.length) {
    return sourceWeeks.map((week, index, arr) => {
      const relative = index === arr.length - 1 ? "本周" : index === arr.length - 2 ? "上周" : index === arr.length - 3 ? "上上周" : "";
      return {
        start: week.start,
        end: week.end,
        label: relative ? `${relative} ${week.label}` : week.label,
      };
    });
  }
  const starts = [...new Set(sourceTasks.map((task) => startOfWeek(task.date)))].sort();
  return starts.map((start, index, arr) => {
    const startDate = dateFromIso(start);
    const endDate = dateFromIso(start);
    endDate.setDate(endDate.getDate() + 6);
    const label = `${startDate.getMonth() + 1}/${startDate.getDate()}-${endDate.getMonth() + 1}/${endDate.getDate()}`;
    const relative = index === arr.length - 1 ? "本周" : index === arr.length - 2 ? "上周" : index === arr.length - 3 ? "上上周" : "";
    return {
      start,
      end: localIsoDate(endDate),
      label: relative ? `${relative} ${label}` : label,
    };
  });
}

function chooseDefaultWeekIndex(options) {
  if (!options.length) return 0;
  const today = localIsoDate(new Date());
  const currentWeekIndex = options.findIndex((week) => today >= week.start && today <= week.end);
  if (currentWeekIndex >= 0) return currentWeekIndex;
  const latestPastWeekIndex = options.reduce((best, week, index) => (week.start <= today ? index : best), -1);
  return latestPastWeekIndex >= 0 ? latestPastWeekIndex : options.length - 1;
}

function isBadLabel(value) {
  const text = String(value || "").trim();
  return (
    !text ||
    text === "undefined" ||
    text === "null" ||
    text === "text" ||
    /^tbl[a-zA-Z0-9]+(?:\s+text)?$/.test(text) ||
    /^rec[a-zA-Z0-9]+$/.test(text)
  );
}

function cleanLabel(value, fallback = "未归类") {
  const text = String(value || "").trim();
  return isBadLabel(text) ? fallback : text;
}

function cleanTask(task) {
  const project = cleanLabel(task.project, "未归类");
  const subProject = cleanLabel(task.subProject, project);
  const rootProject = cleanLabel(task.rootProject, subProject || project || "未归类");
  return {
    date: task.date,
    member: cleanLabel(task.member, "未分配"),
    project,
    subProject,
    rootProject,
    name: cleanLabel(task.name, "未命名任务"),
  };
}

function readCachedPayload() {
  try {
    const raw = window.localStorage?.getItem(dataCacheKey);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!Array.isArray(cached.tasks) || !cached.tasks.length) return null;
    return cached;
  } catch (error) {
    console.warn("Failed to read dashboard cache", error);
    return null;
  }
}

function writeCachedPayload(payload) {
  try {
    window.localStorage?.setItem(
      dataCacheKey,
      JSON.stringify({
        ...payload,
        cachedAt: new Date().toISOString(),
      })
    );
  } catch (error) {
    console.warn("Failed to write dashboard cache", error);
  }
}

function applyPayload(payload, { previousWeekStart = "", hadReliableData = false, fromCache = false } = {}) {
  if (!Array.isArray(payload.tasks) || !payload.tasks.length) throw new Error("data.json has no tasks");
  const sourceWeeks = payload.source?.weeks || [];
  allTasks = payload.tasks.map(cleanTask).filter((task) => task.date && task.name);
  if (!allTasks.length) throw new Error("data.json has no usable tasks");
  dataReady = true;
  dataLoadError = fromCache ? "正在显示上次成功缓存的数据，后台会继续刷新。" : "";
  weekOptions = buildWeekOptions(allTasks, sourceWeeks);
  const restoredWeekIndex = hadReliableData ? weekOptions.findIndex((week) => week.start === previousWeekStart) : -1;
  activeWeekIndex = restoredWeekIndex >= 0 ? restoredWeekIndex : chooseDefaultWeekIndex(weekOptions);
  refreshDerivedData();
}

function hydrateFromCache() {
  const cached = readCachedPayload();
  if (!cached) return false;
  try {
    applyPayload(cached, { fromCache: true });
    return true;
  } catch (error) {
    console.warn("Failed to hydrate dashboard cache", error);
    return false;
  }
}

function buildWeekDays(sourceTasks = []) {
  const activeWeek = weekOptions[activeWeekIndex];
  const monday = activeWeek ? dateFromIso(activeWeek.start) : dateFromIso(startOfWeek(sourceTasks[0]?.date || localIsoDate(new Date())));
  const names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return names.map((name, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const iso = `${year}-${month}-${day}`;
    return [iso, name, `${date.getMonth() + 1}/${date.getDate()}`];
  });
}

function refreshDerivedData() {
  const activeWeek = weekOptions[activeWeekIndex];
  tasks = activeWeek ? allTasks.filter((task) => task.date >= activeWeek.start && task.date <= activeWeek.end) : [...allTasks];
  weekDays = buildWeekDays(tasks);
  projects = [...new Set(tasks.map((task) => task.rootProject || task.project))];
  projectColors = Object.fromEntries(projects.map((project, index) => [project, palette[index % palette.length]]));
  members = [...new Set(tasks.map((task) => task.member))]
    .map((member) => ({
      name: member,
      count: tasks.filter((task) => task.member === member).length,
      days: new Set(tasks.filter((task) => task.member === member).map((task) => task.date)).size,
    }))
    .sort((a, b) => b.count - a.count);
  if (activeIndex >= members.length) activeIndex = 0;
  const selectableProjects = new Set(tasks.flatMap((task) => [task.rootProject || task.project, task.project]));
  if (selectedProject !== "全部" && !selectableProjects.has(selectedProject)) selectedProject = "全部";
}

async function loadData() {
  assertLocalDateMath();
  const previousWeekStart = weekOptions[activeWeekIndex]?.start;
  const hadReliableData = dataReady;
  try {
    const response = await fetch(`./data.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("No data.json");
    const payload = await response.json();
    applyPayload(payload, { previousWeekStart, hadReliableData });
    writeCachedPayload(payload);
  } catch (error) {
    console.warn(error);
    if (hadReliableData) {
      dataLoadError = "";
      refreshDerivedData();
      return;
    }
    const cached = readCachedPayload();
    if (cached) {
      try {
        applyPayload(cached, { fromCache: true });
        return;
      } catch (cacheError) {
        console.warn(cacheError);
      }
    }
    allTasks = [];
    dataReady = false;
    dataLoadError = "飞书数据暂时没有加载成功，请刷新页面或稍后再试。";
    weekOptions = buildWeekOptions(allTasks, []);
    activeWeekIndex = chooseDefaultWeekIndex(weekOptions);
    refreshDerivedData();
  }
}

function taskMatchesProject(task, project) {
  return project === "全部" || task.project === project || task.subProject === project || task.rootProject === project;
}

function taskSearchText(task) {
  return [task.rootProject, task.subProject, task.project, task.name, task.member].filter(Boolean).join(" ").toLowerCase();
}

function countBy(field, source = tasks) {
  return source.reduce((acc, task) => {
    acc[task[field]] = (acc[task[field]] || 0) + 1;
    return acc;
  }, {});
}

function entriesByCount(data, limit = Infinity) {
  return Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function weekFilteredTasks() {
  return tasks.filter((task) => {
    const hitProject = taskMatchesProject(task, selectedProject);
    const hitSearch = taskSearchText(task).includes(searchTerm);
    return hitProject && hitSearch;
  });
}

function searchedTasks() {
  return tasks.filter((task) => taskSearchText(task).includes(searchTerm));
}

function getFilteredTasks({ memberOnly = true } = {}) {
  if (!members.length) return [];
  const activeMember = members[activeIndex].name;
  return tasks.filter((task) => {
    const hitMember = !memberOnly || task.member === activeMember;
    const hitProject = taskMatchesProject(task, selectedProject);
    const hitSearch = taskSearchText(task).includes(searchTerm);
    return hitMember && hitProject && hitSearch;
  });
}

function formatDate(date) {
  const day = weekDays.find(([value]) => value === date);
  return day ? `${day[2]} ${day[1]}` : date;
}

function taskMarkup(task, index) {
  return `
    <button class="task-card" data-task-index="${index}" style="--task-color:${projectColors[task.rootProject] || projectColors[task.project]}">
      <span class="task-project">${task.project}</span>
      <div class="task-name">${task.name}</div>
    </button>
  `;
}

function memberInitial(name) {
  return name.slice(0, 1);
}

function renderMembers() {
  memberList.innerHTML = "";
  if (!members.length) {
    pageLabel.textContent = "0 / 0";
    memberList.innerHTML = `<div class="empty-day">${dataLoadError || "当前周暂无成员任务"}</div>`;
    return;
  }
  members.forEach((member, index) => {
    const topProject = entriesByCount(countBy("rootProject", tasks.filter((task) => task.member === member.name)), 1)[0]?.[0] || "-";
    const button = document.createElement("button");
    button.className = `member-tab ${index === activeIndex ? "active" : ""}`;
    button.innerHTML = `
      <span class="member-avatar">${memberInitial(member.name)}</span>
      <span class="member-main">
        <strong>${member.name}</strong>
        <small>${member.days} 个工作日 · 高频：${topProject}</small>
      </span>
      <span class="member-count">${member.count}</span>
    `;
    button.addEventListener("click", () => {
      activeIndex = index;
      render();
    });
    memberList.appendChild(button);
  });
  pageLabel.textContent = `${activeIndex + 1} / ${members.length}`;
}

function renderProjectFilters() {
  const counts = countBy("rootProject");
  const chips = [["全部", tasks.length], ...entriesByCount(counts)];
  projectFilters.innerHTML = chips
    .map(([project, count]) => {
      const color = project === "全部" ? "#2f6bff" : projectColors[project];
      return `
        <button class="filter-chip ${selectedProject === project ? "active" : ""}" data-project="${project}">
          <span class="chip-dot" style="--dot:${color}"></span>
          ${project}
          <strong>${count}</strong>
        </button>
      `;
    })
    .join("");
}

function renderWeekSwitcher() {
  const activeWeek = weekOptions[activeWeekIndex];
  weekLabel.textContent = activeWeek ? activeWeek.label : "暂无周数据";
  prevWeekButton.disabled = activeWeekIndex <= 0;
  nextWeekButton.disabled = activeWeekIndex >= weekOptions.length - 1;
}

function renderProjectOverview() {
  const groups = projectGroups(searchedTasks());
  if (!groups.length) {
    projectOverviewList.innerHTML = `<div class="empty-day">${dataLoadError || "当前筛选下暂无项目任务"}</div>`;
    return;
  }
  const max = Math.max(...groups.map((group) => group.count), 1);
  projectOverviewList.innerHTML = groups
    .map((group, index) => {
      const color = projectColors[group.root] || palette[index % palette.length];
      const expandedClass = expandedRootProjects.has(group.root) ? "expanded" : "";
      return `
        <article class="project-system-row project-tree-card ${selectedProject === group.root ? "active" : ""} ${expandedClass}" style="--dot:${color}">
          <button class="project-tree-root" data-root-project="${group.root}">
            <span class="project-icon">${index + 1}</span>
            <span class="project-system-main">
              <strong>${group.root}</strong>
              <small>${group.children.length} 个子项目</small>
              <span class="project-meter"><i style="width:${(group.count / max) * 100}%"></i></span>
            </span>
            <span class="project-score">${group.count}<small>条</small></span>
            <span class="project-arrow">⌄</span>
          </button>
          <div class="project-children">
            ${group.children
              .map(
                (child, childIndex) => `
                  <button class="project-child-row ${selectedProject === child.name ? "active" : ""}" data-sub-project="${child.name}">
                    <span>${childIndex + 1}</span>
                    <strong>${child.name}</strong>
                    <i style="width:${(child.count / group.count) * 100}%"></i>
                    <em>${child.count} 条</em>
                  </button>
                `,
              )
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");
}

function projectGroups(source) {
  const byRoot = new Map();
  source.forEach((task) => {
    const root = task.rootProject || task.project || "未归类";
    const child = task.subProject || task.project || root;
    if (!byRoot.has(root)) byRoot.set(root, { root, count: 0, children: new Map() });
    const group = byRoot.get(root);
    group.count += 1;
    group.children.set(child, (group.children.get(child) || 0) + 1);
  });
  return [...byRoot.values()]
    .map((group) => ({
      ...group,
      children: [...group.children.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.count - a.count || a.root.localeCompare(b.root));
}

function renderHeartbeat() {
  const filtered = getFilteredTasks();
  const counts = weekDays.map(([date, weekName, label]) => ({
    date,
    label,
    count: filtered.filter((task) => task.date === date).length,
  }));
  const peak = counts.reduce((best, item) => (item.count > best.count ? item : best), counts[0]);
  avgTasks.textContent = Math.round(counts.reduce((sum, item) => sum + item.count, 0) / 7);
  maxTasks.textContent = peak?.count || 0;
  activeDays.textContent = counts.filter((item) => item.count > 0).length;
}

function renderCalendar() {
  if (!members.length) {
    activeMemberTitle.textContent = "暂无数据";
    activeMemberMeta.textContent = "请先同步飞书数据";
    calendarWeek.innerHTML = `<div class="empty-day">暂无任务数据</div>`;
    return;
  }
  const member = members[activeIndex];
  const filtered = getFilteredTasks();
  const dates = hideEmptyDays ? weekDays.filter(([date]) => filtered.some((task) => task.date === date)) : weekDays;

  activeMemberTitle.textContent = member.name;
  activeMemberMeta.textContent = `${filtered.length} 条任务 · ${new Set(filtered.map((task) => task.date)).size} 个工作日`;
  calendarWeek.className = `calendar-week ${compact ? "compact" : ""} ${viewMode === "list" ? "list-mode" : ""}`;
  calendarWeek.innerHTML = "";

  if (!dates.length) {
    calendarWeek.innerHTML = `<div class="empty-day">当前筛选下没有任务，换个项目或关键词试试。</div>`;
    return;
  }

  dates.forEach(([date, weekName, label]) => {
    const dayTasks = filtered.filter((task) => task.date === date);
    const card = document.createElement("article");
    card.className = "day-card";
    const limit = compact ? 7 : 10;
    const visibleTasks = expanded || viewMode === "list" ? dayTasks : dayTasks.slice(0, limit);
    card.innerHTML = `
      <header class="day-head" data-date="${date}">
        <div>
          <div class="day-name">${weekName}</div>
          <div class="day-date">${label}</div>
        </div>
        <div class="day-count">${dayTasks.length} 条</div>
      </header>
      <div class="tasks">
        ${
          visibleTasks.length
            ? visibleTasks.map((task) => taskMarkup(task, tasks.indexOf(task))).join("")
            : `<div class="empty-day">无任务</div>`
        }
        ${
          !expanded && dayTasks.length > visibleTasks.length
            ? `<button class="empty-day" data-date="${date}">还有 ${dayTasks.length - visibleTasks.length} 条，点击查看当天</button>`
            : ""
        }
      </div>
    `;
    calendarWeek.appendChild(card);
  });
}

function renderInsights() {
  const dayEntry = entriesByCount(countBy("date"), 1)[0];
  const projectEntry = entriesByCount(countBy("rootProject"), 1)[0];
  const filtered = getFilteredTasks();
  if (!dayEntry || !projectEntry || !members.length) return;
  document.querySelector("#peakInsight").textContent = `${formatDate(dayEntry[0])} · ${dayEntry[1]} 条`;
  document.querySelector("#projectInsight").textContent = `${projectEntry[0]} · ${projectEntry[1]} 条`;
  document.querySelector("#focusInsight").textContent = `${members[activeIndex].name} · ${filtered.length} 条`;
  document.querySelector("#focusInsightMeta").textContent =
    `${selectedProject === "全部" ? "全部项目" : selectedProject}${searchTerm ? ` · 搜索 ${searchTerm}` : ""}`;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

function openDrawer({ title, kicker = "任务详情", items, meta }) {
  drawerKicker.textContent = kicker;
  drawerTitle.textContent = title;
  drawerMeta.textContent = meta || `${items.length} 条任务`;
  drawerList.innerHTML = items.length
    ? items
        .map(
          (task) => `
        <article class="drawer-item">
          <strong>${task.project}</strong>
          <p>${task.name}</p>
          <small>${task.member} · ${formatDate(task.date)}</small>
        </article>
      `,
        )
        .join("")
    : `<div class="empty-day">没有任务</div>`;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.hidden = false;
}

function closeDrawer() {
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.hidden = true;
}

function copySummary() {
  const lines = members.flatMap((member) => {
    const memberLines = [`${member.name}`];
    weekDays.forEach(([date, weekName, label]) => {
      const dayTasks = tasks.filter((task) => task.member === member.name && task.date === date);
      if (!dayTasks.length) return;
      memberLines.push(`${label} ${weekName}`);
      dayTasks.forEach((task) => memberLines.push(`- ${task.rootProject || task.project} / ${task.project}｜${task.name}`));
    });
    return memberLines.concat("");
  });
  navigator.clipboard.writeText(lines.join("\n")).then(() => showToast("已复制本周汇总"));
}

function render() {
  renderWeekSwitcher();
  renderMembers();
  renderProjectFilters();
  renderCalendar();
  renderProjectOverview();
  renderHeartbeat();
  renderInsights();
  document.querySelector("#totalRows").textContent = tasks.length;
  document.querySelector("#memberCount").textContent = members.length;
  document.querySelector("#projectCount").textContent = projects.length;
}

document.querySelector("#prevMember").addEventListener("click", () => {
  if (!members.length) return;
  activeIndex = (activeIndex - 1 + members.length) % members.length;
  render();
});

document.querySelector("#nextMember").addEventListener("click", () => {
  if (!members.length) return;
  activeIndex = (activeIndex + 1) % members.length;
  render();
});

prevWeekButton.addEventListener("click", () => {
  if (activeWeekIndex <= 0) return;
  activeWeekIndex -= 1;
  activeIndex = 0;
  selectedProject = "全部";
  refreshDerivedData();
  render();
});

nextWeekButton.addEventListener("click", () => {
  if (activeWeekIndex >= weekOptions.length - 1) return;
  activeWeekIndex += 1;
  activeIndex = 0;
  selectedProject = "全部";
  refreshDerivedData();
  render();
});

document.querySelector("#expandAll").addEventListener("click", (event) => {
  expanded = !expanded;
  event.currentTarget.textContent = expanded ? "收起长列表" : "展开全部";
  renderCalendar();
});

document.querySelector("#copySummary").addEventListener("click", copySummary);

searchInput.addEventListener("input", (event) => {
  searchTerm = event.target.value.trim().toLowerCase();
  render();
});

projectFilters.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-project]");
  if (!chip) return;
  selectedProject = chip.dataset.project;
  render();
});

projectOverviewList.addEventListener("click", (event) => {
  const child = event.target.closest("[data-sub-project]");
  if (child) {
    selectedProject = selectedProject === child.dataset.subProject ? "全部" : child.dataset.subProject;
    render();
    return;
  }

  const root = event.target.closest("[data-root-project]");
  if (!root) return;
  const project = root.dataset.rootProject;
  if (expandedRootProjects.has(project)) {
    expandedRootProjects.delete(project);
  } else {
    expandedRootProjects.add(project);
  }
  selectedProject = selectedProject === project ? "全部" : project;
  render();
});

calendarWeek.addEventListener("click", (event) => {
  const taskButton = event.target.closest("[data-task-index]");
  if (taskButton) {
    const task = tasks[Number(taskButton.dataset.taskIndex)];
    openDrawer({ title: task.name, kicker: task.project, items: [task], meta: `${task.member} · ${formatDate(task.date)}` });
    return;
  }

  const dayTarget = event.target.closest("[data-date]");
  if (dayTarget) {
    const date = dayTarget.dataset.date;
    const items = getFilteredTasks().filter((task) => task.date === date);
    openDrawer({ title: formatDate(date), kicker: "当天任务", items, meta: `${members[activeIndex].name} · ${items.length} 条任务` });
  }
});

document.querySelector("#calendarView").addEventListener("click", () => {
  viewMode = "calendar";
  document.querySelector("#calendarView").classList.add("active");
  document.querySelector("#listView").classList.remove("active");
  renderCalendar();
});

document.querySelector("#listView").addEventListener("click", () => {
  viewMode = "list";
  document.querySelector("#listView").classList.add("active");
  document.querySelector("#calendarView").classList.remove("active");
  renderCalendar();
});

document.querySelector("#densityToggle").addEventListener("click", (event) => {
  compact = !compact;
  event.currentTarget.textContent = compact ? "紧凑模式" : "舒展模式";
  renderCalendar();
});

document.querySelector("#emptyToggle").addEventListener("click", (event) => {
  hideEmptyDays = !hideEmptyDays;
  event.currentTarget.textContent = hideEmptyDays ? "显示空日期" : "隐藏空日期";
  renderCalendar();
});

document.querySelector("#drawerClose").addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});

if (hydrateFromCache()) render();
loadData().then(render);
setInterval(() => {
  loadData().then(render);
}, 10 * 60 * 1000);
