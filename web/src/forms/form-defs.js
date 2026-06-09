/* ============================================================================
   CHOROS — form-defs.js
   Разметка form-js (.fjs-*) для двух форм User Task + рантайм, исполняемый
   ВНУТРИ sandbox-iframe (тогглы select, числовые стрелки, расчёт «итого»,
   подсветка required, авто-высота через postMessage).
   Чистый JS — грузится в РОДИТЕЛЬСКОМ документе, отдаёт строки для srcdoc.
   ============================================================================ */
(function () {
  /* ---- общие глифы ---- */
  var CHEVRON =
    '<svg class="fjs-select-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
  var CAL =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/></svg>';
  var HUMAN_GLYPH =
    '<svg class="fjs-exec__glyph" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="currentColor" stroke="currentColor" stroke-width="1.4"/></svg>';

  /* ---- генератор select ---- */
  function select(field, label, value, options, opts) {
    opts = opts || {};
    var items = options
      .map(function (o) {
        var sel = o.label === value;
        var mono = o.mono ? '<span class="fjs-dd-mono">' + o.mono + "</span>" : "";
        return (
          '<div class="fjs-dropdownlist-item" data-val="' +
          o.label +
          '" aria-selected="' +
          (sel ? "true" : "false") +
          '">' +
          o.label +
          mono +
          "</div>"
        );
      })
      .join("");
    return (
      '<div class="fjs-form-field fjs-form-field-select" data-field="' +
      field +
      '">' +
      '<label class="fjs-form-field-label">' +
      label +
      (opts.required ? '<span class="fjs-asterix">*</span>' : "") +
      "</label>" +
      '<div class="fjs-select-display" tabindex="0">' +
      '<span class="fjs-select-value">' +
      value +
      "</span>" +
      CHEVRON +
      "</div>" +
      '<div class="fjs-dropdownlist">' +
      items +
      "</div>" +
      "</div>"
    );
  }

  /* ============================================================================
     ФОРМА 1 — ЗАЯВКА НА ЗАКУПКУ
     ============================================================================ */
  var PURCHASE =
    '<form class="fjs-container" novalidate>' +
    '<div class="fjs-form">' +
    '<div class="fjs-vertical-layout">' +

    // заголовок
    '<div class="fjs-form-field fjs-form-field-text"><div class="fjs-text-view">' +
    '<div class="fjs-form-title"><h1>Заявка на закупку</h1>' +
    '<span class="fjs-form-title-id">PR-2026-0418</span></div>' +
    "</div></div>" +

    // поставщик / категория
    '<div class="fjs-row">' +
    '<div class="fjs-column" data-col="2">' +
    select(
      "supplier",
      "Поставщик",
      "ООО «Вектор»",
      [
        { label: "ООО «Вектор»", mono: "ИНН 7701..." },
        { label: "АО «Линия»", mono: "ИНН 7736..." },
        { label: "ООО «Стек-Трейд»", mono: "ИНН 5024..." },
        { label: "Новый контрагент…" }
      ],
      { required: true }
    ) +
    "</div>" +
    '<div class="fjs-column">' +
    select("category", "Категория", "IT-оборудование", [
      { label: "IT-оборудование" },
      { label: "Программное обеспечение" },
      { label: "Услуги" },
      { label: "Канцелярия и АХО" }
    ]) +
    "</div>" +
    "</div>" +

    // предмет закупки
    '<div class="fjs-form-field fjs-form-field-textfield" data-field="subject">' +
    '<label class="fjs-form-field-label">Предмет закупки<span class="fjs-asterix">*</span></label>' +
    '<input class="fjs-input" type="text" value="Ноутбуки Lenovo ThinkPad T14 Gen 5 (32 ГБ / 1 ТБ)">' +
    '<div class="fjs-form-field-description">Краткая номенклатура; детальная спецификация — во вложении.</div>' +
    "</div>" +

    // кол-во / цена / срок
    '<div class="fjs-row">' +
    '<div class="fjs-column">' +
    '<div class="fjs-form-field fjs-form-field-number" data-field="qty">' +
    '<label class="fjs-form-field-label">Кол-во</label>' +
    '<div class="fjs-input-group">' +
    '<input class="fjs-input fjs-input--adorned" type="text" inputmode="numeric" value="4" data-amount>' +
    '<div class="fjs-number-arrow-container">' +
    '<button type="button" class="fjs-number-arrow-up" data-step="1">▲</button>' +
    '<button type="button" class="fjs-number-arrow-down" data-step="-1">▼</button>' +
    "</div></div></div></div>" +
    '<div class="fjs-column">' +
    '<div class="fjs-form-field fjs-form-field-number" data-field="price">' +
    '<label class="fjs-form-field-label">Цена за ед.</label>' +
    '<div class="fjs-input-group">' +
    '<input class="fjs-input fjs-input--adorned" type="text" inputmode="decimal" value="124 000" data-amount>' +
    '<span class="fjs-input-adornment">₽</span>' +
    "</div></div></div>" +
    '<div class="fjs-column">' +
    '<div class="fjs-form-field fjs-form-field-datetime" data-field="due">' +
    '<label class="fjs-form-field-label">Срок поставки</label>' +
    '<div class="fjs-input-group">' +
    '<input class="fjs-input fjs-input--adorned" type="text" value="21.06.2026">' +
    '<span class="fjs-input-adornment">' +
    CAL +
    "</span></div></div></div>" +
    "</div>" +

    // ЦФО / способ закупки
    '<div class="fjs-row">' +
    '<div class="fjs-column" data-col="2">' +
    select(
      "budget",
      "ЦФО · статья бюджета",
      "ИТ-инфраструктура · CAPEX",
      [
        { label: "ИТ-инфраструктура · CAPEX", mono: "B-204" },
        { label: "Операционные ИТ · OPEX", mono: "B-211" },
        { label: "Развитие продукта · CAPEX", mono: "B-118" }
      ],
      { required: true }
    ) +
    "</div>" +
    '<div class="fjs-column" data-col="2">' +
    '<div class="fjs-form-field fjs-form-field-radio" data-field="method">' +
    '<label class="fjs-form-field-label">Способ закупки</label>' +
    '<div class="fjs-radio-group" data-inline="true">' +
    '<label class="fjs-radio-label"><input type="radio" class="fjs-radio" name="method" checked><span>Прямая</span></label>' +
    '<label class="fjs-radio-label"><input type="radio" class="fjs-radio" name="method"><span>Тендер</span></label>' +
    '<label class="fjs-radio-label"><input type="radio" class="fjs-radio" name="method"><span>Рамочный</span></label>' +
    "</div></div></div>" +
    "</div>" +

    // обоснование
    '<div class="fjs-form-field fjs-form-field-textarea" data-field="reason">' +
    '<label class="fjs-form-field-label">Обоснование</label>' +
    '<textarea class="fjs-textarea" rows="2">Замена парка устройств отдела разработки с истёкшим сроком амортизации. Согласовано с руководителем направления.</textarea>' +
    "</div>" +

    // срочная
    '<div class="fjs-form-field fjs-form-field-checkbox" data-field="urgent">' +
    '<label class="fjs-checkbox-label"><input type="checkbox" class="fjs-checkbox"><span>Срочная закупка — вне планового цикла</span></label>' +
    "</div>" +

    '<div class="fjs-form-field fjs-form-field-separator"><hr class="fjs-separator"></div>' +

    // итого
    '<div class="fjs-form-field fjs-form-field-text"><div class="fjs-text-view">' +
    '<div class="fjs-amount fjs-amount--ok">' +
    '<span class="fjs-amount__label">Итого к согласованию</span>' +
    '<span class="fjs-amount__val" data-total>496 000 ₽</span>' +
    "</div></div></div>" +

    // кнопки
    '<div class="fjs-form-field fjs-form-field-button"><div class="fjs-button-group">' +
    '<button type="submit" class="fjs-button">Отправить на согласование</button>' +
    '<button type="button" class="fjs-button fjs-button--secondary">Сохранить черновик</button>' +
    "</div></div>" +

    "</div></div></form>";

  /* ============================================================================
     ФОРМА 2 — СОГЛАСОВАНИЕ
     ============================================================================ */
  var APPROVAL =
    '<form class="fjs-container" novalidate>' +
    '<div class="fjs-form">' +
    '<div class="fjs-vertical-layout">' +

    // заголовок
    '<div class="fjs-form-field fjs-form-field-text"><div class="fjs-text-view">' +
    '<div class="fjs-form-title"><h1>Согласование закупки</h1>' +
    '<span class="fjs-form-title-id">AP-2026-0418-2</span></div>' +
    "</div></div>" +

    // сводка «что согласуем»
    '<div class="fjs-form-field fjs-form-field-text"><div class="fjs-text-view">' +
    '<dl class="fjs-kv">' +
    "<dt>Заявка</dt><dd><span class=\"fjs-mono fjs-mono--accent\">PR-2026-0418</span></dd>" +
    '<dt>Инициатор</dt><dd><span class="fjs-exec fjs-exec--human">' +
    HUMAN_GLYPH +
    "А. Кравцова</span></dd>" +
    "<dt>Предмет</dt><dd>Ноутбуки ThinkPad T14 Gen 5 · <span class=\"fjs-mono\">4 шт.</span></dd>" +
    "<dt>Контрагент</dt><dd>ООО «Вектор» · прямая закупка</dd>" +
    "</dl></div></div>" +

    // сумма / лимит
    '<div class="fjs-row">' +
    '<div class="fjs-column"><div class="fjs-form-field fjs-form-field-text"><div class="fjs-text-view">' +
    '<div class="fjs-amount fjs-amount--ok"><span class="fjs-amount__label">Сумма заявки</span>' +
    '<span class="fjs-amount__val">496 000 ₽</span></div>' +
    "</div></div></div>" +
    '<div class="fjs-column"><div class="fjs-form-field fjs-form-field-text"><div class="fjs-text-view">' +
    '<div class="fjs-amount fjs-amount--limit"><span class="fjs-amount__label">Ваш лимит</span>' +
    '<span class="fjs-amount__val">≤ 500 000 ₽</span></div>' +
    "</div></div></div>" +
    "</div>" +

    '<div class="fjs-form-field fjs-form-field-separator"><hr class="fjs-separator"></div>' +

    // решение
    '<div class="fjs-form-field fjs-form-field-radio" data-field="decision">' +
    '<label class="fjs-form-field-label">Решение<span class="fjs-asterix">*</span></label>' +
    '<div class="fjs-radio-group" data-inline="true">' +
    '<label class="fjs-radio-label"><input type="radio" class="fjs-radio" name="decision" value="ok" checked><span>Согласовать</span></label>' +
    '<label class="fjs-radio-label"><input type="radio" class="fjs-radio" name="decision" value="reject"><span>Отклонить</span></label>' +
    '<label class="fjs-radio-label"><input type="radio" class="fjs-radio" name="decision" value="return"><span>Вернуть на доработку</span></label>' +
    "</div></div>" +

    // комментарий
    '<div class="fjs-form-field fjs-form-field-textarea" data-field="comment">' +
    '<label class="fjs-form-field-label">Комментарий<span class="fjs-asterix" data-req-when-reject hidden>*</span></label>' +
    '<textarea class="fjs-textarea" rows="2" placeholder="Обязателен при отклонении или возврате"></textarea>' +
    '<div class="fjs-form-field-description">Будет записан в аудит-лог инстанса.</div>' +
    "</div>" +

    // следующий согласующий
    '<div class="fjs-row">' +
    '<div class="fjs-column" data-col="2">' +
    select("next", "Следующий согласующий", "Е. Ларина · Финдиректор", [
      { label: "Е. Ларина · Финдиректор" },
      { label: "Авто по маршруту процесса" },
      { label: "Без эскалации" }
    ]) +
    "</div>" +
    '<div class="fjs-column"></div>' +
    "</div>" +

    // проверки
    '<div class="fjs-form-field fjs-form-field-checklist" data-field="checks">' +
    '<label class="fjs-form-field-label">Контроль перед согласованием</label>' +
    '<div class="fjs-checkbox-group">' +
    '<label class="fjs-checkbox-label"><input type="checkbox" class="fjs-checkbox" checked><span>Бюджет статьи подтверждён</span></label>' +
    '<label class="fjs-checkbox-label"><input type="checkbox" class="fjs-checkbox" checked><span>Договор проверен · <span class="fjs-mono">ДГ-2231</span></span></label>' +
    '<label class="fjs-checkbox-label"><input type="checkbox" class="fjs-checkbox"><span>Реквизиты контрагента сверены</span></label>' +
    "</div></div>" +

    // кнопки
    '<div class="fjs-form-field fjs-form-field-button"><div class="fjs-button-group">' +
    '<button type="submit" class="fjs-button">Согласовать</button>' +
    '<button type="button" class="fjs-button fjs-button--danger">Отклонить</button>' +
    '<button type="button" class="fjs-button fjs-button--secondary">Вернуть</button>' +
    "</div></div>" +

    "</div></div></form>";

  /* ============================================================================
     РАНТАЙМ ВНУТРИ SANDBOX (строка → инлайн-скрипт srcdoc)
     ============================================================================ */
  var SANDBOX_SCRIPT = [
    "(function(){",
    "  var d=document;",
    "  function fmt(n){return Math.round(n).toLocaleString('ru-RU').replace(/\\u00a0/g,' ');}",
    "  function num(v){return parseFloat(String(v).replace(/[^0-9.,-]/g,'').replace(',', '.'))||0;}",
    // select toggles
    "  function closeAll(except){d.querySelectorAll('.fjs-select-display').forEach(function(s){if(s!==except){s.removeAttribute('data-open');var dd=s.nextElementSibling;if(dd)dd.removeAttribute('data-open');}});}",
    "  d.querySelectorAll('.fjs-form-field-select').forEach(function(f){",
    "    var disp=f.querySelector('.fjs-select-display');var list=f.querySelector('.fjs-dropdownlist');var val=f.querySelector('.fjs-select-value');",
    "    disp.addEventListener('click',function(e){e.stopPropagation();var open=disp.hasAttribute('data-open');closeAll(disp);if(!open){disp.setAttribute('data-open','true');list.setAttribute('data-open','true');}});",
    "    list.querySelectorAll('.fjs-dropdownlist-item').forEach(function(it){it.addEventListener('click',function(e){e.stopPropagation();list.querySelectorAll('[aria-selected]').forEach(function(x){x.setAttribute('aria-selected','false');});it.setAttribute('aria-selected','true');val.textContent=it.getAttribute('data-val');disp.removeAttribute('data-open');list.removeAttribute('data-open');});});",
    "  });",
    "  d.addEventListener('click',function(){closeAll(null);});",
    // number steppers
    "  d.querySelectorAll('.fjs-number-arrow-up,.fjs-number-arrow-down').forEach(function(b){b.addEventListener('click',function(){var inp=b.closest('.fjs-input-group').querySelector('.fjs-input');var v=num(inp.value)+parseInt(b.getAttribute('data-step'),10);if(v<0)v=0;inp.value=fmt(v);recalc();});});",
    // total recalc (purchase)
    "  function recalc(){var q=d.querySelector('[data-field=qty] .fjs-input');var p=d.querySelector('[data-field=price] .fjs-input');var t=d.querySelector('[data-total]');if(q&&p&&t){t.textContent=fmt(num(q.value)*num(p.value))+' ₽';}}",
    "  d.querySelectorAll('[data-field=qty] .fjs-input,[data-field=price] .fjs-input').forEach(function(i){i.addEventListener('input',recalc);});recalc();",
    // decision → comment required
    "  var dec=d.querySelectorAll('input[name=decision]');var reqStar=d.querySelector('[data-req-when-reject]');",
    "  dec.forEach(function(r){r.addEventListener('change',function(){var need=(d.querySelector('input[name=decision]:checked')||{}).value!=='ok';if(reqStar)reqStar.hidden=!need;});});",
    // auto height
    "  function postH(){var h=d.documentElement.scrollHeight;parent.postMessage({type:'fjs-height',h:h},'*');}",
    "  if(window.ResizeObserver){new ResizeObserver(postH).observe(d.body);}",
    "  window.addEventListener('load',postH);postH();setTimeout(postH,200);setTimeout(postH,600);",
    "  d.addEventListener('input',postH);d.addEventListener('click',function(){setTimeout(postH,140);});",
    "})();"
  ].join("\n");

  window.CHOROS_FORMS = { purchase: PURCHASE, approval: APPROVAL };
  window.CHOROS_SANDBOX_SCRIPT = SANDBOX_SCRIPT;
})();
