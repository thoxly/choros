# Spec · T-0135 — Наполнение PRESETS грантов (E3.4 / зона 4)

**Epic/Story:** E3.4 зона 4 (gap-map §4): «Посильность модели прав без решётки скоупов — пресеты
пусты» (T-0030 предполагает `PRESETS` — ни одного не определено; gap-map 2026-06-11).

**Status:** `ready` (approved approved T-0030 DONE; механизм пресетов существует —
`ra-data.jsx` PRESETS + `GET /api/rights/dictionaries` FR-8, но словарь пресетов пуст и
не включён в ответ dictionaries).

**Phase:** SPEC.

**Deps:**
- T-0030 (DONE): `POST /api/grants`, `GET /api/rights/dictionaries`, `ra-data.jsx` PRESETS.
- `grant-lattice.ts` (T-0018): словарь `Operation` + `ResourceType`.
- `web/src/screens/rights/ra-data.jsx`: существующий `PRESETS` массив + `RESOURCES`.

---

## 0. Одна строка

Наполнить `PRESETS` **реальными пресетами дня-1** — именованными наборами грантов
в терминах существующих `resource_type` / `operation`; включить `presets` в ответ
`GET /api/rights/dictionaries`; добавить тесты применения пресета (расширение → правильные гранты,
идемпотентность).

---

## 1. Источники пресетов

Источники: gap-map §4, `ra-data.jsx` (SoD-правила + TRAIL + ролевые метки), TEL-референс
(роли: Инициатор, Менеджер по договорной работе, согласующие службы SSD/LGM, Главбух, Подписант).

Механизм (AC-18 T-0030): пресеты — клиентская удобность, **не таблица БД**. При отправке
форма разворачивает пресет в структурные атомы (те же, что advanced-mode) и вызывает
`POST /api/grants`. Пресеты живут:
1. `src/http/grants.ts` — `DICT_PRESETS` (TypeScript, сервируются из `GET /api/rights/dictionaries`).
2. `web/src/screens/rights/ra-data.jsx` — `PRESETS` (фронтенд, для прогрессивного раскрытия).

Оба источника должны быть синхронизированы по `id` и грантовым атомам.

---

## 2. Словарь ресурсов и операций (существующий, не создаётся)

### 2.1 Ресурсы (`RESOURCES` / `DICT_RESOURCES`)

| URI | Имя | Флаги |
|-----|-----|-------|
| `mcp://ledger.invoices` | Реестр счетов | sensitive |
| `mcp://ledger.recon` | Сверка платежей | sensitive |
| `mcp://payments.initiate` | Платёжный шлюз | external, guarded |
| `mcp://payments.refund` | Возвраты средств | external, guarded |
| `mcp://counterparty.kyc` | Контрагенты (KYC) | sensitive |
| `mcp://contracts.lookup` | Справочник договоров | — |
| `mcp://support.queue` | Очередь обращений | — |
| `mcp://crm.customer` | CRM клиента | sensitive |
| `mcp://kb.search` | База знаний | — |
| `mcp://escalations.queue` | Очередь эскалаций | — |

### 2.2 Операции (`Operation` из `grant-lattice.ts`)

`read | create | update | delete | approve | transition | invoke`

### 2.3 Org-узлы (`ORG_TREE`)

Slug-ключи: `org | fin | fin-calc | fin-approve | fin-treasury | cs | cs-l1 | cs-l2 | plat | sales | sales-smb | sales-ent`

---

## 3. Day-1 пресеты — список и состав

Каждый пресет: `{ id, label, desc, critical?, grants: [{ uri, ops, scopeOwn?, scopeOrg? }] }`.
`scopeOwn` = scope ограничен собственным подразделением; `scopeOrg` = явный org-узел.

Пресеты выбраны из реальных ролей в `TRAIL` / SoD-правилах / TEL-референсе (роли из
живых данных, не выдуманы):

