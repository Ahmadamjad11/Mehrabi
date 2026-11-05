(() => {
  const PAGE_SIZE = 25;
  const weekdays = [
    ["sunday", "الأحد"], ["monday", "الاثنين"], ["tuesday", "الثلاثاء"],
    ["wednesday", "الأربعاء"], ["thursday", "الخميس"], ["friday", "الجمعة"], ["saturday", "السبت"],
  ];
  const sourceMeta = {
    official: { title: "سجلات الوزارة", hint: "ابحث بالاسم أو المحافظة أو المديرية أو المنطقة." },
    osm: { title: "معالم OpenStreetMap", hint: "صحّح أسماء معالم OSM. عنصر الوزارة المرتبط يأخذ اسم الوزارة المعدّل ما لم يُضف المدير تجاوزًا خاصًا بـOSM." },
    community: { title: "أماكن المجتمع", hint: "تعديل أسماء وساعات الأماكن التي أضافها المجتمع؛ السجلات الرسمية لا تظهر هنا." },
    moderation: { title: "مراجعة الأماكن", hint: "راجع المشاركات المجتمعية واعتمدها أو ارفضها أو استعد سجلًا محذوفًا." },
    reviews: { title: "مراجعة التعليقات", hint: "راجع البلاغات وأظهر التعليقات أو أخفها؛ لا تُعرض بيانات صاحب التقييم." },
    "name-suggestions": { title: "اقتراحات الأسماء", hint: "راجع الاسم الذي أرسله المستخدم، ثم اعتمده ليظهر الاسم الجديد أو ارفضه مع بقاء الاسم الحالي." },
  };
  const $ = (selector) => document.querySelector(selector);
  const state = { source: "official", search: "", placeStatus: "pending", reviewStatus: "reported", nameSuggestionStatus: "pending", offset: 0, total: 0, items: [], loading: false, debounce: null };
  const loginPanel = $("#login-panel");
  const dashboard = $("#dashboard");
  const list = $("#catalog-list");
  const pageMessage = $("#page-message");

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) showLogin("انتهت الجلسة. سجّل الدخول مرة أخرى.");
      throw new Error(payload.error || "تعذر إكمال الطلب.");
    }
    return payload;
  }

  function showLogin(error = "") {
    dashboard.hidden = true;
    loginPanel.hidden = false;
    $("#login-password").value = "";
    $("#login-error").textContent = error;
    $("#login-error").hidden = !error;
  }

  function showDashboard(user) {
    loginPanel.hidden = true;
    dashboard.hidden = false;
    $("#session-user").textContent = user.email || user.name || "مدير";
  }

  function setMessage(text, kind = "") {
    pageMessage.textContent = text;
    pageMessage.className = `message${kind ? ` ${kind}` : ""}`;
  }

  function formatSchedule(schedule) {
    if (!schedule) return "لم تُحدد ساعات بعد.";
    const parts = weekdays.flatMap(([key, label]) => {
      const intervals = schedule[key];
      if (intervals === null) return [];
      if (intervals.length === 0) return [`${label}: مغلق`];
      return [`${label}: ${intervals.map((item) => `${item.opensAt}–${item.closesAt}`).join("، ")}`];
    });
    return parts.length ? parts.join(" · ") : "لم تُحدد ساعات بعد.";
  }

  function scheduleEditor(item) {
    const schedule = item.weeklyHours || {};
    return `<details class="schedule-details" ${item.hoursMode === "weekly" ? "open" : "hidden"}>
      <summary>جدول الأسبوع للمصلى</summary>
      <p class="schedule-preview">${escapeHtml(formatSchedule(item.weeklyHours))}</p>
      <div class="weekly-editor">${weekdays.map(([key, label]) => {
        const entries = schedule[key];
        const mode = entries === null || entries === undefined ? "unknown" : entries.length === 0 ? "closed" : "open";
        const first = entries?.[0] || {};
        const second = entries?.[1] || {};
        return `<div class="day-row" data-day="${key}">
          <span class="day-name">${label}</span>
          <select class="day-state" aria-label="حالة ${label}">
            <option value="unknown" ${mode === "unknown" ? "selected" : ""}>غير محدد</option>
            <option value="closed" ${mode === "closed" ? "selected" : ""}>مغلق</option>
            <option value="open" ${mode === "open" ? "selected" : ""}>مفتوح</option>
          </select>
          <input class="time-input time-open-1" type="time" aria-label="فتح ${label}" value="${escapeHtml(first.opensAt || "")}" ${mode !== "open" ? "disabled" : ""} />
          <input class="time-input time-close-1" type="time" aria-label="إغلاق ${label}" value="${escapeHtml(first.closesAt || "")}" ${mode !== "open" ? "disabled" : ""} />
          <input class="time-input time-open-2" type="time" aria-label="فتح إضافي ${label}" value="${escapeHtml(second.opensAt || "")}" ${mode !== "open" ? "disabled" : ""} />
          <input class="time-input time-close-2" type="time" aria-label="إغلاق إضافي ${label}" value="${escapeHtml(second.closesAt || "")}" ${mode !== "open" ? "disabled" : ""} />
        </div>`;
      }).join("")}</div>
      <p class="schedule-note">استخدم تنسيق 24 ساعة. يمكن إدخال فترتين كحد أقصى لكل يوم؛ الفترة الليلية التي تعبر منتصف الليل غير مقبولة حاليًا.</p>
    </details>`;
  }

  function statusBadge(item) {
    if (item.isTemporarilyClosed) return '<span class="badge red">مغلق مؤقتًا</span>';
    if (item.kind === "mosque") return '<span class="badge green">يفتح وقت الصلوات</span>';
    if (item.hoursMode === "weekly") return '<span class="badge green">جدول أسبوعي محدد</span>';
    return '<span class="badge">ساعات غير محددة</span>';
  }

  function renderCard(item) {
    const isMosque = item.kind === "mosque";
    const location = [item.area, Number.isFinite(Number(item.latitude)) && item.latitude !== null ? `${Number(item.latitude).toFixed(5)}, ${Number(item.longitude).toFixed(5)}` : ""].filter(Boolean).join(" · ");
    const sourceLabel = item.source === "official" ? "وزارة الأوقاف" : item.source === "osm" ? `OSM · ${item.osmKey}` : "مكان مجتمعي";
    const nameValue = item.displayName;
    const nameLabel = item.source === "community" ? "اسم العرض (اتركه فارغًا لاستخدام الاسم الأصلي)" : "تجاوز الاسم الأصلي (اتركه فارغًا للرجوع إلى المصدر)";
    const namePlaceholder = item.effectiveName;
    const hoursControl = isMosque
      ? `<div class="field"><label>سياسة الدوام</label><div class="badge green">يفتح وقت الصلوات</div><p class="hint">لا ندخل أوقاتًا تفصيلية غير موثقة.</p></div>`
      : `<div class="field"><label for="hours-${escapeHtml(item.id)}">دوام المصلى</label><select class="hours-mode" id="hours-${escapeHtml(item.id)}"><option value="unknown" ${item.hoursMode !== "weekly" ? "selected" : ""}>غير محدد</option><option value="weekly" ${item.hoursMode === "weekly" ? "selected" : ""}>جدول أسبوعي</option></select><p class="hint">الأيام غير المدخلة تظل غير محددة.</p></div>`;
    return `<article class="catalog-card" data-source="${item.source}" data-id="${escapeHtml(item.id)}" ${item.source === "osm" ? `data-osm-key="${escapeHtml(item.osmKey)}"` : ""}>
      <div class="card-top"><div class="card-title"><h3>${escapeHtml(item.effectiveName || (isMosque ? "مسجد" : "مصلى"))}</h3><p class="card-meta">${escapeHtml(sourceLabel)}${location ? ` · ${escapeHtml(location)}` : ""}</p>${item.sourceName && item.sourceName !== item.effectiveName ? `<p class="card-meta">الاسم الأصلي: ${escapeHtml(item.sourceName)}</p>` : ""}${item.matchedOfficialName ? `<p class="card-meta">اسم الوزارة المرتبط: ${escapeHtml(item.matchedOfficialName)}</p>` : ""}</div><div class="badges">${isMosque ? '<span class="badge">مسجد</span>' : '<span class="badge">مصلى</span>'}${statusBadge(item)}${item.displayable === false ? '<span class="badge">غير معروض على الخريطة</span>' : ""}</div></div>
      <div class="card-edit">
        <div class="field"><label for="name-${escapeHtml(item.id)}">${nameLabel}</label><input class="display-name" id="name-${escapeHtml(item.id)}" maxlength="255" value="${escapeHtml(nameValue || "")}" placeholder="${escapeHtml(namePlaceholder || "اكتب الاسم" )}" /></div>
        ${hoursControl}
        <label class="closed-field"><input class="temporarily-closed" type="checkbox" ${item.isTemporarilyClosed ? "checked" : ""} />مغلق مؤقتًا</label>
      </div>
      ${!isMosque ? scheduleEditor(item) : ""}
      <div class="card-actions"><p class="save-result" aria-live="polite"></p><button class="button primary save-entry" type="button">حفظ التعديل</button></div>
    </article>`;
  }

  function bindCard(card) {
    const modeSelect = card.querySelector(".hours-mode");
    if (modeSelect) {
      modeSelect.addEventListener("change", () => {
        const details = card.querySelector(".schedule-details");
        details.hidden = modeSelect.value !== "weekly";
        if (modeSelect.value === "weekly") details.open = true;
      });
    }
    card.querySelectorAll(".day-state").forEach((select) => select.addEventListener("change", () => {
      const row = select.closest(".day-row");
      const enabled = select.value === "open";
      row.querySelectorAll(".time-input").forEach((input) => { input.disabled = !enabled; });
      if (enabled) row.querySelector(".time-open-1").focus();
    }));
    card.querySelector(".save-entry").addEventListener("click", () => saveCard(card));
  }

  function collectWeeklySchedule(card) {
    const schedule = {};
    for (const [key] of weekdays) {
      const row = card.querySelector(`[data-day="${key}"]`);
      const state = row.querySelector(".day-state").value;
      if (state === "unknown") { schedule[key] = null; continue; }
      if (state === "closed") { schedule[key] = []; continue; }
      const values = [
        [row.querySelector(".time-open-1").value, row.querySelector(".time-close-1").value],
        [row.querySelector(".time-open-2").value, row.querySelector(".time-close-2").value],
      ];
      const periods = [];
      for (const [opensAt, closesAt] of values) {
        if (!opensAt && !closesAt) continue;
        if (!opensAt || !closesAt) throw new Error("أكمل وقت الفتح والإغلاق لكل فترة، أو اترك الفترة الثانية فارغة بالكامل.");
        periods.push({ opensAt, closesAt });
      }
      if (periods.length === 0) throw new Error("اختر «غير محدد» أو «مغلق»، أو أدخل وقت فتح وإغلاق لليوم.");
      schedule[key] = periods;
    }
    return schedule;
  }

  async function saveCard(card) {
    const button = card.querySelector(".save-entry");
    const result = card.querySelector(".save-result");
    const source = card.dataset.source;
    button.disabled = true;
    card.classList.add("is-saving");
    result.textContent = "جارٍ الحفظ…";
    try {
      const closed = card.querySelector(".temporarily-closed").checked;
      const name = card.querySelector(".display-name").value.trim();
      let payload;
      if (source === "official") {
        payload = { source, id: Number(card.dataset.id), displayName: name, isTemporarilyClosed: closed };
      } else {
        const hoursMode = card.querySelector(".hours-mode")?.value;
        const kind = card.querySelector(".badges .badge")?.textContent === "مسجد" ? "mosque" : "musalla";
        const actualMode = kind === "mosque" ? "prayer_times" : (hoursMode || "unknown");
        const weeklyHours = actualMode === "weekly" ? collectWeeklySchedule(card) : null;
        if (source === "osm") {
          payload = { source, osmKey: card.dataset.osmKey, displayName: name, hoursMode: actualMode, weeklyHours, isTemporarilyClosed: closed };
        } else {
          payload = { source, id: Number(card.dataset.id), name, hoursMode: actualMode, weeklyHours, isTemporarilyClosed: closed };
        }
      }
      await request("/api/admin/catalog/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      result.textContent = "حُفظ التعديل. ستظهر البيانات الجديدة بعد تحديث التطبيق.";
      result.className = "save-result message success";
      setMessage("حُفظ التعديل بنجاح.", "success");
      await loadCatalog(true);
    } catch (error) {
      result.textContent = error instanceof Error ? error.message : "تعذر حفظ التعديل.";
      result.className = "save-result message error";
    } finally {
      button.disabled = false;
      card.classList.remove("is-saving");
    }
  }

  function renderModerationCard(item) {
    const statusLabels = { pending: "بانتظار المراجعة", approved: "معتمد", rejected: "مرفوض", deleted: "محذوف" };
    const actions = item.status === "pending"
      ? '<button class="button primary" data-action="approve">اعتماد</button><button class="button secondary" data-action="reject">رفض</button>'
      : item.status === "deleted"
        ? '<button class="button primary" data-action="restore">استعادة</button>'
        : item.status === "rejected"
          ? '<button class="button primary" data-action="approve">اعتماد</button><button class="button secondary" data-action="delete">حذف منطقي</button>'
          : '<button class="button secondary" data-action="delete">حذف منطقي</button>';
    return `<article class="catalog-card moderation-card" data-id="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}">
      <div class="card-top"><div class="card-title"><h3>${escapeHtml(item.effectiveName || (item.kind === "mosque" ? "مسجد" : "مصلى"))}</h3>
      <p class="card-meta">${item.kind === "mosque" ? "مسجد" : "مصلى"} · ${escapeHtml(item.area || "لا يوجد عنوان")}</p>
      <p class="card-meta">${escapeHtml(item.latitude)}, ${escapeHtml(item.longitude)} · ${escapeHtml(new Date(item.createdAt).toLocaleDateString("ar-JO"))}</p></div>
      <div class="badges"><span class="badge ${item.status === "approved" ? "green" : item.status === "deleted" || item.status === "rejected" ? "red" : ""}">${statusLabels[item.status] || "غير معروف"}</span></div></div>
      <div class="card-actions moderation-actions">${actions}</div></article>`;
  }

  function renderReviewCard(item) {
    const statusLabels = { visible: "ظاهر", reported: "مبلّغ عنه", hidden: "مخفي" };
    const actions = item.status === "visible"
      ? '<button class="button secondary" data-action="hide">إخفاء</button><button class="button secondary" data-action="report">تعليم كمبلّغ عنه</button>'
      : item.status === "hidden"
        ? '<button class="button primary" data-action="show">إظهار</button><button class="button secondary" data-action="report">تعليم كمبلّغ عنه</button>'
        : '<button class="button primary" data-action="show">إظهار</button><button class="button secondary" data-action="hide">إخفاء</button>';
    return `<article class="catalog-card review-card" data-id="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}">
      <div class="card-top"><div class="card-title"><h3>تقييم المكان #${escapeHtml(item.placeId)}</h3><p class="card-meta">${escapeHtml(new Date(item.createdAt).toLocaleDateString("ar-JO"))}</p></div>
      <div class="badges"><span class="badge">★ ${escapeHtml(item.rating)} / 5</span><span class="badge ${item.status === "visible" ? "green" : item.status === "hidden" ? "red" : ""}">${statusLabels[item.status] || "غير معروف"}</span></div></div>
      <p class="review-comment">${item.comment ? escapeHtml(item.comment) : "بدون تعليق نصي"}</p><div class="card-actions moderation-actions">${actions}</div></article>`;
  }

  function renderNameSuggestionCard(item) {
    const sourceLabels = { community: "مكان مجتمعي", official: "سجل وزارة الأوقاف", osm: "OpenStreetMap" };
    const statusLabels = { pending: "بانتظار المراجعة", approved: "معتمد", rejected: "مرفوض" };
    const statusClass = item.status === "approved" ? "green" : item.status === "rejected" ? "red" : "";
    const coordinates = Number.isFinite(Number(item.targetLatitude)) && item.targetLatitude !== null
      && Number.isFinite(Number(item.targetLongitude)) && item.targetLongitude !== null
      ? `${Number(item.targetLatitude).toFixed(5)}, ${Number(item.targetLongitude).toFixed(5)}` : "";
    const location = [item.targetArea, coordinates].filter(Boolean).join(" · ");
    const actions = item.status === "pending"
      ? '<button class="button primary" data-name-action="approve" type="button">اعتماد الاسم</button><button class="button secondary" data-name-action="reject" type="button">رفض الاقتراح</button>'
      : "";
    return `<article class="catalog-card name-suggestion-card" data-id="${escapeHtml(item.id)}">
      <div class="card-top"><div class="card-title"><h3>${escapeHtml(item.currentName)} <span class="suggestion-arrow">←</span> ${escapeHtml(item.suggestedName)}</h3>
      <p class="card-meta">${escapeHtml(sourceLabels[item.source] || "مصدر غير معروف")} · ${escapeHtml(item.targetKind === "mosque" ? "مسجد" : "مصلى")}</p>
      ${location ? `<p class="card-meta">${escapeHtml(location)}</p>` : ""}
      <p class="card-meta">أُرسل ${escapeHtml(new Date(item.createdAt).toLocaleString("ar-JO"))}</p></div>
      <div class="badges"><span class="badge ${statusClass}">${escapeHtml(statusLabels[item.status] || "غير معروف")}</span></div></div>
      <div class="review-comment"><strong>الاسم الحالي:</strong> ${escapeHtml(item.currentName)}<br /><strong>الاسم المقترح:</strong> ${escapeHtml(item.suggestedName)}</div>
      <div class="card-actions moderation-actions">${actions}</div></article>`;
  }

  async function runModerationAction(card, action, isReview) {
    const confirmText = { reject: "رفض المكان؟", delete: "نقل المكان إلى المحذوفات؟", hide: "إخفاء التعليق؟" }[action];
    if (confirmText && !window.confirm(confirmText)) return;
    const endpoint = isReview ? "/api/admin/moderation/review-status"
      : action === "delete" ? "/api/admin/moderation/place-delete"
        : action === "restore" ? "/api/admin/moderation/place-restore" : "/api/admin/moderation/place-status";
    const status = { approve: "approved", reject: "rejected", hide: "hidden", show: "visible", report: "reported" }[action];
    const payload = isReview || (action !== "delete" && action !== "restore")
      ? { id: Number(card.dataset.id), status }
      : { id: Number(card.dataset.id) };
    const buttons = card.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setMessage("تم تحديث الحالة.", "success");
      await loadCatalog(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر تحديث الحالة.", "error");
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function bindModerationCard(card, isReview) {
    card.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
      void runModerationAction(card, button.dataset.action, isReview);
    }));
  }

  async function runNameSuggestionAction(card, action) {
    const status = action === "approve" ? "approved" : "rejected";
    const confirmText = status === "approved"
      ? "اعتماد الاسم المقترح وتحديث الاسم الظاهر لهذا المكان؟"
      : "رفض اقتراح الاسم؟ سيبقى الاسم الحالي كما هو.";
    if (!window.confirm(confirmText)) return;
    const buttons = card.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await request("/api/admin/name-suggestions/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(card.dataset.id), status }),
      });
      setMessage(status === "approved" ? "تم اعتماد الاسم وتحديث عرضه." : "تم رفض الاقتراح؛ بقي الاسم الحالي دون تغيير.", "success");
      await loadCatalog(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر مراجعة اقتراح الاسم.", "error");
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function bindNameSuggestionCard(card) {
    card.querySelectorAll("[data-name-action]").forEach((button) => button.addEventListener("click", () => {
      void runNameSuggestionAction(card, button.dataset.nameAction);
    }));
  }

  function renderCatalog() {
    const start = state.total === 0 ? 0 : state.offset + 1;
    const end = Math.min(state.offset + state.items.length, state.total);
    const renderer = state.source === "moderation" ? renderModerationCard
      : state.source === "reviews" ? renderReviewCard
        : state.source === "name-suggestions" ? renderNameSuggestionCard : renderCard;
    $("#catalog-list").innerHTML = state.items.length
      ? state.items.map(renderer).join("")
      : '<div class="empty-state">لا توجد سجلات مطابقة.<br />جرّب بحثًا أقصر أو امسح كلمة البحث.</div>';
    $("#catalog-list").querySelectorAll(".catalog-card").forEach((card) => {
      if (state.source === "moderation") bindModerationCard(card, false);
      else if (state.source === "reviews") bindModerationCard(card, true);
      else if (state.source === "name-suggestions") bindNameSuggestionCard(card);
      else bindCard(card);
    });
    $("#result-count").textContent = String(state.total);
    $("#page-label").textContent = state.total ? `${start}–${end} من ${state.total}` : "لا توجد نتائج";
    $("#previous-page").disabled = state.offset === 0 || state.loading;
    $("#next-page").disabled = state.offset + PAGE_SIZE >= state.total || state.loading;
    $("#catalog-title").textContent = sourceMeta[state.source].title;
    $("#catalog-hint").textContent = sourceMeta[state.source].hint;
    $("#moderation-controls").hidden = state.source !== "moderation";
    $("#review-controls").hidden = state.source !== "reviews";
    $("#name-suggestion-controls").hidden = state.source !== "name-suggestions";
    $(".guidance").hidden = state.source === "moderation" || state.source === "reviews" || state.source === "name-suggestions";
    $("#approve-all-button").hidden = state.placeStatus !== "pending";
    const countId = state.source === "official" ? "#official-count" : state.source === "osm" ? "#osm-count" : state.source === "community" ? "#community-count" : null;
    if (countId) $(countId).textContent = String(state.total);
  }

  async function loadCatalog(preserveMessage = false) {
    if (state.loading) return;
    state.loading = true;
    if (!preserveMessage) setMessage("");
    list.innerHTML = '<div class="empty-state">جارٍ تحميل السجلات…</div>';
    renderCatalog();
    try {
      const params = new URLSearchParams({ source: state.source, offset: String(state.offset), limit: String(PAGE_SIZE) });
      if (state.search) params.set("search", state.search);
      if (state.source === "moderation") params.set("status", state.placeStatus);
      if (state.source === "reviews") params.set("status", state.reviewStatus);
      if (state.source === "name-suggestions") params.set("status", state.nameSuggestionStatus);
      const payload = await request(`/api/admin/catalog?${params.toString()}`);
      state.items = Array.isArray(payload.items) ? payload.items : [];
      state.total = Number(payload.total) || 0;
      if (state.offset >= state.total && state.total > 0) state.offset = Math.max(0, Math.floor((state.total - 1) / PAGE_SIZE) * PAGE_SIZE);
      renderCatalog();
    } catch (error) {
      if (error instanceof Error && !loginPanel.hidden) return;
      setMessage(error instanceof Error ? error.message : "تعذر تحميل السجلات.", "error");
      list.innerHTML = '<div class="empty-state">تعذر تحميل البيانات. تحقق من الاتصال وحاول مجددًا.</div>';
    } finally {
      state.loading = false;
      renderCatalog();
    }
  }

  async function checkSession() {
    try {
      const user = await request("/api/admin/session");
      showDashboard(user);
      await loadCatalog();
    } catch {
      showLogin();
    }
  }

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#login-button");
    const errorBox = $("#login-error");
    button.disabled = true;
    button.textContent = "جارٍ التحقق…";
    errorBox.hidden = true;
    try {
      const response = await fetch("/api/auth/email/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-client-platform": "web" },
        body: JSON.stringify({ identifier: $("#login-email").value.trim(), password: $("#login-password").value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "تعذر تسجيل الدخول.");
      $("#login-password").value = "";
      const user = await request("/api/admin/session");
      showDashboard(user);
      await loadCatalog();
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر تسجيل الدخول.";
      errorBox.textContent = message.includes("صلاحية مدير") ? message : message;
      errorBox.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = "تسجيل الدخول";
    }
  });

  $("#logout-button").addEventListener("click", async () => {
    try { await request("/api/admin/logout", { method: "POST" }); } catch { /* session may already be expired */ }
    showLogin();
  });

  document.querySelectorAll(".source-tab").forEach((tab) => tab.addEventListener("click", () => {
    if (state.loading || tab.dataset.source === state.source) return;
    state.source = tab.dataset.source;
    state.offset = 0;
    document.querySelectorAll(".source-tab").forEach((item) => item.classList.toggle("active", item === tab));
    void loadCatalog();
  }));

  $("#place-status-filter").addEventListener("change", () => {
    state.placeStatus = $("#place-status-filter").value;
    state.offset = 0;
    renderCatalog();
    void loadCatalog();
  });
  $("#review-status-filter").addEventListener("change", () => {
    state.reviewStatus = $("#review-status-filter").value;
    state.offset = 0;
    void loadCatalog();
  });
  $("#name-suggestion-status-filter").addEventListener("change", () => {
    state.nameSuggestionStatus = $("#name-suggestion-status-filter").value;
    state.offset = 0;
    void loadCatalog();
  });
  $("#approve-all-button").addEventListener("click", async () => {
    if (!window.confirm("اعتماد جميع الأماكن المعلّقة؟")) return;
    const button = $("#approve-all-button");
    button.disabled = true;
    try {
      const result = await request("/api/admin/moderation/approve-all", { method: "POST" });
      setMessage(`تم اعتماد ${Number(result.count) || 0} مكانًا.`, "success");
      await loadCatalog(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر اعتماد الأماكن.", "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.search = $("#search-input").value.trim();
    state.offset = 0;
    void loadCatalog();
  });
  $("#search-input").addEventListener("input", () => {
    clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.search = $("#search-input").value.trim();
      state.offset = 0;
      void loadCatalog();
    }, 300);
  });
  $("#clear-search").addEventListener("click", () => {
    $("#search-input").value = "";
    state.search = "";
    state.offset = 0;
    void loadCatalog();
  });
  $("#previous-page").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    void loadCatalog();
  });
  $("#next-page").addEventListener("click", () => {
    if (state.offset + PAGE_SIZE >= state.total) return;
    state.offset += PAGE_SIZE;
    void loadCatalog();
  });

  void checkSession();
})();
  const state = { source: "official", search: "", placeStatus: "pending", reviewStatus: "reported", nameSuggestionStatus: "pending", offset: 0, total: 0, items: [], loading: false, debounce: null };
