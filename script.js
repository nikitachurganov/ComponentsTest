(function () {
  "use strict";

  /** Check mark for selected month/year row (`<img>`; path relative to page) */
  const CHECK_ICON_SRC = "./assets/check.svg";

  const MONTH_NAMES = [
    "Январь",
    "Февраль",
    "Март",
    "Апрель",
    "Май",
    "Июнь",
    "Июль",
    "Август",
    "Сентябрь",
    "Октябрь",
    "Ноябрь",
    "Декабрь",
  ];

  /** Default placeholder; restored after calendar hover or close */
  const DEFAULT_PLACEHOLDER = "ДД.ММ.ГГГГ";

  /** When `true`, blur/Enter on an empty field shows the required error message */
  const isRequired = false;

  const ERROR_MSG = "Дата введена неверно";

  const MIN_YEAR = 1998;

  /** Latest selectable calendar year (= current calendar year when read). */
  function getMaxYear() {
    return new Date().getFullYear();
  }

  const el = {
    root: document.getElementById("datepicker"),
    input: document.getElementById("date-input"),
    toggle: document.getElementById("calendar-toggle"),
    clear: document.getElementById("clear-input"),
    popup: document.getElementById("date-calendar-popup"),
    overlay: document.getElementById("calendar-sheet-overlay"),
    sheetInput: document.getElementById("calendar-sheet-input"),
    grid: document.getElementById("calendar-grid"),
    monthButton: document.getElementById("calendar-month-button"),
    yearButton: document.getElementById("calendar-year-button"),
    weekdays: document.getElementById("calendar-weekdays"),
    prev: document.getElementById("calendar-prev-month"),
    next: document.getElementById("calendar-next-month"),
    error: document.getElementById("date-error"),
  };

  /** After Enter: skip duplicate validate on the blur that follows programmatic blur() */
  let skipBlurValidationOnce = false;

  /** blur will move to clear — skip validation until click clears input (helps when relatedTarget is null). */
  let skipBlurForClearTap = false;

  /** `true` after user typed `.` / pasted dotted date — no auto-dot mask until cleared or normalized. */
  let dateInputManualDotMode = false;

  /** @type {{ year: number, month: number }} month is 0–11 */
  let viewDate = { year: new Date().getFullYear(), month: new Date().getMonth() };

  /** @type {'days' | 'months' | 'years'} */
  let calendarViewMode = "days";

  /** @type {Date | null} selected date at local midnight */
  let selectedDate = null;

  /** Shared DD.MM.YYYY tooltip for calendar day hover (single element on `document.body`) */
  let dayTooltipEl = null;

  /** Pending `setTimeout` id for delayed show (cleared on hide / leave) */
  let dayTooltipShowTimerId = null;

  /** Stashed input while a calendar day hover temporarily shows another date */
  let hoverPreviewValueBefore = null;

  let isHoverPreviewActive = false;

  const TOOLTIP_SHOW_DELAY_MS = 1000;
  const TOOLTIP_VIEW_MARGIN = 8;

  /** Popup open/close + month height (ms) */
  const POPUP_HEIGHT_ANIM_MS = 180;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /** Web Animations API handle for calendar height */
  let heightAnimation = null;

  /** Monotonic guard so stale `onfinish`/`oncancel` do not clear styles after a newer run */
  let heightAnimationId = 0;

  /** Timeout backup if `transitionend` does not fire */
  let closeAnimFallbackId = null;

  function cancelHeightAnim() {
    if (heightAnimation) {
      heightAnimation.cancel();
      heightAnimation = null;
    }
    el.popup.style.height = "";
    el.popup.style.overflow = "";
    void el.popup.offsetHeight;
  }

  /** @param {{ year: number, month: number }} vd @param {-1 | 1} delta */
  function addMonth(vd, delta) {
    const d = new Date(vd.year, vd.month + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  }

  function getPopupContentHeight() {
    const popup = el.popup;
    const popupRect = popup.getBoundingClientRect();
    const computed = window.getComputedStyle(popup);

    const paddingTop = parseFloat(computed.paddingTop) || 0;
    const paddingBottom = parseFloat(computed.paddingBottom) || 0;
    const borderTop = parseFloat(computed.borderTopWidth) || 0;
    const borderBottom = parseFloat(computed.borderBottomWidth) || 0;

    let contentBottom = paddingTop;

    Array.from(popup.children).forEach(function (child) {
      if (!(child instanceof HTMLElement)) return;
      if (child.hidden) return;

      const childRect = child.getBoundingClientRect();
      const bottom = childRect.bottom - popupRect.top;
      contentBottom = Math.max(contentBottom, bottom);
    });

    const raw = Math.ceil(contentBottom + paddingBottom + borderTop + borderBottom);
    const viewportMax =
      typeof window.innerHeight === "number" ? Math.floor(window.innerHeight - 32) : raw;
    return Math.min(raw, viewportMax);
  }

  function updateCalendarWithHeightAnimation(updateFn) {
    hideDayTooltip();
    restoreDefaultPlaceholder();

    const popup = el.popup;

    if (!popup || popup.hidden || prefersReducedMotion.matches) {
      updateFn();
      return;
    }

    if (!popup.classList.contains("calendar-popup--open")) {
      updateFn();
      return;
    }

    heightAnimationId += 1;
    const currentAnimId = heightAnimationId;

    if (heightAnimation) {
      heightAnimation.cancel();
      heightAnimation = null;
    }

    const firstHeight = popup.getBoundingClientRect().height;

    popup.style.height = firstHeight + "px";
    popup.style.overflow = "hidden";

    updateFn();

    const lastHeight = getPopupContentHeight();

    if (Math.abs(firstHeight - lastHeight) < 1) {
      popup.style.height = "";
      popup.style.overflow = "";
      return;
    }

    popup.style.height = firstHeight + "px";
    void popup.offsetHeight;

    if (typeof popup.animate !== "function") {
      popup.style.height = "";
      popup.style.overflow = "";
      return;
    }

    heightAnimation = popup.animate(
      [
        { height: firstHeight + "px" },
        { height: lastHeight + "px" },
      ],
      {
        duration: POPUP_HEIGHT_ANIM_MS,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        fill: "forwards",
      }
    );

    heightAnimation.onfinish = function () {
      if (currentAnimId !== heightAnimationId) return;
      popup.style.height = "";
      popup.style.overflow = "";
      heightAnimation = null;
    };

    heightAnimation.oncancel = function () {
      if (currentAnimId !== heightAnimationId) return;
      popup.style.height = "";
      popup.style.overflow = "";
      heightAnimation = null;
    };
  }

  function clearCloseAnimListeners() {
    el.popup.removeEventListener("transitionend", onPopupCloseTransitionEnd);
    if (closeAnimFallbackId !== null) {
      clearTimeout(closeAnimFallbackId);
      closeAnimFallbackId = null;
    }
  }

  function finalizePopupClose() {
    clearCloseAnimListeners();
    if (el.popup.hasAttribute("hidden")) return;

    calendarViewMode = "days";
    el.popup.classList.remove("calendar-popup--closing");
    el.popup.setAttribute("hidden", "");
    el.input.setAttribute("aria-expanded", "false");
    el.popup.setAttribute("aria-hidden", "true");
    setOverlayOpen(false);
    if (!el.toggle.hidden) {
      el.toggle.setAttribute("aria-expanded", "false");
      setToggleLabel(false);
    }
    restoreDefaultPlaceholder();
    hideDayTooltip();
  }

  function onPopupCloseTransitionEnd(ev) {
    if (ev.currentTarget !== el.popup || ev.propertyName !== "opacity") return;
    finalizePopupClose();
  }

  function clearDayTooltipShowTimer() {
    if (dayTooltipShowTimerId !== null) {
      clearTimeout(dayTooltipShowTimerId);
      dayTooltipShowTimerId = null;
    }
  }

  function ensureDayTooltip() {
    if (!dayTooltipEl) {
      dayTooltipEl = document.createElement("div");
      dayTooltipEl.id = "calendar-day-tooltip";
      dayTooltipEl.className = "tooltip";
      dayTooltipEl.setAttribute("role", "tooltip");
      dayTooltipEl.hidden = true;
      dayTooltipEl.setAttribute("aria-hidden", "true");
      document.body.appendChild(dayTooltipEl);
    }
    return dayTooltipEl;
  }

  /** Hide tooltip and cancel any delayed show */
  function hideDayTooltip() {
    clearDayTooltipShowTimer();
    restoreDayHoverInputPreviewIfActive();
    if (!dayTooltipEl) return;
    dayTooltipEl.hidden = true;
    dayTooltipEl.style.visibility = "hidden";
    dayTooltipEl.setAttribute("aria-hidden", "true");
  }

  /**
   * Tooltip top-left at day button bottom-right (`rect.right`, `rect.bottom`), then
   * shift only if needed so the box stays inside the viewport.
   */
  function showDayTooltipForButton(btn, year, month0, dayNum) {
    const label = formatNormalized(year, month0, dayNum);
    const tip = ensureDayTooltip();
    tip.textContent = label;

    tip.removeAttribute("hidden");
    tip.hidden = false;
    tip.style.position = "fixed";
    tip.style.visibility = "hidden";
    tip.style.left = "-99999px";
    tip.style.top = "0";
    tip.style.pointerEvents = "none";
    tip.setAttribute("aria-hidden", "false");

    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const rect = btn.getBoundingClientRect();

    let left = rect.right;
    let top = rect.bottom;

    if (left + tw > window.innerWidth - TOOLTIP_VIEW_MARGIN) {
      left = window.innerWidth - tw - TOOLTIP_VIEW_MARGIN;
    }
    if (left < TOOLTIP_VIEW_MARGIN) {
      left = TOOLTIP_VIEW_MARGIN;
    }

    if (top + th > window.innerHeight - TOOLTIP_VIEW_MARGIN) {
      top = window.innerHeight - th - TOOLTIP_VIEW_MARGIN;
    }
    if (top < TOOLTIP_VIEW_MARGIN) {
      top = TOOLTIP_VIEW_MARGIN;
    }

    tip.style.left = left + "px";
    tip.style.top = top + "px";
    tip.style.visibility = "visible";
  }

  window.addEventListener(
    "scroll",
    function () {
      hideDayTooltip();
    },
    true
  );

  window.addEventListener("resize", hideDayTooltip);

  // ─── Monday-first weekday index: 0 = Mon … 6 = Sun
  function mondayIndex(d) {
    return (d.getDay() + 6) % 7;
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  /**
   * Core calendar validation: {@link month0} is 0–11. Returns `{ year, month, day }` or null.
   */
  function parseValidatedParts(day, month0, year) {
    if (month0 < 0 || month0 > 11) return null;
    if (day < 1 || day > daysInMonth(year, month0)) return null;

    const d = new Date(year, month0, day);
    if (d.getFullYear() !== year || d.getMonth() !== month0 || d.getDate() !== day) return null;

    return { year, month: month0, day };
  }

  /** @param month1 month 1–12 */
  function parseDatePartsWithMinYear(day, month1, year) {
    if (month1 < 1 || month1 > 12) return null;
    let y = year;
    if (y < MIN_YEAR) y = MIN_YEAR;
    const maxY = getMaxYear();
    if (y > maxY) y = maxY;
    return parseValidatedParts(day, month1 - 1, y);
  }

  /**
   * Full date only: dotted `D.M.YYYY` / `DD.MM.YYYY`, or compact `DDMMYYYY` (8 digits).
   * Returns `{ year, month, day }` (month 0–11) or null if not a recognized full string or calendar-invalid.
   */
  function parseSupportedDate(str) {
    const s = String(str).trim();
    if (!s) return null;

    const compact = /^(\d{8})$/.exec(s);
    if (compact) {
      const ds = compact[1];
      const day = parseInt(ds.slice(0, 2), 10);
      const month1 = parseInt(ds.slice(2, 4), 10);
      const year = parseInt(ds.slice(4, 8), 10);
      return parseDatePartsWithMinYear(day, month1, year);
    }

    const dotSep = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    if (dotSep) {
      const day = parseInt(dotSep[1], 10);
      const month1 = parseInt(dotSep[2], 10);
      const year = parseInt(dotSep[3], 10);
      return parseDatePartsWithMinYear(day, month1, year);
    }

    return null;
  }

  /**
   * Keep viewDate within selectable years [MIN_YEAR, current year]; if viewing current calendar year,
   * do not leave viewDate.month after “today”.
   */
  function clampViewDateToAllowedRange() {
    if (viewDate.year < MIN_YEAR) viewDate.year = MIN_YEAR;
    const maxY = getMaxYear();
    if (viewDate.year > maxY) viewDate.year = maxY;
    const cm = new Date().getMonth();
    if (viewDate.year === maxY && viewDate.month > cm) {
      viewDate.month = cm;
    }
  }

  /** Max length for dotted manual + masked display (`31.12.YYYY`). */
  const DATE_INPUT_MAX_LEN = 10;

  /**
   * Manual dot entry: only `0–9` and `.`, at most two dots, max length {@link DATE_INPUT_MAX_LEN}.
   * Skips leading dots and avoids `..`.
   */
  function sanitizeManualDateInput(s) {
    let out = "";
    let dots = 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      if (out.length >= DATE_INPUT_MAX_LEN) break;
      const ch = str[i];
      if (ch >= "0" && ch <= "9") {
        out += ch;
        continue;
      }
      if (ch === "." && dots < 2) {
        if (out.length === 0 || out[out.length - 1] === ".") continue;
        out += ".";
        dots++;
      }
    }
    return out.slice(0, DATE_INPUT_MAX_LEN);
  }

  /** Input mask helper — digits only (max 8), auto-insert `.` separators. */
  function formatMaskedDateInput(value) {
    const digits = String(value).replace(/\D/g, "").slice(0, 8);

    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return digits.slice(0, 2) + "." + digits.slice(2);
    return digits.slice(0, 2) + "." + digits.slice(2, 4) + "." + digits.slice(4);
  }

  /** Normalized DD.MM.YYYY from calendar parts */
  function formatNormalized(y, mo, da) {
    const dd = String(da).padStart(2, "0");
    const mm = String(mo + 1).padStart(2, "0");
    return `${dd}.${mm}.${y}`;
  }

  function formatFromDate(dt) {
    return formatNormalized(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  function restoreDefaultPlaceholder() {
    el.input.placeholder = DEFAULT_PLACEHOLDER;
  }

  function restoreDayHoverInputPreviewIfActive() {
    if (!isHoverPreviewActive) return;
    el.input.value = hoverPreviewValueBefore != null ? hoverPreviewValueBefore : "";
    hoverPreviewValueBefore = null;
    isHoverPreviewActive = false;
  }

  /** Printable keys: digits and dot (slash and other separators are blocked). */
  function isAllowedDateInputPrintable(key) {
    return key.length === 1 && /[0-9.]/.test(key);
  }

  /** Navigation / editing keys that must pass through */
  function shouldAllowDateInputNonPrintable(key) {
    const allowed = [
      "Backspace",
      "Delete",
      "Tab",
      "Enter",
      "Escape",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ];
    return allowed.indexOf(key) !== -1;
  }

  /** Return true when keydown should not insert or perform default for blocked chars */
  function shouldBlockDateInputKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const key = e.key;

    if (shouldAllowDateInputNonPrintable(key)) return false;
    if (key.length > 1) return false;
    return !isAllowedDateInputPrintable(key);
  }

  /** Merge pasted/dropped digit string into current digit stream and apply mask */
  function mergeMaskedDigitsAtSelection(insertText) {
    dateInputManualDotMode = false;
    const input = el.input;
    const start =
      typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === "number" ? input.selectionEnd : input.value.length;
    const val = input.value;
    const beforeDigits = val.slice(0, start).replace(/\D/g, "").length;
    const selDigits = val.slice(start, end).replace(/\D/g, "").length;
    const digitStr = val.replace(/\D/g, "");
    const pasteDigits = String(insertText).replace(/\D/g, "").slice(0, 8);
    const newDigits = (digitStr.slice(0, beforeDigits) + pasteDigits + digitStr.slice(beforeDigits + selDigits)).slice(
      0,
      8
    );
    input.value = formatMaskedDateInput(newDigits);
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Paste/drop text with manual dots: merge at selection, sanitize, then sync. */
  function mergeManualDotsAtSelection(insertText) {
    dateInputManualDotMode = true;
    const input = el.input;
    const start =
      typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === "number" ? input.selectionEnd : input.value.length;
    const val = input.value;
    const cleaned = String(insertText).replace(/[^0-9.]/g, "");
    const merged = sanitizeManualDateInput(val.slice(0, start) + cleaned + val.slice(end));
    input.value = merged;
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** After value change: digit mask and/or manual dots, sync calendar (no errors while typing). */
  function syncFromDateInput() {
    let rawForParse;

    if (!dateInputManualDotMode) {
      const digits = el.input.value.replace(/\D/g, "").slice(0, 8);
      el.input.value = formatMaskedDateInput(digits);
      rawForParse = el.input.value.trim();
    } else {
      const sanitized = sanitizeManualDateInput(el.input.value);
      if (el.input.value !== sanitized) {
        el.input.value = sanitized;
      }
      rawForParse = sanitized.trim();
    }

    setError(false);

    if (rawForParse.length === 0) {
      selectedDate = null;
      dateInputManualDotMode = false;
      syncEndIcons();
      if (isOpen()) {
        calendarViewMode = "days";
        updateCalendarWithHeightAnimation(function () {
          renderCalendar();
        });
      }
      syncSheetInputFromMain();
      return;
    }

    const parsed = parseSupportedDate(rawForParse);
    if (!parsed) {
      selectedDate = null;
      syncEndIcons();
      if (isOpen()) {
        calendarViewMode = "days";
        updateCalendarWithHeightAnimation(function () {
          renderCalendar();
        });
      }
      syncSheetInputFromMain();
      return;
    }

    dateInputManualDotMode = false;
    const normalizedStr = formatNormalized(parsed.year, parsed.month, parsed.day);
    if (el.input.value !== normalizedStr) {
      el.input.value = normalizedStr;
    }

    selectedDate = new Date(parsed.year, parsed.month, parsed.day);
    viewDate = { year: parsed.year, month: parsed.month };
    setError(false);
    if (isOpen()) {
      calendarViewMode = "days";
      updateCalendarWithHeightAnimation(function () {
        renderCalendar();
      });
    }
    syncEndIcons();
    syncSheetInputFromMain();
  }

  /** Show calendar glyph when empty, × clear button when anything is typed */
  function syncEndIcons() {
    const hasVal = el.input.value.trim().length > 0;
    el.toggle.hidden = hasVal;
    el.clear.hidden = !hasVal;
  }

  /** @param {boolean} show */
  function setError(show) {
    if (!show) {
      el.root.dataset.state = "";
      el.input.setAttribute("aria-invalid", "false");
      el.error.hidden = true;
      return;
    }
    el.error.textContent = ERROR_MSG;
    el.root.dataset.state = "error";
    el.input.setAttribute("aria-invalid", "true");
    el.error.hidden = false;
  }

  function syncSheetInputFromMain() {
    if (!el.sheetInput) return;
    el.sheetInput.value = el.input.value;
  }

  function isMobileSheetMode() {
    return window.matchMedia("(max-width: 768px)").matches;
  }

  function setOverlayOpen(open) {
    if (!el.overlay) return;
    if (open) {
      el.overlay.removeAttribute("hidden");
      window.requestAnimationFrame(function () {
        el.overlay.classList.add("calendar-sheet-overlay--open");
      });
      return;
    }
    el.overlay.classList.remove("calendar-sheet-overlay--open");
    el.overlay.setAttribute("hidden", "");
  }

  function setToggleLabel(open) {
    el.toggle.setAttribute("aria-label", open ? "Закрыть календарь" : "Открыть календарь");
  }

  function setOpen(open) {
    if (open) {
      clearCloseAnimListeners();
      cancelHeightAnim();
      el.popup.classList.remove("calendar-popup--closing");

      if (
        el.popup.classList.contains("calendar-popup--open") &&
        !el.popup.hasAttribute("hidden")
      ) {
        syncViewToSelectionOrToday();
        updateCalendarWithHeightAnimation(function () {
          renderCalendar();
        });
        syncSheetInputFromMain();
        if (isMobileSheetMode() && el.sheetInput) {
          el.sheetInput.focus();
        }
        return;
      }

      el.popup.removeAttribute("hidden");
      if (isMobileSheetMode()) setOverlayOpen(true);
      el.input.setAttribute("aria-expanded", "true");
      el.popup.setAttribute("aria-hidden", "false");
      if (!el.toggle.hidden) {
        el.toggle.setAttribute("aria-expanded", "true");
        setToggleLabel(true);
      }

      calendarViewMode = "days";
      syncViewToSelectionOrToday();
      renderCalendar();
      syncSheetInputFromMain();

      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          el.popup.classList.add("calendar-popup--open");
          if (isMobileSheetMode() && el.sheetInput) {
            el.sheetInput.focus();
          }
        });
      });
      return;
    }

    if (el.popup.hasAttribute("hidden")) return;
    if (el.popup.classList.contains("calendar-popup--closing")) return;
    if (!el.popup.classList.contains("calendar-popup--open")) return;

    cancelHeightAnim();
    el.popup.classList.remove("calendar-popup--open");
    el.popup.classList.add("calendar-popup--closing");

    if (prefersReducedMotion.matches) {
      finalizePopupClose();
      return;
    }

    el.popup.addEventListener("transitionend", onPopupCloseTransitionEnd);
    closeAnimFallbackId = window.setTimeout(finalizePopupClose, 200);
  }

  function isOpen() {
    return el.popup.classList.contains("calendar-popup--open");
  }

  function syncViewToSelectionOrToday() {
    if (selectedDate) {
      viewDate = { year: selectedDate.getFullYear(), month: selectedDate.getMonth() };
    } else {
      const t = new Date();
      viewDate = { year: t.getFullYear(), month: t.getMonth() };
    }
  }

  /** Blur / Enter: full valid date normalizes to DD.MM.YYYY; incomplete or invalid → format error */
  function validateAndNormalize() {
    const raw = el.input.value.trim();

    if (raw.length === 0) {
      dateInputManualDotMode = false;
      selectedDate = null;
      if (isRequired) {
        setError(true);
        return false;
      }
      setError(false);
      restoreDefaultPlaceholder();
      syncEndIcons();
      if (isOpen()) {
        calendarViewMode = "days";
        updateCalendarWithHeightAnimation(function () {
          renderCalendar();
        });
      }
      return true;
    }

    const parsed = parseSupportedDate(raw);
    if (!parsed) {
      setError(true);
      selectedDate = null;
      syncEndIcons();
      return false;
    }

    dateInputManualDotMode = false;
    el.input.value = formatNormalized(parsed.year, parsed.month, parsed.day);
    selectedDate = new Date(parsed.year, parsed.month, parsed.day);
    viewDate = { year: parsed.year, month: parsed.month };
    setError(false);
    if (isOpen()) {
      calendarViewMode = "days";
      updateCalendarWithHeightAnimation(function () {
        renderCalendar();
      });
    }
    syncEndIcons();
    return true;
  }

  function handleClearClick(e) {
    e.preventDefault();
    e.stopPropagation();

    el.input.value = "";
    selectedDate = null;
    dateInputManualDotMode = false;

    setError(false);
    restoreDefaultPlaceholder();
    syncEndIcons();

    el.input.focus({ preventScroll: true });
    setOpen(true);
  }

  /** Enter: validate, normalize, close popup, blur input (valid & invalid paths) */
  function handleEnterInInput(e) {
    e.preventDefault();
    validateAndNormalize();
    skipBlurValidationOnce = true;
    setOpen(false);
    el.input.blur();
    skipBlurValidationOnce = false;
  }

  function todayStart() {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }

  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function attachDayHoverHandlers(btn, yyyy, mm, dd) {
    btn.addEventListener("mouseenter", function onDayHover() {
      const ddmmyyyy = formatNormalized(yyyy, mm, dd);

      if (!isHoverPreviewActive) {
        hoverPreviewValueBefore = el.input.value;
      }

      isHoverPreviewActive = true;
      el.input.value = ddmmyyyy;

      clearDayTooltipShowTimer();
      dayTooltipShowTimerId = window.setTimeout(function () {
        dayTooltipShowTimerId = null;
        showDayTooltipForButton(btn, yyyy, mm, dd);
      }, TOOLTIP_SHOW_DELAY_MS);
    });
    btn.addEventListener("mouseleave", function onDayHoverEnd() {
      if (isHoverPreviewActive) {
        el.input.value = hoverPreviewValueBefore || "";
        hoverPreviewValueBefore = null;
        isHoverPreviewActive = false;
      }

      restoreDefaultPlaceholder();
      syncEndIcons();
      hideDayTooltip();
    });
  }

  function renderNavLabels() {
    if (calendarViewMode === "days") {
      el.prev.setAttribute("aria-label", "Предыдущий месяц");
      el.next.setAttribute("aria-label", "Следующий месяц");
    } else if (calendarViewMode === "months") {
      el.prev.setAttribute("aria-label", "Предыдущий год");
      el.next.setAttribute("aria-label", "Следующий год");
    } else {
      el.prev.setAttribute("aria-label", "Предыдущие 12 лет");
      el.next.setAttribute("aria-label", "Следующие 12 лет");
    }
  }

  function renderHeader() {
    const monthLabel = el.monthButton.querySelector(".calendar-title-button__text");
    const yearLabel = el.yearButton.querySelector(".calendar-title-button__text");
    if (monthLabel) monthLabel.textContent = MONTH_NAMES[viewDate.month];
    else el.monthButton.textContent = MONTH_NAMES[viewDate.month];
    if (yearLabel) yearLabel.textContent = String(viewDate.year);
    else el.yearButton.textContent = String(viewDate.year);
    el.monthButton.setAttribute("aria-expanded", calendarViewMode === "months" ? "true" : "false");
    el.yearButton.setAttribute("aria-expanded", calendarViewMode === "years" ? "true" : "false");

    if (calendarViewMode === "days") {
      el.prev.disabled = false;
      el.next.disabled = false;
      el.prev.setAttribute("aria-disabled", "false");
      el.next.setAttribute("aria-disabled", "false");
    } else {
      el.prev.disabled = true;
      el.next.disabled = true;
      el.prev.setAttribute("aria-disabled", "true");
      el.next.setAttribute("aria-disabled", "true");
    }

    renderNavLabels();
  }

  function renderDaysView() {
    const { year, month } = viewDate;
    const first = new Date(year, month, 1);
    const startOffset = mondayIndex(first);
    const dim = daysInMonth(year, month);

    for (let i = 0; i < startOffset; i++) {
      const empty = document.createElement("div");
      empty.className = "calendar-cell calendar-cell--empty";
      empty.setAttribute("aria-hidden", "true");
      el.grid.appendChild(empty);
    }

    for (let dayNum = 1; dayNum <= dim; dayNum++) {
      const idx = startOffset + dayNum - 1;
      const col = idx % 7;
      const isWeekendCell = col === 5 || col === 6;

      const cellDate = new Date(year, month, dayNum);
      const isToday = sameDay(cellDate, todayStart());
      const isSel = selectedDate && sameDay(cellDate, selectedDate);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "calendar-day";
      if (isWeekendCell) btn.classList.add("day--weekend");
      btn.textContent = String(dayNum);
      btn.setAttribute("role", "gridcell");
      if (isToday) btn.dataset.today = "true";
      if (isSel) btn.dataset.selected = "true";

      attachDayHoverHandlers(btn, year, month, dayNum);

      btn.addEventListener("click", function onDayClick() {
        selectedDate = new Date(year, month, dayNum);
        el.input.value = formatFromDate(selectedDate);
        hoverPreviewValueBefore = null;
        isHoverPreviewActive = false;
        setError(false);
        restoreDefaultPlaceholder();
        syncEndIcons();
        setOpen(false);
        el.input.blur();
      });

      el.grid.appendChild(btn);
    }
  }

  function renderMonthsView() {
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();

    for (let m = 0; m < 12; m++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "calendar-meta-button calendar-list-item";
      btn.textContent = MONTH_NAMES[m];

      const isFutureMonth = viewDate.year === currentYear && m > currentMonth;

      if (isFutureMonth) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
        btn.classList.add("calendar-list-item--disabled");
        el.grid.appendChild(btn);
        continue;
      }

      const isSelectedMonth = m === viewDate.month;

      if (isSelectedMonth) {
        btn.dataset.selected = "true";
        btn.classList.add("calendar-list-item--selected");
        const checkImg = document.createElement("img");
        checkImg.src = CHECK_ICON_SRC;
        checkImg.className = "calendar-list-check-icon";
        checkImg.alt = "";
        checkImg.setAttribute("aria-hidden", "true");
        btn.appendChild(checkImg);
      }

      (function (monthIndex, monthBtn) {
        monthBtn.addEventListener("click", function () {
          if (monthBtn.disabled) return;
          updateCalendarWithHeightAnimation(function () {
            viewDate.month = monthIndex;
            calendarViewMode = "days";
            renderCalendar();
          });
        });
      })(m, btn);

      el.grid.appendChild(btn);
    }
  }

  function renderYearsView() {
    for (let year = getMaxYear(); year >= MIN_YEAR; year--) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "calendar-meta-button calendar-list-item";
      btn.textContent = String(year);

      const isSelectedYear = year === viewDate.year;

      if (isSelectedYear) {
        btn.dataset.selected = "true";
        btn.classList.add("calendar-list-item--selected");
        const checkImg = document.createElement("img");
        checkImg.src = CHECK_ICON_SRC;
        checkImg.className = "calendar-list-check-icon";
        checkImg.alt = "";
        checkImg.setAttribute("aria-hidden", "true");
        btn.appendChild(checkImg);
      }

      (function (y) {
        btn.addEventListener("click", function () {
          updateCalendarWithHeightAnimation(function () {
            viewDate.year = y;
            clampViewDateToAllowedRange();
            calendarViewMode = "days";
            renderCalendar();
          });
        });
      })(year);

      el.grid.appendChild(btn);
    }
  }

  /**
   * Header + body by `calendarViewMode`; day grid — leading weekday blanks only, no trailing empties.
   */
  function renderCalendar() {
    hideDayTooltip();
    restoreDefaultPlaceholder();

    if (calendarViewMode === "months") {
      clampViewDateToAllowedRange();
    }

    renderHeader();

    if (el.weekdays) {
      el.weekdays.hidden = calendarViewMode !== "days";
    }

    el.grid.innerHTML = "";

    if (calendarViewMode === "days") {
      el.grid.className = "calendar-grid";
      el.grid.setAttribute("role", "grid");
      renderDaysView();
      return;
    }

    el.grid.className = "calendar-grid calendar-grid--meta calendar-list";
    el.grid.removeAttribute("role");

    if (calendarViewMode === "months") {
      renderMonthsView();
      return;
    }

    renderYearsView();
  }

  let swipeStartY = 0;
  let swipeCurrentY = 0;
  let swipeTracking = false;

  el.popup.addEventListener("touchstart", function (e) {
    if (!isMobileSheetMode() || !isOpen()) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    swipeTracking = true;
    swipeStartY = t.clientY;
    swipeCurrentY = 0;
  }, { passive: true });

  el.popup.addEventListener("touchmove", function (e) {
    if (!swipeTracking || !isMobileSheetMode()) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dy = Math.max(0, t.clientY - swipeStartY);
    swipeCurrentY = dy;
    if (dy > 0) {
      el.popup.style.transform = "translateY(" + dy + "px)";
      if (el.overlay) {
        el.overlay.style.opacity = String(Math.max(0, 1 - dy / 320));
      }
    }
  }, { passive: true });

  el.popup.addEventListener("touchend", function () {
    if (!swipeTracking) return;
    swipeTracking = false;
    const shouldClose = swipeCurrentY > 96;
    el.popup.style.transform = "";
    if (el.overlay) el.overlay.style.opacity = "";
    if (shouldClose) {
      setOpen(false);
    }
  });

  el.popup.addEventListener("mousedown", function (e) {
    e.preventDefault();
  });

  if (el.overlay) {
    el.overlay.addEventListener("click", function () {
      setOpen(false);
    });
  }

  document.addEventListener("pointerdown", function (e) {
    if (!el.root.contains(e.target)) {
      setOpen(false);
    }
  });

  el.input.addEventListener("focus", function () {
    setOpen(true);
  });

  el.input.addEventListener("click", function () {
    if (isMobileSheetMode()) {
      el.input.blur();
    }
    if (!isOpen()) setOpen(true);
  });

  if (el.sheetInput) {
    el.sheetInput.addEventListener("beforeinput", function (e) {
      const ie = /** @type {InputEvent} */ (e);
      if (ie.inputType && String(ie.inputType).indexOf("delete") === 0) return;
      const data = ie.data;
      if (data && /[^0-9.]/.test(data)) e.preventDefault();
    });

    el.sheetInput.addEventListener("input", function () {
      el.input.value = el.sheetInput.value;
      syncFromDateInput();
      syncSheetInputFromMain();
    });

    el.sheetInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        validateAndNormalize();
        syncSheetInputFromMain();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    });
  }

  el.input.addEventListener("input", function () {
    syncFromDateInput();
  });

  /** Allow digits and `.` only; paste/drop handled separately */
  el.input.addEventListener("beforeinput", function (e) {
    const ie = /** @type {InputEvent} */ (e);

    if (
      ie.inputType === "insertFromPaste" ||
      ie.inputType === "insertFromDrop" ||
      ie.inputType === "historyUndo" ||
      ie.inputType === "historyRedo"
    ) {
      return;
    }

    if (ie.inputType && String(ie.inputType).indexOf("delete") === 0) return;

    const data = ie.data;
    if (data !== null && data !== undefined && data !== "") {
      const invalid = [...data].some(function (ch) {
        return !/[0-9.]/.test(ch);
      });
      if (invalid) e.preventDefault();
    }
  });

  el.input.addEventListener("paste", function (e) {
    e.preventDefault();
    const clip = e.clipboardData || window.clipboardData;
    const text = clip ? clip.getData("text") : "";
    const t = String(text);
    const onlyDigitsAndDots = t.replace(/[^0-9.]/g, "");
    if (onlyDigitsAndDots.indexOf(".") !== -1) {
      mergeManualDotsAtSelection(onlyDigitsAndDots);
    } else {
      mergeMaskedDigitsAtSelection(onlyDigitsAndDots);
    }
  });

  el.input.addEventListener("drop", function (e) {
    e.preventDefault();
    const text = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
    const t = String(text);
    const onlyDigitsAndDots = t.replace(/[^0-9.]/g, "");
    if (onlyDigitsAndDots.indexOf(".") !== -1) {
      mergeManualDotsAtSelection(onlyDigitsAndDots);
    } else {
      mergeMaskedDigitsAtSelection(onlyDigitsAndDots);
    }
  });

  el.input.addEventListener("blur", function (e) {
    if (skipBlurValidationOnce) return;
    if (skipBlurForClearTap) {
      skipBlurForClearTap = false;
      return;
    }
    const rt = e.relatedTarget;
    if (rt instanceof Node && el.popup.contains(rt)) return;
    if (rt === el.clear || (rt instanceof Node && el.clear.contains(rt))) return;
    validateAndNormalize();
  });

  el.clear.addEventListener("pointerdown", function () {
    skipBlurForClearTap = true;
  });

  el.input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      handleEnterInInput(e);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }

    if (e.key === "." && !e.ctrlKey && !e.metaKey && !e.altKey) {
      dateInputManualDotMode = true;
    }

    if (shouldBlockDateInputKeyDown(e)) {
      e.preventDefault();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      setOpen(false);
    }
  });

  el.toggle.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(!el.popup.classList.contains("calendar-popup--open"));
  });

  el.clear.addEventListener("click", handleClearClick);

  el.prev.addEventListener("click", function (e) {
    e.stopPropagation();
    updateCalendarWithHeightAnimation(function () {
      if (calendarViewMode === "days") {
        viewDate = addMonth(viewDate, -1);
      } else if (calendarViewMode === "months") {
        viewDate = addMonth(viewDate, -12);
      }
      renderCalendar();
    });
  });

  el.next.addEventListener("click", function (e) {
    e.stopPropagation();
    updateCalendarWithHeightAnimation(function () {
      if (calendarViewMode === "days") {
        viewDate = addMonth(viewDate, 1);
      } else if (calendarViewMode === "months") {
        viewDate = addMonth(viewDate, 12);
      }
      renderCalendar();
    });
  });

  el.monthButton.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    updateCalendarWithHeightAnimation(function () {
      if (calendarViewMode === "months") {
        calendarViewMode = "days";
      } else {
        calendarViewMode = "months";
      }
      renderCalendar();
    });
  });

  el.yearButton.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    updateCalendarWithHeightAnimation(function () {
      if (calendarViewMode === "years") {
        calendarViewMode = "days";
      } else {
        calendarViewMode = "years";
      }
      renderCalendar();
    });
  });

  el.popup.setAttribute("aria-hidden", "true");

  el.input.maxLength = DATE_INPUT_MAX_LEN;

  setError(false);
  setOpen(false);
  setToggleLabel(false);
  restoreDefaultPlaceholder();
  syncEndIcons();
})();