| id | label | Гранты | Крит. |
|----|-------|--------|-------|
| `p-budget-approver` | Согласующий бюджета в Финансах | ledger.invoices:read + ledger.invoices:approve, scopeOrg=fin | нет |
| `p-treasury-exec` | Казначей-исполнитель | ledger.invoices:read + ledger.recon:read + ledger.recon:update + payments.initiate:invoke (4 атома), constraint≤500k, scopeOrg=fin-treasury | **critical** |
| `p-audit-observer` | Наблюдатель аудита | ledger.invoices:read + ledger.recon:read + contracts.lookup:read, scopeOrg=fin | нет |
| `p-contract-initiator` | Инициатор договорной работы | contracts.lookup:read,create + counterparty.kyc:read, scopeOwn=true | нет |
| `p-contract-approver` | Согласующий договоров | contracts.lookup:read,approve + counterparty.kyc:read, scopeOwn=true | нет |
| `p-support-l1` | Линия поддержки L1 | support.queue:read,update + crm.customer:read + kb.search:read, scopeOrg=cs-l1 | нет |
| `p-escalation-receiver` | Приёмник эскалаций агентов | escalations.queue:read,update + crm.customer:read, scopeOrg=cs | нет |
| `p-recon-accountant` | Бухгалтер сверки | ledger.invoices:read + ledger.recon:read,write, scopeOrg=fin | нет |
| `p-pay-init-limited` | Инициировать платёж до лимита | payments.initiate:invoke, constraint≤250k, scopeOwn=true | **critical** |
| `p-refund-operator` | Оператор возвратов | payments.refund:invoke + ledger.invoices:read, scopeOrg=fin, constraint≤30k | **critical** |

**Итого 10 пресетов.** Невырождение: каждый пресет содержит минимум 1 ненулевой
grant-атом с реальным ресурсом и операцией.

---

## 4. Шейп пресета в API (TypeScript / JSON)

```ts
interface GrantAtom {
  resource_type: string;   // URI из DICT_RESOURCES или mgmt_object:*
  operation: string;       // из Operation union
  scope_own?: boolean;     // true = узел ограничен собственным подразделением (UI заполняет)
  scope_org?: string;      // org slug / nodeId (явный), если не scopeOwn
  constraint?: unknown;    // jsonb, например {amount_le: 250000}
  delegable?: boolean;     // по умолчанию true
}

interface GrantPreset {
  id: string;
  label: string;
  desc: string;
  critical?: boolean;
  grants: GrantAtom[];
}
```

Массив `DICT_PRESETS: GrantPreset[]` добавляется в `src/http/grants.ts` и включается
в ответ `GET /api/rights/dictionaries` под ключом `presets`.

Фронтенд `PRESETS` в `ra-data.jsx` обновляется с тем же набором (синхронизация вручную;
живая сверка — через тест).

---

## 5. Acceptance criteria

| Id | Текст | Верификация |
|----|-------|-------------|
| AC-01 | `GET /api/rights/dictionaries` возвращает ключ `presets` — массив, минимум 10 элементов. | test |
| AC-02 | Каждый пресет в `presets` имеет поля `id`, `label`, `desc`, `grants`; каждый grant-атом имеет `resource_type` и `operation`. | test |
| AC-03 | `resource_type` каждого гранта в каждом пресете совпадает с URI из `resources` (тот же словарь из DICT_RESOURCES). | test |
| AC-04 | `operation` каждого гранта — одно из `["read","create","update","delete","approve","transition","invoke"]`. | test |
| AC-05 | Пресет `p-budget-approver` содержит ровно 2 атома: `mcp://ledger.invoices:read` и `mcp://ledger.invoices:approve`. | test |
| AC-06 | Пресет `p-treasury-exec` содержит ровно 4 атома: `ledger.invoices:read`, `ledger.recon:read`, `ledger.recon:update` и `payments.initiate:invoke`; помечен `critical:true`. | test |
| AC-07 | Пресет `p-pay-init-limited` помечен `critical:true`; содержит `payments.initiate:invoke` с `constraint.amount_le = 250000`. | test |
| AC-08 | Нет вырожденного пресета (пустой `grants` массив не допускается). | test |
| AC-09 | `DICT_PRESETS` экспортируется из `src/http/grants.ts` (или отдельного модуля) и импортируется в обработчик `registerDictionariesRoute`; никакого дублирования логики расширения в другой ветке. | fitness |
| AC-10 | `PRESETS` в `ra-data.jsx` синхронизирован с `DICT_PRESETS`: для каждого `id` в DICT_PRESETS существует запись с тем же `id` в `PRESETS`, и количества совпадают. | fitness |

---

## 6. Что вне скоупа

- Расширение пресета на сервере (AC-18 T-0030 — клиентская сторона, без preset-таблицы).
- Вычисление `isGenesisOwner` или вызов `validateAdminDelegation` при получении пресета
  (GET dictionaries — read-only, без аутентификации).
- Дополнительная DDL (пресеты — seed в TS, не в БД).
- Пересмотр SoD-правил или изменение `ORG_TREE`.