(function initRangePicker() {
  const startInput = document.getElementById("range-start-input");
  const endInput = document.getElementById("range-end-input");
  const errorEl = document.getElementById("range-error");
  if (!startInput || !endInput || !errorEl) return;

  function normalize(raw) {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return digits.slice(0, 2) + "." + digits.slice(2);
    return digits.slice(0, 2) + "." + digits.slice(2, 4) + "." + digits.slice(4);
  }

  function toDate(v) {
    const m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return null;
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    if (d.getFullYear() !== Number(m[3]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[1])) return null;
    return d;
  }

  function validateRange() {
    errorEl.hidden = true;
    const s = toDate(startInput.value.trim());
    const e = toDate(endInput.value.trim());
    if (!s || !e) return;
    if (s.getTime() > e.getTime()) errorEl.hidden = false;
  }

  [startInput, endInput].forEach(function (input) {
    input.addEventListener("input", function () {
      input.value = normalize(input.value);
      validateRange();
    });
    input.addEventListener("blur", validateRange);
  });
})();

(function initRangeCalendar(){
  const root=document.getElementById('date-range-picker');
  const startInput=document.getElementById('range-start-input');
  const endInput=document.getElementById('range-end-input');
  const popup=document.getElementById('range-calendar-popup');
  const left=document.getElementById('range-cal-left');
  const right=document.getElementById('range-cal-right');
  const prev=document.getElementById('range-prev');
  const next=document.getElementById('range-next');
  if(!root||!startInput||!endInput||!popup||!left||!right) return;
  const monthNames=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  let view=new Date(new Date().getFullYear(),new Date().getMonth(),1);
  let start=null,end=null;
  function fmt(d){const dd=String(d.getDate()).padStart(2,'0');const mm=String(d.getMonth()+1).padStart(2,'0');return `${dd}.${mm}.${d.getFullYear()}`}
  function parse(v){const m=v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);if(!m) return null; const d=new Date(+m[3],+m[2]-1,+m[1]); return d && d.getMonth()==+m[2]-1?d:null;}
  function isSame(a,b){return a&&b&&a.toDateString()===b.toDateString()}
  function between(d,a,b){return a&&b&&d>a&&d<b}
  function makeGrid(host,base){
    host.innerHTML='';
    const head=document.createElement('div');head.className='range-cal-header';head.textContent=`${monthNames[base.getMonth()]} ${base.getFullYear()}`;host.appendChild(head);
    const wd=document.createElement('div');wd.className='range-weekdays';wd.innerHTML='<span>пн</span><span>вт</span><span>ср</span><span>чт</span><span>пт</span><span style="color:#fc8507">сб</span><span style="color:#fc8507">вс</span>';host.appendChild(wd);
    const grid=document.createElement('div');grid.className='range-grid';
    const first=(new Date(base.getFullYear(),base.getMonth(),1).getDay()+6)%7;
    const days=new Date(base.getFullYear(),base.getMonth()+1,0).getDate();
    for(let i=0;i<first;i++){const e=document.createElement('span');grid.appendChild(e)}
    for(let d=1;d<=days;d++){const cur=new Date(base.getFullYear(),base.getMonth(),d);const b=document.createElement('button');b.type='button';b.className='range-day';b.textContent=String(d);
      const dow=(cur.getDay()+6)%7;if(dow>=5)b.classList.add('is-weekend');
      if(isSame(cur,start))b.classList.add('is-start'); if(isSame(cur,end))b.classList.add('is-end'); if(between(cur,start,end))b.classList.add('is-between');
      b.addEventListener('click',()=>{ if(!start||end){start=cur;end=null;} else if(cur<start){end=start;start=cur;} else {end=cur;} startInput.value= start?fmt(start):''; endInput.value=end?fmt(end):''; render();});
      grid.appendChild(b)
    }
    host.appendChild(grid);
  }
  function render(){ makeGrid(left,view); makeGrid(right,new Date(view.getFullYear(),view.getMonth()+1,1)); }
  function open(){ popup.hidden=false; render(); }
  function close(){ popup.hidden=true; }
  [startInput,endInput].forEach(i=>i.addEventListener('focus',open));
  prev.addEventListener('click',()=>{view=new Date(view.getFullYear(),view.getMonth()-1,1);render();});
  next.addEventListener('click',()=>{view=new Date(view.getFullYear(),view.getMonth()+1,1);render();});
  document.addEventListener('pointerdown',e=>{ if(!root.contains(e.target)) close(); });
})();
